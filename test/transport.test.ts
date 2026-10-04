// Real stdio children, fake Grok only. No login or model usage.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GrokModelConnection, type SessionHandlers } from '../src/model/connection.ts';
import { GrokModelSession } from '../src/model/session.ts';

const FAKE_GROK = join(import.meta.dirname, 'fixtures', 'fake-grok.ts');
const FAKE_LEASH = join(import.meta.dirname, 'fixtures', 'fake-leash.ts');
chmodSync(FAKE_GROK, 0o755);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}
function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'pstdio-'));
  return { home, log: join(home, 'received.jsonl'), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
function connect(s: ReturnType<typeof scratch>, env: NodeJS.ProcessEnv = {}) {
  return new GrokModelConnection({ leashPath: FAKE_LEASH, binary: FAKE_GROK, env: { FAKE_GROK_LOG: s.log, ...env }, logPath: join(s.home, 'grok-stdio.log'), stopGraceMs: 40 });
}
const received = (s: ReturnType<typeof scratch>, id: string) => (existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id === id) : []);
const handlers: SessionHandlers = { onUpdate() {}, async onMcp() { return {}; } };
const input = { cwd: '/repo', serverId: 'server', serverName: 'pi', offerPiTools: false, handlers };

test('ask mode: a slow human confirm is forwarded once without a timer deny', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, {});
  t.after(() => connection.close());
  connection.hasUI = true;
  const session = new GrokModelSession(connection, 'pi-ask', s.home);
  session.piToolNames = ['read', 'edit', 'write', 'bash'];
  session.permissionMode = 'ask';
  session.askDialog = async () => { await sleep(900); return true; };
  await session.attach(undefined);
  assert.equal(session.grokSessionId, 'fake-session');
  await connection.agent.notify('test/emit', { jsonrpc: '2.0', id: 'r9', method: '_x.ai/hooks/run', params: { hookCallbackId: 'pi-pre', hookEventName: 'pre_tool_use', sessionId: 'fake-session', cwd: s.home, toolName: 'hashline_edit', toolUseId: 't9', toolInput: { path: 'a.ts' } } });
  await until(() => received(s, 'r9').length >= 1, 'an answer for the gated edit', 4000);
  await sleep(400);
  assert.deepEqual(received(s, 'r9').map((m) => m.result), [{ decision: 'continue' }], 'the human\'s answer, once');
  assert.deepEqual(session.hookLog.map((h) => h.decision), ['continue']);
});

test('simulated Grok lists lent Pi tools while session/new is still pending', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_MCP_LIST: '1' });
  t.after(() => connection.close());
  const session = new GrokModelSession(connection, 'pi-mcp', s.home);
  session.tools = [{ name: 'intercom', description: 'Message another session', parameters: { type: 'object', properties: {} } as any }];
  await session.attach(undefined);
  assert.deepEqual(received(s, 'initialize')[0].params._meta, { 'x.ai/mcp/sdk': true });
  const params = received(s, 'session/new')[0].params;
  assert.deepEqual(params.mcpServers, []);
  assert.equal(params._meta['x.ai/mcp/servers'][0].name, 'pi');
  await connection.attachSession({ ...input, sessionId: 'fake-session', offerPiTools: true });
  const loaded = received(s, 'session/load')[0].params;
  assert.deepEqual(loaded.mcpServers, []);
  assert.equal(loaded._meta['x.ai/mcp/servers'][0].serverId, 'server');
  const [listed] = received(s, 'mcp-tools-list');
  assert.equal(listed.error, undefined, `the handshake is answered (${JSON.stringify(listed.error)})`);
  assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ['intercom']);
});

test('a Grok turn that outlives its Pi session (/new, shutdown) is denied tool use, not waved through', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, {});
  t.after(() => connection.close());
  const session = new GrokModelSession(connection, 'pi-orphan', s.home);
  session.piToolNames = ['read', 'edit', 'write', 'bash'];
  await session.attach(undefined);
  assert.equal(session.grokSessionId, 'fake-session');
  session.detach();
  const emit = (id: string, hookEventName: string, extra: Record<string, unknown> = {}) =>
    connection.agent.notify('test/emit', { jsonrpc: '2.0', id, method: '_x.ai/hooks/run', params: { hookCallbackId: `pi-${hookEventName}`, hookEventName, sessionId: 'fake-session', cwd: s.home, ...extra } });
  await emit('o1', 'pre_tool_use', { toolName: 'hashline_read', toolUseId: 'o1', toolInput: { path: 'a.ts' } });
  await emit('o2', 'post_tool_use', { toolName: 'hashline_read', toolUseId: 'o2', toolInput: {}, toolResponse: {} });
  await emit('o3', 'stop', { reason: 'end_turn' });
  await until(() => received(s, 'o1').length >= 1 && received(s, 'o2').length >= 1 && received(s, 'o3').length >= 1, 'answers for the orphaned hooks', 4000);
  assert.equal(received(s, 'o1')[0].result.decision, 'deny', 'even a read is denied: Pi\'s gate no longer applies');
  assert.match(received(s, 'o1')[0].result.reason, /detached/);
  assert.equal(received(s, 'o2')[0].result.decision, 'continue', 'post_tool_use has nothing to deny');
  assert.equal(received(s, 'o3')[0].result.decision, 'continue', 'stop is not held open for an orphan');
  assert.equal(session.hookLog.length, 0, 'the detached Pi session saw none of it');
});

