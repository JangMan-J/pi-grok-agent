// Send a second session/prompt while the first is running. Does Grok queue it (steer or follow-up), reject it, or merge it?
import WebSocket from 'ws'; import { readConfig } from '../src/config.ts';
const c = await readConfig(); const ws = new WebSocket(c.url, { headers: { Authorization: `Bearer ${c.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, any>(); const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
const t0 = Date.now(); const log: string[] = []; let text = '';
ws.on('message', (d) => { const m = JSON.parse(d.toString());
  if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id); p.delete(m.id); log.push(`${Date.now() - t0}ms response id=${m.id} ${m.error ? 'ERROR ' + JSON.stringify(m.error).slice(0, 120) : 'stop=' + m.result?.stopReason}`); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === '_x.ai/queue/changed') log.push(`${Date.now() - t0}ms queue/changed entries=${JSON.stringify(m.params.entries).slice(0, 160)} running=${m.params.runningKind ?? ''}`);
  if (m.method === 'session/update' && m.params.update?.sessionUpdate === 'agent_message_chunk') text += m.params.update.content?.text ?? '';
  if (m.method === 'session/update' && m.params.update?.sessionUpdate === 'user_message_chunk') log.push(`${Date.now() - t0}ms user_message_chunk ${JSON.stringify(m.params.update.content?.text).slice(0, 80)}`);
  if (m.method === 'session/request_permission') send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }); });
await req('initialize', { protocolVersion: 1, clientInfo: { name: 'q', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
const s = await req('session/new', { cwd: '/tmp', mcpServers: [], _meta: { yoloMode: false } });
const first = req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Write the numbers from one to sixty as words, one per line, no other text. Then say done.' }] });
await new Promise((r) => setTimeout(r, 1500));
log.push(`${Date.now() - t0}ms sending second prompt while first runs (text so far: ${text.split('\n').length} lines)`);
const mode = process.argv[2] ?? 'prompt';
const second = mode === 'interject'
  ? req('_x.ai/interject', { sessionId: s.sessionId, text: 'Actually stop counting and just say the word BANANA.' })
  : req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Actually stop counting and just say the word BANANA.' }] });
log.push(`mode=${mode}`);
await Promise.allSettled([first, second]);
await new Promise((r) => setTimeout(r, 1000));
console.log(log.join('\n')); console.log('--- text:', JSON.stringify(text.slice(0, 300)));
ws.close();
