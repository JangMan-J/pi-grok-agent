// Failure modes of the stdio child. Fake Grok only; no login and no model usage.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { normalizeContext, type Api, type Model } from '@earendil-works/pi-ai';
import { GrokModelConnection } from '../src/model/connection.ts';
import { GrokModelSession } from '../src/model/session.ts';
import { createGrokStream, GROK_API } from '../src/model/provider.ts';
import { storedSessionAction } from '../src/model/child-report.ts';
import { appendStdioLog, enqueueWrite } from '../src/model/stdio-log.ts';

const FAKE_GROK = join(import.meta.dirname, 'fixtures', 'fake-grok.ts');
const FAKE_LEASH = join(import.meta.dirname, 'fixtures', 'fake-leash.ts');
chmodSync(FAKE_GROK, 0o755);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, timeoutMs = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}
function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'phard-'));
  return { home, log: join(home, 'received.jsonl'), stdioLog: join(home, 'grok-stdio.log'), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
function connect(s: ReturnType<typeof scratch>, env: NodeJS.ProcessEnv = {}, extra: ConstructorParameters<typeof GrokModelConnection>[0] = {}) {
  return new GrokModelConnection({ leashPath: FAKE_LEASH, binary: FAKE_GROK, env: { FAKE_GROK_LOG: s.log, ...env }, logPath: s.stdioLog, stopGraceMs: 40, ...extra });
}
const received = (s: ReturnType<typeof scratch>, id: string) => (existsSync(s.log) ? readFileSync(s.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((message) => message.id === id) : []);
function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const model = { id: 'grok-4.7', name: 'Grok', api: GROK_API, provider: 'grok', baseUrl: 'stdio://grok', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as Model<Api>;
async function collect(stream: AsyncIterable<any>) { const events: any[] = []; for await (const event of stream) events.push(event); return events; }
const user = (text: string) => normalizeContext({ messages: [{ role: 'user', content: text, timestamp: 1 }] });

test('item 1: a child that exits mid-turn ends the Pi turn with the cause, and parked lent calls reject', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_DIE_ON: 'session/prompt', FAKE_GROK_DIE_STDERR: 'oom: fake grok died' });
  t.after(() => connection.close());
  const session = new GrokModelSession(connection, 'pi-die', s.home);
  const stream = createGrokStream(connection, { current: () => session });
  const events = await collect(stream(model, user('hello'), {}));
  const error = events.at(-1);
  assert.equal(error.type, 'error');
  assert.match(error.error.errorMessage, /exit code 137/);
  assert.match(error.error.errorMessage, /oom: fake grok died/);
  assert.match(error.error.errorMessage, /Send the message again/);

  const parked = connect(s, {});
  t.after(() => parked.close());
  const parkedSession = new GrokModelSession(parked, 'pi-park', s.home);
  parkedSession.tools = [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } as any }];
  await parkedSession.attach(undefined);
  await parked.agent.notify('test/emit', { jsonrpc: '2.0', id: 'park', method: '_x.ai/mcp/sdk_call', params: { serverId: parkedSession.serverId, message: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read', arguments: { path: 'a' } } } } });
  await until(() => parkedSession.pendingToolCallIds.length === 1, 'a parked lent call');
  const pid = parked.pid!;
  process.kill(pid, 'SIGKILL');
  await until(() => parkedSession.pendingToolCallIds.length === 0 && !alive(pid), 'parked call rejected and child gone');
  assert.match(parked.lastDrop ?? '', /signal SIGKILL/);
});

test('item 2: a child that exits between turns is respawned once, including two overlapping opens', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_DIE_ON: 'test/die', FAKE_GROK_DIE_STDERR: 'died between turns' });
  t.after(() => connection.close());
  const session = new GrokModelSession(connection, 'pi-between', s.home);
  await session.attach(undefined);
  const first = connection.pid;
  await connection.agent.notify('test/die', {});
  await until(() => !connection.isOpen && !alive(first), 'child exited between turns');
  await session.attach(undefined);
  assert.notEqual(connection.pid, first);
  assert.equal(received(s, 'session/load').length, 1);
  assert.match(session.reconnected ?? '', /died between turns|exit code 137/);
  assert.equal(received(s, 'spawn').length, 2);

  const slow = scratch(); t.after(slow.cleanup);
  const racing = connect(slow, { FAKE_GROK_DELAY_MS: '250' });
  t.after(() => racing.close());
  await Promise.all([racing.open(), racing.open()]);
  assert.equal(received(slow, 'spawn').length, 1, 'one opening promise, one child');
});

