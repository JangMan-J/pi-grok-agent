// Pi-side leash integration. Only fake children; no Grok login or model usage.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { normalizeContext, type Api, type Model } from '@earendil-works/pi-ai';
import { GrokModelConnection, type ConnectionOptions } from '../src/model/connection.ts';
import { GrokModelSession } from '../src/model/session.ts';
import { createGrokStream, GROK_API } from '../src/model/provider.ts';
import { permissionAnswer, permissionDialog } from '../src/model/permissions.ts';
import { questionAnswerer } from '../src/model/questions.ts';

const GROK = join(import.meta.dirname, 'fixtures', 'fake-grok.ts');
const LEASH = join(import.meta.dirname, 'fixtures', 'fake-leash.ts');
chmodSync(GROK, 0o755);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(15); }
}
const rows = (path: string): any[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
function setup(t: TestContext, options: ConnectionOptions = {}, env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pleash-'));
  const log = join(home, 'leash.jsonl'), grokLog = join(home, 'grok.jsonl');
  const connection = new GrokModelConnection({ binary: GROK, leashPath: LEASH, stopGraceMs: 200, ...options,
    env: { FAKE_GROK_LOG: grokLog, PI_GROK_LEASH_LOG: log, ...env, ...options.env }, logPath: join(home, 'stdio.log') });
  t.after(async () => { await connection.close(); rmSync(home, { recursive: true, force: true }); });
  const session = new GrokModelSession(connection, 'pi-leash', home);
  return { home, log, grokLog, connection, session };
}
const hook = (session: GrokModelSession, id: string | number) => ({ jsonrpc: '2.0', id, method: '_x.ai/hooks/run', params: {
  sessionId: session.grokSessionId, hookEventName: 'pre_tool_use', hookCallbackId: 'pi-pre', cwd: session.cwd,
  toolName: 'hashline_edit', toolInput: { path: 'a.ts' },
} });
const model = { id: 'grok-4.7', name: 'Grok', api: GROK_API, provider: 'grok', baseUrl: 'stdio://grok', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as Model<Api>;
function turn(connection: GrokModelConnection, session: GrokModelSession) {
  const stream = createGrokStream(connection, { current: () => session });
  const out = stream(model, normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }), {});
  return (async () => { const events: any[] = []; for await (const event of out) events.push(event); return events; })();
}

