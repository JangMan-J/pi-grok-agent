// Live probe: Grok reaches a Pi-hosted tool. Default transport `http`: the tool server is registered as an
// ordinary HTTP MCP server at the gateway's /mcp/<token>, which relays to this socket as _x.ai/mcp/sdk_call.
// GROK_MODEL_PROBE_TRANSPORT=sdk uses Grok's in-process SDK channel instead (needs the forked leader).
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../src/config.ts';

const config = await readConfig();
const cwd = await mkdtemp(join(tmpdir(), 'grok-model-probe-'));
const token = randomBytes(12).toString('hex');
const serverId = `pi-probe-${randomBytes(6).toString('hex')}`;
const transport = process.env.GROK_MODEL_PROBE_TRANSPORT === 'sdk' ? 'sdk' : 'http';
const mcpBase = new URL(config.url).origin.replace(/^ws/, 'http');
const toolWaitMs = Number(process.env.GROK_MODEL_PROBE_TOOL_WAIT_MS ?? 5000);
const evidence: Record<string, unknown> = { cwd, transport, toolWaitMs, sdkCalls: [] as unknown[], toolCallUpdates: [] as unknown[], checks: [] as string[] };
const sdkCalls = evidence.sdkCalls as { method: string; id: unknown; heldMs?: number }[];
const toolCallUpdates = evidence.toolCallUpdates as unknown[];
const checks = evidence.checks as string[];