test('item 3: a missing, non-executable, or pre-1.0.46 binary fails the turn with what to install', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const missing = new GrokModelConnection({ leashPath: FAKE_LEASH, binary: join(s.home, 'no-such-grok'), logPath: s.stdioLog, deadlines: { initialize: 1000 } });
  t.after(() => missing.close());
  await assert.rejects(missing.open(), /Cannot start pi-grok-leash[\s\S]*ENOENT/);

  const locked = join(s.home, 'locked-grok');
  writeFileSync(locked, '#!/usr/bin/env node\n', { mode: 0o644 });
  const denied = new GrokModelConnection({ leashPath: FAKE_LEASH, binary: locked, logPath: join(s.home, 'denied.log') });
  t.after(() => denied.close());
  await assert.rejects(denied.open(), /Cannot start pi-grok-leash[\s\S]*EACCES/);

  const old = connect(s, { FAKE_GROK_USAGE_EXIT: '1' });
  t.after(() => old.close());
  await assert.rejects(old.open(), /agent --no-leader stdio[\s\S]*1\.0\.46[\s\S]*unknown flag --no-leader/);
});

test('item 4: a signed-out child, including a failed authenticate, points at /grok login', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const loggedOut = connect(s, { FAKE_GROK_LOGGED_OUT: '1' });
  t.after(() => loggedOut.close());
  await assert.rejects(loggedOut.open(), /not signed in\. Run \/grok login/);
  const auth = connect(s, { FAKE_GROK_AUTH_FAIL: '1' });
  t.after(() => auth.close());
  await assert.rejects(auth.open(), /not signed in\. Run \/grok login/);
  assert.equal(auth.isOpen, false);
});

test('item 5: explicit unguarded shutdown escalates EOF, SIGTERM, SIGKILL; parent death has only EOF protection', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const stubborn = connect(s, { FAKE_GROK_IGNORE_EOF: '1', FAKE_GROK_IGNORE_TERM: '1' }, { leashPath: 'none' });
  const pid = await (async () => { await stubborn.open(); return stubborn.pid!; })();
  const closed = stubborn.close();
  await sleep(30);
  assert.equal(alive(pid), true, 'SIGKILL waits out both grace periods');
  await closed;
  await until(() => !alive(pid), 'SIGKILL reaped the child');

  const parentPath = join(s.home, 'parent.mjs');
  writeFileSync(parentPath, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.argv[2], '--permission-mode', 'default', 'agent', '--no-leader', 'stdio'], { stdio: ['pipe', 'ignore', 'ignore'], env: process.env });
