// Pi-side leash integration. Only fake children; no Grok login or model usage.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
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
const FAKE_LEASH = join(import.meta.dirname, 'fixtures', 'fake-leash.ts');
const LEASH = process.env.PI_GROK_LEASH || FAKE_LEASH;
const leashCommand = LEASH === FAKE_LEASH ? process.execPath : LEASH;
const leashPrefix = LEASH === FAKE_LEASH ? [LEASH] : [];
chmodSync(GROK, 0o755);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(15); }
}
const rows = (path: string): any[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
function setup(t: TestContext, options: ConnectionOptions = {}, env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pleash-'));
  const log = join(home, 'leash.jsonl'), grokLog = join(home, 'grok.jsonl'), trace = join(home, 'trace.jsonl');
  const connection = new GrokModelConnection({ binary: GROK, leashPath: LEASH, stopGraceMs: 200, ...options,
    env: { FAKE_GROK_LOG: grokLog, PI_GROK_LEASH_LOG: log, FAKE_LEASH_TRACE: trace, ...env, ...options.env }, logPath: join(home, 'stdio.log') });
  t.after(async () => { await connection.close(); rmSync(home, { recursive: true, force: true }); });
  const session = new GrokModelSession(connection, 'pi-leash', home);
  return { home, log, grokLog, trace, connection, session };
}
const grokCommand = [GROK, '--permission-mode', 'default', 'agent', '--no-leader', 'stdio'];
function rawLeash(t: TestContext, flags: string[] = [], command = grokCommand, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(leashCommand, [...leashPrefix, '--parent', String(process.pid), '--stall-ms', '5000', ...flags, '--', ...command], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  const exited = once(child, 'exit');
  const lines: string[] = [], messages: any[] = [], output: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    try { messages.push(JSON.parse(line)); } catch { /* Forwarded malformed bytes. */ }
  });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  t.after(async () => { child.stdin.end(); await exited; });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return { child, exited, lines, messages, send, output };
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

test('leash argv, ready metadata, and heartbeats across several stall windows; control frames never reach Grok', async (t) => {
  const s = setup(t, { stallMs: 500, requestMs: 24000, dialogMs: 500000 });
  await s.session.attach(undefined);
  await sleep(1600);
  assert.equal(s.connection.isOpen, true);
  assert.equal(rows(s.log).some((r) => r.params?.event === 'stall'), false);
  assert.deepEqual(rows(s.log)[0], { event: 'start', parent: process.pid, args: [
    GROK, '--permission-mode', 'default', 'agent', '--no-leader', 'stdio',
  ] });
  assert.ok(!readFileSync(s.log, 'utf8').includes('--always-approve'));
  assert.deepEqual(rows(s.grokLog).find((r) => r.id === 'spawn').argv, ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']);
  if (LEASH === FAKE_LEASH) {
    const beats = rows(s.trace).filter((r) => r.event === 'heartbeat').map((r) => r.t as number);
    const gaps = beats.slice(2).map((n, i) => n - beats[i + 1]).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    assert.ok(median >= 60 && median <= 200, `heartbeat median ${median}ms`);
  }
  const debug = s.connection.debugLines().join('\n');
  const ready = rows(s.log).find((r) => r.params?.event === 'ready').params;
  assert.ok(debug.includes(`leash version: ${ready.version}`));
  assert.match(ready.version, /^\d+\.\d+\.\d+/);
  assert.equal(rows(s.log)[1].params.event, 'ready');
  assert.match(debug, new RegExp(`leash pid: ${s.connection.pid}`));
  assert.match(debug, new RegExp(`grok pid: ${ready.grokPid}`));
  assert.equal(ready.stallMs, 500);
  assert.equal(ready.requestMs, 24000);
  assert.match(debug, /stall 500 ms, request 24000 ms, dialog 500000 ms/);
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
  await until(() => !!confirm, 'hook dialog');
  await sleep(350);
  if (LEASH === FAKE_LEASH) assert.deepEqual(rows(s.trace).filter((r) => r.event === 'extend'), [{ event: 'extend', id: 'dialog-hook', ms: 5000 }]);
  assert.equal(rows(s.log).some((r) => r.params?.event === 'deadline'), false);
  confirm(true);
  await until(() => rows(s.grokLog).some((r) => r.id === 'dialog-hook'), 'human answer');
  assert.deepEqual(rows(s.grokLog).find((r) => r.id === 'dialog-hook').result, { decision: 'continue' });
});

test('permission and question UI extend distinct numeric/string ids; headless and yolo do not', async (t) => {
  const s = setup(t, { requestMs: 200, dialogMs: 510000 });
  const ui = { hasUI: true, ui: { select: async (_title: string, labels: string[]) => { await sleep(350); return labels[0]; } } } as any;
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
  assert.equal(rows(s.log).some((r) => r.params?.event === 'deadline'), false);
  assert.equal(rows(s.grokLog).find((r) => r.id === 7).result.outcome.outcome, 'selected');
  assert.equal(rows(s.grokLog).find((r) => r.id === '7').result.outcome, 'accepted');
  if (LEASH === FAKE_LEASH) assert.deepEqual(rows(s.trace).filter((r) => r.event === 'extend').map((r) => [r.id, r.ms]), [[7, 510000], ['7', 510000]]);
  s.session.permission = permissionAnswer(true, permissionDialog(ui), 'dialog', () => 'yolo');
  s.session.ask = questionAnswerer({ hasUI: false, ui: ui.ui });
  await s.connection.agent.notify('test/emit', permission('yolo'));
  await s.connection.agent.notify('test/emit', question('headless'));
  await until(() => rows(s.grokLog).some((r) => r.id === 'headless'), 'headless answer');
  if (LEASH === FAKE_LEASH) assert.equal(rows(s.trace).filter((r) => r.event === 'extend').length, 2);
});

test('stall ends the provider turn with the exact notification message; next turn respawns and loads', async (t) => {
  const s = setup(t, { heartbeatMs: 0, stallMs: 700 }, { FAKE_GROK_HOLD_PROMPT: '1' });
  const events = await turn(s.connection, s.session);
  const stall = rows(s.log).find((r) => r.params?.event === 'stall').params;
  assert.equal(stall.ms, 700);
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

test('deadline is one notice; the same child finishes normally and a noncooperating handler cannot reply late', async (t) => {
  const s = setup(t, { requestMs: 200 }, { FAKE_GROK_HOLD_PROMPT: '1', FAKE_GROK_FINISH_ON_DENY: '1' });
  let answer!: (reply: any) => void;
  let signal: AbortSignal | undefined;
  s.session.onHookRun = (_payload, gate) => { signal = gate?.signal; return new Promise((resolve) => { answer = resolve; }); };
  const running = turn(s.connection, s.session);
  await until(() => rows(s.grokLog).some((r) => r.id === 'session/prompt'), 'running prompt');
  const pid = s.connection.pid, generation = s.connection.generation;
  await s.connection.agent.notify('test/emit', hook(s.session, 'slow-hook'));
  const events = await running;
  const deadline = rows(s.log).find((r) => r.params?.event === 'deadline').params;
  assert.equal(deadline.ms, 200);
  assert.deepEqual(events.filter((e) => e.type === 'thinking_delta').map((e) => e.delta), [`[pi-grok-leash denied _x.ai/hooks/run slow-hook after ${deadline.ms} ms: Pi did not answer]\n`]);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).reason, 'stop');
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''), 'continued after denial');
  assert.equal(signal?.aborted, true);
  assert.equal(s.connection.isOpen, true);
  answer({ decision: 'continue' });
  await sleep(30);
  const replies = rows(s.grokLog).filter((r) => r.id === 'slow-hook');
  assert.deepEqual(replies.map((r) => r.result), [{ decision: 'deny', reason: `pi-grok-leash: no answer in ${deadline.ms} ms` }]);
  assert.equal(rows(s.log).some((r) => r.params?.event === 'late-reply'), false);
  await s.session.attach(undefined);
  assert.equal(s.connection.pid, pid);
  assert.equal(s.connection.generation, generation);
  assert.equal(rows(s.grokLog).filter((r) => r.id === 'spawn').length, 1);
  assert.equal(rows(s.grokLog).filter((r) => r.id === 'session/load').length, 0);
});

