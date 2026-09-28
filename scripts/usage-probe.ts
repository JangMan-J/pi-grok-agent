// What usage fields does Grok send, and where? Two prompts in one session so the second can show cache reads.
import WebSocket from 'ws'; import { readConfig } from '../src/config.ts';
const c = await readConfig(); const ws = new WebSocket(c.url, { headers: { Authorization: `Bearer ${c.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, any>(); const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
const usageFrames: any[] = [];
const scan = (obj: any, path: string, out: string[]) => { if (!obj || typeof obj !== 'object') return; for (const [k, v] of Object.entries(obj)) { const kp = path ? `${path}.${k}` : k; if (/usage|token|cache|cost/i.test(k)) out.push(`${kp}=${JSON.stringify(v).slice(0, 160)}`); if (v && typeof v === 'object' && out.length < 40) scan(v, kp, out); } };
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id); p.delete(m.id); const hits: string[] = []; scan(m.result, 'result', hits); if (hits.length) usageFrames.push({ where: 'response', hits }); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === 'session/request_permission') { send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
  const hits: string[] = []; scan(m.params, 'params', hits); if (hits.length) usageFrames.push({ where: m.method + (m.params?.update?.sessionUpdate ? ':' + m.params.update.sessionUpdate : ''), hits }); });
await req('initialize', { protocolVersion: 1, clientInfo: { name: 'usage', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
const s = await req('session/new', { cwd: '/tmp', mcpServers: [], _meta: { yoloMode: false } });
for (const t of ['Reply with the single word one.', 'Reply with the single word two.']) { usageFrames.length = 0; await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: t }] }); console.log(`== after "${t}"`); for (const f of usageFrames) console.log(' ', f.where, '\n    ' + f.hits.join('\n    ')); }
ws.close();
