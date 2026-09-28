// Live probe for the gateway's tiered fail-closed guard. Three cases, each its own Grok session:
//   hung:   hooks registered, client never acks or answers pre_tool_use -> gateway denies at ACK_MS, file not created
//   gone:   client drops its socket while a permission prompt is open -> gateway rejects, file not created
//   dialog: client acks the permission with dialog:true, answers "allow" after ACK_MS has passed -> honored, file created
// Run against the active gateway. PI_GROK_ACK_MS on the gateway sets tier 2 (default 5 s).
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../src/config.ts';

const config = await readConfig();
const ACK_MS = Number(process.env.PI_GROK_ACK_MS || 5000);
const evidence: Record<string, unknown> = { ackMs: ACK_MS, cases: {} };
const cases = evidence.cases as Record<string, unknown>;
const exists = async (p: string) => { try { await readFile(p); return true; } catch { return false; } };

async function connect() {
  const ws = new WebSocket(config.url, { headers: { Authorization: `Bearer ${config.secret}` } });
  await new Promise<void>((r, j) => { ws.once('open', r); ws.once('error', j); });
  let n = 0; const p = new Map<number, { res(v: any): void; rej(e: Error): void }>();
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const req = (method: string, params: unknown) => new Promise<any>((res, rej) => { const id = ++n; p.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
  const log: string[] = []; const t0 = Date.now(); const mark = (s: string) => log.push(`${Date.now() - t0}ms ${s}`);
  const handlers: { onHook?: (m: any) => void; onPermission?: (m: any) => void } = {};
  let text = '';
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (p.has(m.id) && ('result' in m || 'error' in m)) { const x = p.get(m.id)!; p.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; }
    if (m.method === '_x.ai/hooks/run') { mark(`hook ${m.params.hookEventName} ${m.params.toolName ?? ''}`); handlers.onHook?.(m); return; }
    if (m.method === 'session/request_permission') { mark(`permission ${m.params.toolCall?.title}`); handlers.onPermission?.(m); return; }
    if (m.method === 'session/update') { const u = m.params.update; if (u.sessionUpdate === 'tool_call') mark(`tool_call ${u.title}`); if (u.sessionUpdate === 'tool_call_update' && u.status) mark(`tool ${u.status} ${JSON.stringify(u.content ?? '').slice(0, 140)}`); if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text; }
  });
  await req('initialize', { protocolVersion: 1, clientInfo: { name: 'guard-probe', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  await req('authenticate', { methodId: 'cached_token' }).catch(() => {});
  return { ws, req, send, log, handlers, mark, text: () => text };
}

// hung
{
  const cwd = await mkdtemp(join(tmpdir(), 'grok-guard-hung-'));
  const c = await connect();
  c.handlers.onHook = (m) => { if (m.params.hookEventName !== 'pre_tool_use') c.send({ jsonrpc: '2.0', id: m.id, result: { decision: 'continue' } }); else c.mark('client ignores pre_tool_use (no ack)'); };
  const s = await c.req('session/new', { cwd, mcpServers: [], _meta: { yoloMode: false, 'x.ai/hooks': { PreToolUse: [{ hookCallbackIds: ['pi-pre'], timeout: 30 }], Stop: [{ hookCallbackIds: ['pi-stop'], timeout: 600 }] } } });
  const started = Date.now();
  const r = await c.req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Create a file named hung.txt containing hi. If a tool is denied, quote the denial reason you were given and stop.' }] });
  const created = await exists(join(cwd, 'hung.txt'));
  const deniedLine = c.log.find((l) => /tool failed/.test(l));
  const denyAt = c.log.find((l) => /client ignores/.test(l)); const failAt = deniedLine;
  const gateMs = denyAt && failAt ? parseInt(failAt) - parseInt(denyAt) : undefined;
  cases.hung = { ok: !created && !!deniedLine && (gateMs ?? 1e9) < 30_000, fileCreated: created, toolDenied: !!deniedLine, gatewayDenyAfterMs: gateMs, stopReason: r.stopReason, elapsedMs: Date.now() - started, answer: c.text().slice(-300), log: c.log };
  c.ws.close();
}

// gone
{
  const cwd = await mkdtemp(join(tmpdir(), 'grok-guard-gone-'));
  const c = await connect();
  const s = await c.req('session/new', { cwd, mcpServers: [], _meta: { yoloMode: false } });
  let dropped = false;
  c.handlers.onPermission = () => { if (!dropped) { dropped = true; c.mark('client drops socket'); c.ws.terminate(); } };
  c.req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Run this exact shell command: echo hi > gone.txt' }] }).catch(() => {});
  await new Promise<void>((r) => { const i = setInterval(() => { if (dropped) { clearInterval(i); r(); } }, 50); setTimeout(() => { clearInterval(i); r(); }, 60_000); });
  await new Promise((r) => setTimeout(r, 4000));
  const created = await exists(join(cwd, 'gone.txt'));
  cases.gone = { ok: !created && dropped, promptSeen: dropped, fileCreated: created, log: c.log };
}

// dialog
{
  const cwd = await mkdtemp(join(tmpdir(), 'grok-guard-dialog-'));
  const c = await connect();
  const waitMs = ACK_MS + 3000;
  c.handlers.onPermission = (m) => {
    c.send({ jsonrpc: '2.0', method: 'pi/gate-ack', params: { key: `perm:${m.params.toolCall?.toolCallId}`, dialog: true } });
    c.mark(`acked with dialog:true; answering in ${waitMs}ms`);
    const allow = m.params.options.find((o: any) => o.kind === 'allow_once');
    setTimeout(() => { c.mark('client answers allow'); c.send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } }); }, waitMs);
  };
  const s = await c.req('session/new', { cwd, mcpServers: [], _meta: { yoloMode: false } });
  const r = await c.req('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Run this exact shell command: echo hi > dialog.txt . Then reply done.' }] });
  const created = await exists(join(cwd, 'dialog.txt'));
  cases.dialog = { ok: created && r.stopReason === 'end_turn', fileCreated: created, stopReason: r.stopReason, answeredAfterMs: waitMs, log: c.log };
  c.ws.close();
}

evidence.ok = Object.values(cases).every((c: any) => c.ok);
await writeFile(new URL('../evidence/gateway-guard-probe.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ ok: evidence.ok, ...Object.fromEntries(Object.entries(cases).map(([k, v]: any) => [k, { ok: v.ok, fileCreated: v.fileCreated, gatewayDenyAfterMs: v.gatewayDenyAfterMs, stopReason: v.stopReason, answer: v.answer }])) }, null, 1));
process.exitCode = evidence.ok ? 0 : 1;
