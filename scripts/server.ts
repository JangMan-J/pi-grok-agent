import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { agentDir, defaultSecretFile, readConfig } from '../src/config.ts';

// Secret file first (readConfig needs it), then the validated settings the rest of the file depends on.
await mkdir(agentDir, { recursive: true, mode: 0o700 });
if (!process.env.GROK_AGENT_SECRET) {
  try { await writeFile(defaultSecretFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
const config = await readConfig();

// One leader owns agent state. Each WebSocket gets a native, independently routed stdio client.
// The same listener also serves Pi-hosted MCP tools to Grok over HTTP: Grok's own MCP client POSTs
// JSON-RPC to /mcp/<token>, and the gateway relays each message to the Pi socket that registered the
// token (as an _x.ai/mcp/sdk_call request), so the stock leader is never asked to route it.
const MCP_PATH = '/mcp/';
const GATEWAY_ID_PREFIX = 'pi-gw:';
type Relay = { socket: WebSocket; pending: Map<string, ServerResponse>; tokens: Set<string>; gates: Map<string, Gate>; gateKeys: Map<string, string> };

// Tiered fail-closed guard for Grok's reverse requests. Grok fails OPEN when a client hook times out (the tool
// runs) and waits forever on a permission prompt, so the gateway answers on Pi's behalf when Pi cannot.
//
//   tier 0  Pi's extension answers (policy, capability mirror, check): normally < 1 ms
//   tier 1  Pi acks the request (`pi/gate-ack`, same socket): Pi is alive. With `dialog: true` a human is
//           deciding, so wait the dialog window; with `check: true` a check is running, so wait the check budget
//   tier 2  no ack within the ack window, or the socket closes: Pi is hung or gone. Gate -> deny, feedback ->
//           continue, permission -> reject. Always before Grok's own deadline (tier 3, fail-open)
// Tier windows come from `guard` in ~/.pi/agent/grok-ws.json (env PI_GROK_ACK_MS, PI_GROK_POLICY_MS,
// PI_GROK_CHECK_BUDGET_MS, PI_GROK_DIALOG_MS override). `readConfig` validates them against Grok's deadlines.
const { ackMs: ACK_MS, policyMs: POLICY_MS, checkBudgetMs: CHECK_BUDGET_MS, dialogMs: DIALOG_MS } = config.guard;
type GateKind = 'gate' | 'feedback' | 'permission';
type Gate = { kind: GateKind; acked: boolean; timer?: ReturnType<typeof setTimeout>; answer(why: string): void };
/** Content key both sides can derive from the payload (Pi's handlers never see the JSON-RPC id). */
function gateKey(message: any): string | undefined {
  const p = message?.params ?? {};
  if (message?.method === '_x.ai/hooks/run') {
    const event = String(p.hookEventName ?? '');
    if (event === 'stop') return `stop:${p.sessionId ?? p.session_id ?? ''}`;
    return p.toolUseId ? `${event}:${p.toolUseId}` : undefined;
  }
  if (message?.method === 'session/request_permission') return p.toolCall?.toolCallId ? `perm:${p.toolCall.toolCallId}` : undefined;
  if (message?.method === '_x.ai/ask_user_question') return `ask:${p.toolCallId ?? p.tool_call_id ?? ''}`;
  return undefined;
}
const guardStats = { gateDenied: 0, feedbackContinued: 0, permissionRejected: 0 };
function arm(relay: Relay, id: string, gate: Gate, ms: number, why: string) {
  clearTimeout(gate.timer);
  gate.timer = setTimeout(() => { if (relay.gates.delete(id)) gate.answer(why); }, ms);
}
function watchReverseRequest(relay: Relay, proxyStdin: NodeJS.WritableStream, message: any) {
  if (typeof message?.method !== 'string' || !('id' in message) || message.id === null) return;
  const id = JSON.stringify(message.id);
  const reply = (result: unknown) => proxyStdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  let gate: Gate | undefined;
  if (message.method === '_x.ai/hooks/run') {
    const event = String(message.params?.hookEventName ?? '');
    if (event === 'pre_tool_use') gate = { kind: 'gate', acked: false, answer: (why) => { guardStats.gateDenied++; reply({ decision: 'deny', reason: `Denied by the Pi gateway: ${why}.` }); } };
    else if (event === 'stop' || event === 'post_tool_use') gate = { kind: 'feedback', acked: false, answer: () => { guardStats.feedbackContinued++; reply({ decision: 'continue' }); } };
  } else if (message.method === 'session/request_permission') {
    const options: any[] = message.params?.options ?? [];
    const reject = options.find((o) => o?.kind === 'reject_once') ?? options.find((o) => String(o?.kind).startsWith('reject'));
    gate = { kind: 'permission', acked: false, answer: () => { guardStats.permissionRejected++; reply(reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } }); } };
  } else if (message.method === '_x.ai/ask_user_question') {
    // Grok waits up to 30 min for an answer; a vanished Pi must not leave the tool hanging. `cancelled` is a normal outcome.
    gate = { kind: 'permission', acked: false, answer: () => { guardStats.permissionRejected++; reply({ outcome: 'cancelled' }); } };
  }
  if (!gate) return;
  relay.gates.set(id, gate);
  const key = gateKey(message);
  if (key) relay.gateKeys.set(key, id);
  arm(relay, id, gate, ACK_MS, `Pi did not acknowledge within ${ACK_MS / 1000}s`);
}
/** Pi's `pi/gate-ack` notification: Pi is alive and says what it is doing with the request. Re-arms the deadline. */
function handleGateAck(relay: Relay, params: any) {
  const id = relay.gateKeys.get(String(params?.key ?? ''));
  const gate = id ? relay.gates.get(id) : undefined;
  if (!id || !gate) return;
  gate.acked = true;
  if (params?.dialog) arm(relay, id, gate, DIALOG_MS, `no answer to the dialog within ${DIALOG_MS / 60_000} min`);
  else if (params?.check) arm(relay, id, gate, CHECK_BUDGET_MS, `check exceeded ${CHECK_BUDGET_MS / 1000}s`);
  else arm(relay, id, gate, POLICY_MS, `Pi policy did not answer within ${POLICY_MS / 1000}s`);
}
/** Pi answered a reverse request: stop guarding it. */
function settleReverseAnswer(relay: Relay, message: any): void {
  if (!message || !('id' in message) || !('result' in message || 'error' in message)) return;
  const gate = relay.gates.get(JSON.stringify(message.id));
  if (!gate) return;
  relay.gates.delete(JSON.stringify(message.id));
  for (const [key, id] of relay.gateKeys) if (id === JSON.stringify(message.id)) relay.gateKeys.delete(key);
  clearTimeout(gate.timer);
}
function answerAllGates(relay: Relay, why: string) {
  for (const [id, gate] of relay.gates) { relay.gates.delete(id); clearTimeout(gate.timer); gate.answer(why); }
  relay.gateKeys.clear();
}
const relays = new Map<string, Relay>(); // token -> owning Pi connection
let gatewayIds = 0;
function mcpTokenFrom(value: unknown): string | undefined {
  try { const path = new URL(String(value)).pathname; if (path.startsWith(MCP_PATH)) return path.slice(MCP_PATH.length); } catch {}
  return undefined;
}
function registerMcpTokens(relay: Relay, message: any) {
  if (message?.method !== 'session/new' && message?.method !== 'session/load') return;
  for (const server of message.params?.mcpServers ?? []) {
    const token = mcpTokenFrom(server?.url);
    if (!token) continue;
    const previous = relays.get(token);
    if (previous && previous !== relay) previous.tokens.delete(token);
    relays.set(token, relay); relay.tokens.add(token);
  }
}
function endJson(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
function handleMcpHttp(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!path.startsWith(MCP_PATH)) { endJson(res, 404, { error: 'not found' }); return; }
  const token = path.slice(MCP_PATH.length);
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; } // no SSE stream; rmcp tolerates 405 on GET
  const relay = relays.get(token);
  if (!relay || relay.socket.readyState !== WebSocket.OPEN) { endJson(res, 404, { error: 'unknown MCP token' }); return; }
  const chunks: Buffer[] = []; let size = 0;
  req.on('data', (c: Buffer) => { size += c.length; if (size > 16 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    let message: any;
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { endJson(res, 400, { error: 'invalid JSON' }); return; }
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') { endJson(res, 400, { error: 'expected a JSON-RPC message' }); return; } // also answers Grok's anonymous `{}` probe without an auth challenge
    if (!('id' in message) || message.id === null) { res.writeHead(202); res.end(); return; } // notification
    const id = `${GATEWAY_ID_PREFIX}${++gatewayIds}`;
    relay.pending.set(id, res);
    res.on('close', () => relay.pending.delete(id));
    relay.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: '_x.ai/mcp/sdk_call', params: { serverId: token, message } }), (error) => {
      if (error && relay.pending.delete(id)) endJson(res, 502, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Pi connection send failed' } });
    });
  });
}
function answerFromPi(relay: Relay, message: any): boolean {
  if (typeof message?.id !== 'string' || !message.id.startsWith(GATEWAY_ID_PREFIX) || !('result' in message || 'error' in message)) return false;
  const res = relay.pending.get(message.id);
  relay.pending.delete(message.id);
  if (!res) return true;
  if ('error' in message) endJson(res, 200, { jsonrpc: '2.0', id: null, error: message.error });
  else endJson(res, 200, message.result);
  return true;
}
const url = new URL(config.url);
if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ws') {
  throw new Error('The local launcher requires a loopback ws:// endpoint ending in /ws.');
}
// Not under ~/.grok/leader-*.sock on purpose: Grok's TUI auto-discovers that pattern, attaches, and evicts an
// older leader (SIGTERM, exit 143) with its own. A socket outside the pattern is ours alone.
const leaderSocket = process.env.PI_GROK_LEADER_SOCKET || join(homedir(), '.grok', 'pi', 'leader.sock');
await mkdir(join(homedir(), '.grok', 'pi'), { recursive: true, mode: 0o700 });
// PI_GROK_BINARY selects a forked build (needed for Pi-hosted tools through the leader on 1.0.41).
const grokBinary = process.env.PI_GROK_BINARY || 'grok';
const proxies = new Set<ChildProcess>();
let gateway: WebSocketServer | undefined;
let httpServer: ReturnType<typeof createServer> | undefined;
let stopping = false;