test('leash argv, ready metadata, and ~100ms heartbeats; control frames never reach Grok', async (t) => {
  const s = setup(t, { stallMs: 1500, requestMs: 24000, dialogMs: 500000 });
  await s.session.attach(undefined);
  await until(() => rows(s.log).filter((r) => r.event === 'heartbeat').length >= 6, 'six heartbeats');
  assert.deepEqual(rows(s.log).find((r) => r.event === 'argv').argv, [
    '--parent', String(process.pid), '--stall-ms', '1500', '--request-ms', '24000', '--', GROK,
    '--permission-mode', 'default', 'agent', '--no-leader', 'stdio',
  ]);
  assert.ok(!readFileSync(s.log, 'utf8').includes('--always-approve'));
  assert.deepEqual(rows(s.grokLog).find((r) => r.id === 'spawn').argv, ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']);
  const beats = rows(s.log).filter((r) => r.event === 'heartbeat').map((r) => r.t as number);
  const gaps = beats.slice(2).map((n, i) => n - beats[i + 1]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  assert.ok(median >= 60 && median <= 200, `heartbeat median ${median}ms`);
  const debug = s.connection.debugLines().join('\n');
  const ready = rows(s.log).find((r) => r.params?.event === 'ready').params;
  assert.match(debug, /leash version: 0\.0\.0-fake/);
  assert.match(debug, new RegExp(`leash pid: ${s.connection.pid}`));
  assert.match(debug, new RegExp(`grok pid: ${ready.grokPid}`));
  assert.match(debug, /stall 1500 ms, request 24000 ms, dialog 500000 ms/);
  assert.notEqual(ready.grokPid, s.connection.pid);
  assert.equal(rows(s.grokLog).some((r) => r.method?.startsWith('pi/')), false);
});

test('hook ask dialog extends its raw request id once beyond the request deadline', async (t) => {
  const s = setup(t, { requestMs: 200, dialogMs: 5000 });
  s.session.piToolNames = ['read', 'edit'];
  s.session.permissionMode = 'ask';
  let confirm!: (answer: boolean) => void;
  s.session.askDialog = () => new Promise((resolve) => { confirm = resolve; });
  await s.session.attach(undefined);
  await s.connection.agent.notify('test/emit', hook(s.session, 'dialog-hook'));
  await until(() => rows(s.log).some((r) => r.event === 'extend'), 'hook extension');
  await sleep(300);
  assert.deepEqual(rows(s.log).filter((r) => r.event === 'extend'), [{ event: 'extend', id: 'dialog-hook', ms: 5000 }]);
  assert.equal(rows(s.log).some((r) => r.params?.event === 'deadline'), false);
  confirm(true);
  await until(() => rows(s.grokLog).some((r) => r.id === 'dialog-hook'), 'human answer');
  assert.deepEqual(rows(s.grokLog).find((r) => r.id === 'dialog-hook').result, { decision: 'continue' });
});

test('permission and question UI extend distinct numeric/string ids; headless and yolo do not', async (t) => {
  const s = setup(t, { dialogMs: 510000 });
  const ui = { hasUI: true, ui: { select: async (_title: string, labels: string[]) => labels[0] } } as any;
  s.session.permission = permissionAnswer(true, permissionDialog(ui), 'dialog');
  s.session.ask = questionAnswerer(ui);
  await s.session.attach(undefined);
  const permission = (id: string | number) => ({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: s.session.grokSessionId, toolCall: { toolCallId: 't', title: 'write' }, options: [{ kind: 'allow_once', optionId: 'yes', name: 'Allow' }],
  } });
  const question = (id: string) => ({ jsonrpc: '2.0', id, method: '_x.ai/ask_user_question', params: {
    sessionId: s.session.grokSessionId, questions: [{ question: 'Pick', options: [{ label: 'A', description: '' }] }, { question: 'Next', options: [{ label: 'B', description: '' }] }], mode: 'default',
  } });
  await s.connection.agent.notify('test/emit', permission(7));
  await s.connection.agent.notify('test/emit', question('7'));
  await until(() => rows(s.grokLog).filter((r) => r.id === 7 || r.id === '7').length === 2, 'dialog answers');
  assert.deepEqual(rows(s.log).filter((r) => r.event === 'extend').map((r) => [r.id, r.ms]), [[7, 510000], ['7', 510000]]);
  s.session.permission = permissionAnswer(true, permissionDialog(ui), 'dialog', () => 'yolo');
  s.session.ask = questionAnswerer({ hasUI: false, ui: ui.ui });
  await s.connection.agent.notify('test/emit', permission('yolo'));
  await s.connection.agent.notify('test/emit', question('headless'));
  await until(() => rows(s.grokLog).some((r) => r.id === 'headless'), 'headless answer');
  assert.equal(rows(s.log).filter((r) => r.event === 'extend').length, 2);
});

test('stall ends the provider turn with the exact notification message; next turn respawns and loads', async (t) => {
  const s = setup(t, { heartbeatMs: 0, stallMs: 700 }, { FAKE_GROK_HOLD_PROMPT: '1' });
  const events = await turn(s.connection, s.session);
  const stall = rows(s.log).find((r) => r.params?.event === 'stall').params;
  assert.equal(events.at(-1).error.errorMessage, `[grok stopped by pi-grok-leash: stall after ${stall.ms} ms; no unguarded tool ran]`);
  assert.equal(s.connection.isOpen, false);
  assert.match(s.connection.debugLines().join('\n'), /"event":"stall"/);
  await s.session.attach(undefined);
  assert.equal(rows(s.grokLog).filter((r) => r.id === 'spawn').length, 2);
  assert.equal(rows(s.grokLog).filter((r) => r.id === 'session/load').length, 1);
  const next = s.session.startPrompt('next');
  await until(() => rows(s.grokLog).filter((r) => r.id === 'session/prompt').length === 2, 'next prompt');
  await s.session.cancel();
  await next;
});

test('deadline denies once, ends the provider turn, and drops before a late handler answer can reach Grok', async (t) => {
  const s = setup(t, { requestMs: 200 }, { FAKE_GROK_HOLD_PROMPT: '1' });
  let answer!: (reply: any) => void;
  s.session.onHookRun = () => new Promise((resolve) => { answer = resolve; });
  const running = turn(s.connection, s.session);
  await until(() => s.session.promptActive, 'running prompt');
  await s.connection.agent.notify('test/emit', hook(s.session, 'slow-hook'));
  const events = await running;
  const deadline = rows(s.log).find((r) => r.params?.event === 'deadline').params;
  assert.equal(events.at(-1).error.errorMessage, `[pi-grok-leash denied _x.ai/hooks/run slow-hook after ${deadline.ms} ms: Pi did not answer]`);
  assert.equal(s.connection.isOpen, false);
  await s.connection.close();
  answer({ decision: 'continue' });
  await sleep(30);
  const replies = rows(s.grokLog).filter((r) => r.id === 'slow-hook');
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].result, { decision: 'deny', reason: `pi-grok-leash: no answer in ${deadline.ms} ms` });
  // Immediate drop closes stdin, so this late answer cannot produce a leash late-reply event.
  assert.equal(rows(s.log).filter((r) => r.params?.event === 'deadline').length, 1);
});

