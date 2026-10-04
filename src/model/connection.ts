// One stdio agent per Pi process; sessions and HTTP MCP routes share that child.
import { client, ndJsonStream, type AnyMessage, type ClientConnection, type InitializeResponse, type NewSessionResponse, type LoadSessionResponse, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { GATE_REGISTRATION_MS } from '../config.ts';
import { ReverseRequestGuard } from './guard.ts';
import { startMcpServer } from './mcp-server.ts';

export type ConnectionOptions = { binary?: string; env?: NodeJS.ProcessEnv };
type AgentChild = ChildProcessByStdio<Writable, Readable, null>;

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

/** Grok caps hook deadlines at 600 s and fails OPEN on expiry; there are no in-process deadlines. */
export const CLIENT_HOOKS = {
  PreToolUse: [{ hookCallbackIds: ['pi-pre'], timeout: GATE_REGISTRATION_MS / 1000 }],
  PostToolUse: [{ hookCallbackIds: ['pi-post'], timeout: 600 }],
  PostToolUseFailure: [{ hookCallbackIds: ['pi-post-failure'], timeout: 60 }],
  Stop: [{ hookCallbackIds: ['pi-stop'], timeout: 600 }],
};

export class GrokModelConnection {
  private child?: AgentChild;
  private guard?: ReverseRequestGuard;
  private stopping = new Set<Promise<void>>();
  private mcpServer?: Awaited<ReturnType<typeof startMcpServer>>;
  private mcpStarting?: ReturnType<typeof startMcpServer>;
  private connection?: ClientConnection;
  private initialized?: InitializeResponse;
  private readonly sessions = new Map<string, SessionHandlers>();
  // serverId -> handlers. Registered before session/new is sent: Grok lists the MCP server's tools while it
  // creates the session, before Pi knows the session id.
  private readonly servers = new Map<string, SessionHandlers>();
  private opening?: Promise<void>;
  private closed = false;
  private readonly options: ConnectionOptions;
  constructor(options: ConnectionOptions = {}) { this.options = { ...options }; }

  get binary() { return this.options.binary ?? process.env.PI_GROK_BINARY ?? 'grok'; }

  /** Reasons the last connection ended, for status and error text. */
  lastDrop?: string;

  get isOpen() { return !!this.connection && !this.closed; }

  /** The child went away. Sessions stay in the map so attach() can session/load them. */
  private markDropped(reason: string) {
    if (!this.connection && !this.child) return;
    this.lastDrop = reason;
    this.connection = undefined;
    this.child = undefined;
    this.guard = undefined;
    this.initialized = undefined;
    this.generation++;
  }

  /** Increments on every drop; a session attached under an older generation must session/load again. */
  generation = 0;

  async open(signal?: AbortSignal) {
    if (this.opening) return this.opening;
    if (this.connection) return;
    this.closed = false;
    signal?.throwIfAborted();
    this.opening = (async () => {
      const binary = this.binary;
      const child = spawn(binary, ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'], {
        stdio: ['pipe', 'pipe', 'inherit'],
        // Grok Build 1.0.46 user guide, 14-headless-mode.md: SDKs inject this for non-leader agents they spawn.
        env: { ...process.env, ...this.options.env, GROK_DISABLE_AUTOUPDATER: '1' },
      });
      this.child = child;
      const guard = new ReverseRequestGuard((message) => {
        if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n');
      });
      this.guard = guard;
      let rejectEnded!: (error: Error) => void;
      const ended = new Promise<never>((_, reject) => { rejectEnded = reject; });
      const fail = (why: string) => {
        rejectEnded(new Error(`Grok stdio child ${binary}: ${why}`));
        if (this.child === child) this.drop(why);
      };
      child.once('error', (error) => fail(error.message));
      child.once('exit', (code, signal) => fail(`exited (${code ?? signal})`));
      child.stdin.on('error', (error) => fail(error.message));
      const abort = () => fail('connection cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      child.once('close', () => signal?.removeEventListener('abort', abort));
      if (signal?.aborted) abort();
      const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
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
            const handler = this.sessions.get(params.sessionId)?.onPermission;
            return handler ? handler(params) : { outcome: { outcome: 'cancelled' } };
          })
          .onRequest('_x.ai/ask_user_question', (raw) => raw as any, async ({ params }) => {
            const handler = this.sessions.get(params.sessionId ?? params.session_id)?.onQuestion;
            return handler ? handler(params) : { outcome: 'cancelled' };
          })
          .onRequest('_x.ai/hooks/run', (raw) => raw as any, async ({ params }) => {
            const handler = this.sessions.get(params.sessionId ?? params.session_id)?.onHookRun;
            const event = String(params.hookEventName ?? '');
            if (handler) return handler(params, { dialog: () => {} });
            // No Pi session owns this Grok session (detached by /new or shutdown while a turn was still running).
            // Pi's capability gate is gone, so tool use is denied rather than left to Grok's own permission mode.
            if (event === 'pre_tool_use') return { decision: 'deny', reason: 'Pi detached from this Grok session; tool use is denied until a Pi session owns it again.' };
            return { decision: 'continue' };
          })
          .onNotification('_x.ai/session_notification', (raw) => raw as any, ({ params }) => {
            this.sessions.get(params.sessionId ?? params.session_id)?.onSessionExt?.(params.update);
          })
          .onNotification('_x.ai/hooks/event', (raw) => raw as any, ({ params }) => {
            this.sessions.get(params.sessionId ?? params.session_id)?.onHookEvent?.(params);
          })
          .connect(guardedStream);
        const agent = this.connection.agent;
        this.initialized = await Promise.race([ended, agent.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'pi-grok-model', version: '0.1.0' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        })]);
        if ((this.initialized.authMethods ?? []).some((m) => m.id === 'cached_token')) {
          await Promise.race([ended, agent.request('authenticate', { methodId: 'cached_token' })]);
        } else {
          // Grok offers `cached_token` only with a stored login. Drop this connection so the turn after a login
          // initializes again and sees the new credential.
          this.drop('Grok Build is not signed in');
          throw new Error('Grok Build is not signed in. Run /grok login, approve the code in your browser, then send the message again.');
        }
      } catch (error) {
        if (this.child === child) this.drop(error instanceof Error ? error.message : String(error));
        throw new Error(`Grok stdio child ${binary}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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

  get mcpBaseUrl() { return this.mcpServer?.baseUrl; }

  private async ensureMcpServer() {
    if (!this.mcpStarting) this.mcpStarting = startMcpServer((id) => this.servers.get(id));
    this.mcpServer = await this.mcpStarting;
    return this.mcpServer;
  }

  /** Create or load a Grok session with Grok's native harness intact. `offerPiTools` adds the Pi-hosted MCP server. */
  async attachSession(input: { sessionId?: string; cwd: string; serverId: string; serverName: string; rules?: string; handlers: SessionHandlers; toolTimeoutMs?: number; offerPiTools: boolean; hooks?: boolean; grokMode?: 'default' | 'auto' | 'yolo' }) {
    const _meta: Record<string, unknown> = { yoloMode: input.grokMode === 'yolo', ...(input.grokMode === 'auto' ? { autoMode: true } : {}) };
    if (input.hooks !== false) _meta['x.ai/hooks'] = CLIENT_HOOKS;
    const mcpServers: unknown[] = [];
    if (input.offerPiTools) {
      await this.ensureMcpServer();
      mcpServers.push({ type: 'http', name: input.serverName, url: `${this.mcpBaseUrl}/mcp/${input.serverId}`, headers: [] });
      _meta.mcpConfig = { [input.serverName]: { toolTimeoutMs: input.toolTimeoutMs ?? 6 * 60 * 60 * 1000 } };
    }
    if (input.rules) _meta.rules = input.rules;
    const params = { cwd: input.cwd, mcpServers, _meta };
    // Registered before the request: Grok may list the MCP server's tools while session/new is pending.
    this.servers.set(input.serverId, input.handlers);
    let session: NewSessionResponse | LoadSessionResponse;
    let sessionId: string;
    try {
      if (input.sessionId) {
        this.sessions.set(input.sessionId, input.handlers);
        session = await this.agent.request<LoadSessionResponse>('session/load', { ...params, sessionId: input.sessionId });
        sessionId = input.sessionId;
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
    return { sessionId, response: session };
  }

  detachSession(sessionId: string, serverId: string) {
    this.sessions.delete(sessionId);
    this.servers.delete(serverId);
  }

  /** End only this agent child; a new open starts another and sessions session/load themselves. */
  drop(reason = 'reconnect requested') {
    const child = this.child;
    this.guard?.close(reason);
    this.markDropped(reason);
    if (!child) return;
    // Flush close-time answers before EOF. Kill a child that does not exit on pipe closure.
    const stopped = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const kill = setTimeout(() => child.kill('SIGKILL'), 500);
      child.once('close', () => { clearTimeout(kill); resolve(); });
      child.stdin.end();
    });
    this.stopping.add(stopped);
    void stopped.finally(() => this.stopping.delete(stopped));
  }

  async close() {
    this.closed = true;
    this.drop('Pi connection closed');
    this.sessions.clear();
    this.servers.clear();
    const server = await this.mcpStarting;
    await server?.close();
    this.mcpServer = undefined;
    this.mcpStarting = undefined;
    await Promise.all(this.stopping);
  }
}
