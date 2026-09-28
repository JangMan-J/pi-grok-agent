import WebSocket from 'ws'; import { readConfig } from '../src/config.ts';
const c = await readConfig(); const ws = new WebSocket(c.url, { headers: { Authorization: `Bearer ${c.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, any>(); const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
let text = ''; const notes: string[] = [];
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id); p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === 'session/request_permission') { send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
  if (m.method === 'session/update') { const u = m.params.update; if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text; else if (u.sessionUpdate !== 'agent_thought_chunk') notes.push(u.sessionUpdate + (u.title ? ' ' + u.title : '') + (u.currentModeId ? ' mode=' + u.currentModeId : '')); }
  else if (m.method?.startsWith('_x.ai/') && !/session_notification|queue|sessions\/changed|session\/setup|settings|announcements|models/.test(m.method)) notes.push(m.method + ' ' + JSON.stringify(m.params).slice(0, 160)); });
const init = await req('initialize', { protocolVersion: 1, clientInfo: { name: 'cmds', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
console.log('commands:', JSON.stringify(init._meta?.availableCommands?.map((x: any) => ({ n: x.name, d: (x.description ?? '').slice(0, 70), in: x.input?.hint })), null, 0));
const s = await req('session/new', { cwd: '/tmp', mcpServers: [], _meta: { yoloMode: false } });
const sid = s.sessionId; console.log('session keys:', Object.keys(s), 'meta keys:', Object.keys(s._meta ?? {}));
for (const [label, prompt] of [['goal-status', '/goal'], ['plan-enter', 'Enter plan mode now using your enter_plan_mode tool, then say which mode you are in.'], ['context', '/context']]) {
  text = ''; notes.length = 0; const t0 = Date.now();
  const r = await req('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: prompt }] });
  console.log(`\n== ${label} (${Date.now() - t0}ms, stop=${r.stopReason})\n  text: ${text.trim().slice(0, 240).replace(/\n/g, ' | ')}\n  events: ${[...new Set(notes)].slice(0, 8).join(' ; ')}`);
}
try { const m = await req('session/set_mode', { sessionId: sid, modeId: 'plan' }); console.log('\nset_mode plan ->', JSON.stringify(m)); } catch (e) { console.log('\nset_mode plan -> error', String(e).slice(0, 160)); }
ws.close();