test('the leash itself drops a late response and emits late-reply after its synthetic denial', async (t) => {
  const s = setup(t);
  // The real connection must drop immediately at deadline. A raw client keeps this fixture alive
  // only to verify the other side of that boundary: a late Pi answer is never forwarded.
  const child = spawn(process.execPath, [LEASH, '--parent', String(process.pid), '--stall-ms', '5000', '--request-ms', '150', '--', GROK, '--permission-mode', 'default', 'agent', '--no-leader', 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FAKE_GROK_LOG: s.grokLog, PI_GROK_LEASH_LOG: s.log },
  });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exited; });
  const events: any[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => events.push(JSON.parse(line)));
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  await until(() => events.some((m) => m.params?.event === 'ready'), 'ready');
  send({ jsonrpc: '2.0', method: 'test/emit', params: hook(s.session, 'late') });
  await until(() => events.some((m) => m.params?.event === 'deadline'), 'synthetic denial');
  send({ jsonrpc: '2.0', id: 'late', result: { decision: 'continue' } });
  await until(() => events.some((m) => m.params?.event === 'late-reply'), 'late reply dropped');
  child.stdin.end();
  await exited;
  assert.deepEqual(rows(s.grokLog).filter((r) => r.id === 'late').map((r) => r.result.decision), ['deny']);
  assert.equal(rows(s.log).filter((r) => r.params?.event === 'late-reply').length, 1);
});

test('slow Grok stdin cannot starve leash heartbeat consumption', async (t) => {
  const s = setup(t);
  const script = join(s.home, 'blocked-stdin.js');
  writeFileSync(script, 'setInterval(() => {}, 60000);\n');
  const child = spawn(process.execPath, [LEASH, '--parent', String(process.pid), '--stall-ms', '350', '--', process.execPath, script], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_GROK_LEASH_LOG: s.log },
  });
  const exited = once(child, 'exit');
  child.stdout.resume();
  child.stdin.on('error', () => {});
  const heartbeat = setInterval(() => child.stdin.write('{"jsonrpc":"2.0","method":"pi/heartbeat"}\n', () => {}), 100);
  t.after(async () => { clearInterval(heartbeat); child.stdin.end(); await exited; });
  await until(() => rows(s.log).some((r) => r.params?.event === 'ready'), 'ready');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'blocked', params: { text: 'x'.repeat(2_000_000) } }) + '\n');
  await until(() => rows(s.log).filter((r) => r.event === 'heartbeat').length >= 7, 'heartbeats beyond the stall window');
  assert.equal(child.exitCode, null);
  assert.equal(rows(s.log).some((r) => r.params?.event === 'stall'), false);
  clearInterval(heartbeat);
  child.stdin.end();
  await exited;
});

test('missing leash refuses startup, names the build command, and never spawns Grok', async (t) => {
  const s = setup(t, { leashPath: join(tmpdir(), 'pi-grok-leash-does-not-exist') });
  await assert.rejects(s.connection.open(), /Cannot start pi-grok-leash[\s\S]*npm run build:leash/);
  assert.equal(existsSync(s.grokLog), false);
  assert.equal(s.connection.isOpen, false);
});

