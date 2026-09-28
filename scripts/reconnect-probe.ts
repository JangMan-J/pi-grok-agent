// Reproduces the "ACP connection closed" failure and checks the fix: a Pi RPC session on grok/<id> has the
// gateway restarted between two turns. Turn 2 must reconnect, session/load the same Grok session, and keep
// context from turn 1. Refuses to run when another client is attached to the gateway.
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const model = process.argv[2] ?? 'grok-4.7';
// mode: gateway (restart the whole gateway) or leader (SIGTERM only the Grok leader; the gateway must respawn it)
const mode = process.argv[3] ?? 'gateway';
const established = Number(execSync("ss -tn '( sport = :2419 )' | grep -c ESTAB || true").toString().trim() || 0);
if (established > 0) { console.log('SKIP: another client is attached to the gateway'); process.exit(2); }
const cwd = await mkdtemp(join(tmpdir(), 'pi-grok-reconnect-'));
const token = randomBytes(6).toString('hex');
const pidFile = join(homedir(), '.pi', 'agent', 'grok-ws.pid');
const gatewayPidAtStart = Number((await readFile(pidFile, 'utf8')).trim());

async function restartGateway() {
  const old = Number((await readFile(pidFile, 'utf8')).trim());
  process.kill(old, 'SIGTERM');
  for (;;) { try { process.kill(old, 0); await new Promise((r) => setTimeout(r, 200)); } catch { break; } }
  const child = spawn(process.execPath, ['scripts/server.ts'], { cwd: new URL('..', import.meta.url).pathname, detached: true, stdio: 'ignore' });
  child.unref();
  await writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
  for (;;) { if (execSync("ss -ltn '( sport = :2419 )'").toString().includes('2419')) break; await new Promise((r) => setTimeout(r, 300)); }
}

async function killLeader() {
  // The leader is the gateway's child running `agent leader`; pgrep -f would also match this probe's own shell.
  const leaderPids = () => execSync(`pgrep -P ${gatewayPidAtStart} -f 'agent leader' || true`).toString().trim().split(/\s+/).filter(Boolean);
  const before = leaderPids();
  if (!before.length) throw new Error('no leader child under the gateway');
  for (const pid of before) process.kill(Number(pid), 'SIGTERM');
  // wait for the gateway to respawn a leader with a new pid and its socket to answer
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const now = leaderPids();
    if (now.length && !now.some((p) => before.includes(p))) { await new Promise((r) => setTimeout(r, 2000)); return; }
  }
  throw new Error('leader was not respawned');
}

const pi = spawn('pi', ['--mode', 'rpc', '--model', `grok/${model}`, '--no-session', '--no-context-files', '--no-skills', '--no-prompt-templates'], { cwd, env: { ...process.env, PI_GROK_HEADLESS_PERMISSIONS: 'allow' }, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const events: any[] = []; let idle: (() => void) | undefined;
pi.stdout.on('data', (d) => { buf += d; for (;;) { const i = buf.indexOf('\n'); if (i < 0) break; const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const e = JSON.parse(line); events.push(e); if (e.type === 'agent_settled' || e.type === 'agent_end') idle?.(); } catch {} } });
const prompt = (text: string) => new Promise<void>((resolve) => { idle = resolve; pi.stdin.write(JSON.stringify({ type: 'prompt', message: text }) + '\n'); });
const lastAssistant = () => [...events].reverse().find((e) => e.type === 'message_end' && e.message?.role === 'assistant')?.message;

await prompt(`Remember this token for later: ${token}. Reply with only the word stored.`);
const a1 = lastAssistant();
const grokSession = events.find((e) => e.type === 'entry_appended' && e.entry?.customType === 'grok-model-session')?.entry?.data?.grokSessionId;
if (mode === 'leader') await killLeader(); else await restartGateway();
await prompt('What was the token I asked you to remember? Reply with only the token.');
const a2 = lastAssistant();
const text2 = (a2?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
const think2 = (a2?.content ?? []).filter((c: any) => c.type === 'thinking').map((c: any) => c.thinking).join('');
const ok = a1?.stopReason === 'stop' && a2?.stopReason === 'stop' && text2.includes(token) && /\[grok reconnected after/.test(think2);
const evidence = { ok, model, grokSessionId: grokSession, turn1: { stop: a1?.stopReason }, disruption: mode, gatewayPidUnchanged: mode === 'leader' ? Number((await readFile(pidFile, 'utf8')).trim()) === gatewayPidAtStart : undefined, turn2: { stop: a2?.stopReason, error: a2?.errorMessage, tokenRecalled: text2.includes(token), reconnectNote: think2.match(/\[grok reconnected[^\]]*\]/)?.[0] } };
await writeFile(new URL(`../evidence/reconnect-probe${mode === 'leader' ? '-leader' : ''}.json`, import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 1));
pi.stdin.end(); pi.kill('SIGTERM');
process.exit(ok ? 0 : 1);
