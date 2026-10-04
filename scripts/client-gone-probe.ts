// Live probe: what does the leader do with a running turn when its stdio client dies while a pre_tool_use
// hook is pending? Spawns `grok agent --leader stdio` directly (no gateway), registers the hook, asks for a
// shell command that leaves a marker file, and kills the client instead of answering the hook.
//   marker appears  -> the leader kept the turn and ran the tool after the hook timed out (fail open)
//   marker absent   -> the leader cancelled the turn with its client
// `control` mode answers the hook with continue, to show the same prompt creates the marker when allowed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mode = process.argv[2] === 'control' ? 'control' : 'kill';
// `--no-leader`: one agent process per client instead of a shared leader. Does the tool die with the client then?
const noLeader = process.argv.includes('--no-leader');
const hookTimeoutS = 10;
const leaderSocket = process.env.PI_GROK_LEADER_SOCKET || join(homedir(), '.grok', 'pi', 'leader.sock');
const cwd = await mkdtemp(join(tmpdir(), 'grok-client-gone-'));
const marker = join(cwd, 'marker.txt');
const evidence: Record<string, unknown> = { mode, noLeader, cwd, leaderSocket, hookTimeoutS, timeline: [] as string[] };
const timeline = evidence.timeline as string[];
const t0 = Date.now(); const log = (s: string) => { timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`); console.error(timeline.at(-1)); };

const args = noLeader ? ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'] : ['--permission-mode', 'default', 'agent', '--leader', 'stdio', '--leader-socket', leaderSocket];
const child = spawn(process.env.PI_GROK_BINARY || 'grok', args, { stdio: ['pipe', 'pipe', 'inherit'] });
evidence.clientPid = child.pid;
let nextId = 0; const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
const request = (method: string, params: unknown, timeoutMs = 120_000) => new Promise<any>((resolve, reject) => {
  const id = ++nextId; const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
  pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  send({ jsonrpc: '2.0', id, method, params });
});
let buffer = ''; let killed = false; let text = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if ('id' in m && ('result' in m || 'error' in m) && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); continue; }
    if (m.method === '_x.ai/hooks/run' && 'id' in m) {
      const p = m.params; log(`hook ${p.hookEventName} for ${p.toolName}`);
      if (p.hookEventName === 'pre_tool_use' && mode === 'kill' && !killed) { killed = true; log(`SIGKILL client pid ${child.pid} with the hook unanswered`); child.kill('SIGKILL'); continue; }
      send({ jsonrpc: '2.0', id: m.id, result: { decision: 'continue' } }); continue;
    }
    if (m.method === 'session/request_permission' && 'id' in m) { log(`permission prompt for ${m.params?.toolCall?.title ?? '?'}: allowing`); const opt = (m.params.options ?? []).find((o: any) => /allow/i.test(o.kind ?? o.optionId))?.optionId; send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt } } }); continue; }
    if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk' && m.params.update.content?.type === 'text') text += m.params.update.content.text;
    if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'tool_call') log(`tool_call ${m.params.update.title ?? m.params.update.kind ?? ''}`);
  }
});
child.on('exit', (code, sig) => log(`client exited code=${code} signal=${sig}`));

try {
  const init = await request('initialize', { protocolVersion: 1, clientInfo: { name: 'pi-grok-client-gone-probe', version: '0.1.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  if ((init.authMethods ?? []).some((m: any) => m.id === 'cached_token')) await request('authenticate', { methodId: 'cached_token' });
  const session = await request('session/new', { cwd, mcpServers: [], _meta: { yoloMode: true, 'x.ai/hooks': { PreToolUse: [{ hookCallbackIds: ['pi-pre'], timeout: hookTimeoutS }] } } });
  evidence.sessionId = session.sessionId; log(`session ${session.sessionId}`);
  const prompt: Promise<any> = request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Run exactly this shell command in the current directory and nothing else: touch marker.txt . Then reply with the single word done.' }] }, 90_000);
  prompt.catch(() => {}); // in kill mode the client is gone before it answers
  if (mode === 'control') { const r = await prompt; log(`prompt finished: ${r.stopReason}; answer: ${text.trim().slice(0, 60)}`); }
  else {
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Wait past the hook timeout plus a margin: a fail-open leader would run the tool by then.
    const waitS = hookTimeoutS + 15; log(`waiting ${waitS}s for marker`);
    const until = Date.now() + waitS * 1000;
    while (Date.now() < until && !existsSync(marker)) await new Promise((r) => setTimeout(r, 500));
  }
  evidence.markerExists = existsSync(marker); log(`marker exists: ${evidence.markerExists}`);
  evidence.verdict = mode === 'control'
    ? (evidence.markerExists ? 'control: the prompt creates the marker when the hook answers continue' : 'control: no marker; the prompt did not produce the tool call')
    : (evidence.markerExists ? 'FAIL OPEN: leader ran the tool after its client died with the hook unanswered' : 'leader did not run the tool after its client died');
  evidence.ok = true;
} catch (error) { evidence.ok = false; evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  if (!child.killed && child.exitCode == null) child.kill();
  await writeFile(new URL(`../evidence/client-gone-probe-${mode}${noLeader ? '-no-leader' : ''}.json`, import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: evidence.ok, verdict: evidence.verdict, error: evidence.error, timeline }, null, 1));
}