test('deadline aborts hook confirm, permission select, and question select/input dialogs', async (t) => {
  for (const kind of ['hook', 'permission', 'question-select', 'question-input']) await t.test(kind, async (t) => {
    const s = setup(t, { requestMs: 200, dialogMs: 250 }, { FAKE_GROK_HOLD_PROMPT: '1', FAKE_GROK_FINISH_ON_DENY: '1' });
    let closed = 0;
    const dialog = (_title: string, _options: unknown, opts: { signal?: AbortSignal }) => new Promise<undefined>((resolve) => {
      assert.ok(opts.signal);
      opts.signal.addEventListener('abort', () => { closed++; resolve(undefined); }, { once: true });
    });
    const ctx = { hasUI: true, ui: { select: kind === 'question-input' ? async () => 'Other' : dialog, input: dialog } } as any;
    s.session.hookSettings = { allowGrokTools: ['hashline_edit'] };
    s.session.permissionMode = 'ask';
    s.session.askDialog = async (tool, input, signal) => { await dialog(tool, input, { signal }); return false; };
    s.session.permission = permissionAnswer(true, permissionDialog(ctx), 'dialog');
    s.session.ask = questionAnswerer(ctx);
    const running = turn(s.connection, s.session);
    await until(() => rows(s.grokLog).some((r) => r.id === 'session/prompt'), 'prompt');
    const pid = s.connection.pid, generation = s.connection.generation;
    const request = kind === 'hook' ? hook(s.session, kind) : kind === 'permission'
      ? { jsonrpc: '2.0', id: kind, method: 'session/request_permission', params: { sessionId: s.session.grokSessionId, toolCall: { toolCallId: 't', title: 'write' }, options: [{ kind: 'allow_once', optionId: 'yes', name: 'Allow' }] } }
      : { jsonrpc: '2.0', id: kind, method: '_x.ai/ask_user_question', params: { sessionId: s.session.grokSessionId, questions: [{ question: 'Pick', options: [{ label: 'A', description: '' }] }], mode: 'default' } };
    await s.connection.agent.notify('test/emit', request);
    const events = await running;
    assert.equal(rows(s.log).find((r) => r.params?.event === 'deadline').params.ms, 250);
    assert.equal(closed, 1, 'the displayed dialog was dismissed by its abort signal');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.filter((e) => e.type === 'thinking_delta').length, 1);
    assert.equal(rows(s.grokLog).filter((r) => r.id === kind).length, 1, 'only the leash synthetic reply');
    assert.equal(rows(s.log).some((r) => r.params?.event === 'late-reply'), false);
    assert.equal(s.connection.pid, pid);
    assert.equal(s.connection.generation, generation);
  });
});

