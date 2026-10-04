#!/usr/bin/env node
// A stand-in for the Grok Build binary, for transport tests that must not spend Grok usage.
// Select it with PI_GROK_BINARY. Two modes, supporting legacy leader and direct stdio tests:
//   ... agent leader --leader-socket <path>   hold the leader socket and write <path minus .sock>.lock with this pid
//   ... agent --leader stdio ...              JSON-RPC over stdio: answers initialize and session/new, emits any
//                                             message sent as a `test/emit` notification, and appends every
//                                             response it receives to FAKE_GROK_LOG (one JSON line each).
//                                             FAKE_GROK_MCP_LIST=1: lists the session's first MCP server before it
//                                             answers session/new, as Grok does, and logs the answer as `mcp-tools-list`
// Failure knobs (stdio mode):
//   FAKE_GROK_USAGE_EXIT=1     print usage and exit 2 before speaking JSON
//   FAKE_GROK_DIE_AFTER=<n>    exit after n JSON responses
//   FAKE_GROK_DIE_ON=<method>  exit when that request arrives, before answering
//   FAKE_GROK_EXIT_CODE, FAKE_GROK_DIE_SIGNAL, FAKE_GROK_DIE_STDERR
//   FAKE_GROK_HANG=<method>    never answer that method
//   FAKE_GROK_DELAY_MS         pause before answering initialize
//   FAKE_GROK_STDOUT_NOISE     write this line to stdout before any JSON
//   FAKE_GROK_STDOUT_PARTIAL   write this truncated frame with no newline
//   FAKE_GROK_STDERR           write this line to stderr at startup
//   FAKE_GROK_LOAD_ERROR=1     session/load returns "session not found"
//   FAKE_GROK_AUTH_FAIL=1      authenticate returns an error
//   FAKE_GROK_HOLD_PROMPT=1    leave session/prompt unanswered until session/cancel
//   FAKE_GROK_IGNORE_CANCEL=1  ignore session/cancel
//   FAKE_GROK_IGNORE_EOF=1     do not exit when stdin closes
//   FAKE_GROK_IGNORE_TERM=1    ignore SIGTERM
//   FAKE_GROK_LOG_BYTES=1      log byte counts for lines over 4 KB instead of the line
//   FAKE_GROK_TOOL_RAN_MS      after a pre_tool_use emit, write FAKE_GROK_TOOL_RAN if still unanswered (fail-open stand-in)
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const socketPath = args[args.indexOf('--leader-socket') + 1] ?? '';

function die(why: string) {
  const line = why.endsWith('\n') ? why : `${why}\n`;
  process.stderr.write(line, () => {
    const signal = process.env.FAKE_GROK_DIE_SIGNAL;
    if (signal) process.kill(process.pid, signal as NodeJS.Signals);
    else process.exit(Number(process.env.FAKE_GROK_EXIT_CODE ?? 137));
  });
}

if (process.env.FAKE_GROK_USAGE_EXIT === '1') {
  process.stdout.write('usage: grok agent [--no-leader] <transport>\n');
  process.stderr.write('error: unknown flag --no-leader\n');
  process.exit(2);
}

