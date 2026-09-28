// Live probe: register client hooks over ACP and see what Grok sends Pi around a native tool call.
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../src/config.ts';

const config = await readConfig();
const cwd = await mkdtemp(join(tmpdir(), 'grok-hooks-probe-'));
const token = randomBytes(8).toString('hex');
await writeFile(join(cwd, 'token.txt'), token + '\n');
const evidence: Record<string, unknown> = { cwd, runs: [] as unknown[], events: [] as unknown[], checks: [] as string[] };
const runs = evidence.runs as any[]; const events = evidence.events as any[]; const checks = evidence.checks as string[];
const ws = new WebSocket(config.url, { headers: { Authorization: `Bearer ${config.secret}` }, handshakeTimeout: 10_000 });
await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
let nextId = 0; const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
let text = ''; let denied = false;
const send = (m: unknown) => ws.send(JSON.stringify(m));
const request = (method: string, params: unknown, timeoutMs = 240_000) => new Promise<any>((resolve, reject) => {
  const id = ++nextId; const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
  pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  send({ jsonrpc: '2.0', id, method, params });
});
const summarize = (p: any): Record<string, any> => ({ event: p.hookEventName, cb: p.hookCallbackId, tool: p.toolName, toolUseId: p.toolUseId, input: p.toolInput, result: typeof p.toolResult === 'string' ? p.toolResult.slice(0, 200) : p.toolResult, sessionId: p.sessionId ?? p.session_id, keys: Object.keys(p) });
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if ('id' in m && ('result' in m || 'error' in m) && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
  if (m.method === '_x.ai/hooks/run' && 'id' in m) {
    const p = m.params; const s = summarize(p); runs.push(s);
    let reply: any = { decision: 'continue' };
    // Deny the first shell call so we see the deny path; annotate a file read so we see additionalContext.
    if (p.hookEventName === 'pre_tool_use' && /terminal|bash/i.test(String(p.toolName)) && !denied) { denied = true; reply = { decision: 'deny', reason: 'Pi policy: use the file tools, not the shell, for this task.' }; }
    if (p.hookEventName === 'post_tool_use' && /read/i.test(String(p.toolName))) reply = { decision: 'continue', additionalContext: 'PI-HOOK-CONTEXT: append the word HOOKED after the token in your final answer.' };
    s.reply = reply; send({ jsonrpc: '2.0', id: m.id, result: reply }); return;
  }
  if (m.method === '_x.ai/hooks/event') { events.push(summarize(m.params)); return; }
  if (m.method === 'session/request_permission' && 'id' in m) { send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
  if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk' && m.params.update.content?.type === 'text') text += m.params.update.content.text;
});
try {
  const init = await request('initialize', { protocolVersion: 1, clientInfo: { name: 'pi-grok-hooks-probe', version: '0.1.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  evidence.advertisedHooks = init._meta?.['x.ai/hooks'];
  if ((init.authMethods ?? []).some((m: any) => m.id === 'cached_token')) await request('authenticate', { methodId: 'cached_token' });
  const session = await request('session/new', { cwd, mcpServers: [], _meta: { yoloMode: false, 'x.ai/hooks': {
    PreToolUse: [{ hookCallbackIds: ['pi-pre'], timeout: 120 }],
    PostToolUse: [{ hookCallbackIds: ['pi-post'], timeout: 120 }],
    Stop: [{ hookCallbackIds: ['pi-stop'], timeout: 120 }],
    SessionStart: [{ hookCallbackIds: ['pi-obs'] }], UserPromptSubmit: [{ hookCallbackIds: ['pi-obs'] }],
  } } });
  evidence.sessionId = session.sessionId;
  const r = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Use a shell command to print token.txt. If that is not allowed, read token.txt with a file tool instead. Reply with only the token.' }] });
  evidence.stopReason = r.stopReason; evidence.answer = text.trim();
  const pre = runs.filter((x) => x.event === 'pre_tool_use'); const post = runs.filter((x) => x.event === 'post_tool_use'); const stop = runs.filter((x) => x.event === 'stop');
  if (!pre.length) throw new Error('no pre_tool_use hook run received'); checks.push(`pre_tool_use received for ${pre.map((x) => x.tool).join(', ')}`);
  if (!pre.some((x) => x.reply?.decision === 'deny')) throw new Error('deny path not exercised'); checks.push('a shell call was denied by the Pi hook');
  if (!post.length) throw new Error('no post_tool_use hook run received'); checks.push(`post_tool_use received with results for ${post.map((x) => x.tool).join(', ')}`);
  if (!text.includes(token)) throw new Error('token missing from answer'); checks.push('Grok fell back to a file tool and returned the token');
  if (text.includes('HOOKED')) checks.push('additionalContext from the Pi hook reached the model'); else evidence.note = 'additionalContext not reflected in the answer';
  if (stop.length) checks.push('stop hook consulted at turn end');
  evidence.ok = true;
} catch (error) { evidence.ok = false; evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally { ws.close(); await writeFile(new URL('../evidence/hooks-probe.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify({ ok: evidence.ok, error: evidence.error, checks, answer: evidence.answer, runs: runs.map((r) => ({ event: r.event, tool: r.tool, reply: r.reply })), passiveEvents: events.map((e) => e.event) }, null, 1)); }
