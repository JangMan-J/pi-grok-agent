// The gateway through the interface its callers use: the real scripts/server.ts process, a fake Grok binary
// (test/fixtures/fake-grok.ts) behind PI_GROK_BINARY, and Pi's own WebSocket wire. No Grok usage is spent.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { GrokModelConnection } from '../src/model/connection.ts';
import { GrokModelSession } from '../src/model/session.ts';

const ROOT = join(import.meta.dirname, '..');
const SERVER = join(ROOT, 'scripts', 'server.ts');
const FAKE_GROK = join(ROOT, 'test', 'fixtures', 'fake-grok.ts');
chmodSync(FAKE_GROK, 0o755); // git keeps the bit, but a checkout with core.fileMode=false may not
const SECRET = 'test-secret';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); s.on('error', reject); });
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A scratch HOME and agent dir so the gateway touches nothing of the user's. Short path: Unix sockets cap at ~100 chars. */
function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'pgw-'));
  const socket = join(home, 'leader.sock');
  return { home, socket, lock: join(home, 'leader.lock'), log: join(home, 'received.jsonl'), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
function gatewayEnv(s: ReturnType<typeof scratch>, port: number, extra: Record<string, string> = {}) {
  return { ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: join(s.home, 'agent'), GROK_AGENT_SECRET: SECRET, PI_GROK_LEADER_SOCKET: s.socket, PI_GROK_BINARY: FAKE_GROK, GROK_ACP_URL: `ws://127.0.0.1:${port}/ws`, FAKE_GROK_LOG: s.log, ...extra };
}
function startGateway(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, stdout: () => stdout, stderr: () => stderr, ready: () => until(() => /ready at/.test(stdout), 'gateway ready line') };
}
/** A leader that belongs to someone else: started by the test, not by the gateway under test. */
function foreignLeader(s: ReturnType<typeof scratch>): Promise<ChildProcess> {
  const child = spawn(FAKE_GROK, ['agent', 'leader', '--leader-socket', s.socket], { stdio: 'ignore' });
  return until(() => existsSync(s.lock), 'foreign leader lock').then(() => child);
}
const stop = async (child: ChildProcess) => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGINT'); await new Promise((r) => child.once('exit', r)); } };
const received = (s: ReturnType<typeof scratch>, id: string) => (existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id === id) : []);

test('a launch that loses its port leaves another gateway\'s leader running', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const leader = await foreignLeader(s); t.after(() => leader.kill('SIGTERM'));
  const port = await freePort();
  const occupant = createServer(); await new Promise<void>((r) => occupant.listen(port, '127.0.0.1', r)); t.after(() => occupant.close());
  const gw = startGateway(gatewayEnv(s, port));
  const code = await gw.exited;
  assert.notEqual(code, 0, 'the launch fails');
  assert.match(gw.stderr(), /EADDRINUSE/);
  await sleep(300);
  assert.ok(alive(leader.pid!) && leader.exitCode === null, `the foreign leader survived (stderr: ${gw.stderr().trim()})`);
});

test('a successful launch owns its leader: spawned or adopted, Ctrl+C stops it', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const gw = startGateway(gatewayEnv(s, await freePort())); t.after(() => stop(gw.child));
  await gw.ready();
  const spawned = Number(readFileSync(s.lock, 'utf8').trim());
  assert.ok(alive(spawned), 'a leader was spawned before the ready line');
  gw.child.kill('SIGINT');
  assert.equal(await gw.exited, 0);
  await until(() => !alive(spawned), 'spawned leader to stop');

  const orphan = await foreignLeader(s); t.after(() => orphan.kill('SIGTERM'));
  const gw2 = startGateway(gatewayEnv(s, await freePort())); t.after(() => stop(gw2.child));
  await gw2.ready();
  assert.match(gw2.stderr(), /Adopted leader/);
  gw2.child.kill('SIGINT');
  assert.equal(await gw2.exited, 0);
  await until(() => orphan.exitCode !== null, 'adopted leader to stop');
});