test('PI_GROK_LEASH=none explicitly spawns Grok directly and marks debug UNGUARDED', async (t) => {
  const s = setup(t, { leashPath: undefined, env: { PI_GROK_LEASH: 'none' } });
  await s.connection.open();
  assert.deepEqual(rows(s.grokLog).find((r) => r.id === 'spawn').argv, ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']);
  assert.match(s.connection.debugLines().join('\n'), /UNGUARDED \(PI_GROK_LEASH=none\)/);
  assert.equal(existsSync(s.log), false);
});

test('ready timeout includes stderr and sends no initialize; invalid first lines fail closed', async (t) => {
  for (const first of ['', 'not-json\n', '{"jsonrpc":"2.0","method":"wrong"}\n']) {
    const s = setup(t);
    const script = join(s.home, 'not-ready.js'), seen = join(s.home, 'stdin');
    writeFileSync(script, `import { appendFileSync } from 'node:fs';
process.stderr.write('startup diagnostic');
process.stdout.write(${JSON.stringify(first)});
process.stdin.on('data', b => appendFileSync(${JSON.stringify(seen)}, b));
process.stdin.on('end', () => process.exit(0));`);
    const connection = new GrokModelConnection({ binary: GROK, leashPath: script, readyMs: 300, logPath: join(s.home, 'ready.log') });
    t.after(() => connection.close());
    await assert.rejects(connection.open(), first ? /first stdout line was not a valid ready/ : /no ready notification within 300 ms[\s\S]*startup diagnostic/);
    await connection.close();
    assert.equal(existsSync(seen) && readFileSync(seen, 'utf8').includes('initialize'), false);
    assert.equal(existsSync(s.grokLog), false);
  }
});

test('a drop while attach resolves cannot mark the replacement generation as loaded', async () => {
  const loaded: (string | undefined)[] = [];
  const connection = {
    generation: 0, isOpen: true,
    async attachSession(input: { sessionId?: string }) {
      loaded.push(input.sessionId);
      if (loaded.length === 1) this.generation++; // drop between the reply and attach's continuation
      return { sessionId: 'stored', response: {} };
    },
  };
  const session = new GrokModelSession(connection as unknown as GrokModelConnection, 'generation', '/repo');
  await session.attach(undefined);
  await session.attach(undefined);
  await session.attach(undefined);
  assert.deepEqual(loaded, [undefined, 'stored']);
});

test('old-child stderr callbacks cannot pollute the replacement child ring', async (t) => {
  const s = setup(t, {}, { FAKE_GROK_STDERR: 'current-child' });
  await s.connection.open();
  const old = (s.connection as any).child;
  s.connection.drop('replace');
  await s.connection.open();
  // Deliver the stale callback deterministically after the replacement has started.
  old.stderr.emit('data', 'old-child-late-stderr\n');
  const debug = s.connection.debugLines().join('\n');
  assert.match(debug, /child stderr: current-child/);
  assert.doesNotMatch(debug, /old-child-late-stderr/);
});

test('leash event debug retains the last five timestamps, counts late replies, and records child status', async (t) => {
  const s = setup(t, {}, { FAKE_GROK_DIE_ON: 'test/die', FAKE_GROK_EXIT_CODE: '23' });
  await s.connection.open();
  // Inject notifications to exercise the Pi event consumer; actual deadline ownership is tested above.
  for (let id = 0; id < 7; id++) await s.connection.agent.notify('test/emit', { jsonrpc: '2.0', method: 'pi/leash', params: { event: 'late-reply', id } });
  await until(() => s.connection.debugLines().includes('leash late replies: 7'), 'late reply count');
  const history = s.connection.debugLines().find((line) => line.startsWith('leash events:'))!;
  assert.equal((history.match(/"event":"late-reply"/g) ?? []).length, 5);
  assert.ok(!history.includes('"id":1'));
  assert.match(history, /\d{4}-\d{2}-\d{2}T/);
  await s.connection.agent.notify('test/die', {});
  await until(() => !s.connection.isOpen, 'child exit');
  assert.match(s.connection.debugLines().join('\n'), /child exits: .*exit 23/);
  assert.match(s.connection.debugLines().join('\n'), /"event":"child-exit","code":23/);
});
