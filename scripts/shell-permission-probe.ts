// Raw ACP: what does Grok do with a shell call when the client cancels every permission request?
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../src/config.ts';

const c = await readConfig();
const cwd = await mkdtemp(join(tmpdir(), 'grok-shell-perm-'));
await writeFile(join(cwd, 'token.txt'), 'tok\n');
const ws = new WebSocket(c.url, { headers: { Authorization: `Bearer ${c.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, { res(v: any): void; rej(e: Error): void }>(); const log: string[] = [];
const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id)!; p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === 'session/request_permission') { log.push(`PERMISSION ${m.params.toolCall?.title} options=${m.params.options.map((o: any) => o.kind).join('/')}`); send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
  if (m.method === 'session/update') {
    const u = m.params.update;
    if (u.sessionUpdate === 'tool_call') log.push(`TOOL ${u.title}`);
    if (u.sessionUpdate === 'tool_call_update' && u.status) log.push(`  status ${u.status} ${JSON.stringify(u.content ?? '').slice(0, 400)} meta=${JSON.stringify(u._meta ?? '').slice(0, 300)}`);
    if (u.sessionUpdate === 'agent_message_chunk') log.push(`TEXT ${String(u.content?.text ?? '').slice(0, 120)}`);
  }
});
await req('initialize', { protocolVersion: 1, clientInfo: { name: 'dbg', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
const s = await req('session/new', { cwd, mcpServers: [], _meta: { yoloMode: false } });
const t = setTimeout(() => { log.push('TIMEOUT 120s'); console.log(log.join('\n')); process.exit(2); }, 120_000);
const prompt = process.env.PROBE_PROMPT ?? 'Run the shell command: cat token.txt. Reply with only the output.';
const r = await req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: prompt }] });
clearTimeout(t);
log.push(`STOP ${r.stopReason}`);
console.log(log.join('\n'));
ws.close();