test('a signed-out Grok fails the turn with a pointer to /grok login, and the next open checks again', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_LOGGED_OUT: '1' });
  t.after(() => connection.close());
  await assert.rejects(connection.open(), /not signed in\. Run \/grok login/);
  assert.equal(connection.isOpen, false, 'the connection is dropped, so the turn after a login initializes again');
  await assert.rejects(connection.open(), /not signed in/, 'a second open asks Grok again instead of reusing a stale answer');
});

test('the model picked in Pi is applied to the Grok session; one the account lacks fails with the available list', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_MODELS: 'grok-4.7,grok-4.6' });
  t.after(() => connection.close());
  const session = new GrokModelSession(connection, 'pi-model', s.home);
  await session.attach(undefined);
  assert.equal(session.grokModel, 'grok-4.7');
  assert.deepEqual(session.grokModels, ['grok-4.7', 'grok-4.6']);
  await session.applyModel('grok-4.7');
  assert.equal(received(s, 'set_config_option').length, 0, 'already current: nothing sent');
  await session.applyModel('grok-4.6');
  await until(() => received(s, 'set_config_option').length === 1, 'set_config_option at Grok');
  assert.deepEqual(received(s, 'set_config_option')[0].params, { sessionId: 'fake-session', configId: 'model', value: 'grok-4.6' });
  await assert.rejects(session.applyModel('grok-4.5'), /grok-4\.5 is not available on this Grok account\. Available: grok-4\.7, grok-4\.6/);
});

test('failed session attach removes only its own early routing registrations', async (t) => {
  const connection = new GrokModelConnection();
  t.after(() => connection.close());
  const handlers = {} as import('../src/model/connection.ts').SessionHandlers;
  const replacement = {} as import('../src/model/connection.ts').SessionHandlers;
  const routes = connection as any;
  let replace = false;
  t.mock.getter(GrokModelConnection.prototype, 'agent', () => ({
    request: async () => {
      assert.equal(routes.servers.get('server'), handlers, 'registered before request');
      if (replace) { routes.servers.set('server', replacement); routes.sessions.set('loaded', replacement); }
      throw new Error('attach failed');
    },
  }) as never);
  const input = { cwd: '/repo', serverId: 'server', serverName: 'pi', offerPiTools: true, handlers };
  await assert.rejects(connection.attachSession(input), /attach failed/);
  assert.equal(routes.servers.size, 0);
  await assert.rejects(connection.attachSession({ ...input, sessionId: 'loaded' }), /attach failed/);
  assert.equal(routes.servers.size, 0);
  assert.equal(routes.sessions.size, 0);
  replace = true;
  await assert.rejects(connection.attachSession({ ...input, sessionId: 'loaded' }), /attach failed/);
  assert.equal(routes.servers.get('server'), replacement, 'do not remove a newer registration');
  assert.equal(routes.sessions.get('loaded'), replacement);
});

test('one leashed agent child serves multiple sessions and drop starts a new child', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { GROK_DISABLE_AUTOUPDATER: '0' }); t.after(() => connection.close());
  await Promise.all([connection.open(), connection.open()]);
  await connection.attachSession(input);
  await connection.attachSession({ ...input, serverId: 'second' });
  assert.deepEqual(received(s, 'spawn').map((m) => m.argv), [['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']]);
  assert.deepEqual(received(s, 'spawn').map((m) => m.autoupdate), ['1']);
  const generation = connection.generation;
  connection.drop();
  assert.equal(connection.isOpen, false);
  await connection.open();
  await connection.attachSession({ ...input, sessionId: 'fake-session' });
  assert.equal(connection.generation, generation + 1);
  assert.deepEqual(received(s, 'spawn').map((m) => m.autoupdate), ['1', '1']);
});

