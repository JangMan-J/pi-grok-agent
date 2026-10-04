#!/usr/bin/env node
// EOF-only stand-in for pi-grok-leash; no native parent-death signal support.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, openSync } from 'node:fs';
import { constants } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('pi-grok-leash 0.0.0-fake (eof-only)');
  process.exit(0);
}
function usage(): never {
  console.error('usage: pi-grok-leash --parent <pid> [--stall-ms 1000] [--request-ms 25000] [--log <path>] -- <grok> <args...> | --version');
  process.exit(2);
}
let parent = 0, stallMs = 1000n, requestMs = 25000n;
const U64_MAX = (1n << 64n) - 1n;
// Node 22.19+ preserves primitive source tokens without a second JSON parser.
const rawJSON = (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON;
const wireMs = (ms: bigint) => rawJSON(ms.toString());
let log = process.env.PI_GROK_LEASH_LOG;
const trace = process.env.FAKE_LEASH_TRACE;
function recordTrace(row: unknown) {
  if (trace) appendFileSync(trace, JSON.stringify(row) + '\n');
}
let i = 0;
for (; i < args.length && args[i] !== '--'; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (!value) usage();
  if (flag === '--log') { log = value; continue; }
  if (!['--parent', '--stall-ms', '--request-ms'].includes(flag) || !/^\+?\d+$/.test(value)) usage();
  const number = BigInt(value);
  if (number <= 0n || number > (flag === '--parent' ? 2147483647n : U64_MAX)) usage();
  if (flag === '--parent') parent = Number(number);
  else if (flag === '--stall-ms') stallMs = number;
  else requestMs = number;
}
if (!parent || args[i] !== '--' || !args[i + 1]) usage();
if (process.ppid !== parent) process.exit(3);
recordTrace({ event: 'argv', argv: args });
let logFd: number | undefined;
try { if (log !== undefined) logFd = openSync(log, 'a'); }
catch (error) { console.error(String(error)); process.exit(1); }
function logLine(line: string) {
  // Like Rust's logger, a write failure must not change protocol/lifetime behavior.
  try { if (logFd !== undefined) appendFileSync(logFd, line); } catch { /* Best-effort log. */ }
}

// Keep the original bytes, including CRLF and any unterminated final fragment.
async function* lines(stream: Readable) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, end + 1);
      pending = pending.subarray(end + 1);
      yield line;
    }
  }
  if (pending.length) yield pending;
}

// Both producers share a queue; write callbacks also wait for backpressure.
function writer(stream: Writable) {
  let tail = Promise.resolve();
  return (data: string | Buffer) => {
    const next = tail.then(() => new Promise<void>((resolve, reject) => {
      stream.write(data, (error) => error ? reject(error) : resolve());
    }));
    tail = next.catch(() => {});
    return next;
  };
}
const child = spawn(args[i + 1], args.slice(i + 2), {
  stdio: ['pipe', 'pipe', 'inherit'], detached: true,
});
try { await once(child, 'spawn'); }
catch (error) { console.error(String(error)); process.exit(1); }
logLine(JSON.stringify({ event: 'start', parent, args: args.slice(i + 1) }) + '\n');
const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
const toChild = writer(child.stdin);
const toPi = writer(process.stdout);
type Id = { key: string; wire: unknown };
const tracked = new Map<string, { id: Id; method: string; deadline: number; ms: bigint }>();
const answered = new Set<string>();
const methods = new Set(['_x.ai/hooks/run', 'session/request_permission', '_x.ai/ask_user_question']);
let lastHeartbeat = performance.now(), lastTick = lastHeartbeat, stopping = false, childExited = false, malformed = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const tokens = new WeakMap<object, Record<string, string>>();
function parse(line: Buffer): Record<string, any> | undefined {
  try {
    const text = decoder.decode(line);
    // Match the Rust parser's depth limit and rejection of lone UTF-16 surrogates,
    // including strings that a later duplicate object key would otherwise overwrite.
    let depth = 0;
    for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]|[^\s{}\[\],:]+/g)) {
      if (token === '}' || token === ']') { depth--; continue; }
      if (depth > 129) throw new Error('JSON depth exceeds 128');
      if (token === '{' || token === '[') depth++;
      else if (token.startsWith('"')) {
        for (const char of JSON.parse(token) as string) {
          const cp = char.codePointAt(0)!;
          if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('unpaired surrogate');
        }
      }
    }
    const value = JSON.parse(text, function (key, value, context?: { source?: string }) {
      if ((key === 'id' || key === 'ms') && context?.source) {
        const fields = tokens.get(this) ?? Object.create(null);
        fields[key] = context.source;
        tokens.set(this, fields);
      }
      return value;
    });
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Malformed bytes are passed through unchanged. */ }
  malformed++;
}
function idOf(message: Record<string, any> | undefined): Id | undefined {
  if (!message || !['string', 'number'].includes(typeof message.id)) return;
  const raw = tokens.get(message)?.id;
  if (raw) return { key: typeof message.id === 'string' ? `s:${message.id}` : `n:${raw}`, wire: rawJSON(raw) };
}
function expire(now: number) {
  const expired = [...tracked.entries()].filter(([, request]) => now >= request.deadline)
    .sort(([, a], [, b]) => a.deadline - b.deadline);
  for (const [key, request] of expired) {
    tracked.delete(key);
    answered.add(key);
    const { id, method, ms } = request;
    const result = method === '_x.ai/hooks/run'
      ? { decision: 'deny', reason: `pi-grok-leash: no answer in ${ms} ms` }
      : { outcome: { outcome: 'cancelled' } };
    void toChild(JSON.stringify({ jsonrpc: '2.0', id: id.wire, result }) + '\n')
      .then(() => event('deadline', { id: id.wire, method, ms: wireMs(ms) })).catch(fail);
  }
}
function event(name: string, params: Record<string, unknown> = {}) {
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'pi/leash', params: { event: name, ...params } }) + '\n';
  logLine(line);
  return toPi(line);
}
function killGroup() {
  try { process.kill(-child.pid!, 'SIGKILL'); }
  catch { try { process.kill(child.pid!, 'SIGKILL'); } catch { /* Already exited. */ } }
}
async function finish(code: number, kill: boolean, notification?: { name: string; params: Record<string, unknown> }) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  process.stdin.destroy();
  if (kill) killGroup();
  await childExit;
  if (notification) await event(notification.name, notification.params);
  logLine(JSON.stringify({ event: 'exit', code, malformed }) + '\n');
  await toPi('');
  process.stdout.end(() => process.exit(code));
}
function fail(error: unknown) {
  if (stopping || childExited) return;
  console.error(String(error));
  void finish(1, true).catch(() => { killGroup(); process.exit(1); });
}
child.stdin.on('error', fail);
process.stdout.on('error', () => { killGroup(); process.exit(1); });
await event('ready', { version: '0.0.0-fake', grokPid: child.pid, stallMs: wireMs(stallMs), requestMs: wireMs(requestMs) });