test('an idle deadline is recorded without buffering a notice into a later turn', async (t) => {
  const s = setup(t, { requestMs: 150 });
  s.session.onHookRun = () => new Promise(() => {});
  await s.session.attach(undefined);
  await s.connection.agent.notify('test/emit', hook(s.session, 'idle'));
  await until(() => s.connection.debugLines().some((line) => line.includes('"event":"deadline"')), 'idle deadline');
  const events: any[] = [];
  s.session.consume((event) => events.push(event));
  assert.equal(events.length, 0);
  await s.session.startPrompt('next');
  assert.equal(events.some((e) => e.kind === 'thought'), false);
  assert.equal(s.connection.isOpen, true);
});

test('the leash itself drops a late response and emits late-reply after its synthetic denial', async (t) => {
  const s = setup(t);
  // The connection suppresses late responses locally. A raw client bypasses that protection
  // to verify the leash's independent late-reply suppression.
  const child = spawn(leashCommand, [...leashPrefix, '--parent', String(process.pid), '--stall-ms', '5000', '--request-ms', '150', '--', GROK, '--permission-mode', 'default', 'agent', '--no-leader', 'stdio'], {
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
  const child = spawn(leashCommand, [...leashPrefix, '--parent', String(process.pid), '--stall-ms', '350', '--', process.execPath, script], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_GROK_LEASH_LOG: s.log },
  });
  const exited = once(child, 'exit');
  child.stdout.resume();
  child.stdin.on('error', () => {});
  const heartbeat = setInterval(() => child.stdin.write('{"jsonrpc":"2.0","method":"pi/heartbeat"}\n', () => {}), 100);
  t.after(async () => { clearInterval(heartbeat); child.stdin.end(); await exited; });
  await until(() => rows(s.log).some((r) => r.params?.event === 'ready'), 'ready');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'blocked', params: { text: 'x'.repeat(2_000_000) } }) + '\n');
  await sleep(1200); // More than three stall windows while Grok never reads stdin.
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