// The leader is supervised. If it dies (crash, eviction by another Grok client, SIGTERM from outside), the gateway keeps
// listening, drops the bridges (their Pi sockets close; Pi reconnects and session/loads on its next turn), and makes sure a
// leader is back on our socket. A bridge that is still alive may already have spawned one through Grok's own
// connect_or_spawn; those come up with --no-exit-on-disconnect and --relay-on-demand and inherit the socket, so the
// gateway adopts it instead of racing it for the lock. Sessions persist on disk; only the turn in flight is lost.
let leader: ChildProcess | { pid: number; adopted: true } | undefined;
let leaderRestarts = 0;
const leaderLock = leaderSocket.replace(/\.sock$/, '') + '.lock';
function socketAnswers(): Promise<boolean> {
  return new Promise((resolve) => { const s = createConnection(leaderSocket); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => { s.destroy(); resolve(false); }); });
}
/** A live leader already on our socket (spawned by a bridge): its pid from Grok's lock file, if the socket answers. */
async function existingLeaderPid(): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(leaderLock, 'utf8')).trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    try { process.kill(pid, 0); } catch { return undefined; }
    return (await socketAnswers()) ? pid : undefined;
  } catch { return undefined; }
}
function leaderAlive(): boolean { return !!leader; }
function stopLeader() {
  if (!leader) return;
  if ('adopted' in leader) { try { process.kill(leader.pid, 'SIGTERM'); } catch {} leader = undefined; return; }
  stopChild(leader);
}
/** Watch an adopted (non-child) leader by polling its pid; Node cannot get 'exit' for a process it did not spawn. */
function watchAdopted(pid: number) {
  const timer = setInterval(() => {
    if (leader && 'adopted' in leader && leader.pid === pid) { try { process.kill(pid, 0); return; } catch { leader = undefined; clearInterval(timer); if (!stopping) void onLeaderGone(`adopted leader ${pid} exited`); } }
    else clearInterval(timer);
  }, 1000);
  timer.unref();
}
const LEADER_ARGS = ['--permission-mode', 'default', 'agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--no-auto-update', '--leader-socket', leaderSocket];
function waitForSocket(child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Grok leader socket startup timed out.')); }, timeoutMs);
    const failed = () => { cleanup(); reject(new Error('Grok leader exited before startup.')); };
    const interval = setInterval(() => {
      const socket = createConnection(leaderSocket);
      socket.once('connect', () => { socket.destroy(); cleanup(); resolve(); });
      socket.once('error', () => socket.destroy());
    }, 100);
    const cleanup = () => { clearTimeout(timeout); clearInterval(interval); child.off('exit', failed); child.off('error', failed); };
    child.once('exit', failed); child.once('error', failed);
    if (stopping) failed();
  });
}
async function startLeader(): Promise<void> {
  const existing = await existingLeaderPid();
  if (existing) { leader = { pid: existing, adopted: true }; watchAdopted(existing); console.error(`Adopted leader ${existing} already on ${leaderSocket}.`); return; }
  // Remove a stale socket only when no process holds the lock; deleting a live leader's socket strands it (alive, locked, unreachable).
  try { const pid = Number((await readFile(leaderLock, 'utf8')).trim()); process.kill(pid, 0); } catch { await rm(leaderSocket, { force: true }); }
  const child = spawn(grokBinary, LEADER_ARGS, { stdio: ['ignore', 'inherit', 'inherit'] });
  leader = child;
  child.once('exit', (code, sig) => {
    if (leader !== child) return;
    leader = undefined;
    if (stopping) return;
    void onLeaderGone(`exited (${code ?? sig})`);
  });
  child.once('error', (error) => { if (leader === child) { leader = undefined; if (!stopping) void onLeaderGone(error.message); } });
  await waitForSocket(child);
}
async function onLeaderGone(why: string) {
  leaderRestarts++;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(leaderRestarts - 1, 5));
  console.error(`Grok leader ${why}; dropping ${proxies.size} bridge(s), ensuring a leader in ${delay / 1000}s (restart #${leaderRestarts}).`);
  for (const proxy of proxies) stopChild(proxy); // Pi sees a closed socket and reconnects on its next turn
  await new Promise((r) => setTimeout(r, delay));
  if (stopping) return;
  try { await startLeader(); console.error(leader && 'adopted' in leader ? 'Grok leader adopted.' : 'Grok leader respawned.'); if (leaderRestarts > 0) setTimeout(() => { leaderRestarts = Math.max(0, leaderRestarts - 1); }, 120_000).unref(); }
  catch (error) { console.error(`Grok leader respawn failed: ${error instanceof Error ? error.message : String(error)}`); void onLeaderGone('respawn failed'); }
}
function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2500);
  kill.unref();
  child.once('exit', () => clearTimeout(kill));
}
function shutdown(error?: Error) {
  if (stopping) return;
  stopping = true;
  if (error) { console.error(error.message); process.exitCode = 1; }
  for (const socket of gateway?.clients ?? []) socket.terminate();
  gateway?.close();
  httpServer?.close();
  for (const proxy of proxies) stopChild(proxy);
  stopLeader();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => shutdown());

