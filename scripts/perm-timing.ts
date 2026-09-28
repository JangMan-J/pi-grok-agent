// Time Grok's permission round trip: stamp when the request arrives, answer immediately, stamp when the tool status changes.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../src/config.ts';
const c = await readConfig();
const cwd = await mkdtemp(join(tmpdir(), 'grok-perm-timing-'));
await writeFile(join(cwd, 'a.txt'), 'x\n');
const ws = new WebSocket(c.url, { headers: { Authorization: `Bearer ${c.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, { res(v: any): void; rej(e: Error): void }>();
const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
const t0 = Date.now(); const ev: { t: number; what: string }[] = [];
const mark = (what: string) => ev.push({ t: Date.now() - t0, what });
let hookRuns = 0, perms = 0;
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id)!; p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === 'session/request_permission') { perms++; mark(`perm_request ${m.params.toolCall?.title}`); const o = m.params.options.find((o: any) => o.kind === 'allow_once'); send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: o.optionId } } }); mark('perm_answered'); return; }
  if (m.method === '_x.ai/hooks/run') { hookRuns++; mark(`hook ${m.params.hookEventName} ${m.params.toolName ?? ''}`); send({ jsonrpc: '2.0', id: m.id, result: { decision: 'continue' } }); return; }
  if (m.method === 'session/update') { const u = m.params.update; if (u.sessionUpdate === 'tool_call') mark(`tool_call ${u.title}`); if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) mark(`tool_${u.status}`); }
});
await req('initialize', { protocolVersion: 1, clientInfo: { name: 'timing', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
const hooks = process.env.HOOKS === '1' ? { 'x.ai/hooks': { PreToolUse: [{ hookCallbackIds: ['h'], timeout: 600 }], PostToolUse: [{ hookCallbackIds: ['h'], timeout: 600 }], Stop: [{ hookCallbackIds: ['h'], timeout: 600 }] } } : {};
const s = await req('session/new', { cwd, mcpServers: [], _meta: { yoloMode: false, ...hooks } });
const prompt = 'Using shell commands with output redirection, do these three steps one at a time: 1) echo one > b.txt  2) echo two >> b.txt  3) cat b.txt. Reply with only the final cat output.';
const start = Date.now();
const r = await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: prompt }] });
const total = Date.now() - start;
// pair each perm_request with the next perm_answered and the next tool status
const gaps: number[] = []; const toolGaps: number[] = [];
for (let i = 0; i < ev.length; i++) if (ev[i].what.startsWith('perm_request')) {
  const ans = ev.slice(i + 1).find((e) => e.what === 'perm_answered'); const done = ev.slice(i + 1).find((e) => e.what.startsWith('tool_completed') || e.what.startsWith('tool_failed'));
  if (ans) gaps.push(ans.t - ev[i].t); if (done) toolGaps.push(done.t - ev[i].t);
}
console.log(JSON.stringify({ hooks: process.env.HOOKS === '1', stop: r.stopReason, totalMs: total, permissionPrompts: perms, hookRuns, clientAnswerMs: gaps, promptToToolDoneMs: toolGaps, timeline: ev.map((e) => `${e.t}ms ${e.what}`) }, null, 1));
ws.close();
