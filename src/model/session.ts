// Per-Pi-session Grok turn state. Grok runs one long turn per user prompt on its own harness:
// native tools execute inside Grok and show up here as observations. Only calls to Pi-hosted
// tools are parked until Pi's loop returns a result. Events that arrive while no Pi stream is
// consuming are buffered.
import type { SessionNotification, PromptResponse, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Tool, ToolResultMessage } from '@earendil-works/pi-ai';
import type { GrokModelConnection, McpToolDefinition, SdkCall } from './connection.ts';
import { descriptionForPiTool, PI_MCP_SERVER_NAME, type PiToolAttribution, type PiToolRoute } from '../tool-policy.ts';
import { capabilityGate, postEditContext, stopGate, classify, mcpServerOf, type GrokToolStamp, type HookRun, type HookReply } from './hooks.ts';
import type { HookSettings, PiPermissionMode } from '../config.ts';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

export type TurnEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'thought'; delta: string }
  | { kind: 'toolcall'; toolCallId: string; name: string; arguments: Record<string, unknown> }
  | { kind: 'complete'; response: PromptResponse; usage?: GrokTurnUsage }
  | { kind: 'error'; error: Error };

/** Token accounting from Grok's `turn_completed` extension notification (per turn, all model calls summed). */
export type GrokTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  modelCalls: number;
  /** Grok reports cost in USD ticks; 1e9 ticks per dollar by cross-check against SuperGrok rates. */
  costUsd: number;
  /** Context size after the turn (`_meta.totalTokens` on the prompt response). */
  contextTokens?: number;
};
export function parseTurnUsage(raw: any): GrokTurnUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { inputTokens: n(raw.inputTokens), outputTokens: n(raw.outputTokens), cachedReadTokens: n(raw.cachedReadTokens), cacheCreationTokens: n(raw.cacheCreationTokens), reasoningTokens: n(raw.reasoningTokens), modelCalls: n(raw.modelCalls), costUsd: n(raw.costUsdTicks) / 1e9 };
}

/** One Grok-native tool call, executed on Grok's harness, as a structured record for Pi's session. */
export type GrokToolRecord = {
  toolUseId: string;
  tool: string;
  input: unknown;
  status: 'completed' | 'failed' | 'denied';
  output?: string;
  durationMs?: number;
  denyReason?: string;
  hookContext?: string;
  /** Media file Pi shows and later turns can use: the project copy when `mediaDir` is set, else Grok's original. */
  mediaPath?: string;
  /** Grok's original file under ~/.grok/sessions/<url-encoded cwd>/..., kept for reference. */
  sourcePath?: string;
};

/** Display-only activity entries for complete, low-frequency Grok state that is not otherwise shown. */

type Parked = { resolve(result: unknown): void; reject(error: Error): void };
type NativeCall = { title: string };

