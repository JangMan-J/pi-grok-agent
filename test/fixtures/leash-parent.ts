// A disposable Pi process for real-leash signal tests. Never starts the real Grok binary.
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeContext, type Api, type Model } from '@earendil-works/pi-ai';
import { GrokModelConnection } from '../../src/model/connection.ts';
import { GrokModelSession } from '../../src/model/session.ts';
import { createGrokStream, GROK_API } from '../../src/model/provider.ts';

const [home, mode] = process.argv.slice(2);
if (!home || !['hook', 'idle'].includes(mode)) throw new Error('usage: leash-parent.ts <test directory> <hook|idle>');
const report = (event: string, data: Record<string, unknown> = {}) => process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
const connection = new GrokModelConnection({
  binary: join(import.meta.dirname, 'fake-grok.ts'),
  leashPath: join(import.meta.dirname, '..', '..', 'bin', 'pi-grok-leash'),
  stallMs: 1000,
  // Longer than fake Grok's 1500ms fail-open, so a denial cannot mask a failed kill.
  requestMs: 5000,
  logPath: join(home, 'stdio.log'),
  env: {
    FAKE_GROK_LOG: join(home, 'grok.jsonl'),
    PI_GROK_LEASH_LOG: join(home, 'leash.jsonl'),
    FAKE_GROK_TOOL_MARKER: join(home, 'tool-ran'),
    FAKE_GROK_HOOK_FAIL_OPEN_MS: '1500',
    FAKE_GROK_HOLD_PROMPT: mode === 'hook' ? '1' : '0',
  },
});
const session = new GrokModelSession(connection, 'pi-process-test', home);
session.onHookRun = () => {
  report('hook-pending');
  return new Promise(() => {});
};
connection.onDrop((message) => report('dropped', { message, debug: connection.debugLines() }));
const model = { id: 'grok-4.7', name: 'Grok', api: GROK_API, provider: 'grok', baseUrl: 'stdio://grok', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as Model<Api>;
let previousPid: number | undefined;
function pids() {
  // debugLines exposes grokPid from the real leash's ready notification.
  const grokPid = Number(connection.debugLines().find((line) => line.startsWith('grok pid: '))?.slice('grok pid: '.length));
  if (!connection.pid || !(grokPid > 0)) throw new Error('attached without leash ready pids');
  return { leashPid: connection.pid, grokPid };
}
async function attach() {
  await session.attach(undefined);
  const current = pids();
  report(previousPid && previousPid !== current.leashPid ? 'respawned' : 'attached', current);
  previousPid = current.leashPid;
}
let sequence = 0;
async function turn(withHook = false) {
  await attach();
  const stream = createGrokStream(connection, { current: () => session });
  const out = stream(model, normalizeContext({ messages: [{ role: 'user', content: `turn ${++sequence}`, timestamp: sequence }] }), {});
  const completed = (async () => {
    const events: unknown[] = [];
    for await (const event of out) events.push(event);
    report('turn-ended', { events, ...(!connection.isOpen ? { message: connection.lastDrop } : pids()) });
  })();
  if (withHook) {
    const end = performance.now() + 5000;
    while (!session.promptActive) {
      if (performance.now() > end) throw new Error('provider did not start a prompt');
      await sleep(10);
    }
    await connection.agent.notify('test/emit', { jsonrpc: '2.0', id: 'pending-hook', method: '_x.ai/hooks/run', params: {
      sessionId: session.grokSessionId, hookEventName: 'pre_tool_use', hookCallbackId: 'pi-pre', cwd: home,
      toolName: 'hashline_edit', toolInput: { path: 'a.ts' },
    } });
  }
  await completed;
}
function fatal(error: unknown) {
  report('fatal', { message: error instanceof Error ? error.message : String(error) });
  void connection.close().finally(() => process.exit(1));
}
const input = createInterface({ input: process.stdin });
let commands = Promise.resolve();
input.on('line', (line) => {
  commands = commands.then(async () => {
    if (line === 'next') await turn();
    else if (line === 'status') report('status', pids());
    else throw new Error(`unknown command: ${line}`);
  }).catch(fatal);
});
input.on('close', () => { void connection.close().finally(() => process.exit(0)); });
void (mode === 'hook' ? turn(true) : attach()).catch(fatal);