test('leash CLI reports semver, usage exit 2, and parent mismatch exit 3', () => {
  const invoke = (...args: string[]) => spawnSync(leashCommand, [...leashPrefix, ...args], { encoding: 'utf8' });
  const version = invoke('--version');
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^pi-grok-leash \d+\.\d+\.\d+(?:-[\w.-]+)?(?: \(eof-only\))?\n$/);
  for (const args of [[], ['--unknown'], ['--parent', String(process.pid), '--stall-ms', '0', '--', GROK],
    ['--parent', '3000000000', '--', GROK], ['--parent', String(process.pid), '--request-ms', '18446744073709551616', '--', GROK]]) {
    const result = invoke(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
  }
  const mismatch = invoke('--parent', '2147483647', '--', GROK);
  assert.equal(mismatch.status, 3);
  assert.equal(mismatch.stdout, '');
  for (const flags of [['--stall-ms', '+5'], ['--request-ms', '18446744073709551615'], ['--log', '--log-like-a-flag']]) {
    assert.equal(invoke('--parent', '+2147483647', ...flags, '--', GROK).status, 3, 'valid flags reach parent check');
  }
});

test('ready is first, buffered output precedes natural child-exit, and exit status is preserved', async (t) => {
  for (const [ending, code, signal] of [['process.exit(23)', 23, null], ["process.kill(process.pid, 'SIGTERM')", null, 'SIGTERM']] as const) {
    const r = rawLeash(t, [], [process.execPath, '-e', `process.stdout.write('{"first":1}\\n{"last":2}\\n', () => { ${ending}; });`]);
    const [status] = await r.exited;
    await until(() => r.messages.some((m) => m.params?.event === 'child-exit'), 'drained exit event');
    assert.equal(status, code ?? 143);
    assert.equal(r.messages[0].params.event, 'ready');
    assert.deepEqual(r.messages.slice(1), [{ first: 1 }, { last: 2 }, { jsonrpc: '2.0', method: 'pi/leash', params: { event: 'child-exit', code, signal } }]);
  }
});

test('log contains only start, verbatim leash events, and exit with malformed count; --log overrides env', async (t) => {
  const s = setup(t), ignored = join(s.home, 'ignored.jsonl');
  const command = [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'];
  const r = rawLeash(t, ['--log', s.log], command, { PI_GROK_LEASH_LOG: ignored, FAKE_LEASH_TRACE: s.trace });
  await until(() => r.messages[0]?.params?.event === 'ready', 'first ready');
  r.send({ jsonrpc: '2.0', method: 'pi/heartbeat' });
  r.send({ jsonrpc: '2.0', method: 'pi/extend', params: { id: 'unknown', ms: 20 } });
  const malformed = Buffer.concat([
    Buffer.from('not-json\r\n{"x":"\\ud800"}\n'),
    Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}\n'),
    Buffer.from(`{"x":${'['.repeat(130)}0${']'.repeat(130)}}\n`),
  ]);
  r.child.stdin.write(malformed);
  await until(() => Buffer.concat(r.output).includes(malformed), 'malformed bytes echoed unchanged');
  r.child.stdin.end();
  assert.deepEqual(await r.exited, [0, null]);
  await until(() => r.messages.some((m) => m.params?.event === 'parent-gone'), 'EOF event');
  assert.equal(existsSync(ignored), false);
  const log = readFileSync(s.log, 'utf8').trimEnd().split('\n');
  assert.equal(log[0], JSON.stringify({ event: 'start', parent: process.pid, args: command }));
  assert.deepEqual(log.slice(1, -1), r.lines.filter((line) => line.startsWith('{"jsonrpc":"2.0","method":"pi/leash"')));
  assert.equal(log.at(-1), '{"event":"exit","code":0,"malformed":8}');
  assert.deepEqual(rows(s.log).filter((m) => m.params).map((m) => m.params.event), ['ready', 'parent-gone']);
});

