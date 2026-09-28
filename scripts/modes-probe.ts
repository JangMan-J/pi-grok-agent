import WebSocket from 'ws'; import { readConfig } from '../src/config.ts';
const c = await readConfig(); const ws = new WebSocket(c.url, { headers: { Authorization: `Bearer ${c.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, any>(); const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
const cmds: any[] = [];
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id); p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === 'session/update' && m.params.update?.sessionUpdate === 'available_commands_update') cmds.push(...m.params.update.availableCommands); });
const init = await req('initialize', { protocolVersion: 1, clientInfo: { name: 'modes', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
const s = await req('session/new', { cwd: '/tmp', mcpServers: [], _meta: { yoloMode: false } });
await new Promise((r) => setTimeout(r, 1500));
console.log('modes:', JSON.stringify(s.modes));
console.log('init availableCommands (sample):', (init._meta?.availableCommands ?? []).map((x: any) => x.name).slice(0, 60).join(' '));
console.log('session availableCommands:', cmds.map((x) => x.name + (x.input ? '<' + (x.input.hint ?? 'arg') + '>' : '')).join(' '));
ws.close();