try {
  await startLeader(); // first start is fatal on failure: nothing to serve without a leader
  if (stopping) throw new Error('Grok gateway startup cancelled.');
  httpServer = createServer(handleMcpHttp);
  httpServer.requestTimeout = 0; httpServer.headersTimeout = 60_000; // a relayed tools/call may wait on a Pi permission dialog
  gateway = new WebSocketServer({
    server: httpServer, path: '/ws', maxPayload: 16 * 1024 * 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.authorization === `Bearer ${config.secret}`,
  });
  gateway.on('error', (error) => shutdown(error));
  httpServer.on('error', (error) => shutdown(error));
  httpServer.listen(Number(url.port || 80), url.hostname === '[::1]' ? '::1' : url.hostname, () => console.log(`Grok WebSocket ACP ready at ${url}; MCP relay at ${url.origin.replace(/^ws/, 'http')}${MCP_PATH}<token>; leader socket ${leaderSocket}; binary ${grokBinary}`));
  gateway.on('connection', async (socket) => {
    // A client arriving while the leader is being respawned waits briefly instead of getting a bridge that cannot connect.
    for (let i = 0; !leaderAlive() && !stopping && i < 100; i++) await new Promise((r) => setTimeout(r, 300));
    if (!leaderAlive() || stopping) { socket.close(1013, 'Grok leader unavailable'); return; }
    const proxy = spawn(grokBinary, ['--permission-mode', 'default', 'agent', '--leader', 'stdio', '--leader-socket', leaderSocket], { stdio: ['pipe', 'pipe', 'inherit'] });
    proxies.add(proxy);
    const relay: Relay = { socket, pending: new Map(), tokens: new Set(), gates: new Map(), gateKeys: new Map() };
    let buffer = '';
    const fail = () => { if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Grok leader client disconnected'); stopChild(proxy); };
    proxy.stdout.setEncoding('utf8');
    proxy.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024 || socket.bufferedAmount > 16 * 1024 * 1024) { fail(); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { watchReverseRequest(relay, proxy.stdin, JSON.parse(line)); } catch {}
        if (socket.readyState === WebSocket.OPEN) socket.send(line, (error) => { if (error) fail(); });
      }
    });
    socket.on('message', (data) => {
      const text = data.toString().replace(/[\r\n]+$/, '');
      if (!text || text === 'ping') return;
      let message: any;
      try { message = JSON.parse(text); } catch { message = undefined; }
      if (message && answerFromPi(relay, message)) return; // Pi answered a relayed MCP call; it never reaches the leader
      if (message?.method === 'pi/gate-ack') { handleGateAck(relay, message.params); return; } // gateway-only; never reaches the leader
      if (message) { settleReverseAnswer(relay, message); registerMcpTokens(relay, message); }
      if (!proxy.stdin.write(text + '\n')) socket.pause();
    });
    proxy.stdin.on('drain', () => socket.resume());
    proxy.stdin.on('error', fail);
    proxy.on('error', fail);
    proxy.once('exit', () => { proxies.delete(proxy); if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Grok leader client exited'); });
    socket.on('error', () => stopChild(proxy));
    socket.once('close', () => {
      // Pi is gone: deny open gates and reject open prompts first, give the bridge a moment to forward them, then stop it.
      const hadGates = relay.gates.size > 0;
      answerAllGates(relay, 'Pi connection closed');
      if (hadGates) setTimeout(() => stopChild(proxy), 500); else stopChild(proxy);
      for (const token of relay.tokens) if (relays.get(token) === relay) relays.delete(token);
      for (const [id, res] of relay.pending) { relay.pending.delete(id); endJson(res, 502, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Pi connection closed' } }); }
    });
  });
} catch (error) { shutdown(error instanceof Error ? error : new Error(String(error))); }