test('close kills the leashed child without TS synthetic answers; late handlers cannot reach Grok', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s); t.after(() => connection.close());
  let hookArrived = false; let permissionArrived = false;
  let resolveHook!: (value: Record<string, unknown>) => void;
  let resolvePermission!: (value: any) => void;
  await connection.open();
  await connection.attachSession({ ...input, handlers: {
    ...handlers,
    onHookRun: () => { hookArrived = true; return new Promise((r) => { resolveHook = r; }); },
    onPermission: () => { permissionArrived = true; return new Promise((r) => { resolvePermission = r; }); },
  } });
  await connection.agent.notify('test/emit', { jsonrpc: '2.0', id: 'pending-hook', method: '_x.ai/hooks/run', params: { sessionId: 'fake-session', hookEventName: 'pre_tool_use' } });
  await connection.agent.notify('test/emit', { jsonrpc: '2.0', id: 'pending-perm', method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'tool', title: 'write' }, options: [{ optionId: 'always-no', kind: 'reject_always', name: 'Never' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] } });
  await until(() => hookArrived && permissionArrived, 'handlers');
  await sleep(450);
  assert.equal(received(s, 'pending-hook').length, 0);
  assert.equal(received(s, 'pending-perm').length, 0);
  await connection.close();
  assert.equal(received(s, 'pending-hook').length, 0);
  assert.equal(received(s, 'pending-perm').length, 0);
  resolveHook({ decision: 'continue' });
  resolvePermission({ outcome: { outcome: 'selected', optionId: 'yes' } });
  await sleep(100);
  assert.equal(received(s, 'pending-hook').length, 0);
  assert.equal(received(s, 'pending-perm').length, 0);
});

test('missing binary and pre-initialize exit report the binary; abort ends the child', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const missing = new GrokModelConnection({ leashPath: FAKE_LEASH, binary: join(s.home, 'missing-grok'), logPath: join(s.home, 'missing.log') }); t.after(() => missing.close());
  await assert.rejects(missing.open(), /missing-grok/);
  assert.equal(missing.isOpen, false);
  const exitsBinary = join(s.home, 'exits-grok');
  writeFileSync(exitsBinary, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  const exits = new GrokModelConnection({ leashPath: FAKE_LEASH, binary: exitsBinary, logPath: join(s.home, 'exits.log'), stopGraceMs: 40 }); t.after(() => exits.close());
  await assert.rejects(exits.open(), /exits-grok/);
  const connection = connect(s, { FAKE_GROK_DELAY_MS: '400' }); t.after(() => connection.close());
  const abort = new AbortController();
  const opening = connection.open(abort.signal);
  await sleep(30);
  abort.abort();
  await assert.rejects(opening, /cancelled/);
  assert.equal(connection.isOpen, false);
  assert.match(connection.lastDrop ?? '', /cancelled/);
  // Escape after the child is ready cancels the turn. It does not drop the child from this signal.
  const stayed = connect(s); t.after(() => stayed.close());
  const later = new AbortController();
  await stayed.open(later.signal);
  later.abort();
  assert.equal(stayed.isOpen, true);
});

test('sdk_call routes one MCP message through the session handler', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = new GrokModelConnection({ leashPath: FAKE_LEASH, binary: FAKE_GROK, env: { FAKE_GROK_LOG: s.log }, logPath: join(s.home, 'grok-stdio.log'), stopGraceMs: 40 });
  t.after(() => connection.close());
  const calls: string[] = [];
  await connection.open();
  await connection.attachSession({ ...input, offerPiTools: true, toolTimeoutMs: 1234, handlers: {
    ...handlers,
    async onMcp(message) { calls.push(message.method); if (message.method === 'fail') throw new Error('failed tool'); return { tools: [{ name: 'lent' }] }; },
  } });
  assert.deepEqual(received(s, 'initialize')[0].params._meta, { 'x.ai/mcp/sdk': true });
  const params = received(s, 'session/new')[0].params;
  assert.deepEqual(params.mcpServers, []);
  assert.deepEqual(params._meta['x.ai/mcp/servers'], [{ name: 'pi', serverId: 'server' }]);
  assert.deepEqual(params._meta.mcpConfig, { pi: { toolTimeoutMs: 1234 } });
  await connection.attachSession({ ...input, sessionId: 'fake-session', serverId: 'loaded-server', offerPiTools: true });
  const loaded = received(s, 'session/load')[0].params;
  assert.deepEqual(loaded.mcpServers, []);
  assert.deepEqual(loaded._meta['x.ai/mcp/servers'], [{ name: 'pi', serverId: 'loaded-server' }]);
  for (const [id, serverId, method] of [['sdk-list', 'server', 'tools/list'], ['sdk-error', 'server', 'fail'], ['sdk-missing', 'missing', 'tools/list']]) {
    await connection.agent.notify('test/emit', { jsonrpc: '2.0', id, method: '_x.ai/mcp/sdk_call', params: { serverId, message: { jsonrpc: '2.0', id: 1, method } } });
    await until(() => received(s, id).length === 1, id);
  }
  assert.deepEqual(calls, ['tools/list', 'fail']);
  assert.deepEqual(received(s, 'sdk-list')[0].result, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'lent' }] } });
  assert.equal(received(s, 'sdk-error')[0].result.error.code, -32603);
  assert.equal(received(s, 'sdk-missing')[0].result.error.code, -32603);
});