export class GrokModelSession {
  grokSessionId?: string;
  readonly serverId: string;
  tools: Tool[] = [];
  private readonly parked = new Map<string, Parked>();
  private readonly buffer: TurnEvent[] = [];
  private consumer?: (event: TurnEvent) => void;
  private activePrompt?: Promise<PromptResponse>;
  private toolSeq = 0;
  private readonly connection: GrokModelConnection;
  readonly piSessionId: string;
  readonly cwd: string;
  /** Grok's native permission prompts (file edits, shell) go here; default denies. */
  permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> = async () => ({ outcome: { outcome: 'cancelled' } });
  /** Grok's ask_user_question; default cancelled (the model is told the user did not answer). */
  ask: (request: any) => Promise<Record<string, unknown>> = async () => ({ outcome: 'cancelled' });
  /** Pi tool names present in the Pi session; the pre_tool_use gate mirrors them onto Grok's harness. */
  piToolNames: string[] = [];
  /** Runtime source/namespace metadata for Pi tools, when Pi exposes it before transcript serialization. */
  piToolAttributions: readonly PiToolAttribution[] = [];
  /** Grok-facing MCP names mapped back to original Pi tool names. */
  piToolRoutes: PiToolRoute[] = [];
  hookSettings: HookSettings = {};
  /** Grok-side permission mode sent at session/new. */
  grokMode: 'default' | 'auto' | 'yolo' = 'default';
  /**
   * Pi-side permission mode for Grok's native tools, applied at pre_tool_use (so it holds even where Grok's own
   * rules would auto-allow): `auto` = capability mirror only; `readonly` = deny writes and shell regardless of Pi's
   * tools; `ask` = mirror, then a Pi dialog for every write or shell call; `yolo` = mirror as if Pi had read, edit,
   * write, and bash, with no Pi dialog, and a Grok permission prompt is answered allow once. `denyGrokTools` still
   * applies. `ask_user_question` still opens a dialog. Headless Pi treats `ask` as `readonly`.
   */
  permissionMode: PiPermissionMode = 'auto';
  /** Dialog used by `ask` mode; set by the extension when Pi has a UI. */
  askDialog?: (tool: string, input: unknown) => Promise<boolean>;
  /** Directory for project copies of Grok media (relative to cwd, or absolute). Empty disables copying. */
  mediaDir = '.pi/grok-images';
  /** Hook decisions this session made, for evidence and tests. */
  readonly hookLog: { event: string; tool?: string; decision?: string; reason?: string; context?: string }[] = [];
  /** Grok tool calls seen by the pre_tool_use hook in this session (hookLog keeps only the recent entries). */
  toolCallsSeen = 0;
  private logHook(entry: GrokModelSession['hookLog'][number]): void {
    this.hookLog.push(entry);
    if (this.hookLog.length > HOOK_LOG_LIMIT) this.hookLog.splice(0, this.hookLog.length - HOOK_LOG_LIMIT);
  }
  /** Receives one structured record per Grok-native tool call (from the hook pairs). */
  onToolRecord?: (record: GrokToolRecord) => void;
  /** Receives visible, display-only Grok activity records. */
  private readonly nativeCalls = new Map<string, NativeCall>(); // toolCallId -> active call
  /** `_meta["x.ai/tool"]` from each tool_call update, keyed by toolCallId; the gate classifies by it. */
  private readonly stamps = new Map<string, GrokToolStamp>();
  /** Per-tool `_meta` from `_x.ai/mcp/list`, keyed by qualified `server__tool`. Fetched once per session on first need. */
  private mcpToolMeta?: Map<string, unknown>;
  private mcpToolMetaLoading?: Promise<void>;

  private async loadMcpToolMeta() {
    if (this.mcpToolMeta || !this.grokSessionId) return;
    if (!this.mcpToolMetaLoading) this.mcpToolMetaLoading = (async () => {
      const map = new Map<string, unknown>();
      try {
        const raw: any = await this.connection.agent.request('_x.ai/mcp/list', { sessionId: this.grokSessionId });
        const body = raw?.result ?? raw;
        for (const server of body?.servers ?? []) for (const tool of server?.session?.tools ?? []) if (tool?._meta) map.set(`${server.name}__${tool.name}`, tool._meta);
      } catch { /* no catalog: fall back to server allowlist */ }
      this.mcpToolMeta = map;
    })();
    await this.mcpToolMetaLoading;
  }

  constructor(connection: GrokModelConnection, piSessionId: string, cwd: string, serverId?: string) {
    this.connection = connection;
    this.piSessionId = piSessionId;
    this.cwd = cwd;
    this.serverId = serverId ?? `pi-${piSessionId}`;
  }

  get promptActive() { return !!this.activePrompt; }
  get pendingToolCallIds() { return [...this.parked.keys()]; }

  /** Set when a turn had to reconnect; the provider surfaces it once. */
  reconnected?: string;
  /** Connection generation this session was attached under; a newer generation means the socket dropped since. */
  private attachedGeneration = -1;
  /** True once a Grok turn attached this session in this Pi process (a restored session ID alone does not count). */
  get attached(): boolean { return this.attachedGeneration >= 0; }

