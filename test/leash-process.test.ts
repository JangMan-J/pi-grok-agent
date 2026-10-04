// Linux process-lifetime checks: real Rust leash, Pi connection/session, fake Grok only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';

const binary = join(import.meta.dirname, '..', 'bin', 'pi-grok-leash');
const skip = process.platform !== 'linux' ? 'real leash signal checks are Linux-only'
  : !existsSync(binary) ? 'real leash binary missing; run npm run build:leash' : false;
const options = { skip, timeout: 30_000 };
type Row = Record<string, any>;
function rows(path: string): Row[] {
  if (!existsSync(path)) return [];
  // The writer may be in the middle of appending the final line.
  return readFileSync(path, 'utf8').split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
}
async function until(check: () => boolean, what: string, ms = 5000) {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
}
function signal(pid: number, name: NodeJS.Signals) {
  try { process.kill(pid, name); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
function state(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}
function setup(t: TestContext, mode: 'hook' | 'idle') {
  const home = mkdtempSync(join(tmpdir(), 'leash-process-'));
  const log = join(home, 'leash.jsonl'), grokLog = join(home, 'grok.jsonl'), marker = join(home, 'tool-ran');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('FAKE_GROK_') || key.startsWith('PI_GROK_LEASH')) delete env[key];
  const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures', 'leash-parent.ts'), home, mode], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events: Row[] = [];
  const owned = new Set<number>();
  if (child.pid) owned.add(child.pid);
  let stderr = '', spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
  const output = createInterface({ input: child.stdout });
  output.on('line', (line) => {
    const event = JSON.parse(line);
    events.push(event);
    if (event.leashPid) owned.add(event.leashPid);
    if (event.grokPid) owned.add(event.grokPid);
  });
  t.after(async () => {
    // Also cover failures before attach reported the ready pids.
    for (const row of rows(log)) if (row.params?.grokPid) owned.add(row.params.grokPid);
    for (const pid of owned) signal(pid, 'SIGCONT');
    // Kill descendants before their parent so the live parent can reap them.
    for (const pid of [...owned].reverse()) signal(pid, 'SIGKILL');
    await until(() => child.exitCode !== null || child.signalCode !== null || !!spawnError, 'harness cleanup');
    output.close();
    rmSync(home, { recursive: true, force: true });
  });
  async function waitEvent(event: string, from = 0): Promise<Row> {
    await until(() => {
      const fatal = events.find((r) => r.event === 'fatal');
      if (fatal || spawnError) throw new Error(`harness failed: ${fatal?.message ?? spawnError}; ${stderr}`);
      if (events.slice(from).some((r) => r.event === event)) return true;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`harness exited before ${event}: ${child.exitCode}/${child.signalCode}; ${stderr}`);
      return false;
    }, `harness ${event}; ${stderr}`);
    return events.slice(from).find((r) => r.event === event)!;
  }
  return { child, events, log, grokLog, marker, waitEvent, command: (line: string) => child.stdin.write(`${line}\n`) };
}
function stall(log: string): Row | undefined {
  return rows(log).find((row) => row.params?.event === 'stall')?.params;
}

test('real leash: SIGKILL Pi during a hook kills leash and Grok before fail-open', options, async (t) => {
  const s = setup(t, 'hook');
  const { leashPid, grokPid } = await s.waitEvent('attached');
  await s.waitEvent('hook-pending');
  const start = performance.now();
  s.child.kill('SIGKILL');
  await until(() => gone(leashPid) && gone(grokPid), `pdeathsig reaping (leash ${leashPid}, Grok ${grokPid})`, 500);
  t.diagnostic(`parent death: leash and Grok reaped in ${Math.round(performance.now() - start)}ms`);
  await sleep(1600); // Past the fake Grok fail-open window, even after the kill observation.
  assert.equal(existsSync(s.marker), false, 'no unguarded tool ran');
});

