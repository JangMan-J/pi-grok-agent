#!/usr/bin/env node
// EOF-only stand-in for pi-grok-leash; no native parent-death signal support.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { constants } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('pi-grok-leash 0.0.0-fake (eof-only)');
  process.exit(0);
}
function usage(): never {
  console.error('usage: fake-leash.ts --parent <pid> [--stall-ms N] [--request-ms N] [--log <path>] -- <cmd> <args...>');
  process.exit(2);
}
let parent = 0, stallMs = 1000, requestMs = 25000;
let log = process.env.PI_GROK_LEASH_LOG;
let i = 0;
for (; i < args.length && args[i] !== '--'; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (!value || value.startsWith('--')) usage();
  if (flag === '--log') { log = value; continue; }
  if (!['--parent', '--stall-ms', '--request-ms'].includes(flag)) usage();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) usage();
  if (flag === '--parent') parent = Number(value);
  else if (flag === '--stall-ms') stallMs = Number(value);
  else requestMs = Number(value);
}
if (!parent || args[i] !== '--' || !args[i + 1]) usage();
if (process.ppid !== parent) process.exit(3);
if (log) appendFileSync(log, JSON.stringify({ event: 'argv', argv: args }) + '\n');

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
const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
const toChild = writer(child.stdin);
const toPi = writer(process.stdout);
const tracked = new Map<string, { id: unknown; method: string; deadline: number; startedAt: number }>();
const answered = new Set<string>();
const methods = new Set(['_x.ai/hooks/run', 'session/request_permission', '_x.ai/ask_user_question']);
let lastHeartbeat = performance.now(), stopping = false, childExited = false, malformed = 0;
let timer: ReturnType<typeof setInterval> | undefined;
function parse(line: Buffer): Record<string, any> | undefined {
  try {
    const value = JSON.parse(line.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Non-JSON is passed through unchanged. */ }
  malformed++;
}
function event(name: string, params: Record<string, unknown> = {}) {
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'pi/leash', params: { event: name, ...params } }) + '\n';
  if (log) appendFileSync(log, line);
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
  if (notification) await event(notification.name, notification.params);
  await childExit;
  if (log) appendFileSync(log, JSON.stringify({ event: 'summary', malformed }) + '\n');
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
await event('ready', { version: '0.0.0-fake', grokPid: child.pid, stallMs, requestMs });

const output = (async () => {
  for await (const line of lines(child.stdout)) {
    if (stopping) break;
    const message = parse(line);
    if (message && methods.has(message.method) && 'id' in message) {
      const now = performance.now(), key = JSON.stringify(message.id);
      tracked.set(key, { id: message.id, method: message.method, deadline: now + requestMs, startedAt: now });
      if (tracked.size > 64) {
        await toPi(line);
        await finish(0, true, { name: 'stall', params: { ms: Math.round(now - lastHeartbeat) } });
        return;
      }
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
      if (log) appendFileSync(log, JSON.stringify({ event: 'heartbeat', t: lastHeartbeat }) + '\n');
      continue;
    }
    if (message?.method === 'pi/extend') {
      if (log) appendFileSync(log, JSON.stringify({ event: 'extend', ...message.params }) + '\n');
      const request = tracked.get(JSON.stringify(message.params?.id));
      const ms = message.params?.ms;
      if (request && Number.isFinite(ms) && ms >= 0) request.deadline = performance.now() + ms;
      continue;
    }
    if (message && 'id' in message && !('method' in message) && ('result' in message || 'error' in message)) {
      const key = JSON.stringify(message.id);
      if (answered.has(key)) { await event('late-reply', { id: message.id }); continue; }
      tracked.delete(key);
    }
    // Keep reading heartbeats even when Grok stops reading stdin. The writer chain
    // is intentionally unbounded and preserves order, including synthetic replies.
    void toChild(line).catch(fail);
  }
  if (!childExited) await finish(0, true);
})().catch(fail);

timer = setInterval(() => {
  if (stopping || childExited) return;
  const now = performance.now(), gap = now - lastHeartbeat;
  if (gap > 10 * stallMs) lastHeartbeat = now;
  else if (gap > stallMs) {
    void finish(0, true, { name: 'stall', params: { ms: Math.round(gap) } }).catch(fail);
    return;
  }
  for (const [key, request] of tracked) {
    if (now < request.deadline) continue;
    tracked.delete(key);
    answered.add(key);
    const ms = Math.round(now - request.startedAt);
    const result = request.method === '_x.ai/hooks/run'
      ? { decision: 'deny', reason: `pi-grok-leash: no answer in ${ms} ms` }
      : { outcome: { outcome: 'cancelled' } };
    void toChild(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
      .then(() => event('deadline', { id: request.id, method: request.method, ms })).catch(fail);
  }
}, 50);
void childExit.then(async ({ code, signal }) => {
  childExited = true;
  clearInterval(timer);
  process.stdin.destroy();
  await output;
  await finish(code ?? (128 + (signal ? constants.signals[signal] : 0)), false, {
    name: 'child-exit', params: { code, signal },
  });
}).catch(fail);