  async attach(rules: string | undefined) {
    if (!this.connection.isOpen) await this.connection.open();
    if (this.grokSessionId && this.attachedGeneration === this.connection.generation) return;
    if (this.grokSessionId && this.attachedGeneration >= 0) {
      // Socket dropped since the last attach (for example a gateway restart). session/load the same Grok session; history lives on the leader.
      if (this.activePrompt) { this.activePrompt = undefined; this.rejectParked('Grok connection dropped; the turn was lost.'); }
      this.reconnected = this.connection.lastDrop ?? 'reconnected';
    }
    const { sessionId, response } = await this.connection.attachSession({
      sessionId: this.grokSessionId, cwd: this.cwd, serverId: this.serverId, serverName: PI_MCP_SERVER_NAME, rules,
      offerPiTools: this.tools.length > 0, grokMode: this.grokMode,
      handlers: { onUpdate: (n) => this.onUpdate(n), onMcp: (m) => this.onMcp(m), onPermission: (r) => this.permission(r), onHookRun: (p, gate) => this.onHookRun(p, gate), onHookEvent: (p) => { void this.onHookRun(p); }, onQuestion: (q) => this.ask(q), onSessionExt: (u) => this.onSessionExt(u) },
    });
    this.grokSessionId = sessionId;
    this.attachedGeneration = this.connection.generation;
    // Grok reports the session's model and the models this account may use as the `model` config option.
    const modelOption = ((response as { configOptions?: { id?: string; currentValue?: string; options?: { value?: string }[] }[] }).configOptions ?? []).find((o) => o.id === 'model');
    if (modelOption) {
      this.grokModel = modelOption.currentValue;
      this.grokModels = (modelOption.options ?? []).map((o) => o.value).filter((v): v is string => !!v);
    }
  }

  /** Grok's current model for this session, and the models the signed-in account may use, from the `model` config option. */
  grokModel?: string;
  grokModels?: string[];

  /** Switch Grok to the model picked in Pi. Without this Grok runs its default model whatever Pi shows. */
  async applyModel(modelId: string) {
    if (modelId === this.grokModel) return;
    if (this.grokModels?.length && !this.grokModels.includes(modelId)) {
      throw new Error(`${modelId} is not available on this Grok account. Available: ${this.grokModels.join(', ')}. Pick one of those in /models.`);
    }
    await this.setConfigOption('model', modelId);
    this.grokModel = modelId;
  }

  detach() {
    if (this.grokSessionId) this.connection.detachSession(this.grokSessionId, this.serverId);
    for (const p of this.parked.values()) p.reject(new Error('Pi session detached.'));
    this.parked.clear();
    this.buffer.length = 0;
    this.consumer = undefined;
    this.activePrompt = undefined;
  }