test('real leash: SIGSTOP Pi during a hook stalls, prevents fail-open, and ends the turn', options, async (t) => {
  const s = setup(t, 'hook');
  const { grokPid } = await s.waitEvent('attached');
  await s.waitEvent('hook-pending');
  s.child.kill('SIGSTOP');
  await until(() => state(s.child.pid!) === 'T', 'Pi stopped');
  await sleep(3000); // Deliberate Pi event-loop freeze, longer than stall and fail-open.
  assert.ok(stall(s.log), 'real leash logged stall while Pi was stopped');
  assert.equal(gone(grokPid), true, 'Grok was killed and reaped');
  assert.equal(existsSync(s.marker), false, 'no unguarded tool ran');
  s.child.kill('SIGCONT');
  const ended = await s.waitEvent('turn-ended');
  const expected = `[grok stopped by pi-grok-leash: stall after ${stall(s.log)!.ms} ms; no unguarded tool ran]`;
  assert.equal(ended.events.at(-1).type, 'error');
  assert.equal(ended.events.at(-1).error.errorMessage, expected);
  assert.equal(ended.message, expected);
});

test('real leash: idle SIGSTOP stalls too; the next turn respawns and session/loads', options, async (t) => {
  const s = setup(t, 'idle');
  const first = await s.waitEvent('attached');
  assert.equal(rows(s.grokLog).some((r) => r.id === 'session/prompt'), false);
  s.child.kill('SIGSTOP');
  await until(() => state(s.child.pid!) === 'T', 'idle Pi stopped');
  await sleep(3000);
  assert.ok(stall(s.log), 'heartbeats guard idle connections, not only pending hooks');
  assert.equal(gone(first.grokPid), true);
  assert.equal(existsSync(s.marker), false);
  s.child.kill('SIGCONT');
  await s.waitEvent('dropped');
  s.command('next');
  const next = await s.waitEvent('respawned');
  assert.notEqual(next.leashPid, first.leashPid);
  assert.notEqual(next.grokPid, first.grokPid);
  const ended = await s.waitEvent('turn-ended');
  assert.equal(ended.events.at(-1).type, 'done');
  assert.equal(ended.events.at(-1).reason, 'stop');
  assert.equal(rows(s.grokLog).filter((r) => r.id === 'session/load').length, 1);
});

test('real leash: suspending the whole trio for 15s preserves the child and next turn', options, async (t) => {
  const s = setup(t, 'idle');
  const first = await s.waitEvent('attached');
  // Freeze the watchdog first so it cannot fire during the staggered stop.
  signal(first.leashPid, 'SIGSTOP');
  await until(() => state(first.leashPid) === 'T', 'leash stopped');
  signal(first.grokPid, 'SIGSTOP');
  s.child.kill('SIGSTOP');
  await until(() => state(first.grokPid) === 'T' && state(s.child.pid!) === 'T', 'whole trio stopped');
  await sleep(15_000); // > 10 * stallMs: intentionally exercises the suspend guard.
  // Resume promptly in one synchronous turn, Pi first to restore heartbeat production.
  s.child.kill('SIGCONT');
  signal(first.grokPid, 'SIGCONT');
  signal(first.leashPid, 'SIGCONT');
  const from = s.events.length;
  s.command('status');
  const resumed = await s.waitEvent('status', from);
  assert.equal(resumed.leashPid, first.leashPid);
  assert.equal(resumed.grokPid, first.grokPid);
  s.command('next');
  const ended = await s.waitEvent('turn-ended');
  assert.equal(ended.events.at(-1).type, 'done');
  assert.equal(ended.events.at(-1).reason, 'stop');
  assert.equal(ended.leashPid, first.leashPid);
  assert.equal(ended.grokPid, first.grokPid);
  assert.equal(gone(first.leashPid), false);
  assert.equal(gone(first.grokPid), false);
  assert.equal(stall(s.log), undefined);
  assert.equal(rows(s.grokLog).filter((r) => r.id === 'spawn').length, 1);
  assert.equal(rows(s.grokLog).some((r) => r.id === 'session/load'), false);
});