test('log open failure refuses to spawn; later log write failures do not change child status', async (t) => {
  const s = setup(t), marker = join(s.home, 'spawned');
  const command = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.exit(23);`];
  const r = rawLeash(t, ['--log', join(s.home, 'missing', 'log')], command);
  assert.deepEqual(await r.exited, [1, null]);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(r.lines, []);
  if (existsSync('/dev/full')) {
    const full = rawLeash(t, ['--log', '/dev/full'], command);
    assert.deepEqual(await full.exited, [23, null]);
    await until(() => full.messages.some((m) => m.params?.event === 'child-exit'), 'child exit despite log write failure');
    assert.equal(full.messages[0].params.event, 'ready');
    assert.equal(full.messages.at(-1).params.code, 23);
  }
});

test('65th outstanding request is not forwarded and causes only stall with configured ms', async (t) => {
  const script = `for (let id = 0; id < 65; id++) console.log(JSON.stringify({jsonrpc:'2.0',id,method:'_x.ai/hooks/run'})); setInterval(() => {}, 60000);`;
  const r = rawLeash(t, [], [process.execPath, '-e', script]);
  assert.deepEqual(await r.exited, [0, null]);
  await until(() => r.messages.some((m) => m.params?.event === 'stall'), 'overflow stall');
  assert.equal(r.messages[0].params.event, 'ready');
  assert.deepEqual(r.messages.filter((m) => m.method === '_x.ai/hooks/run').map((m) => m.id), Array.from({ length: 64 }, (_, i) => i));
  assert.deepEqual(r.messages.filter((m) => m.method === 'pi/leash').slice(1), [{ jsonrpc: '2.0', method: 'pi/leash', params: { event: 'stall', ms: 5000 } }]);
});

test('deadline uses latest extension length, follows its request, and reused ids clear late-reply state', async (t) => {
  const s = setup(t);
  const r = rawLeash(t, ['--request-ms', '500'], grokCommand, { FAKE_GROK_LOG: s.grokLog });
  await until(() => r.messages[0]?.params?.event === 'ready', 'ready');
  r.send({ jsonrpc: '2.0', method: 'test/emit', params: hook(s.session, 'reuse') });
  await until(() => r.messages.some((m) => m.id === 'reuse'), 'request');
  await sleep(100);
  r.send({ jsonrpc: '2.0', method: 'pi/extend', params: { id: 'reuse', ms: 250 } });
  await until(() => r.messages.some((m) => m.params?.event === 'deadline'), 'extended deadline');
  const deadline = r.messages.find((m) => m.params?.event === 'deadline');
  assert.equal(deadline.params.ms, 250);
  assert.ok(r.messages.indexOf(deadline) > r.messages.findIndex((m) => m.id === 'reuse'));
  await until(() => rows(s.grokLog).some((m) => m.id === 'reuse'), 'synthetic reply');
  assert.equal(rows(s.grokLog).find((m) => m.id === 'reuse').result.reason, 'pi-grok-leash: no answer in 250 ms');
  r.send({ jsonrpc: '2.0', method: 'test/emit', params: hook(s.session, 'reuse') });
  await until(() => r.messages.filter((m) => m.id === 'reuse').length === 2, 'reused request');
  r.send({ jsonrpc: '2.0', id: 'reuse', result: { decision: 'continue' } });
  await until(() => rows(s.grokLog).filter((m) => m.id === 'reuse').length === 2, 'reused id response');
  assert.equal(rows(s.grokLog).filter((m) => m.id === 'reuse')[1].result.decision, 'continue');
  assert.equal(r.messages.some((m) => m.params?.event === 'late-reply'), false);
});

test('raw id tokens survive synthetic replies and late events; numeric spellings stay distinct', async (t) => {
  const r = rawLeash(t, ['--request-ms', '200'], [process.execPath, '-e', 'process.stdin.pipe(process.stdout)']);
  await until(() => r.messages[0]?.params?.event === 'ready', 'ready');
  const ids = ['9007199254740993', '1e2', '100', '"a\\u0062c"', 'null', 'true', '{}'];
  for (const id of ids) r.child.stdin.write(`{"jsonrpc":"2.0","id":${id},"method":"_x.ai/hooks/run"}\n`);
  await until(() => r.messages.filter((m) => m.method === '_x.ai/hooks/run').length === ids.length, 'requests');
  r.send({ jsonrpc: '2.0', id: 100, result: {} });
  await until(() => r.messages.filter((m) => m.params?.event === 'deadline').length === 3, 'valid ids expire');
  await until(() => r.messages.filter((m) => m.result?.decision === 'deny').length === 3, 'synthetic replies echoed');
  for (const id of [ids[0], ids[1], ids[3]]) {
    assert.ok(r.lines.some((line) => line.startsWith(`{"jsonrpc":"2.0","id":${id},"result":{"decision":"deny"`)), `raw reply id ${id}`);
    assert.ok(r.lines.some((line) => line.includes(`"event":"deadline","id":${id},`)), `raw event id ${id}`);
  }
  r.child.stdin.write('{"jsonrpc":"2.0","id":"\\u0061bc","result":{}}\n');
  await until(() => r.messages.some((m) => m.params?.event === 'late-reply'), 'decoded string id matches');
  assert.ok(r.lines.some((line) => line.includes('"event":"late-reply","id":"\\u0061bc"')));
  assert.equal(r.messages.filter((m) => m.params?.event === 'deadline').length, 3);
});

test('response classification clears requests without result/error or a string method', async (t) => {
  const r = rawLeash(t, ['--request-ms', '200'], [process.execPath, '-e', 'process.stdin.pipe(process.stdout)']);
  await until(() => r.messages[0]?.params?.event === 'ready', 'ready');
  for (const id of ['bare', 'null-method', 'numeric-method']) r.send({ id, method: '_x.ai/hooks/run' });
  await until(() => r.messages.filter((m) => m.method === '_x.ai/hooks/run').length === 3, 'requests');
  r.send({ id: 'bare' });
  r.send({ id: 'null-method', method: null, result: {} });
  r.send({ id: 'numeric-method', method: 5, result: {} });
  await until(() => r.messages.length === 7, 'responses forwarded');
  await sleep(300);
  assert.equal(r.messages.some((m) => m.params?.event === 'deadline'), false);
});

test('zero extension is final before the next sweep; fractional/exponent extensions are ignored', async (t) => {
  const r = rawLeash(t, ['--request-ms', '250'], [process.execPath, '-e', 'process.stdin.pipe(process.stdout)']);
  await until(() => r.messages[0]?.params?.event === 'ready', 'ready');
  for (const id of ['zero', 'fraction', 'exponent']) r.send({ id, method: '_x.ai/hooks/run' });
  await until(() => r.messages.filter((m) => m.method === '_x.ai/hooks/run').length === 3, 'requests');
  r.child.stdin.write([
    '{"method":"pi/extend","params":{"id":"zero","ms":0}}',
    '{"method":"pi/extend","params":{"id":"zero","ms":1000}}',
    '{"id":"zero","result":{"decision":"continue"}}',
    '{"method":"pi/extend","params":{"id":"fraction","ms":1000.5}}',
    '{"method":"pi/extend","params":{"id":"exponent","ms":1e3}}',
  ].join('\n') + '\n');
  await until(() => r.messages.filter((m) => m.params?.event === 'deadline').length === 3, 'deadlines');
  assert.deepEqual(r.messages.filter((m) => m.params?.event === 'deadline').map((m) => [m.params.id, m.params.ms]), [['zero', 0], ['fraction', 250], ['exponent', 250]]);
  assert.equal(r.messages.some((m) => m.id === 'zero' && m.result?.decision === 'continue'), false);
  assert.ok(r.messages.some((m) => m.params?.event === 'late-reply' && m.params.id === 'zero'));
});
