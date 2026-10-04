// One WebSocket to Grok, many sessions. Grok keeps its full native harness (its own tools,
// permissions, subagents). Pi tools are offered additively as an HTTP MCP server that the gateway
// fronts at /mcp/<serverId>; the gateway relays each MCP message back over this socket as an
// _x.ai/mcp/sdk_call request, routed here by serverId. The stock leader never sees that traffic.
import { client, type ClientConnection, type InitializeResponse, type NewSessionResponse, type LoadSessionResponse, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { openSocket, type ConnectionOptions } from '../client.ts';
import { readSecretFile } from '../config.ts';
import { endpointListening, launchGateway } from '../launch.ts';
import { GATE_REGISTRATION_MS } from '../config.ts';

export type McpToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type McpToolResult = { content: { type: 'text'; text: string }[] | { type: 'image'; data: string; mimeType: string }[] | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
export type SdkCall = { method: string; id: unknown; params?: any };

export interface SessionHandlers {
  onUpdate(notification: SessionNotification): void;
  /** Answer one MCP JSON-RPC message from Grok. Return the JSON-RPC `result` or throw for an error. */
  onMcp(message: SdkCall): Promise<unknown>;
  onPermission?(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /**
   * Blocking client hook (`_x.ai/hooks/run`): pre_tool_use, post_tool_use, stop. `gate.dialog()` tells the gateway a
   * human is deciding, so it waits the dialog window instead of the short policy window before answering for Pi.
   */
  onHookRun?(payload: any, gate?: { dialog(): void }): Promise<Record<string, unknown>>;
  /** Passive client hook notification (`_x.ai/hooks/event`). */
  onHookEvent?(payload: any): void;
  /** Grok's ask_user_question (`_x.ai/ask_user_question`). Default: cancelled. */
  onQuestion?(request: any): Promise<Record<string, unknown>>;
  /** Grok's extension session notifications (`_x.ai/session_notification`): turn_completed carries full token usage. */
  onSessionExt?(update: any): void;
}

/**
 * Client hook registration sent in session/new. Grok caps timeouts at 600 s and fails OPEN on expiry.
 * The gate gets a short deadline; the gateway denies on Pi's behalf well before it (PI_GROK_GATE_DENY_MS).
 */
export const CLIENT_HOOKS = {
  PreToolUse: [{ hookCallbackIds: ['pi-pre'], timeout: GATE_REGISTRATION_MS / 1000 }],
  PostToolUse: [{ hookCallbackIds: ['pi-post'], timeout: 600 }],
  PostToolUseFailure: [{ hookCallbackIds: ['pi-post-failure'], timeout: 60 }],
  Stop: [{ hookCallbackIds: ['pi-stop'], timeout: 600 }],
};

type SdkCallParams = { serverId: string; sessionId?: string; message: SdkCall };

export class GrokModelConnection {
  private socket?: Awaited<ReturnType<typeof openSocket>>;
  private connection?: ClientConnection;
  private initialized?: InitializeResponse;
  private readonly sessions = new Map<string, SessionHandlers>();
  private readonly servers = new Map<string, string>(); // serverId -> sessionId
  private opening?: Promise<void>;
  private closed = false;
  private readonly options: ConnectionOptions & { secretFile?: string; autoStart?: { logDir: string } };

  /**
   * `secret` may be empty when the gateway has not created its file yet; `secretFile` is read again on each open.
   * With `autoStart`, an open that finds nothing listening on a loopback non-TLS endpoint starts the bundled gateway.
   */
  constructor(options: ConnectionOptions & { secretFile?: string; autoStart?: { logDir: string } }) { this.options = { ...options }; }

  /** Pid of the gateway this connection started, if any. */
  launchedGateway?: number;

  private async ensureGateway() {
    let endpoint: URL;
    try {
      endpoint = new URL(this.options.url);
    } catch {
      return;
    }
    if (!this.options.autoStart || endpoint.protocol !== 'ws:') return;
    if (await endpointListening(this.options.url)) return;
    this.launchedGateway = await launchGateway(this.options.url, this.options.autoStart.logDir);
  }

  /** Fill in the secret from its file on first open, so Pi loads and the gateway may start after it. */
  private async resolveSecret() {
    if (this.options.secret.trim() || !this.options.secretFile) return;
    const secret = await readSecretFile(this.options.secretFile);
    if (!secret) throw new Error(`Grok gateway secret not found at ${this.options.secretFile}. Start the gateway once (pi-grok-gateway, or npm run server in the clone); it creates the file. Then send the message again.`);
    this.options.secret = secret;
  }

  /** Reasons the last connection ended, for status and error text. */
  lastDrop?: string;

  get isOpen() { return !!this.connection && !this.closed; }

  /** The socket went away underneath us (gateway restart, network). Sessions stay in the map so attach() can session/load them. */
  private markDropped(reason: string) {
    if (!this.connection && !this.socket) return;
    this.lastDrop = reason;
    this.connection = undefined;
    this.socket = undefined;
    this.initialized = undefined;
    this.generation++;
  }

  /** Increments on every drop; a session attached under an older generation must session/load again. */
  generation = 0;

  async open(signal?: AbortSignal) {
    if (this.connection) return;
    if (this.opening) return this.opening;
    this.closed = false;
    this.opening = (async () => {
      await this.ensureGateway();
      await this.resolveSecret();
      const socket = await openSocket(this.options, signal);
      this.socket = socket;
      void socket.closed.then(() => { if (this.socket === socket) this.markDropped('Grok WebSocket closed'); });
      this.connection = client({ name: 'pi-grok-model' })
        .onNotification('session/update', ({ params }) => {
          this.sessions.get(params.sessionId)?.onUpdate(params);
        })
        .onRequest('session/request_permission', async ({ params }) => {
          const handler = this.sessions.get(params.sessionId)?.onPermission;
          this.ack(`perm:${params.toolCall?.toolCallId ?? ''}`, { dialog: this.hasUI });
          return handler ? handler(params) : { outcome: { outcome: 'cancelled' } };
        })
        .onRequest('_x.ai/ask_user_question', (raw) => raw as any, async ({ params }) => {
          const handler = this.sessions.get(params.sessionId ?? params.session_id)?.onQuestion;
          this.ack(`ask:${params.toolCallId ?? params.tool_call_id ?? ''}`, { dialog: this.hasUI });
          return handler ? handler(params) : { outcome: 'cancelled' };
        })
        .onRequest('_x.ai/hooks/run', (raw) => raw as any, async ({ params }) => {
          const handler = this.sessions.get(params.sessionId ?? params.session_id)?.onHookRun;
          const event = String(params.hookEventName ?? '');
          const key = event === 'stop' ? `stop:${params.sessionId ?? params.session_id ?? ''}` : `${event}:${params.toolUseId ?? ''}`;
          this.ack(key, { check: event === 'post_tool_use' || event === 'stop' });
          if (handler) return handler(params, { dialog: () => this.ack(key, { dialog: true }) });
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
        .onRequest('_x.ai/mcp/sdk_call', (raw) => raw as SdkCallParams, async ({ params }) => {
          const sessionId = params.sessionId ?? this.servers.get(params.serverId);
          const handlers = sessionId ? this.sessions.get(sessionId) : undefined;
          const { message } = params;
          if (!handlers) return { jsonrpc: '2.0', id: message.id, error: { code: -32001, message: `no session for server ${params.serverId}` } };
          try {
            const result = await handlers.onMcp(message);
            return { jsonrpc: '2.0', id: message.id, result };
          } catch (error) {
            return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
          }
        })
        .connect(socket.stream);
      const agent = this.connection.agent;
      this.initialized = await agent.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'pi-grok-model', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        _meta: { 'x.ai/mcp/sdk': true },
      });
      if ((this.initialized.authMethods ?? []).some((m) => m.id === 'cached_token')) {
        await agent.request('authenticate', { methodId: 'cached_token' });
      } else {
        // Grok offers `cached_token` only with a stored login. Drop this connection so the turn after a login
        // initializes again and sees the new credential.
        this.socket?.close();
        this.markDropped('Grok Build is not signed in');
        throw new Error('Grok Build is not signed in. Run /grok login, approve the code in your browser, then send the message again.');
      }
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  get agent() {
    if (!this.connection) throw new Error('Grok model connection is not open.');
    return this.connection.agent;
  }

  /** Whether a human can answer dialogs; the gateway extends permission deadlines when true. */
  hasUI = false;

  /**
   * Tell the gateway Pi is alive and what it is doing with a reverse request (`pi/gate-ack`).
   * The gateway consumes this; it never reaches Grok. Missing acks make the gateway fail closed. A later ack for
   * the same key moves the request to that tier's deadline (for example a hook that turns into a dialog).
   */
  private ack(key: string, state: { dialog?: boolean; check?: boolean }) {
    void this.connection?.agent.notify('pi/gate-ack', { key, ...state }).catch(() => {});
  }

  /** HTTP origin of the gateway that fronts this WebSocket. */
  get mcpBaseUrl() {
    try {
      const url = new URL(this.options.url);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      return url.origin;
    } catch (cause) {
      throw new Error(`Invalid Grok gateway URL: ${this.options.url}`, { cause });
    }
  }

  /** Create or load a Grok session with Grok's native harness intact. `offerPiTools` adds the Pi-hosted MCP server. */
  async attachSession(input: { sessionId?: string; cwd: string; serverId: string; serverName: string; rules?: string; handlers: SessionHandlers; toolTimeoutMs?: number; offerPiTools: boolean; hooks?: boolean; grokMode?: 'default' | 'auto' | 'yolo' }) {
    const _meta: Record<string, unknown> = { yoloMode: input.grokMode === 'yolo', ...(input.grokMode === 'auto' ? { autoMode: true } : {}) };
    if (input.hooks !== false) _meta['x.ai/hooks'] = CLIENT_HOOKS;
    const mcpServers: unknown[] = [];
    if (input.offerPiTools) {
      mcpServers.push({ type: 'http', name: input.serverName, url: `${this.mcpBaseUrl}/mcp/${input.serverId}`, headers: [] });
      _meta.mcpConfig = { [input.serverName]: { toolTimeoutMs: input.toolTimeoutMs ?? 6 * 60 * 60 * 1000 } };
    }
    if (input.rules) _meta.rules = input.rules;
    const params = { cwd: input.cwd, mcpServers, _meta };
    this.servers.set(input.serverId, input.sessionId ?? '');
    let session: NewSessionResponse | LoadSessionResponse;
    let sessionId: string;
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
    this.servers.set(input.serverId, sessionId);
    return { sessionId, response: session };
  }

  detachSession(sessionId: string, serverId: string) {
    this.sessions.delete(sessionId);
    this.servers.delete(serverId);
  }

  /** Close the socket but keep this connection usable: the next `open()` reconnects and sessions `session/load` themselves. */
  drop(reason = 'reconnect requested') {
    const socket = this.socket;
    this.markDropped(reason);
    socket?.close();
  }

  async close() {
    this.closed = true;
    this.sessions.clear();
    this.servers.clear();
    this.connection = undefined;
    this.socket?.close();
    this.socket = undefined;
  }
}
