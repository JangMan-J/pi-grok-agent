#!/usr/bin/env node
// A stand-in for the Grok Build binary, for transport tests that must not spend Grok usage.
// Select it with PI_GROK_BINARY. Two modes, supporting legacy leader and direct stdio tests:
//   ... agent leader --leader-socket <path>   hold the leader socket and write <path minus .sock>.lock with this pid
//   ... agent --leader stdio ...              JSON-RPC over stdio: answers initialize and session/new, emits any
//                                             message sent as a `test/emit` notification, and appends every
//                                             response it receives to FAKE_GROK_LOG (one JSON line each).
//                                             FAKE_GROK_MCP_LIST=1: lists the session's first MCP server before it
//                                             answers session/new, as Grok does, and logs the answer as `mcp-tools-list`
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const socketPath = args[args.indexOf('--leader-socket') + 1] ?? '';

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
  if (log) appendFileSync(log, JSON.stringify({ id: 'spawn', argv: args, autoupdate: process.env.GROK_DISABLE_AUTOUPDATER }) + '\n');
  const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    let message: Record<string, any>;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'test/emit') { send(message.params); return; }
    // Signed in, Grok offers cached_token. FAKE_GROK_LOGGED_OUT=1 offers only the interactive method, as a real logged-out Grok does.
    if (message.method === 'initialize') {
      if (log) appendFileSync(log, JSON.stringify({ id: 'initialize', params: message.params }) + '\n');
      const authMethods = process.env.FAKE_GROK_LOGGED_OUT === '1' ? [{ id: 'grok.com', name: 'Grok' }] : [{ id: 'cached_token', name: 'Cached token' }];
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods } }); return;
    }
    if (message.method === 'authenticate') { send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }
    // FAKE_GROK_MODELS=a,b: the models this account may use, reported as the `model` config option (first is current).
    if (message.method === 'session/new') {
      if (log) appendFileSync(log, JSON.stringify({ id: 'session/new', params: message.params }) + '\n');
      const models = (process.env.FAKE_GROK_MODELS ?? '').split(',').filter(Boolean);
      const configOptions = models.length ? [{ id: 'model', currentValue: models[0], options: models.map((value) => ({ value, name: value })) }] : undefined;
      const mcpUrl = message.params?.mcpServers?.[0]?.url;
      if (process.env.FAKE_GROK_MCP_LIST === '1' && mcpUrl && log) {
        const answer = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((r) => r.json());
        appendFileSync(log, JSON.stringify({ ...answer, id: 'mcp-tools-list' }) + '\n');
      }
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session', ...(configOptions ? { configOptions } : {}) } }); return;
    }
    if (message.method === 'session/set_config_option') { if (log) appendFileSync(log, JSON.stringify({ id: 'set_config_option', params: message.params }) + '\n'); send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }
    if (message.method === 'session/load') { if (log) appendFileSync(log, JSON.stringify({ id: 'session/load', params: message.params }) + '\n'); send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }
    if ('id' in message && ('result' in message || 'error' in message)) { if (log) appendFileSync(log, line + '\n'); return; }
    if ('id' in message && message.id != null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `fake grok does not implement ${String(message.method)}` } });
  });
  lines.on('close', () => process.exit(0));
} else {
  console.error(`fake grok: unsupported arguments ${args.join(' ')}`);
  process.exit(2);
}