if (args.includes('leader')) {
  const lock = socketPath.replace(/\.sock$/, '') + '.lock';
  const server = createServer((socket) => socket.end());
  server.listen(socketPath, () => writeFileSync(lock, `${process.pid}\n`));
  const stop = () => { server.close(); try { unlinkSync(socketPath); } catch { /* already gone */ } process.exit(143); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setInterval(() => {}, 60_000); // stay alive until signalled
} else if (args.includes('stdio')) {
  const log = process.env.FAKE_GROK_LOG;
  if (process.env.FAKE_GROK_STDERR) process.stderr.write(`${process.env.FAKE_GROK_STDERR}\n`);
  if (process.env.FAKE_GROK_STDOUT_NOISE) process.stdout.write(`${process.env.FAKE_GROK_STDOUT_NOISE}\n`);
  if (process.env.FAKE_GROK_STDOUT_PARTIAL) process.stdout.write(process.env.FAKE_GROK_STDOUT_PARTIAL);
  if (log) appendFileSync(log, JSON.stringify({ id: 'spawn', argv: args, autoupdate: process.env.GROK_DISABLE_AUTOUPDATER }) + '\n');
  let sent = 0;
  const limit = Number(process.env.FAKE_GROK_DIE_AFTER ?? 0);
  const send = (message: unknown) => {
    const body = JSON.stringify(message) + '\n';
    process.stdout.write(body, () => {
      sent++;
      if (limit > 0 && sent >= limit) die(process.env.FAKE_GROK_DIE_STDERR ?? 'fake grok died');
    });
  };
  const record = (line: string, id?: unknown) => {
    if (!log) return;
    if (process.env.FAKE_GROK_LOG_BYTES === '1' && line.length > 4096) {
      appendFileSync(log, JSON.stringify({ id: id ?? 'bytes', bytes: Buffer.byteLength(line) }) + '\n');
      return;
    }
    appendFileSync(log, line.endsWith('\n') ? line : `${line}\n`);
  };
  const waiters = new Map<string, (message: Record<string, any>) => void>();
  const heldPrompts: Record<string, any>[] = [];
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    if (process.env.FAKE_GROK_LOG_BYTES === '1' && line.length > 4096) record(line, 'bytes');
    let message: Record<string, any>;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && ('result' in message || 'error' in message)) {
      if (!(process.env.FAKE_GROK_LOG_BYTES === '1' && line.length > 4096)) record(line);
      const waiter = waiters.get(JSON.stringify(message.id));
      if (waiter) { waiters.delete(JSON.stringify(message.id)); waiter(message); return; }
      return;
    }
    if (message.method === 'test/emit') {
      const ranMs = Number(process.env.FAKE_GROK_TOOL_RAN_MS ?? 0);
      const marker = process.env.FAKE_GROK_TOOL_RAN;
      const hook = message.params?.method === '_x.ai/hooks/run' && message.params?.params?.hookEventName === 'pre_tool_use';
      if (hook && ranMs > 0 && marker && message.params?.id != null) {
        const timer = setTimeout(() => { try { writeFileSync(marker, 'ran\n'); } catch { /* process is gone */ } }, ranMs);
        const key = JSON.stringify(message.params.id);
        const prev = waiters.get(key);
        waiters.set(key, (response) => { clearTimeout(timer); prev?.(response); });
      }
      send(message.params);
      return;
    }
    if (message.method === 'test/big') {
      const text = 'y'.repeat(5_000_000);
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      return;
    }
    if (process.env.FAKE_GROK_DIE_ON === message.method) {
      die(process.env.FAKE_GROK_DIE_STDERR ?? `fake grok died on ${message.method}`);
      return;
    }
    if (process.env.FAKE_GROK_HANG === message.method) return;
    const delay = Number(process.env.FAKE_GROK_DELAY_MS ?? 0);
    if (delay && message.method === 'initialize') await new Promise((resolve) => setTimeout(resolve, delay));
    // Signed in, Grok offers cached_token. FAKE_GROK_LOGGED_OUT=1 offers only the interactive method, as a real logged-out Grok does.
    if (message.method === 'initialize') {
      if (log) appendFileSync(log, JSON.stringify({ id: 'initialize', params: message.params }) + '\n');
      const authMethods = process.env.FAKE_GROK_LOGGED_OUT === '1' ? [{ id: 'grok.com', name: 'Grok' }] : [{ id: 'cached_token', name: 'Cached token' }];
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods } }); return;
    }
    if (message.method === 'authenticate') {
      if (process.env.FAKE_GROK_AUTH_FAIL === '1') { send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'no cached token' } }); return; }
      send({ jsonrpc: '2.0', id: message.id, result: {} }); return;
    }
    // FAKE_GROK_MODELS=a,b: the models this account may use, reported as the `model` config option (first is current).
    if (message.method === 'session/new') {
      if (log) appendFileSync(log, JSON.stringify({ id: 'session/new', params: message.params }) + '\n');
      const models = (process.env.FAKE_GROK_MODELS ?? '').split(',').filter(Boolean);
      const configOptions = models.length ? [{ id: 'model', currentValue: models[0], options: models.map((value) => ({ value, name: value })) }] : undefined;
      if (process.env.FAKE_GROK_MCP_LIST === '1' && log) {
        const serverId = message.params?._meta?.['x.ai/mcp/servers']?.[0]?.serverId;
        const answer = await new Promise<Record<string, any>>((resolve) => {
          waiters.set(JSON.stringify('mcp-list'), resolve);
          send({ jsonrpc: '2.0', id: 'mcp-list', method: '_x.ai/mcp/sdk_call', params: { serverId, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } });
        });
        appendFileSync(log, JSON.stringify({ ...(answer.result ?? answer), id: 'mcp-tools-list' }) + '\n');
      }
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session', ...(configOptions ? { configOptions } : {}) } }); return;
    }
    if (message.method === 'session/set_config_option') { if (log) appendFileSync(log, JSON.stringify({ id: 'set_config_option', params: message.params }) + '\n'); send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }
    if (message.method === 'session/set_mode') { if (log) appendFileSync(log, JSON.stringify({ id: 'set_mode', params: message.params }) + '\n'); send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }
    if (message.method === 'session/load') {
      if (log) appendFileSync(log, JSON.stringify({ id: 'session/load', params: message.params }) + '\n');
      if (process.env.FAKE_GROK_LOAD_ERROR === '1') { send({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'session not found' } }); return; }
      send({ jsonrpc: '2.0', id: message.id, result: {} }); return;
    }
    if (message.method === 'session/prompt') {
      if (log) appendFileSync(log, JSON.stringify({ id: 'session/prompt', params: { text: message.params?.prompt?.[0]?.text } }) + '\n');
      if (process.env.FAKE_GROK_HOLD_PROMPT === '1') { heldPrompts.push(message); return; }
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (message.method === 'session/cancel') {
      if (log) appendFileSync(log, JSON.stringify({ id: 'session/cancel', params: message.params }) + '\n');
      if (process.env.FAKE_GROK_IGNORE_CANCEL === '1') return;
      for (const held of heldPrompts.splice(0)) send({ jsonrpc: '2.0', id: held.id, result: { stopReason: 'cancelled' } });
      return;
    }
    if ('id' in message && message.id != null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `fake grok does not implement ${String(message.method)}` } });
  });
  if (process.env.FAKE_GROK_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => process.exit(143));
  if (process.env.FAKE_GROK_IGNORE_EOF !== '1') lines.on('close', () => process.exit(0));
  else setInterval(() => {}, 60_000);
} else {
  console.error(`fake grok: unsupported arguments ${args.join(' ')}`);
  process.exit(2);
}