const ws = new WebSocket(config.url, { headers: { Authorization: `Bearer ${config.secret}` }, handshakeTimeout: 10_000 });
await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
let nextId = 0;
const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
const notifications: any[] = [];
let text = '';
const send = (message: unknown) => ws.send(JSON.stringify(message));
const request = (method: string, params: unknown, timeoutMs = 120_000) => new Promise<any>((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  send({ jsonrpc: '2.0', id, method, params });
});
async function handleSdkCall(id: unknown, params: any) {
  const message = params.message;
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result: { jsonrpc: '2.0', id: message.id, result } });
  const entry: { method: string; id: unknown; heldMs?: number } = { method: message.method, id: message.id };
  sdkCalls.push(entry);
  if (params.serverId !== serverId) { send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown serverId ${params.serverId}` } }); return; }
  switch (message.method) {
    case 'initialize':
      reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pi', version: '0.0.0' } });
      return;
    case 'tools/list':
      reply({ tools: [{ name: 'pi_echo_secret', description: 'Returns the secret token that only Pi holds. Call it with no arguments.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
      return;
    case 'tools/call': {
      const started = Date.now();
      await new Promise((r) => setTimeout(r, toolWaitMs)); // stand-in for a Pi permission dialog / slow tool
      entry.heldMs = Date.now() - started;
      if (message.params?.name === 'pi_echo_secret') reply({ content: [{ type: 'text', text: token }] });
      else reply({ content: [{ type: 'text', text: `unknown tool ${message.params?.name}` }], isError: true });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id, result: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } } });
  }
}
ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if ('id' in message && ('result' in message || 'error' in message) && pending.has(message.id)) {
    const p = pending.get(message.id)!; pending.delete(message.id);
    if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
    return;
  }
  if ((message.method === 'x.ai/mcp/sdk_call' || message.method === '_x.ai/mcp/sdk_call') && 'id' in message) {
    evidence.sdkCallWireMethod = message.method;
    void handleSdkCall(message.id, message.params); return;
  }
  if (message.method === 'session/request_permission' && 'id' in message) {
    // The profile should leave no native tools; any permission request is recorded and cancelled.
    notifications.push({ permission: message.params });
    send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
    return;
  }
  if (message.method === 'session/update') {
    const update = message.params?.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text;
    if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
      toolCallUpdates.push({ kind: update.sessionUpdate, title: update.title, toolKind: update.kind, status: update.status, rawInput: update.rawInput });
    }
    return;
  }
  notifications.push(message);
  (evidence.unmatched ??= [] as unknown[]) as unknown[];
  (evidence.unmatched as unknown[]).push({ method: message.method, hasId: 'id' in message, paramKeys: Object.keys(message.params ?? {}) });
});

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'pi-grok-model-probe', version: '0.1.0' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    _meta: { 'x.ai/mcp/sdk': true },
  });
  evidence.agentAdvertisesSdk = init.agentCapabilities?._meta?.['x.ai/mcp/sdk'] ?? null;
  if ((init.authMethods ?? []).some((m: any) => m.id === 'cached_token')) await request('authenticate', { methodId: 'cached_token' });
  if (transport === 'http') {
    // Gateway contract checks before Grok is involved: unknown token 404, probe `{}` not an auth challenge, GET 405.
    const unknown = await fetch(`${mcpBase}/mcp/nope`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    evidence.unknownTokenStatus = unknown.status; await unknown.text();
    if (unknown.status !== 404) throw new Error(`unknown token should be 404, got ${unknown.status}`);
  }
  const _meta: Record<string, unknown> = {
    yoloMode: false,
    agentProfile: { name: 'pi-model', description: 'Grok reasoning with Pi-hosted tools only', tools: ['mcp__pi__*'] },
    mcpConfig: { pi: { toolTimeoutMs: 600_000 } },
  };
  const mcpServers: unknown[] = [];
  if (transport === 'sdk') _meta['x.ai/mcp/servers'] = [{ name: 'pi', serverId }];
  else mcpServers.push({ type: 'http', name: 'pi', url: `${mcpBase}/mcp/${serverId}`, headers: [] });
  const session = await request('session/new', { cwd, mcpServers, _meta });
  if (transport === 'http') {
    const probe = await fetch(`${mcpBase}/mcp/${serverId}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    evidence.anonymousProbeStatus = probe.status; await probe.text();
    if ([401, 403].includes(probe.status)) throw new Error('anonymous probe must not be an auth challenge');
    const get = await fetch(`${mcpBase}/mcp/${serverId}`); evidence.getStatus = get.status; await get.text();
  }
  evidence.sessionId = session.sessionId;
  evidence.sessionModel = session.models?.currentModelId ?? session._meta?.model ?? null;
  const prompt = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Call the pi_echo_secret tool once and reply with exactly the text it returned, nothing else.' }] }, 240_000);
  evidence.stopReason = prompt.stopReason;
  evidence.answer = text.trim();
  const call = sdkCalls.find((c) => c.method === 'tools/call');
  if (!sdkCalls.some((c) => c.method === 'tools/list')) throw new Error('Grok never listed the Pi-hosted server tools');
  checks.push('Grok listed Pi-hosted tools through x.ai/mcp/sdk_call');
  if (!call) throw new Error('Grok never called the Pi-hosted tool');
  checks.push(`Grok called pi_echo_secret through x.ai/mcp/sdk_call and waited ${call.heldMs}ms for the result`);
  if (!text.includes(token)) throw new Error(`Answer did not contain the Pi-held token: ${text.slice(0, 200)}`);
  checks.push('Final answer contained the token that only the Pi-hosted tool returned');
  const nativeTitles = toolCallUpdates.map((u: any) => String(u.title ?? '')).filter((t) => t && !/pi_echo_secret|mcp__pi|\bpi\b/i.test(t));
  evidence.nativeToolTitles = nativeTitles;
  const permissionRequests = notifications.filter((n) => n.permission).length;
  evidence.permissionRequests = permissionRequests;
  if (permissionRequests) throw new Error('Grok issued a native permission request despite the profile');
  checks.push('No native permission request; tool_call updates reference only the Pi-hosted tool');

  text = '';
  await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'List the names of every tool you currently have available, one per line, and nothing else.' }] }, 240_000);
  evidence.selfReportedTools = text.trim();
  evidence.ok = true;
} catch (error) {
  evidence.ok = false; evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  ws.close();
  await writeFile(new URL('../evidence/model-probe.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
