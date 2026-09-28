// What does x.ai/mcp/list expose per tool for a session with a Pi-hosted server whose tools carry _meta and annotations?
import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import WebSocket from 'ws'; import { readConfig } from '../src/config.ts';
const c = await readConfig(); const cwd = await mkdtemp(join(tmpdir(), 'grok-mcplist-'));
const serverId = `pi-list-${Date.now()}`; const base = new URL(c.url).origin.replace(/^ws/, 'http');
const ws = new WebSocket(c.url, { headers: { Authorization: `Bearer ${c.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, { res(v: any): void; rej(e: Error): void }>();
const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
ws.on('message', (d) => { const m = JSON.parse(d.toString());
  if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id)!; p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === '_x.ai/mcp/sdk_call') { const msg = m.params.message; const reply = (result: unknown) => send({ jsonrpc: '2.0', id: m.id, result: { jsonrpc: '2.0', id: msg.id, result } });
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pi', version: '0' } });
    else if (msg.method === 'tools/list') reply({ tools: [{ name: 'lookup', description: 'read-only lookup', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, title: 'Lookup' }, _meta: { 'pi/readOnly': true, custom: 'x' } }] });
    else send({ jsonrpc: '2.0', id: m.id, result: { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'n/a' } } }); } });
await req('initialize', { protocolVersion: 1, clientInfo: { name: 'l', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
const s = await req('session/new', { cwd, mcpServers: [{ type: 'http', name: 'pi', url: `${base}/mcp/${serverId}`, headers: [] }], _meta: { yoloMode: false } });
await new Promise((r) => setTimeout(r, 6000));
const list = await req('_x.ai/mcp/list', { sessionId: s.sessionId });
const body = list.result ?? list; const pi = (body.servers ?? body.mcpServers ?? (Array.isArray(body) ? body : [])).find((x: any) => x.name === 'pi');
console.log(JSON.stringify({ topLevelKeys: Object.keys(list.result ?? list), piServer: pi }, null, 1));
ws.close();
