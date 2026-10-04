// Live, opt-in: a direct stdio agent calls a Pi-held tool over HTTP (default) or the temporary SDK channel.
// Uses the production connection, including startMcpServer for HTTP. Never run as part of npm test.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.ts';
import { GrokModelConnection, type SdkCall } from '../src/model/connection.ts';

const config = await readConfig();
const connection = new GrokModelConnection({ mcp: config.mcp });
const cwd = await mkdtemp(join(tmpdir(), 'grok-model-probe-'));
const token = randomBytes(12).toString('hex');
const serverId = `pi-probe-${randomBytes(6).toString('hex')}`;
const toolWaitMs = Number(process.env.GROK_MODEL_PROBE_TOOL_WAIT_MS ?? 5000);
if (!Number.isFinite(toolWaitMs) || toolWaitMs < 0) throw new Error('GROK_MODEL_PROBE_TOOL_WAIT_MS must be non-negative.');
const calls: { method: string; name?: string; heldMs?: number }[] = [];
const evidence: Record<string, unknown> = { transport: config.mcp, cwd, toolWaitMs, calls, node: process.version };
let text = '';
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 240_000);
async function onMcp(message: SdkCall) {
  const entry = { method: message.method, name: message.params?.name, heldMs: undefined as number | undefined };
  calls.push(entry);
  switch (message.method) {
    case 'initialize': return { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pi', version: '0.1.0' } };
    case 'tools/list': return { tools: [{ name: 'pi_echo_secret', description: 'Returns the secret token that only Pi holds. Call with no arguments.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
    case 'tools/call': {
      if (message.params?.name !== 'pi_echo_secret') throw new Error(`unknown tool ${message.params?.name}`);
      const started = Date.now();
      await new Promise((resolve) => setTimeout(resolve, toolWaitMs));
      entry.heldMs = Date.now() - started;
      return { content: [{ type: 'text', text: token }] };
    }
    default: throw new Error(`unsupported ${message.method}`);
  }
}
try {
  evidence.grok = execFileSync(connection.binary, ['--version'], { encoding: 'utf8' }).trim();
  evidence.pi = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
  await connection.open(abort.signal);
  const { sessionId } = await connection.attachSession({
    cwd, serverId, serverName: 'pi', offerPiTools: true, hooks: false, toolTimeoutMs: 600_000,
    rules: 'For this probe use only the lent MCP tool pi__pi_echo_secret. Do not use native tools.',
    handlers: {
      onMcp,
      onUpdate({ update }) { if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') text += update.content.text; },
      async onPermission() { return { outcome: { outcome: 'cancelled' } }; },
    },
  });
  evidence.sessionId = sessionId;
  if (config.mcp === 'http') {
    const url = `${connection.mcpBaseUrl}/mcp/${serverId}`;
    const unknown = await fetch(`${connection.mcpBaseUrl}/mcp/unknown`, { method: 'POST', body: '{}' });
    evidence.unknownTokenStatus = unknown.status; await unknown.text();
    if (unknown.status !== 404) throw new Error(`unknown token should be 404, got ${unknown.status}`);
    const anonymous = await fetch(url, { method: 'POST', body: '{}' });
    evidence.anonymousProbeStatus = anonymous.status; await anonymous.text();
    if ([401, 403].includes(anonymous.status)) throw new Error('anonymous probe must not be an auth challenge');
    const get = await fetch(url); evidence.getStatus = get.status; await get.text();
    if (get.status !== 405) throw new Error(`GET should be 405, got ${get.status}`);
  }
  const prompt = await connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Call pi__pi_echo_secret once with no arguments and reply with exactly the text it returns. It is a lent MCP tool available through use_tool. Do not use native tools.' }] });
  evidence.stopReason = prompt.stopReason;
  evidence.answer = text.trim();
  evidence.toolsListed = calls.some((call) => call.method === 'tools/list');
  const call = calls.find((call) => call.method === 'tools/call' && call.name === 'pi_echo_secret');
  evidence.toolCalled = !!call;
  evidence.heldWait = (call?.heldMs ?? -1) >= toolWaitMs;
  evidence.tokenReturned = text.includes(token);
  if (!evidence.toolsListed || !evidence.toolCalled || !evidence.heldWait || !evidence.tokenReturned) throw new Error('Lent tool probe checks failed.');
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await connection.close();
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await writeFile(new URL('../evidence/model-probe.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
