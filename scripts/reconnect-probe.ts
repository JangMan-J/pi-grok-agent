// Live, opt-in: restart Pi, resume its persisted session, and session/load the stored Grok ID.
// Only this probe's Pi processes are stopped. No shared process, port, or PID file is touched.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const model = process.argv[2] ?? 'grok-4.7';
const cwd = await mkdtemp(join(tmpdir(), 'pi-grok-reconnect-'));
const sessionDir = join(cwd, 'pi-sessions');
const token = randomBytes(6).toString('hex');
const extension = fileURLToPath(new URL('../src/model.ts', import.meta.url));
const evidence: Record<string, any> = { model, cwd, node: process.version };

function startPi(sessionFile?: string) {
  // `pi --help`: --session <path|id> resumes a specific file; --resume opens a selector.
  const child = spawn('pi', ['--mode', 'rpc', '--model', `grok/${model}`, '--session-dir', sessionDir,
    ...(sessionFile ? ['--session', sessionFile] : []), '--no-extensions', '-e', extension,
    '--no-context-files', '--no-skills', '--no-prompt-templates'], {
    cwd, env: { ...process.env, PI_GROK_PI_TOOLS: 'none', PI_GROK_HEADLESS_PERMISSIONS: 'deny' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: any[] = [];
  let stderr = ''; let buffer = ''; let nextId = 0;
  const listeners = new Set<(event: any) => void>();
  let exitError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => { exitError = error; resolve(); });
    child.once('close', () => { exitError ??= new Error(`Pi exited: ${stderr}`); resolve(); });
  });
  child.stdin.on('error', () => {}); // an early Pi exit is reported by the close promise
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.on('data', (data) => {
    buffer += data;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const event = JSON.parse(line); events.push(event); for (const listener of listeners) listener(event); } catch { /* non-JSON startup text */ }
    }
  });
  async function sendUntil(command: Record<string, unknown>, matches: (event: any) => boolean) {
    let timer: ReturnType<typeof setTimeout>;
    let listener: (event: any) => void;
    const result = new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Pi RPC timed out')), 240_000);
      listener = (event) => {
        if (event.type === 'response' && event.id === command.id && event.success === false) reject(new Error(JSON.stringify(event)));
        else if (matches(event)) resolve(event);
      };
      listeners.add(listener);
      child.stdin.write(JSON.stringify(command) + '\n');
    });
    try { return await Promise.race([result, exited.then(() => { throw exitError; })]); }
    finally { clearTimeout(timer!); listeners.delete(listener!); }
  }
  return {
    async prompt(message: string) {
      await sendUntil({ type: 'prompt', id: String(++nextId), message }, (event) => event.type === 'agent_end' || event.type === 'agent_settled');
      return [...events].reverse().find((event) => event.type === 'message_end' && event.message?.role === 'assistant')?.message;
    },
    async sessionFile() {
      const id = String(++nextId);
      const response = await sendUntil({ type: 'get_state', id }, (event) => event.type === 'response' && event.id === id);
      if (!response.data?.sessionFile) throw new Error('Pi did not persist a session file');
      return response.data.sessionFile as string;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) { await exited; return; }
      // Observe only direct children of this exact Pi, never search or signal unrelated Grok processes.
      const children = spawnSync('ps', ['-o', 'pid=,args=', '--ppid', String(child.pid)], { encoding: 'utf8' });
      const agents = (children.stdout ?? '').split('\n').filter((row) => /agent\s+--no-leader\s+stdio/.test(row)).map((row) => Number(row.trim().split(/\s+/)[0]));
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stdin.end();
      await exited;
      clearTimeout(kill);
      const deadline = Date.now() + 5000;
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      while (agents.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (children.error) throw children.error;
      if (!agents.length) throw new Error('No direct stdio agent child observed before Pi shutdown');
      if (agents.some(alive)) throw new Error(`This Pi's agent child survived shutdown: ${agents.filter(alive).join(', ')}`);
      return { agentPids: agents, agentsExited: true };
    },
  };
}
async function grokId(file: string) {
  const entries = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const id = entries.findLast((entry) => entry.type === 'custom' && entry.customType === 'grok-model-session')?.data?.grokSessionId;
  if (typeof id !== 'string') throw new Error('No persisted grok-model-session id');
  return id;
}
let current: ReturnType<typeof startPi> | undefined;
try {
  evidence.grok = execFileSync(process.env.PI_GROK_BINARY ?? 'grok', ['--version'], { encoding: 'utf8' }).trim();
  evidence.pi = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
  current = startPi();
  const first = await current.prompt(`Remember this token for later: ${token}. Reply with only the word stored.`);
  const sessionFile = await current.sessionFile();
  evidence.grokSessionId = await grokId(sessionFile);
  evidence.turn1 = { stop: first?.stopReason, error: first?.errorMessage };
  const firstPi = current; current = undefined;
  evidence.firstShutdown = await firstPi.stop();
  current = startPi(sessionFile);
  const second = await current.prompt('What was the token I asked you to remember? Reply with only the token.');
  const text = (second?.content ?? []).filter((content: any) => content.type === 'text').map((content: any) => content.text).join('');
  evidence.turn2 = { stop: second?.stopReason, error: second?.errorMessage };
  evidence.tokenRecalled = text.includes(token);
  evidence.sameGrokSession = await grokId(sessionFile) === evidence.grokSessionId;
  evidence.ok = first?.stopReason === 'stop' && second?.stopReason === 'stop' && evidence.tokenRecalled && evidence.sameGrokSession;
} catch (error) {
  evidence.ok = false; evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  try { if (current) evidence.finalShutdown = await current.stop(); }
  catch (error) { evidence.ok = false; evidence.shutdownError = String(error); }
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await writeFile(new URL('../evidence/reconnect-probe.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
}