test('reverse-request guard: one answer per request, deadlines by tier, fail closed on disconnect', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const port = await freePort();
  const gw = startGateway(gatewayEnv(s, port, { PI_GROK_ACK_MS: '250', PI_GROK_POLICY_MS: '500', PI_GROK_DIALOG_MS: '1500', PI_GROK_CHECK_BUDGET_MS: '1500' }));
  t.after(() => stop(gw.child));
  await gw.ready();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${SECRET}` } });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  // As in the real flow, Pi sees the request before it can ack it: emit resolves once the request has arrived on Pi's socket.
  const arrived = new Set<string>();
  ws.on('message', (data) => { try { const m = JSON.parse(data.toString()); if (typeof m.id === 'string' && m.method) arrived.add(m.id); } catch { /* not JSON */ } });
  const emit = async (id: string, params: unknown, method = '_x.ai/hooks/run') => { send({ jsonrpc: '2.0', method: 'test/emit', params: { jsonrpc: '2.0', id, method, params } }); await until(() => arrived.has(id), `request ${id} at Pi`); };
  const hook = (toolUseId: string) => ({ hookCallbackId: 'pi-pre', hookEventName: 'pre_tool_use', sessionId: 'fake-session', cwd: s.home, toolName: 'write', toolUseId, toolInput: {} });

  // No ack: denied at the ack tier. A late answer from Pi is dropped, not forwarded as a second response.
  await emit('r1', hook('t1'));
  await until(() => received(s, 'r1').length === 1, 'ack-tier deny');
  assert.equal(received(s, 'r1')[0].result.decision, 'deny');
  assert.match(received(s, 'r1')[0].result.reason, /did not acknowledge/);
  send({ jsonrpc: '2.0', id: 'r1', result: { decision: 'continue' } });
  await sleep(300);
  assert.equal(received(s, 'r1').length, 1, 'exactly one answer reached Grok');

  // Acked as a dialog: the policy deadline does not apply; the human's late answer is the one Grok gets.
  await emit('r2', hook('t2'));
  send({ jsonrpc: '2.0', method: 'pi/gate-ack', params: { key: 'pre_tool_use:t2', dialog: true } });
  await sleep(800);
  assert.equal(received(s, 'r2').length, 0, 'no gateway answer inside the dialog window');
  send({ jsonrpc: '2.0', id: 'r2', result: { decision: 'continue' } });
  await until(() => received(s, 'r2').length === 1, 'dialog answer');
  assert.deepEqual(received(s, 'r2')[0].result, { decision: 'continue' });

  // Acked without flags: a policy answer is expected promptly.
  await emit('r3', hook('t3'));
  send({ jsonrpc: '2.0', method: 'pi/gate-ack', params: { key: 'pre_tool_use:t3' } });
  await until(() => received(s, 'r3').length === 1, 'policy-tier deny');
  assert.match(received(s, 'r3')[0].result.reason, /policy did not answer/);

  // Pi vanishes with a permission prompt open: reject_once, before the bridge is stopped.
  await emit('r4', { sessionId: 'fake-session', toolCall: { toolCallId: 'c4', title: 'write' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] }, 'session/request_permission');
  send({ jsonrpc: '2.0', method: 'pi/gate-ack', params: { key: 'perm:c4', dialog: true } });
  await sleep(100);
  ws.close();
  await until(() => received(s, 'r4').length === 1, 'disconnect reject');
  assert.deepEqual(received(s, 'r4')[0].result, { outcome: { outcome: 'selected', optionId: 'no' } });
});

test('ask mode: a slow human confirm is waited for as a dialog, not denied at the policy deadline', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const port = await freePort();
  const gw = startGateway(gatewayEnv(s, port, { PI_GROK_ACK_MS: '250', PI_GROK_POLICY_MS: '500', PI_GROK_DIALOG_MS: '3000' }));
  t.after(() => stop(gw.child));
  await gw.ready();
  const connection = new GrokModelConnection({ url: `ws://127.0.0.1:${port}/ws`, secret: SECRET });
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

test('a Grok turn that outlives its Pi session (/new, shutdown) is denied tool use, not waved through', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const port = await freePort();
  const gw = startGateway(gatewayEnv(s, port));
  t.after(() => stop(gw.child));
  await gw.ready();
  const connection = new GrokModelConnection({ url: `ws://127.0.0.1:${port}/ws`, secret: SECRET });
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

test('a missing secret file fails the first connect with a clear message and is picked up once the gateway wrote it', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const port = await freePort();
  const secretFile = join(s.home, 'late.secret');
  const connection = new GrokModelConnection({ url: `ws://127.0.0.1:${port}/ws`, secret: '', secretFile });
  t.after(() => connection.close());
  await assert.rejects(connection.open(), /secret not found at .*late\.secret.*pi-grok-gateway/, 'no gateway yet: a message that names the file and the command');
  const gw = startGateway(gatewayEnv(s, port));
  t.after(() => stop(gw.child));
  await gw.ready();
  writeFileSync(secretFile, SECRET + '\n');
  await connection.open();
  assert.ok(connection.isOpen, 'the second open read the file and connected');
});

test('auto-start: an open with nothing listening starts the bundled gateway detached; the next connection reuses it', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}/ws`;
  const agent = join(s.home, 'agent');
  const secretFile = join(agent, 'grok-ws.secret');
  // launchGateway passes Pi's environment on, as it would inside Pi. Isolate it; no secret in the env, so the gateway writes the file.
  const saved = { ...process.env };
  Object.assign(process.env, gatewayEnv(s, port));
  delete process.env.GROK_AGENT_SECRET;
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  const first = new GrokModelConnection({ url, secret: '', secretFile, autoStart: { logDir: agent } });
  t.after(() => first.close());
  await first.open();
  const gatewayPid = first.launchedGateway;
  assert.ok(first.isOpen && gatewayPid, 'first open started a gateway and connected');
  t.after(async () => { if (alive(gatewayPid)) { process.kill(gatewayPid, 'SIGINT'); await until(() => !alive(gatewayPid), 'auto-started gateway exit'); } });
  assert.ok(existsSync(secretFile), 'the gateway created the secret file the connection then read');
  assert.match(readFileSync(join(agent, 'grok-ws.log'), 'utf8'), /ready at/);
  const second = new GrokModelConnection({ url, secret: '', secretFile, autoStart: { logDir: agent } });
  t.after(() => second.close());
  await second.open();
  assert.ok(second.isOpen);
  assert.equal(second.launchedGateway, undefined, 'a running gateway is reused, not started again');
  first.close(); second.close();
  assert.ok(alive(gatewayPid), 'detached: the gateway outlives the connection that started it');
  const leaderPid = Number(readFileSync(s.lock, 'utf8').trim());
  process.kill(gatewayPid, 'SIGINT');
  await until(() => !alive(gatewayPid) && !alive(leaderPid), 'gateway and its leader stop together');
});

test('a signed-out Grok fails the turn with a pointer to /grok login, and the next open checks again', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const port = await freePort();
  const gw = startGateway(gatewayEnv(s, port, { FAKE_GROK_LOGGED_OUT: '1' }));
  t.after(() => stop(gw.child));
  await gw.ready();
  const connection = new GrokModelConnection({ url: `ws://127.0.0.1:${port}/ws`, secret: SECRET });
  t.after(() => connection.close());
  await assert.rejects(connection.open(), /not signed in\. Run \/grok login/);
  assert.equal(connection.isOpen, false, 'the connection is dropped, so the turn after a login initializes again');
  await assert.rejects(connection.open(), /not signed in/, 'a second open asks Grok again instead of reusing a stale answer');
});