process.stdout.write(String(child.pid) + '\\n');
setInterval(() => {}, 1e9);
`);
  const parent = spawn(process.execPath, [parentPath, FAKE_GROK], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { process.kill(parent.pid!, 'SIGKILL'); } catch { /* already gone */ } });
  let childPid = '';
  parent.stdout!.setEncoding('utf8');
  childPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('parent did not report the child pid')), 2000);
    parent.stdout!.once('data', (chunk: string) => { clearTimeout(timer); resolve(chunk.trim()); });
  });
  await sleep(50);
  process.kill(parent.pid!, 'SIGKILL');
  const pidNumber = Number(childPid);
  await until(() => !alive(pidNumber), 'child exited after the parent was SIGKILLed');

  const orphanParent = spawn(process.execPath, [parentPath, FAKE_GROK], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FAKE_GROK_IGNORE_EOF: '1' } });
  orphanParent.stdout!.setEncoding('utf8');
  const orphanPid = Number(await new Promise((resolve) => orphanParent.stdout!.once('data', (chunk: string) => resolve(chunk.trim()))));
  await sleep(50);
  process.kill(orphanParent.pid!, 'SIGKILL');
  await sleep(150);
  assert.equal(alive(orphanPid), true, 'a child that ignores stdin EOF survives SIGKILL of Pi; Node cannot set PDEATHSIG');
  process.kill(orphanPid, 'SIGKILL');
});

test('item 6: non-JSON stdout is skipped and child stderr stays off Pi stdout', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const seen: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { seen.push(String(chunk)); return original(chunk as any, ...(rest as [])); }) as typeof process.stdout.write;
  try {
    const connection = connect(s, { FAKE_GROK_STDOUT_NOISE: 'warning: not json', FAKE_GROK_STDOUT_PARTIAL: '{"truncated":', FAKE_GROK_STDERR: 'child-stderr-line' });
    t.after(() => connection.close());
    await connection.open();
    const log = readFileSync(s.stdioLog, 'utf8');
    assert.match(log, /framing: skipped non-JSON stdout: warning: not json/);
    assert.match(log, /stderr: child-stderr-line/);
    assert.equal(seen.some((chunk) => chunk.includes('child-stderr-line') || chunk.includes('warning: not json')), false);
  } finally { process.stdout.write = original; }
});

test('item 7: a 5 MB sdk_call result is delivered, and a full stdin buffer pauses instead of dropping', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_LOG_BYTES: '1' });
  t.after(() => connection.close());
  await connection.open();
  const session = new GrokModelSession(connection, 'pi-big', s.home);
  let inbound = '';
  await connection.attachSession({ cwd: s.home, serverId: session.serverId, serverName: 'pi', offerPiTools: true, handlers: {
    onUpdate(notification) { const text = (notification.update as { content?: { text?: string } }).content?.text; if (text) inbound += text; },
    async onMcp(message) {
      if (message.method === 'tools/call') return { content: [{ type: 'text', text: 'x'.repeat(5_000_000) }] };
      return { tools: [] };
    },
  } });
  await connection.agent.notify('test/emit', { jsonrpc: '2.0', id: 'big', method: '_x.ai/mcp/sdk_call', params: { serverId: session.serverId, message: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'read', arguments: {} } } } });
  await until(() => received(s, 'bytes').some((message) => message.bytes >= 5_000_000), '5 MB result logged', 8000);
  await connection.agent.notify('test/big', {});
  await until(() => inbound.length >= 5_000_000, '5 MB notification', 8000);

  const chunks: Buffer[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const dest = new Writable({ highWaterMark: 1, write(chunk, _enc, callback) { chunks.push(Buffer.from(chunk)); held.then(() => callback()); } });
  const state = { chain: Promise.resolve() };
  const payload = `y${'z'.repeat(64 * 1024)}`;
  const first = enqueueWrite(dest, payload, state);
  const second = enqueueWrite(dest, 'tail', state);
  await sleep(20);
  assert.equal(Buffer.concat(chunks).toString().includes('tail'), false, 'the second write waits while the buffer is full');
  release();
  await Promise.all([first, second]);
  assert.equal(Buffer.concat(chunks).toString(), `${payload}tail`);
});

test('item 8: a hung child times out, is killed, and the next turn respawns', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_HANG: 'initialize' }, { deadlines: { initialize: 200 } });
  t.after(() => connection.close());
  const started = Date.now();
  await assert.rejects(connection.open(), /did not answer initialize within 0\.2s/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(connection.isOpen, false);
  const again = connection.open();
  await until(() => received(s, 'spawn').length === 2, 'a second child');
  connection.drop('stop');
  await assert.rejects(again);

  const modesHome = scratch(); t.after(modesHome.cleanup);
  const modes = connect(modesHome, { FAKE_GROK_HANG: 'session/set_mode' }, { deadlines: { 'session/set_mode': 150 } });
  t.after(() => modes.close());
  const session = new GrokModelSession(modes, 'pi-hang', modesHome.home);
  await session.attach(undefined);
  await assert.rejects(session.setMode('plan'), /did not answer session\/set_mode within 0\.15s/);
  assert.equal(modes.isOpen, false);
  await session.attach(undefined);
  assert.equal(received(modesHome, 'spawn').length, 2);
  assert.equal(received(modesHome, 'session/load').length, 1);
});

test('item 9: session/cancel ends the turn, and a missing ack kills the child', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const acked = connect(s, { FAKE_GROK_HOLD_PROMPT: '1' }, { cancelAckMs: 200 });
  t.after(() => acked.close());
  const ackedSession = new GrokModelSession(acked, 'pi-ack', s.home);
  await ackedSession.attach(undefined);
  const prompt = ackedSession.startPrompt('stop');
  await until(() => received(s, 'session/prompt').length === 1, 'prompt');
  await ackedSession.cancel();
  await prompt;
  assert.equal(acked.isOpen, true, 'an acknowledged cancel leaves the child running');
  assert.equal(received(s, 'session/cancel').length, 1);

  const hung = connect(s, { FAKE_GROK_HOLD_PROMPT: '1', FAKE_GROK_IGNORE_CANCEL: '1' }, { cancelAckMs: 200 });
  t.after(() => hung.close());
  const hungSession = new GrokModelSession(hung, 'pi-noack', s.home);
  const stream = createGrokStream(hung, { current: () => hungSession });
  const controller = new AbortController();
  const running = stream(model, user('go'), { signal: controller.signal });
  await until(() => received(s, 'session/prompt').length === 2, 'second prompt');
  const pid = hung.pid!;
  controller.abort();
  const events = await collect(running);
  assert.equal(events.at(-1).reason, 'aborted');
  await until(() => !alive(pid), 'cancel ack timeout killed the child');
  assert.match(hung.lastDrop ?? '', /session\/cancel/);
});

test('item 10: a missing stored session starts a new one and says so once', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_LOAD_ERROR: '1' });
  t.after(() => connection.close());
  const session = new GrokModelSession(connection, 'pi-missing', s.home);
  session.grokSessionId = 'gone-id';
  const stream = createGrokStream(connection, { current: () => session });
  const first = await collect(stream(model, user('hi'), {}));
  const thinking = first.flatMap((event) => event.type === 'thinking_delta' ? [event.delta] : []).join('');
  assert.match(thinking, /\[grok session gone-id not found; started a new one\]/);
  assert.equal(session.grokSessionId, 'fake-session');
  assert.equal(received(s, 'session/new').length, 1);
  const second = await collect(stream(model, user('again'), {}));
  const again = second.flatMap((event) => event.type === 'thinking_delta' ? [event.delta] : []).join('');
  assert.equal(again.includes('not found'), false);
});

test('item 11: a stored id from another cwd starts a new session', () => {
  // 17-sessions.md groups sessions by encoded cwd. Loading the id under the new cwd would miss it.
  assert.deepEqual(storedSessionAction({ grokSessionId: 'abc', cwd: '/old' }, '/old'), { grokSessionId: 'abc' });
  assert.deepEqual(storedSessionAction({ grokSessionId: 'abc', cwd: '/old' }, '/new'), { notice: '[grok session abc belongs to /old; started a new one]' });
  assert.deepEqual(storedSessionAction(undefined, '/new'), {});
});

test('item 12: a reverse request for an unknown session is answered immediately', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s);
  t.after(() => connection.close());
  let called = false;
  const pending = new Promise(() => {});
  await connection.open();
  await connection.attachSession({ cwd: s.home, serverId: 'server', serverName: 'pi', offerPiTools: false, handlers: {
    onUpdate() {},
    async onMcp() { return {}; },
    onHookRun() { called = true; return pending as Promise<Record<string, unknown>>; },
    onPermission() { called = true; return pending as Promise<any>; },
    onQuestion() { called = true; return pending as Promise<Record<string, unknown>>; },
  } });
  const emit = (id: string, method: string, params: Record<string, unknown>) => connection.agent.notify('test/emit', { jsonrpc: '2.0', id, method, params: { sessionId: 'no-such-session', ...params } });
  await emit('u-hook', '_x.ai/hooks/run', { hookEventName: 'pre_tool_use', toolName: 'bash' });
  await emit('u-post', '_x.ai/hooks/run', { hookEventName: 'post_tool_use' });
  await emit('u-perm', 'session/request_permission', { toolCall: { toolCallId: 't', title: 'write' }, options: [{ kind: 'reject_once', optionId: 'no', name: 'Reject' }] });
  await emit('u-ask', '_x.ai/ask_user_question', {});
  await until(() => ['u-hook', 'u-post', 'u-perm', 'u-ask'].every((id) => received(s, id).length === 1), 'immediate answers');
  assert.equal(called, false);
  assert.equal(received(s, 'u-hook')[0].result.decision, 'deny');
  assert.match(received(s, 'u-hook')[0].result.reason, /answered immediately/);
  assert.equal(received(s, 'u-post')[0].result.decision, 'continue');
  assert.equal(received(s, 'u-perm')[0].result.outcome.outcome, 'cancelled');
  assert.equal(received(s, 'u-ask')[0].result.outcome, 'cancelled');
});

test('item 13: a malformed hook payload is denied and does not throw', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s);
  t.after(() => connection.close());
  const session = new GrokModelSession(connection, 'pi-hook', s.home);
  await session.attach(undefined);
  const direct = await session.onHookRun({} as any);
  assert.equal(direct.decision, 'deny');
  assert.match(direct.reason ?? '', /missing hookEventName/);
  await connection.agent.notify('test/emit', { jsonrpc: '2.0', id: 'bad-hook', method: '_x.ai/hooks/run', params: { sessionId: session.grokSessionId, toolName: 'bash' } });
  await until(() => received(s, 'bad-hook').length === 1, 'malformed hook answer');
  assert.equal(received(s, 'bad-hook')[0].error, undefined);
  assert.equal(received(s, 'bad-hook')[0].result.decision, 'deny');
  assert.match(received(s, 'bad-hook')[0].result.reason, /missing hookEventName/);
});

test('item 14: debug lines report pid, uptime, exits, stderr, pending requests, and mcp counts', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_STDERR: 'stderr-one' });
  t.after(() => connection.close());
  const session = new GrokModelSession(connection, 'pi-debug', s.home);
  session.tools = [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } as any }];
  await session.attach(undefined);
  await connection.agent.notify('test/emit', { jsonrpc: '2.0', id: 'list', method: '_x.ai/mcp/sdk_call', params: { serverId: session.serverId, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } });
  await connection.agent.notify('test/emit', { jsonrpc: '2.0', id: 'miss', method: '_x.ai/mcp/sdk_call', params: { serverId: 'missing', message: { jsonrpc: '2.0', id: 2, method: 'tools/list' } } });
  await until(() => received(s, 'list').length === 1 && received(s, 'miss').length === 1, 'mcp results');
  const lines = connection.debugLines().join('\n');
  assert.match(lines, new RegExp(`child pid: ${connection.pid}`));
  assert.match(lines, /child uptime: \d/);
  assert.match(lines, /child stderr: stderr-one/);
  assert.match(lines, /pending requests: 0/);
  assert.match(lines, /mcp: 1 tools lent, 1 calls served, 1 calls failed/);
  const pid = connection.pid!;
  process.kill(pid, 'SIGTERM');
  await until(() => !connection.isOpen, 'child exited');
  assert.match(connection.debugLines().join('\n'), /child exits: .*exit 143|signal SIGTERM/);
});

test('item 15: child stderr and framing errors are appended to the stdio log, which rotates', async (t) => {
  const s = scratch(); t.after(s.cleanup);
  const connection = connect(s, { FAKE_GROK_STDERR: 'logged-stderr', FAKE_GROK_STDOUT_NOISE: 'noise-line' }, { logMaxBytes: 80 });
  t.after(() => connection.close());
  await connection.open();
  const log = readFileSync(s.stdioLog, 'utf8');
  assert.match(log, /stderr: logged-stderr/);
  assert.match(log, /framing: skipped non-JSON stdout: noise-line/);
  const rotated = join(s.home, 'rotate.log');
  appendStdioLog(rotated, 'a'.repeat(90), 80);
  appendStdioLog(rotated, 'b', 80);
  assert.ok(existsSync(`${rotated}.1`));
  assert.ok(statSync(rotated).size < 80);
  assert.match(readFileSync(`${rotated}.1`, 'utf8'), /a{90}/);
});
