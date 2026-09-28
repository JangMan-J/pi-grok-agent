// Live: MCP/plugin tools through the capability gate in a read-only Pi session.
// Two client-hosted MCP servers reach Grok via the gateway relay:
//   marked:   tool `peek` with _meta.readOnlyHint  -> gate must allow
//   unmarked: tool `poke` with no marker           -> gate must deny (Pi cannot verify it only reads)
// The probe plays the Pi side of the hooks with piToolNames = ['read'] (read-only) using the real gate code.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../src/config.ts';
import { capabilityGate, classify, mcpServerOf, type GrokToolStamp } from '../src/model/hooks.ts';

const config = await readConfig();
const cwd = await mkdtemp(join(tmpdir(), 'grok-mcp-gate-'));
const base = new URL(config.url).origin.replace(/^ws/, 'http');
const ids = { marked: `pi-marked-${Date.now()}`, unmarked: `pi-unmarked-${Date.now()}` };
const calls: string[] = []; const decisions: { tool: string; allow: boolean; reason?: string }[] = []; let text = '';
const stamps = new Map<string, GrokToolStamp>(); let toolMeta: Map<string, unknown> | undefined;

const ws = new WebSocket(config.url, { headers: { Authorization: `Bearer ${config.secret}` } });
await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
let n = 0; const p = new Map<number, { res(v: any): void; rej(e: Error): void }>();
const send = (m: unknown) => ws.send(JSON.stringify(m));
const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
const serveMcp = (serverId: string, m: any) => {
  const msg = m.params.message; const which = serverId === ids.marked ? 'marked' : 'unmarked';
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: m.id, result: { jsonrpc: '2.0', id: msg.id, result } });
  if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: which, version: '0' } });
  if (msg.method === 'tools/list') return reply({ tools: which === 'marked'
    ? [{ name: 'peek', description: 'Returns the secret word. Read-only.', inputSchema: { type: 'object', properties: {} }, _meta: { readOnlyHint: true } }]
    : [{ name: 'poke', description: 'Returns the other secret word.', inputSchema: { type: 'object', properties: {} } }] });
  if (msg.method === 'tools/call') { calls.push(`${which}:${msg.params?.name}`); return reply({ content: [{ type: 'text', text: which === 'marked' ? 'MARBLE' : 'PEBBLE' }] }); }
  send({ jsonrpc: '2.0', id: m.id, result: { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'n/a' } } });
};
let sessionId = '';
ws.on('message', async (d) => {
  const m = JSON.parse(d.toString());
  if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id)!; p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
  if (m.method === '_x.ai/mcp/sdk_call') return serveMcp(m.params.serverId, m);
  if (m.method === 'session/request_permission') return send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } });
  if (m.method === 'session/update') {
    const u = m.params.update;
    if (u.sessionUpdate === 'tool_call') { const st = u._meta?.['x.ai/tool']; if (st) stamps.set(String(u.toolCallId), st); }
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text;
    return;
  }
  if (m.method === '_x.ai/hooks/run') {
    send({ jsonrpc: '2.0', method: 'pi/gate-ack', params: { key: m.params.hookEventName === 'stop' ? `stop:${m.params.sessionId}` : `${m.params.hookEventName}:${m.params.toolUseId}`, check: m.params.hookEventName !== 'pre_tool_use' } });
    if (m.params.hookEventName !== 'pre_tool_use') return send({ jsonrpc: '2.0', id: m.id, result: { decision: 'continue' } });
    const tool = String(m.params.toolName ?? ''); const stamp = stamps.get(String(m.params.toolUseId));
    if ((classify(tool, stamp) === 'mcp' || mcpServerOf(tool)) && !toolMeta) {
      toolMeta = new Map();
      try { const raw: any = await req('_x.ai/mcp/list', { sessionId }); for (const s of (raw?.result ?? raw)?.servers ?? []) for (const t of s?.session?.tools ?? []) if (t?._meta) toolMeta.set(`${s.name}__${t.name}`, t._meta); } catch {}
    }
    const v = capabilityGate(['read'], {}, (t) => toolMeta?.get(t))(tool, stamp);
    decisions.push({ tool, allow: v.allow, reason: (v as any).reason });
    return send({ jsonrpc: '2.0', id: m.id, result: v.allow ? { decision: 'continue' } : { decision: 'deny', reason: (v as any).reason } });
  }
});
await req('initialize', { protocolVersion: 1, clientInfo: { name: 'mcp-gate', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
const s = await req('session/new', { cwd, mcpServers: [
  { type: 'http', name: 'marked', url: `${base}/mcp/${ids.marked}`, headers: [] },
  { type: 'http', name: 'unmarked', url: `${base}/mcp/${ids.unmarked}`, headers: [] },
], _meta: { yoloMode: false, 'x.ai/hooks': { PreToolUse: [{ hookCallbackIds: ['pi-pre'], timeout: 30 }], PostToolUse: [{ hookCallbackIds: ['pi-post'], timeout: 600 }], Stop: [{ hookCallbackIds: ['pi-stop'], timeout: 600 }] } } });
sessionId = s.sessionId;
const r = await req('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Call the peek tool, then call the poke tool. Report each result, or the exact denial reason if a call is denied. Do not retry denied calls.' }] });
const ok = calls.includes('marked:peek') && !calls.includes('unmarked:poke') && decisions.some((d) => d.tool === 'marked__peek' && d.allow) && decisions.some((d) => d.tool === 'unmarked__poke' && !d.allow) && text.includes('MARBLE') && !text.includes('PEBBLE');
const evidence = { ok, stopReason: r.stopReason, mcpCallsReachingServers: calls, gateDecisions: decisions, stampsSeen: [...stamps.values()].map((s) => `${s.name}:${s.kind}:${s.read_only}`), answer: text.slice(-500) };
await writeFile(new URL('../evidence/mcp-gate-probe.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 1));
ws.close(); process.exitCode = ok ? 0 : 1;
