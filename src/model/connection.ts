// One stdio agent per Pi process. Lent Pi tools travel back over that same pipe as `_x.ai/mcp/sdk_call`.
import { client, ndJsonStream, type AnyMessage, type ClientConnection, type InitializeResponse, type NewSessionResponse, type LoadSessionResponse, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { agentDir, WATCHDOG_STALL_MS } from '../config.ts';
import { ReverseRequestGuard } from './guard.ts';
import { childExitMessage, deadlineFor, formatExitRecord, formatUptime, isExplained, isMissingSession, isTransportClose, SIGNED_OUT_MESSAGE, spawnFailureMessage, timeoutMessage, watchdogMessage, type ChildExitRecord } from './child-report.ts';
import { appendStdioLog, enqueueWrite, jsonLineTransform, STDIO_LOG_MAX_BYTES, STDIO_LOG_NAME } from './stdio-log.ts';
import { EventLoopWatchdog } from './watchdog.ts';

export type ConnectionOptions = {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  /** Test overrides for request deadlines. `session/prompt` stays unlimited unless set here. */
  deadlines?: Partial<Record<string, number>>;
  /** Defaults to `<agent dir>/grok-stdio.log`. */
  logPath?: string;
  logMaxBytes?: number;
  /** Pause between stdin EOF and SIGTERM, and between SIGTERM and SIGKILL. Default 500. */
  stopGraceMs?: number;
  /** session/cancel must settle the prompt within this long, or the child is killed. Default 5000. */
  cancelAckMs?: number;
  /** Event-loop stall that kills the child while a reverse request is open. `0` disables. Default 1000. */
  watchdogMs?: number;
};
type AgentChild = ChildProcessByStdio<Writable, Readable, Readable>;

export type McpToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type McpToolResult = { content: { type: 'text'; text: string }[] | { type: 'image'; data: string; mimeType: string }[] | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
export type SdkCall = { method: string; id: unknown; params?: any };

export interface SessionHandlers {
  onUpdate(notification: SessionNotification): void;
  /** Answer one MCP JSON-RPC message from Grok. Return the JSON-RPC `result` or throw for an error. */
  onMcp(message: SdkCall): Promise<unknown>;
  onPermission?(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** Blocking client hook. `gate.dialog()` is retained as a no-op for session handlers. */
  onHookRun?(payload: any, gate?: { dialog(): void }): Promise<Record<string, unknown>>;
  /** Passive client hook notification (`_x.ai/hooks/event`). */
  onHookEvent?(payload: any): void;
  /** Grok's ask_user_question (`_x.ai/ask_user_question`). Default: cancelled. */
  onQuestion?(request: any): Promise<Record<string, unknown>>;
  /** Grok's extension session notifications (`_x.ai/session_notification`): turn_completed carries full token usage. */
  onSessionExt?(update: any): void;
}

/**
 * PreToolUse stays at Grok's 600 s cap. The event-loop watchdog is the guard: it SIGKILLs this child
 * if Pi's loop stalls while a hook, permission, or question is unanswered. A long Grok-side timeout
 * is what lets an ask-mode dialog wait for a human while the loop is still alive. Grok fails open
 * when the timeout expires, so the cap has to outlast that dialog and the watchdog.
 */
export const CLIENT_HOOKS = {
  PreToolUse: [{ hookCallbackIds: ['pi-pre'], timeout: 600 }],
  PostToolUse: [{ hookCallbackIds: ['pi-post'], timeout: 600 }],
  PostToolUseFailure: [{ hookCallbackIds: ['pi-post-failure'], timeout: 60 }],
  Stop: [{ hookCallbackIds: ['pi-stop'], timeout: 600 }],
};

const UNKNOWN_SESSION = 'No Pi session owns this Grok session; the request was answered immediately.';

export class GrokModelConnection {
  private child?: AgentChild;
  private guard?: ReverseRequestGuard;
  private stopping = new Set<Promise<void>>();
  private connection?: ClientConnection;
  private initialized?: InitializeResponse;
  private readonly sessions = new Map<string, SessionHandlers>();
  // serverId -> handlers. Registered before session/new is sent: Grok lists the MCP server's tools while it
  // creates the session, before Pi knows the session id.
  private readonly servers = new Map<string, SessionHandlers>();
  private opening?: Promise<void>;
  private closed = false;
  private ready = false;
  private readonly options: ConnectionOptions;
  private readonly dropListeners = new Set<(reason: string) => void>();
  private readonly stderrRing: string[] = [];
  private stderrPartial = '';
  private readonly exitHistory: ChildExitRecord[] = [];
  private startedAt?: number;
  private pending = 0;
  private childEnd?: Promise<string>;
  private writes: { chain: Promise<void> } = { chain: Promise.resolve() };
  readonly mcpStats = { toolsLent: 0, callsServed: 0, callsFailed: 0 };
  readonly logPath: string;
  readonly stopGraceMs: number;
  readonly cancelAckMs: number;
  private readonly watchdogMs: number;
  private watchdog?: EventLoopWatchdog;
  private readonly logMaxBytes: number;

  constructor(options: ConnectionOptions = {}) {
    this.options = { ...options };
    this.logPath = options.logPath ?? join(agentDir, STDIO_LOG_NAME);
    this.logMaxBytes = options.logMaxBytes ?? STDIO_LOG_MAX_BYTES;
    this.stopGraceMs = options.stopGraceMs ?? 500;
    this.cancelAckMs = options.cancelAckMs ?? 5000;
    this.watchdogMs = options.watchdogMs ?? WATCHDOG_STALL_MS;
    this.ensureWatchdog();
  }

  private ensureWatchdog() {
    if (this.watchdog || this.watchdogMs <= 0) return;
    this.watchdog = new EventLoopWatchdog(this.watchdogMs);
  }

  get binary() { return this.options.binary ?? process.env.PI_GROK_BINARY ?? 'grok'; }

  /** Reasons the last connection ended, for status and error text. */
  lastDrop?: string;

  get isOpen() { return !!this.connection && !this.closed; }

  get pid(): number | undefined { return this.child?.pid; }

  /** Reject parked lent-tool calls when this child ends. */
  onDrop(listener: (reason: string) => void): () => void {
    this.dropListeners.add(listener);
    return () => { this.dropListeners.delete(listener); };
  }

  /** `/grok debug` lines for this child. */
  debugLines(): string[] {
    const uptime = this.startedAt != null && this.child ? formatUptime(Date.now() - this.startedAt) : undefined;
    return [
      `child pid: ${this.pid ?? '(not running)'}`,
      `child uptime: ${uptime ?? '(not running)'}`,
      `child exits: ${this.exitHistory.length ? this.exitHistory.map(formatExitRecord).join('; ') : 'none'}`,
      `child stderr: ${this.stderrRing.length ? this.stderrRing.join('\n') : 'none'}`,
      `pending requests: ${this.pending}`,
      `mcp: ${this.mcpStats.toolsLent} tools lent, ${this.mcpStats.callsServed} calls served, ${this.mcpStats.callsFailed} calls failed`,
      `stdio log: ${this.logPath}`,
    ];
  }

  /** The child went away. Sessions stay in the map so attach() can session/load them. */
  private markDropped(reason: string) {
    if (!this.connection && !this.child) return;
    this.lastDrop = reason;
    this.connection = undefined;
    this.child = undefined;
    this.guard = undefined;
    this.initialized = undefined;
    this.ready = false;
    this.startedAt = undefined;
    this.generation++;
  }

  /** Increments on every drop; a session attached under an older generation must session/load again. */
  generation = 0;

  private writeLog(line: string) {
    try { appendStdioLog(this.logPath, line, this.logMaxBytes); } catch { /* a log failure must not fail the turn */ }
  }

  private keepStderr(line: string) {
    if (this.stderrRing.length >= 10) this.stderrRing.shift();
    this.stderrRing.push(line);
    this.writeLog(`stderr: ${line}`);
  }

  private pushStderr(text: string) {
    this.stderrPartial += text;
    const parts = this.stderrPartial.split('\n');
    this.stderrPartial = parts.pop() ?? '';
    for (const line of parts) if (line.length) this.keepStderr(line);
  }

  private flushStderr() {
    if (!this.stderrPartial) return;
    this.keepStderr(this.stderrPartial);
    this.stderrPartial = '';
  }

  private stderrText(): string { return this.stderrRing.join('\n'); }

  private recordExit(code: number | null, signal: NodeJS.Signals | null, watchdog = false) {
    this.exitHistory.push({ at: new Date().toISOString(), code, signal, ...(watchdog ? { watchdog: true } : {}) });
    if (this.exitHistory.length > 3) this.exitHistory.shift();
  }

  private installRequestGuard(agent: { request: (method: string, params?: unknown) => Promise<unknown> }) {
    const raw = agent.request.bind(agent);
    agent.request = (method: string, params?: unknown) => this.guardedRequest(raw, method, params);
  }

  private guardedRequest(raw: (method: string, params?: unknown) => Promise<unknown>, method: string, params?: unknown): Promise<unknown> {
    const ms = deadlineFor(method, this.options.deadlines);
    this.pending++;
    const finish = () => { this.pending = Math.max(0, this.pending - 1); };
    const request = Promise.resolve().then(() => raw(method, params));
    void request.then(() => undefined, () => undefined);
    const racers: Promise<unknown>[] = [request];
    const childEnd = this.childEnd;
    if (childEnd) racers.push(childEnd.then((detail) => Promise.reject(new Error(detail))));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (ms != null) {
      racers.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(timeoutMessage(method, ms)), { timeout: true })), ms);
      }));
    }
    return Promise.race(racers).then((value) => value, async (error) => {
      const timedOut = !!error && typeof error === 'object' && 'timeout' in error;
      if (timedOut) {
        const message = error instanceof Error ? error.message : timeoutMessage(method, ms ?? 0);
        this.drop(message);
        throw new Error(message);
      }
      if (isTransportClose(error) && childEnd) {
        const detail = await Promise.race([childEnd, sleep(400).then(() => '')]);
        if (detail) throw new Error(detail);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }).finally(() => { if (timer) clearTimeout(timer); finish(); });
  }

  async open(signal?: AbortSignal) {
    if (this.opening) return this.opening;
    if (this.connection) return;
    this.closed = false;
    this.ensureWatchdog();
    signal?.throwIfAborted();
    this.opening = (async () => {
      const binary = this.binary;
      this.stderrRing.length = 0;
      this.stderrPartial = '';
      this.writes = { chain: Promise.resolve() };
      const child = spawn(binary, ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Grok Build 1.0.46 user guide, 14-headless-mode.md: SDKs inject this for non-leader agents they spawn.
        // Not detached. Node has no prctl PDEATHSIG; a SIGKILL of Pi still closes these pipes.
        env: { ...process.env, ...this.options.env, GROK_DISABLE_AUTOUPDATER: '1' },
      }) as AgentChild;
      this.child = child;
      this.watchdog?.setPid(child.pid ?? 0);
      this.startedAt = Date.now();
      let resolveEnd!: (detail: string) => void;
      let endedDetail = false;
      const childEnd = new Promise<string>((resolve) => { resolveEnd = resolve; });
      this.childEnd = childEnd;
      const finishEnd = (detail: string) => { if (endedDetail) return; endedDetail = true; resolveEnd(detail); };
      const guard = new ReverseRequestGuard((message) => {
        void enqueueWrite(child.stdin, `${JSON.stringify(message)}\n`, this.writes).catch(() => {});
      });
      this.guard = guard;
      let rejectEnded!: (error: Error) => void;
      const ended = new Promise<never>((_, reject) => { rejectEnded = reject; });
      void ended.catch(() => {});
      const fail = (why: string) => {
        rejectEnded(new Error(why));
        if (this.child === child) this.drop(why);
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => this.pushStderr(chunk));
      child.stderr.on('error', () => {});
      child.stdout.on('error', () => {});
      child.once('error', (error) => {
        const detail = spawnFailureMessage(binary, error, this.stderrText());
        this.writeLog(`spawn: ${detail}`);
        finishEnd(detail);
        fail(detail);
      });
      child.once('exit', (code, signal) => {
        this.watchdog?.setPid(0);
        const killed = this.watchdog?.takeKill();
        this.recordExit(code, signal, !!killed);
        // 'exit' can beat the last stderr chunk. A short wait lets that chunk land in the ring.
        setTimeout(() => {
          this.flushStderr();
          const detail = killed
            ? watchdogMessage(killed.stallMs)
            : childExitMessage(binary, code, signal, this.stderrText(), this.ready ? 'running' : 'startup');
          this.writeLog(`exit: ${detail.split('\n')[0]}`);
          finishEnd(detail);
          fail(detail);
        }, 20);
      });
      child.stdin.on('error', (error) => fail(error.message));
      const abort = () => fail('Grok connection cancelled.');
      signal?.addEventListener('abort', abort, { once: true });
      child.once('close', () => signal?.removeEventListener('abort', abort));
      if (signal?.aborted) abort();
      const filtered = child.stdout.pipe(jsonLineTransform((line) => this.writeLog(`framing: skipped non-JSON stdout: ${line}`)));
      // Node's toWeb() streams and the ACP SDK's DOM stream types disagree on Uint8Array generics.
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(filtered) as unknown as ReadableStream<Uint8Array>,
      );
      const writer = stream.writable.getWriter();
      const guardedStream = {
        readable: stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
          transform(message, controller) { guard.watch(message); controller.enqueue(message); },
        })),
        writable: new WritableStream<AnyMessage>({
          write(message) { if (guard.settle(message) === 'forward') return writer.write(message); },
        }),
      };
      try {
        this.connection = client({ name: 'pi-grok-model' })
          .onNotification('session/update', ({ params }) => {
            this.sessions.get(params.sessionId)?.onUpdate(params);
          })
          .onRequest('session/request_permission', async ({ params }) => {
            this.watchdog?.enter();
            try {
              const owned = this.sessions.get(params.sessionId);
              if (!owned?.onPermission) return { outcome: { outcome: 'cancelled' as const } };
              return await owned.onPermission(params);
            } finally { this.watchdog?.leave(); }
          })
          .onRequest('_x.ai/ask_user_question', (raw) => raw as any, async ({ params }) => {
            this.watchdog?.enter();
            try {
              const id = params.sessionId ?? params.session_id;
              const owned = id ? this.sessions.get(id) : undefined;
              if (!owned?.onQuestion) return { outcome: 'cancelled' };
              return await owned.onQuestion(params);
            } finally { this.watchdog?.leave(); }
          })
          .onRequest('_x.ai/hooks/run', (raw) => raw as any, async ({ params }) => {
            this.watchdog?.enter();
            try {
              if (!params || typeof params.hookEventName !== 'string' || !params.hookEventName) {
                return { decision: 'deny', reason: 'Malformed hook payload: missing hookEventName.' };
              }
              const id = params.sessionId ?? params.session_id;
              const owned = id ? this.sessions.get(id) : undefined;
              const event = String(params.hookEventName ?? '');
              if (!owned?.onHookRun) {
                // No Pi session owns this Grok session (/new, session_tree, or a late event). Answer now.
                if (event === 'pre_tool_use') return { decision: 'deny', reason: `Pi detached from this Grok session; tool use is denied until a Pi session owns it again. ${UNKNOWN_SESSION}` };
                return { decision: 'continue' };
              }
              return await owned.onHookRun(params, { dialog: () => {} });
            } catch (error) {
              return { decision: 'deny', reason: `Malformed hook payload: ${error instanceof Error ? error.message : String(error)}` };
            } finally { this.watchdog?.leave(); }
          })
          .onNotification('_x.ai/session_notification', (raw) => raw as any, ({ params }) => {
            this.sessions.get(params.sessionId ?? params.session_id)?.onSessionExt?.(params.update);
          })
          .onNotification('_x.ai/hooks/event', (raw) => raw as any, ({ params }) => {
            this.sessions.get(params.sessionId ?? params.session_id)?.onHookEvent?.(params);
          })
          .onRequest('_x.ai/mcp/sdk_call', (raw) => raw as { serverId: string; message: SdkCall }, async ({ params }) => {
            const { message, serverId } = params;
            try {
              const handlers = this.servers.get(serverId);
              if (!handlers) throw new Error(`no session for server ${serverId}`);
              const result = await handlers.onMcp(message);
              this.mcpStats.callsServed++;
              const tools = (result as { tools?: unknown })?.tools;
              if (message.method === 'tools/list' && Array.isArray(tools)) this.mcpStats.toolsLent = tools.length;
              return { jsonrpc: '2.0', id: message.id, result };
            } catch (error) {
              this.mcpStats.callsFailed++;
              return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
            }
          })
          .connect(guardedStream);
        const agent = this.connection.agent as unknown as { request: (method: string, params?: unknown) => Promise<unknown> };
        this.installRequestGuard(agent);
        this.initialized = await Promise.race([ended, agent.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'pi-grok-model', version: '0.1.0' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          _meta: { 'x.ai/mcp/sdk': true },
        })]) as InitializeResponse;
        if ((this.initialized.authMethods ?? []).some((m) => m.id === 'cached_token')) {
          try {
            await Promise.race([ended, agent.request('authenticate', { methodId: 'cached_token' })]);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (isExplained(message)) throw error;
            this.drop(SIGNED_OUT_MESSAGE);
            throw new Error(SIGNED_OUT_MESSAGE);
          }
        } else {
          // Grok offers `cached_token` only with a stored login. Drop this connection so the turn after a login
          // initializes again and sees the new credential.
          this.drop(SIGNED_OUT_MESSAGE);
          throw new Error(SIGNED_OUT_MESSAGE);
        }
        this.ready = true;
        // The signal aborts startup only. A later Escape cancels the turn; it must not drop this child here.
        signal?.removeEventListener('abort', abort);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (this.child === child) this.drop(err.message);
        if (isExplained(err.message)) throw err;
        throw new Error(`Grok stdio child ${binary}: ${err.message}`, { cause: error });
      }
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  get agent() {
    if (!this.connection) throw new Error('Grok model connection is not open.');
    return this.connection.agent;
  }

  /** Retained for the extension's UI state; no guard deadlines depend on it. */
  hasUI = false;

  /** Create or load a Grok session with Grok's native harness intact. `offerPiTools` registers the in-process MCP server. */
  async attachSession(input: { sessionId?: string; cwd: string; serverId: string; serverName: string; rules?: string; handlers: SessionHandlers; toolTimeoutMs?: number; offerPiTools: boolean; hooks?: boolean; grokMode?: 'default' | 'auto' | 'yolo' }) {
    const _meta: Record<string, unknown> = { yoloMode: input.grokMode === 'yolo', ...(input.grokMode === 'auto' ? { autoMode: true } : {}) };
    if (input.hooks !== false) _meta['x.ai/hooks'] = CLIENT_HOOKS;
    const mcpServers: unknown[] = [];
    if (input.offerPiTools) {
      _meta['x.ai/mcp/servers'] = [{ name: input.serverName, serverId: input.serverId }];
      _meta.mcpConfig = { [input.serverName]: { toolTimeoutMs: input.toolTimeoutMs ?? 6 * 60 * 60 * 1000 } };
    }
    if (input.rules) _meta.rules = input.rules;
    const params = { cwd: input.cwd, mcpServers, _meta };
    // Registered before the request: Grok may list the MCP server's tools while session/new is pending.
    this.servers.set(input.serverId, input.handlers);
    let session: NewSessionResponse | LoadSessionResponse;
    let sessionId: string;
    let replacedSessionId: string | undefined;
    try {
      if (input.sessionId) {
        this.sessions.set(input.sessionId, input.handlers);
        try {
          session = await this.agent.request<LoadSessionResponse>('session/load', { ...params, sessionId: input.sessionId });
          sessionId = input.sessionId;
        } catch (error) {
          if (!isMissingSession(error)) throw error;
          // The id is not on disk (wiped ~/.grok, or a different account). Start over and keep the new id.
          if (this.sessions.get(input.sessionId) === input.handlers) this.sessions.delete(input.sessionId);
          const created = await this.agent.request<NewSessionResponse>('session/new', params);
          session = created;
          sessionId = created.sessionId;
          replacedSessionId = input.sessionId;
          this.sessions.set(sessionId, input.handlers);
        }
      } else {
        const created = await this.agent.request<NewSessionResponse>('session/new', params);
        session = created;
        sessionId = created.sessionId;
        this.sessions.set(sessionId, input.handlers);
      }
    } catch (error) {
      // No session exists: a late MCP call or update must not reach these handlers.
      if (this.servers.get(input.serverId) === input.handlers) this.servers.delete(input.serverId);
      if (input.sessionId && this.sessions.get(input.sessionId) === input.handlers) this.sessions.delete(input.sessionId);
      throw error;
    }
    return { sessionId, response: session, replacedSessionId };
  }

  detachSession(sessionId: string, serverId: string) {
    this.sessions.delete(sessionId);
    this.servers.delete(serverId);
  }

  /** End only this agent child; a new open starts another and sessions session/load themselves. */
  drop(reason = 'reconnect requested') {
    this.watchdog?.setPid(0);
    const child = this.child;
    const wasLive = !!this.connection || !!child;
    this.guard?.close(reason);
    const writes = this.writes;
    this.markDropped(reason);
    if (wasLive) for (const listener of this.dropListeners) listener(reason);
    if (!child) return;
    // Fail-closed answers are queued on `writes`. End stdin only after they flush, then SIGTERM, then SIGKILL.
    // Node cannot set PDEATHSIG; a SIGKILL of Pi only closes these pipes.
    const stopped = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const term = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }, this.stopGraceMs);
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, this.stopGraceMs * 2);
      child.once('close', () => { clearTimeout(term); clearTimeout(kill); resolve(); });
      const endStdin = () => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end(); };
      void writes.chain.then(endStdin, endStdin);
    });
    this.stopping.add(stopped);
    void stopped.finally(() => this.stopping.delete(stopped));
  }

  async close() {
    this.closed = true;
    this.watchdog?.stop();
    this.watchdog = undefined;
    this.drop('Pi connection closed');
    this.sessions.clear();
    this.servers.clear();
    await Promise.all(this.stopping);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