  /** Usage from the latest `turn_completed`; consumed by the next `complete` event. Grok sends it just before the prompt response. */
  private lastTurnUsage?: GrokTurnUsage;
  /** Running totals for this Pi session, for `/grok debug`. */
  readonly usageTotals = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, costUsd: 0, turns: 0 };
  /** Grok's context size after the last completed prompt (`_meta.totalTokens`). */
  lastContextTokens?: number;

  private onSessionExt(update: any) {
    if (update?.sessionUpdate !== 'turn_completed') return;
    const usage = parseTurnUsage(update.usage);
    if (!usage) return;
    this.lastTurnUsage = usage;
    this.usageTotals.inputTokens += usage.inputTokens; this.usageTotals.outputTokens += usage.outputTokens;
    this.usageTotals.cachedReadTokens += usage.cachedReadTokens; this.usageTotals.costUsd += usage.costUsd; this.usageTotals.turns++;
  }

  /** Start a Grok turn. Completion, cancellation, and failure surface as TurnEvents. */
  /** Increments per prompt. Events from an earlier prompt (e.g. a cancelled turn's late `complete`) are dropped, not replayed into the next turn. */
  private promptSeq = 0;

  startPrompt(text: string) {
    if (this.activePrompt) throw new Error('A Grok prompt is already active for this session.');
    this.lastTurnUsage = undefined;
    this.buffer.length = 0; // anything buffered belongs to the previous prompt
    const seq = ++this.promptSeq;
    const promise = this.connection.agent.request<PromptResponse>('session/prompt', { sessionId: this.grokSessionId, prompt: [{ type: 'text', text }] });
    this.activePrompt = promise;
    return promise.then(
      (response) => {
        if (seq !== this.promptSeq) return; // superseded: a newer prompt owns the consumer
        this.activePrompt = undefined;
        const usage = this.lastTurnUsage; this.lastTurnUsage = undefined;
        const contextTokens = (response as { _meta?: { totalTokens?: unknown } })._meta?.totalTokens;
        if (typeof contextTokens === 'number') { this.lastContextTokens = contextTokens; if (usage) usage.contextTokens = contextTokens; }
        this.emit({ kind: 'complete', response, usage });
        return response;
      },
      (error) => { if (seq !== this.promptSeq) return undefined; this.activePrompt = undefined; this.emit({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }); return undefined; },
    );
  }

  /**
   * Pi aborted the turn. Ask Grok to cancel and stop treating the in-flight prompt as active, so the next Pi
   * message starts a fresh prompt instead of being parked behind a turn that is ending.
   */
  abandonPrompt() {
    if (!this.activePrompt) return;
    void this.cancel();
    this.activePrompt = undefined;
    this.promptSeq++; // late completion of the cancelled prompt is dropped
    this.buffer.length = 0;
  }

  async cancel() {
    if (!this.grokSessionId || !this.activePrompt) return;
    await this.connection.agent.notify('session/cancel', { sessionId: this.grokSessionId }).catch(() => {});
  }

  /** Grok's current session mode as last reported by `current_mode_update` (or set by us). */
  mode: string = 'default';

  /** Set a Grok session config option (for example `reasoning_effort`); Grok mirrors the change to every subscriber. */
  async setConfigOption(configId: string, value: string) {
    if (!this.grokSessionId) throw new Error('No Grok session yet. Send a message first.');
    await this.connection.agent.request('session/set_config_option', { sessionId: this.grokSessionId, configId, value });
  }

  /** Grok reasoning effort last applied, so a repeated Pi thinking level does not resend it every turn. */
  private appliedEffort?: string;
  /** Apply Pi's thinking level as Grok's `reasoning_effort` when it changed. Grok accepts low, medium, high, and (except 4.5) xhigh. */
  async applyEffort(level: string | undefined) {
    if (!level) return;
    const effort = ({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } as Record<string, string>)[level];
    if (!effort || effort === this.appliedEffort) return;
    await this.setConfigOption('reasoning_effort', effort);
    this.appliedEffort = effort;
  }

  /** Forget the Grok session so the next Pi message creates a fresh one. Pi's own history is untouched. */
  reset() {
    if (this.grokSessionId) this.connection.detachSession(this.grokSessionId, this.serverId);
    this.abandonPrompt();
    this.rejectParked('Grok session reset.');
    this.grokSessionId = undefined;
    this.mode = 'default';
    this.lastContextTokens = undefined;
  }

  /** Switch Grok's session mode (`plan` or `default`) through ACP `session/set_mode`. */
  async setMode(modeId: 'plan' | 'default') {
    if (!this.grokSessionId) throw new Error('No Grok session yet. Send a message first.');
    await this.connection.agent.request('session/set_mode', { sessionId: this.grokSessionId, modeId });
    this.mode = modeId;
  }

  /**
   * Run one of Grok's own slash commands (`/goal status`, `/compact`, `/context`, `/session-info`) as a
   * prompt outside Pi's model loop and return the text Grok streams back. Status-style commands
   * resolve without a model sample.
   */
  async runCommand(text: string, timeoutMs = 120_000): Promise<{ text: string; stopReason: string }> {
    if (!this.grokSessionId) throw new Error('No Grok session yet. Send a message first.');
    if (this.activePrompt) throw new Error('Grok is busy with a turn. Wait for it to finish.');
    let out = '';
    let outcome: Extract<TurnEvent, { kind: 'complete' | 'error' }> | undefined;
    const detach = this.consume((event) => { if (event.kind === 'text') out += event.delta; else if (event.kind === 'complete' || event.kind === 'error') outcome = event; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Same lifetime as a normal turn: startPrompt owns busy state, completion, and late-completion suppression.
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Grok command timed out after ${timeoutMs / 1000}s.`)), timeoutMs); timer.unref?.(); });
      await Promise.race([this.startPrompt(text), timeout]);
      if (!outcome) throw new Error('Grok command ended without a completion.');
      if (outcome.kind === 'error') throw outcome.error;
      return { text: out.trim(), stopReason: outcome.response.stopReason };
    } catch (error) {
      this.abandonPrompt(); // timeout or failure: cancel on Grok and free the session, as a Pi abort does
      throw error;
    } finally { clearTimeout(timer); detach(); }
  }

  /** Feed Pi tool results back to Grok's parked tools/call requests. Returns ids that had no parked call. */
  resolveToolResults(results: ToolResultMessage[]): ToolResultMessage[] {
    const orphans: ToolResultMessage[] = [];
    for (const result of results) {
      const parked = this.parked.get(result.toolCallId);
      if (!parked) { orphans.push(result); continue; }
      this.parked.delete(result.toolCallId);
      parked.resolve({ content: result.content.map((c) => c.type === 'text' ? { type: 'text', text: c.text } : { type: 'image', data: c.data, mimeType: c.mimeType }), isError: result.isError });
    }
    return orphans;
  }

  rejectParked(reason: string) {
    for (const p of this.parked.values()) p.reject(new Error(reason));
    this.parked.clear();
  }

  /** Attach a consumer; buffered events are flushed first. Returns a detach function. */
  consume(consumer: (event: TurnEvent) => void) {
    this.consumer = consumer;
    const backlog = this.buffer.splice(0);
    for (const event of backlog) consumer(event);
    return () => { if (this.consumer === consumer) this.consumer = undefined; };
  }

  private emit(event: TurnEvent) {
    if (this.consumer) this.consumer(event); else this.buffer.push(event);
  }

  private onUpdate(notification: SessionNotification) {
    const update = notification.update as any;
    switch (update?.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text') this.emit({ kind: 'text', delta: update.content.text });
        return;
      case 'agent_thought_chunk':
        if (update.content?.type === 'text') this.emit({ kind: 'thought', delta: update.content.text });
        return;
      case 'current_mode_update':
        if (typeof update.currentModeId === 'string') this.mode = update.currentModeId;
        return;
      case 'tool_call': {
        // A Grok-native tool starting on the Grok harness. Pi observes; it does not execute.
        const title = String(update.title ?? update.kind ?? 'tool');
        if (/^(pi__|mcp__pi__)/.test(title)) return; // Pi-hosted calls surface through sdk_call instead
        const toolUseId = String(update.toolCallId);
        this.nativeCalls.set(toolUseId, { title });
        const stamp = update._meta?.['x.ai/tool'];
        if (stamp && typeof stamp === 'object') this.stamps.set(toolUseId, stamp as GrokToolStamp);
        return;
      }
      case 'tool_call_update': {
        const id = String(update.toolCallId);
        const call = this.nativeCalls.get(id);
        if (!call && !update.title && !update.status) return;
        if (update.status === 'completed' || update.status === 'failed') {
          this.nativeCalls.delete(id);
          this.stamps.delete(id);
        }
        return;
      }
    }
  }

  /** Blocking client hooks: gate native tools by Pi capability, annotate edits, and hold the stop. */
  async onHookRun(payload: HookRun, gate?: { dialog(): void }): Promise<HookReply> {
    try {
      switch (payload.hookEventName) {
        case 'pre_tool_use': {
          const tool = payload.toolName ?? '';
          const stamp = this.stamps.get(payload.toolUseId ?? '');
          if (classify(tool, stamp) === 'mcp' || mcpServerOf(tool)) await this.loadMcpToolMeta();
          const piTools = this.permissionMode === 'readonly' || (this.permissionMode === 'ask' && !this.askDialog) ? this.piToolNames.filter((n) => !['edit', 'write', 'bash'].includes(n))
            : this.permissionMode === 'yolo' ? [...new Set([...this.piToolNames, 'read', 'edit', 'write', 'bash'])] : this.piToolNames;
          let verdict = capabilityGate(piTools, this.hookSettings, (t) => this.mcpToolMeta?.get(t))(tool, stamp);
          const kind = classify(tool, stamp);
          const needsDialog = this.permissionMode === 'ask' && kind !== 'read' && kind !== 'other';
          if (verdict.allow && needsDialog && this.askDialog) {
            gate?.dialog(); // a human is deciding: the gateway waits the dialog window, not the policy window
            const ok = await this.askDialog(tool, payload.toolInput);
            if (!ok) verdict = { allow: false, reason: `The user declined ${tool}.` };
          }
          const reply: HookReply = verdict.allow ? { decision: 'continue' } : { decision: 'deny', reason: verdict.reason };
          this.toolCallsSeen++;
          this.logHook({ event: 'pre_tool_use', tool, decision: reply.decision, reason: reply.reason });
          if (!verdict.allow) this.onToolRecord?.({ toolUseId: payload.toolUseId ?? '', tool, input: payload.toolInput, status: 'denied', denyReason: verdict.reason });
          return reply;
        }
        case 'post_tool_use': {
          const tool = payload.toolName ?? '';
          let context: string | undefined;
          if (classify(tool, this.stamps.get(payload.toolUseId ?? '')) === 'write') context = await postEditContext(payload.toolInput, payload.cwd || this.cwd, this.hookSettings);
          this.logHook({ event: 'post_tool_use', tool, decision: 'continue', context });
          const source = mediaPath(payload.toolResult);
          const media = source ? this.copyMedia(source) : undefined;
          this.onToolRecord?.({ toolUseId: payload.toolUseId ?? '', tool, input: payload.toolInput, status: 'completed', output: media ?? resultText(payload.toolResult), durationMs: payload.durationMs, hookContext: context, mediaPath: media ?? source, sourcePath: source });
          return context ? { decision: 'continue', additionalContext: context } : { decision: 'continue' };
        }
        case 'post_tool_use_failure': {
          const tool = payload.toolName ?? '';
          const output = resultText(payload.toolResult ?? (payload as any).error);
          this.onToolRecord?.({ toolUseId: payload.toolUseId ?? '', tool, input: payload.toolInput, status: 'failed', output, durationMs: payload.durationMs });
          return { decision: 'continue' };
        }
        case 'stop': {
          const reply = await stopGate(payload, this.hookSettings);
          this.logHook({ event: 'stop', decision: reply.decision, reason: reply.reason });
          return reply;
        }
        default:
          return { decision: 'continue' };
      }
    } catch (error) {
      const reason = `hook error: ${error instanceof Error ? error.message : String(error)}`;
      this.logHook({ event: payload.hookEventName, decision: 'continue', reason });
      return { decision: 'continue' }; // fail open, like Grok's own hooks
    }
  }

  /**
   * Copy a Grok media file into the project so Pi shows a readable path instead of
   * ~/.grok/sessions/%2Fhome%2F.../images/1.jpg. Returns the copy's path, or undefined when copying is off or fails.
   */
  private copyMedia(source: string): string | undefined {
    if (!this.mediaDir) return undefined;
    try {
      const dir = isAbsolute(this.mediaDir) ? this.mediaDir : resolve(this.cwd, this.mediaDir);
      mkdirSync(dir, { recursive: true });
      const ignore = join(dir, '.gitignore');
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
      const short = (this.grokSessionId ?? 'session').slice(-6);
      const name = `${stamp}-${short}-${basename(source, extname(source))}${extname(source).toLowerCase()}`;
      const target = join(dir, name);
      if (!existsSync(target)) copyFileSync(source, target);
      return target;
    } catch { return undefined; }
  }

  private onMcp(message: SdkCall): Promise<unknown> {
    switch (message.method) {
      case 'initialize':
        return Promise.resolve({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: PI_MCP_SERVER_NAME, version: '0.1.0' } });
      case 'tools/list':
        return Promise.resolve({ tools: this.tools.map((tool) => toMcpTool(tool, this.piToolRoutes.find((route) => route.originalName === tool.name))) });
      case 'tools/call': {
        // Grok sends the name from tools/list here. Only its model uses the `pi__` qualifier, in `use_tool`.
        const listedName = String(message.params?.name ?? '');
        const name = this.piToolRoutes.find((route) => route.exposedName === listedName)?.originalName ?? listedName;
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        if (!this.tools.some((t) => t.name === name)) return Promise.reject(new Error(`Unknown Pi tool ${listedName}`));
        const toolCallId = `grok_${this.serverId}_${++this.toolSeq}`;
        return new Promise((resolve, reject) => {
          this.parked.set(toolCallId, { resolve, reject });
          this.emit({ kind: 'toolcall', toolCallId, name, arguments: args });
        });
      }
      default:
        return Promise.reject(new Error(`Unsupported MCP method ${message.method}`));
    }
  }
}

/** Saved media path from a Grok media tool result (`{ type: "ImageGen", path, filename, session_folder }` and kin). */
export function mediaPath(value: unknown): string | undefined {
  const v = (value ?? {}) as { path?: unknown; type?: unknown };
  return typeof v.path === 'string' && /^(ImageGen|ImageEdit|ImageToVideo|ReferenceToVideo|VideoGen)$/.test(String(v.type ?? '')) ? v.path : undefined;
}

/** The fields `resultText` looks at in a Grok tool result envelope. */
type ResultEnvelope = { FileContent?: { raw_output?: unknown; content?: unknown }; output?: unknown; stdout?: unknown; text?: unknown; content?: unknown; message?: unknown };

/** Best-effort plain text from a Grok tool result envelope (e.g. ReadFile.FileContent.raw_output, or a string). */
export function resultText(value: unknown, limit = 8000): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.slice(0, limit);
  const media = mediaPath(value);
  if (media) return media;
  const v = value as ResultEnvelope;
  const nested = v.FileContent?.raw_output ?? v.FileContent?.content ?? v.output ?? v.stdout ?? v.text ?? v.content ?? v.message;
  if (typeof nested === 'string') return nested.slice(0, limit);
  if (Array.isArray(nested)) return nested.map((c: unknown) => (typeof c === 'string' ? c : String((c as { text?: unknown } | null)?.text ?? ''))).join('').slice(0, limit) || undefined;
  return JSON.stringify(value).slice(0, limit);
}

const HOOK_LOG_LIMIT = 500;
const PI_READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'symbol_search', 'module_report', 'read_symbol', 'read_enclosing', 'lens_diagnostics', 'project_report', 'effective_config']);

/**
 * Pi tool -> MCP tool definition. Read-only Pi tools carry the marker in `_meta` (Grok forwards `_meta`, not
 * `annotations`), so a read-only Pi session can still let Grok call them. `annotations` is sent too for clients that keep it.
 */
export function toMcpTool(tool: Tool, route?: PiToolRoute): McpToolDefinition & { annotations?: Record<string, unknown>; _meta?: Record<string, unknown> } {
  const readOnly = PI_READ_ONLY_TOOLS.has(tool.name) || (tool as { readOnly?: boolean }).readOnly === true || route?.attribution?.readOnlyHint === true;
  const meta: Record<string, unknown> = { originalPiToolName: tool.name };
  const inputSchema = structuredClone(tool.parameters) as Record<string, unknown>;
  const def: McpToolDefinition & { annotations?: Record<string, unknown>; _meta?: Record<string, unknown> } = { name: route?.exposedName ?? tool.name, description: descriptionForPiTool(tool), inputSchema };
  if (readOnly) { def.annotations = { readOnlyHint: true }; meta.readOnlyHint = true; }
  def._meta = meta;
  return def;
}
