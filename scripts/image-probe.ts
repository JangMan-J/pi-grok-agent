// Live: images in both directions through raw ACP on the active gateway.
//   outbound: Grok's image_gen -> capture the tool_call_update content and the post_tool_use toolResult envelope; locate the file
//   inbound:  send an ACP image content block in session/prompt -> does Grok accept it and describe the image?
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../src/config.ts';

const config = await readConfig();
const cwd = await mkdtemp(join(tmpdir(), 'grok-image-'));
const evidence: Record<string, unknown> = { cwd };
const ws = new WebSocket(config.url, { headers: { Authorization: `Bearer ${config.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, { res(v: any): void; rej(e: Error): void }>();
const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
const updates: any[] = []; const hookResults: any[] = []; let text = '';
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id)!; p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === 'session/request_permission') { const o = m.params.options.find((o: any) => o.kind === 'allow_once'); send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: o.optionId } } }); return; }
  if (m.method === '_x.ai/hooks/run') { if (m.params.hookEventName === 'post_tool_use') hookResults.push({ tool: m.params.toolName, toolResult: m.params.toolResult }); send({ jsonrpc: '2.0', id: m.id, result: { decision: 'continue' } }); return; }
  if (m.method === 'session/update') { const u = m.params.update; if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') updates.push(u); if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text; }
});
await req('initialize', { protocolVersion: 1, clientInfo: { name: 'image-probe', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
const s = await req('session/new', { cwd, mcpServers: [], _meta: { yoloMode: false, 'x.ai/hooks': { PostToolUse: [{ hookCallbackIds: ['pi-post'], timeout: 600 }] } } });

// outbound
const r1 = await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Use image_gen once to generate a small simple image of a single red circle on a white background. Then reply with only the absolute path of the saved file.' }] });
const gen = updates.filter((u) => /image_gen/i.test(String(u.title ?? '')) || /image/i.test(String(u.kind ?? '')));
const finalUpdate = [...updates].reverse().find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
const hook = hookResults.find((h) => /image_gen/.test(String(h.tool)));
const pathMatch = text.match(/\/[^\s`'"]+\.(png|jpg|jpeg|webp)/i);
let fileBytes: number | undefined; let header = '';
if (pathMatch) { try { const b = await readFile(pathMatch[0]); fileBytes = b.length; header = b.subarray(0, 8).toString('hex'); } catch {} }
evidence.outbound = { stopReason: r1.stopReason, answer: text.trim().slice(-300), toolCallUpdates: gen.slice(0, 6).map((u) => ({ kind: u.sessionUpdate, title: u.title, toolKind: u.kind, status: u.status, content: JSON.stringify(u.content ?? '').slice(0, 400), meta: JSON.stringify(u._meta ?? '').slice(0, 300) })), lastCompleted: finalUpdate ? JSON.stringify(finalUpdate).slice(0, 600) : undefined, postToolUseResult: hook ? JSON.stringify(hook.toolResult).slice(0, 800) : undefined, pathFromAnswer: pathMatch?.[0], fileBytes, magic: header, isPng: header.startsWith('89504e47') };

// inbound: 1x1 red PNG
text = '';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
let inbound: Record<string, unknown>;
try {
  const r2 = await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'What color is the attached image? Answer with one word. Do not use any tools.' }, { type: 'image', data: png, mimeType: 'image/png' }] });
  inbound = { accepted: true, stopReason: r2.stopReason, answer: text.trim().slice(0, 200) };
} catch (error) { inbound = { accepted: false, error: error instanceof Error ? error.message : String(error) }; }
// fallback: path in prompt
text = '';
const tmpPng = join(cwd, 'red.png'); await writeFile(tmpPng, Buffer.from(png, 'base64'));
const r3 = await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: `There is an image at ${tmpPng}. What color is it? Answer with one word.` }] });
inbound.pathFallback = { stopReason: r3.stopReason, answer: text.trim().slice(0, 200), toolsUsed: [...new Set(updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => u.title))].slice(-4) };
evidence.inbound = inbound;
await writeFile(new URL('../evidence/image-probe.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 1));
ws.close();