const output = (async () => {
  for await (const line of lines(child.stdout)) {
    if (stopping) break;
    const message = parse(line);
    const id = idOf(message);
    if (message && methods.has(message.method) && id) {
      if (tracked.size === 64 && !tracked.has(id.key)) {
        await finish(0, true, { name: 'stall', params: { ms: wireMs(stallMs) } });
        return;
      }
      answered.delete(id.key);
      tracked.set(id.key, { id, method: message.method, deadline: performance.now() + Number(requestMs), ms: requestMs });
    }
    await toPi(line);
  }
})();
void output.catch(fail);
void (async () => {
  for await (const line of lines(process.stdin)) {
    if (stopping || childExited) return;
    const message = parse(line);
    if (message?.method === 'pi/heartbeat') {
      lastHeartbeat = performance.now();
      recordTrace({ event: 'heartbeat', t: lastHeartbeat });
      continue;
    }
    if (message?.method === 'pi/extend') {
      recordTrace({ event: 'extend', ...message.params });
      const id = idOf(message.params), token = message.params && tokens.get(message.params)?.ms;
      const request = id && tracked.get(id.key), now = performance.now();
      if (request && now < request.deadline && token && /^\d+$/.test(token)) {
        const ms = BigInt(token);
        if (ms <= U64_MAX) { request.deadline = now + Number(ms); request.ms = ms; }
      }
      continue;
    }
    const id = idOf(message);
    if (id && typeof message?.method !== 'string') {
      expire(performance.now()); // Claim expiration even between watchdog ticks.
      tracked.delete(id.key);
      if (answered.has(id.key)) { void event('late-reply', { id: id.wire }).catch(fail); continue; }
    }
    // Keep reading heartbeats even when Grok stops reading stdin. The writer chain
    // is intentionally unbounded and preserves order, including synthetic replies.
    void toChild(line).catch(fail);
  }
  if (!childExited) await finish(0, true, { name: 'parent-gone', params: {} });
})().catch(fail);

timer = setInterval(() => {
  if (stopping || childExited) return;
  if (process.ppid !== parent) {
    void finish(0, true, { name: 'parent-gone', params: {} }).catch(fail);
    return;
  }
  const now = performance.now();
  if (now - lastTick > 10 * Number(stallMs)) lastHeartbeat = now;
  lastTick = now;
  if (now - lastHeartbeat >= Number(stallMs)) {
    void finish(0, true, { name: 'stall', params: { ms: wireMs(stallMs) } }).catch(fail);
    return;
  }
  expire(now);
}, 2);
void childExit.then(async ({ code, signal }) => {
  childExited = true;
  clearInterval(timer);
  process.stdin.destroy();
  await output;
  await finish(code ?? (128 + (signal ? constants.signals[signal] : 0)), false, {
    name: 'child-exit', params: { code, signal },
  });
}).catch(fail);
