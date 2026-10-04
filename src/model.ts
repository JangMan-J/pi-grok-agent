// Pi extension: registers the `grok` model provider backed by Grok Build over WebSocket ACP.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Box, Container, Image, Spacer, Text, getCapabilities } from '@earendil-works/pi-tui';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { agentDir, readConfig, writeConfig, type PiPermissionMode } from './config.ts';
import { grokLogin } from './login.ts';
import { permissionAnswer, permissionDialog } from './model/permissions.ts';
import { questionAnswerer } from './model/questions.ts';
import { GrokModelConnection } from './model/connection.ts';
import { GrokModelSession, type GrokToolRecord } from './model/session.ts';
import { createGrokStream, GROK_API, MODEL_IDS } from './model/provider.ts';
import { createSteerHandler } from './model/steer.ts';
import { handleExtensionsCommand } from './model/extensions-command.ts';
import { blockedToolNamesForExtensions, callableName, sortedNames, toolNamesForExtension, type PiToolAttribution } from './tool-policy.ts';
import { createToolBatcher, TOOL_BATCH_ENTRY } from './tool-batch.ts';

type SavedModelSession = { owner: string; grokSessionId: string; serverId: string; cwd: string };
const ENTRY = 'grok-model-session';
const MODEL_NAMES: Record<string, string> = { 'grok-4.5': 'Grok 4.5', 'grok-4.6': 'Grok 4.6', 'grok-4.7': 'Grok 4.7', 'grok-4.7-build-fast': 'Grok 4.7 Build Fast' };
/** Used when Grok Build's model cache has no context window for a model. Grok Build reported 256,000 for every model on 2026-09-30. */
const DEFAULT_CONTEXT_WINDOW = 256_000;

/**
 * Context window per model id, as Grok Build reports it for the signed-in account in its model cache
 * (`models.<id>.info.context_window`). ACP does not report it. A missing or unreadable cache gives an empty map.
 */
export function grokContextWindows(file = join(homedir(), '.grok', 'models_cache.json')): Record<string, number> {
  try {
    const models = (JSON.parse(readFileSync(file, 'utf8')) as { models?: Record<string, { info?: { context_window?: unknown } }> }).models ?? {};
    return Object.fromEntries(Object.entries(models).flatMap(([id, model]) => {
      const tokens = model?.info?.context_window;
      return typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0 ? [[id, tokens]] : [];
    }));
  } catch {
    return {};
  }
}

const TOOL_ENTRY = 'grok-tool';
const COMMAND_ENTRY = 'grok-command';
/** Marker on the one custom *message* we send (media). pi-agent-core presents custom messages to the model as user
 * messages, so the provider drops any user message that starts with this. */
export const GROK_DISPLAY_ONLY = '\u200b[grok-display]';
const STATUS_ICON: Record<GrokToolRecord['status'], string> = { completed: '\u2713', failed: '\u2717', denied: '\u2298' };
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
// pi-tui sends every inline image as kitty format 100 (PNG). Grok's image_gen writes JPEG, which most kitty
// implementations (Rio here) reserve rows for and then discard. Convert to PNG once with ImageMagick and cache it.
// The PNG becomes an ImageContent block on a `grok-media` message, so Pi renders it the way it renders any image.
function imageContent(path: string): { type: 'image'; data: string; mimeType: string } | undefined {
  const mimeType = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mimeType) return undefined;
  const png = asPng(path, mimeType);
  if (!png) return undefined;
  try { return { type: 'image', data: readFileSync(png.path).toString('base64'), mimeType: png.mimeType }; } catch { return undefined; }
}
const PNG_CACHE = join(tmpdir(), 'pi-grok-images', 'png');
function asPng(path: string, mimeType: string): { path: string; mimeType: string } | undefined {
  if (mimeType === 'image/png') return { path, mimeType };
  const out = join(PNG_CACHE, createHash('sha256').update(path).digest('hex').slice(0, 16) + '.png');
  if (!existsSync(out)) {
    try { mkdirSync(PNG_CACHE, { recursive: true, mode: 0o700 }); execFileSync('magick', [path, '-resize', '1024x1024>', out], { stdio: 'ignore', timeout: 15_000 }); }
    catch { return undefined; }
  }
  return { path: out, mimeType: 'image/png' };
}
function oneLine(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '\u2026' : flat;
}
export default async function grokModel(pi: ExtensionAPI) {
  const config = await readConfig();
  // Live blocked Pi extension set: `/grok extensions` mutates this Set in place and persists it, so the
  // next Grok session lends the updated set without a Pi reload. (Grok reads the tool list once per session.)
  const blockedPiExtensions = new Set(config.blockedPiExtensions);
  const connection = new GrokModelConnection({ url: config.url, secret: config.secret, secretFile: config.secretFile, autoStart: config.autoStartGateway ? { logDir: agentDir } : undefined });
  let current: GrokModelSession | undefined;
  // Pi-side permission mode, persisted as `permissionMode` in grok-ws.json so a chosen `/grok perms`
  // survives Pi restarts. Applied to every Grok session in configure().
  let permissionMode: PiPermissionMode = config.permissionMode;
  // Media generated during a turn; flushed as one `grok-media` message after the turn so Pi renders the images
  // through its normal message path (inline, like an attached image) instead of inside the tool card.
  const pendingMedia: GrokToolRecord[] = [];
  // Routine native tool completions accumulate here and flush as one `grok-tools` summary row per few
  // calls, so a long autonomous burst does not stack one row per call. Interesting records (failures,
  // denials, media, post-edit notes) bypass the batcher and render as their own `grok-tool` rows.
  const toolBatcher = createToolBatcher((records) => pi.appendEntry<GrokToolRecord[]>(TOOL_BATCH_ENTRY, records), config.toolBatchSize);
  const flushTools = () => toolBatcher.flush();
  function flushMedia() {
    const records = pendingMedia.splice(0);
    for (const r of records) {
      if (!r.mediaPath) continue;
      const image = imageContent(r.mediaPath);
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: `${GROK_DISPLAY_ONLY}${r.tool}: ${r.mediaPath}` }];
      if (image) content.push(image);
      // triggerTurn:false is required. This runs while Pi still counts the turn as streaming, and the default path
      // steers the message into the agent as new input, which made Grok "look at the image you attached".
      pi.sendMessage({ customType: 'grok-media', content, display: true, details: { tool: r.tool, mediaPath: r.mediaPath, sourcePath: r.sourcePath } }, { triggerTurn: false });
    }
  }

  function restore(ctx: ExtensionContext) {
    lastCtx = ctx;
    current?.detach();
    const owner = ctx.sessionManager.getSessionId();
    let saved: SavedModelSession | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === ENTRY && (entry.data as SavedModelSession)?.owner === owner) saved = entry.data as SavedModelSession;
    }
    current = configure(new GrokModelSession(connection, owner, ctx.cwd, saved?.serverId), ctx);
    if (saved && saved.cwd === ctx.cwd) current.grokSessionId = saved.grokSessionId;
  }

  /** Permission answers, hook settings, and the structured tool record sink. */
  function configure(session: GrokModelSession, ctx: ExtensionContext) {
    connection.hasUI = ctx.hasUI;
    session.permission = answerFor(ctx, () => session.permissionMode);
    session.ask = questionAnswerer(ctx);
    session.hookSettings = config.hooks;
    session.mediaDir = config.mediaDir;
    session.grokMode = config.grokMode;
    session.permissionMode = permissionMode;
    session.askDialog = ctx.hasUI ? async (tool, input) => (await ctx.ui.confirm(`Grok wants to run ${tool}`, JSON.stringify(input ?? {}, null, 2).slice(0, 2000))) === true : undefined;
    // Routine completions batch into one `grok-tools` row per few calls; failures, denials,
    // media, and post-edit notes keep their own `grok-tool` rows. Leftovers flush at turn end.
    session.onToolRecord = (record) => {
      // A single row flushes the calls batched before it, so the transcript keeps call order.
      if (!toolBatcher.record(record)) { flushTools(); pi.appendEntry<GrokToolRecord>(TOOL_ENTRY, record); }
      if (record.mediaPath) pendingMedia.push(record);
    };
    return session;
  }

  function answerFor(ctx: ExtensionContext, mode: () => 'yolo' | 'auto' | 'ask' | 'readonly') {
    return permissionAnswer(ctx.hasUI, permissionDialog(ctx), config.headlessPermissions, mode);
  }

  function getPiToolAttributions(): PiToolAttribution[] {
    return pi.getAllTools().map((tool) => ({
      name: tool.name,
      namespaceName: tool.namespace?.name,
      sourceInfo: tool.sourceInfo,
      readOnlyHint: tool.annotations?.readOnlyHint,
    }));
  }

  const stream = createGrokStream(connection, { current: () => current, piTools: config.piTools, blockedPiExtensions, getPiToolAttributions });

  const contextWindows = grokContextWindows();
  const contextWindowFor = (id: string | undefined) => (id && contextWindows[id]) || DEFAULT_CONTEXT_WINDOW;

  pi.registerProvider('grok', {
    baseUrl: config.url,
    apiKey: 'grok-build-login',
    api: GROK_API,
    models: MODEL_IDS.map((id) => ({
      id, name: MODEL_NAMES[id] ?? id, reasoning: true, input: ['text', 'image'], // images spill to a temp file and go by path
      // Efforts as the agent advertises them per model: 4.5 has low|medium|high, the others add xhigh. Nothing below low; no max.
      thinkingLevelMap: { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: id === 'grok-4.5' ? null : 'xhigh', max: null },
      // Context window from Grok Build's model cache. Cost per token is unknown; per-turn cost comes from Grok's usage report.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: contextWindowFor(id), maxTokens: 32_000,
    })),
    streamSimple: (model, context, options) => {
      const before = current?.grokSessionId;
      flushTools(); // late records from the previous turn stay with that turn
      const out = stream(model, context, options);
      // Persist the Grok session id once it exists so reloads can session/load it, and surface media generated this turn.
      void out.result().then((message) => {
        flushTools();
        if (current && current.grokSessionId && current.grokSessionId !== before) {
          pi.appendEntry(ENTRY, { owner: current.piSessionId, grokSessionId: current.grokSessionId, serverId: current.serverId, cwd: current.cwd } satisfies SavedModelSession);
        }
        if (message.stopReason !== 'toolUse') flushMedia(); // a toolUse stop continues the same Grok turn; wait for its end
      }).catch(() => { flushTools(); });
      return out;
    },
  });

  // Pi's default custom-message renderer keeps only text blocks, so images need this renderer. It mirrors Pi's own
  // tool-result image path: kitty needs PNG (asPng already converted), width from settings, path line as caption.
  pi.registerMessageRenderer<{ tool?: string; mediaPath?: string; sourcePath?: string }>('grok-media', (message, { expanded }, theme) => {
    const container = new Container();
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content } as const] : message.content;
    const caps = getCapabilities();
    for (const block of blocks) {
      if (block.type === 'text') { container.addChild(new Text(theme.fg('dim', block.text.replace(GROK_DISPLAY_ONLY, '')), 0, 0)); continue; }
      if (block.type !== 'image' || !caps.images || (caps.images === 'kitty' && block.mimeType !== 'image/png')) continue;
      container.addChild(new Spacer(1));
      container.addChild(new Image(block.data, block.mimeType, { fallbackColor: (s: string) => theme.fg('dim', s) }, { maxWidthCells: expanded ? 100 : 60 }));
    }
    if (expanded && message.details?.sourcePath) container.addChild(new Text(theme.fg('dim', `source ${message.details.sourcePath}`), 0, 0));
    return container;
  });

  // Grok-native tool calls are session entries: persisted, rendered, never sent to the model (Grok has its own history).
  // Mid-turn Enter (steer) goes straight into Grok's running turn via x.ai/interject. Alt+Enter (followUp)
  // flows through Pi untouched and becomes the next prompt. Entries render at once, even mid-turn.
  const steer = createSteerHandler({
    hasGrokSession: () => !!current?.grokSessionId,
    interject: (text) => {
      const session = current;
      if (!session?.grokSessionId) throw new Error('no Grok session');
      return connection.agent.request('_x.ai/interject', { sessionId: session.grokSessionId, text });
    },
    record: (text) => pi.appendEntry('grok-steer', { text }),
    notify: (text) => {
      try { lastCtx?.ui.notify(text, 'error'); }
      catch (error) { console.error('Could not display Grok steering notification:', error); }
    },
  });
  let lastCtx: ExtensionContext | undefined;
  pi.on('input', (event, ctx) => {
    if (ctx.model?.provider !== 'grok') return;
    return steer(event);
  });

  pi.registerEntryRenderer<{ text: string }>('grok-steer', (entry, _opts, theme) => {
    if (!entry.data) return undefined;
    return new Text(theme.fg('dim', `→ steered into Grok's turn: ${entry.data.text.split('\n')[0].slice(0, 160)}`), 0, 0);
  });

  pi.registerEntryRenderer<{ title: string; body: string }>(COMMAND_ENTRY, (entry, _opts, theme) => {
    const d = entry.data; if (!d) return undefined;
    const box = new Box(1, 0, (s: string) => theme.bg('customMessageBg', s));
    box.addChild(new Text(theme.fg('accent', d.title), 0, 0));
    for (const line of d.body.split('\n')) if (line) box.addChild(new Text(line, 0, 0));
    return box;
  });

  pi.registerEntryRenderer<GrokToolRecord>(TOOL_ENTRY, (entry, { expanded }, theme) => {
    const r = entry.data; if (!r) return undefined;
    const box = new Box(1, 0, (text: string) => theme.bg('customMessageBg', text));
    const color = r.status === 'completed' ? 'success' : r.status === 'denied' ? 'warning' : 'error';
    const ms = r.durationMs != null ? theme.fg('dim', ` ${r.durationMs}ms`) : '';
    box.addChild(new Text(`${theme.fg(color, STATUS_ICON[r.status])} ${theme.fg('accent', 'grok')} ${r.tool} ${theme.fg('dim', oneLine(r.input, 100))}${ms}`, 0, 0));
    if (r.denyReason) box.addChild(new Text(theme.fg('warning', `  denied: ${oneLine(r.denyReason, 160)}`), 0, 0));
    if (r.mediaPath) {
      box.addChild(new Text(`  ${theme.fg('accent', 'saved')} ${r.mediaPath}`, 0, 0));
      if (expanded && r.sourcePath && r.sourcePath !== r.mediaPath) box.addChild(new Text(theme.fg('dim', `  source ${r.sourcePath}`), 0, 0));
    }
    if (expanded && r.output) box.addChild(new Text(theme.fg('dim', `  ${oneLine(r.output, 600)}`), 0, 0));
    if (r.hookContext) box.addChild(new Text(theme.fg('warning', `  check: ${oneLine(r.hookContext, expanded ? 600 : 160)}`), 0, 0));
    return box;
  });

  pi.registerEntryRenderer<GrokToolRecord[]>(TOOL_BATCH_ENTRY, (entry, { expanded }, theme) => {
    const records = entry.data; if (!records?.length) return undefined;
    const counts = new Map<string, number>();
    let ms = 0;
    for (const r of records) { counts.set(r.tool, (counts.get(r.tool) ?? 0) + 1); ms += r.durationMs ?? 0; }
    const summary = [...counts].map(([tool, n]) => (n > 1 ? `${n} ${tool}` : tool)).join(' · ');
    const box = new Box(1, 0, (text: string) => theme.bg('customMessageBg', text));
    box.addChild(new Text(`${theme.fg('success', STATUS_ICON.completed)} ${theme.fg('accent', 'grok')} ${records.length} calls (${summary})${ms ? theme.fg('dim', ` ${ms}ms`) : ''}`, 0, 0));
    if (expanded) for (const r of records) {
      box.addChild(new Text(theme.fg('dim', `  ${r.tool} ${oneLine(r.input, 100)}${r.durationMs != null ? ` ${r.durationMs}ms` : ''}`), 0, 0));
      if (r.output) box.addChild(new Text(theme.fg('dim', `    ${oneLine(r.output, 200)}`), 0, 0));
    }
    return box;
  });

  // Turn usage is not rendered as its own entry: it duplicated what Pi (and
  // zentui's Turn summary / footer cache figure) already show from the usage
  // the provider puts on the assistant message, and Grok's own accounting
  // counts cached tokens inside inputTokens, so the two lines disagreed.
  // usageFrom() in provider.ts maps Grok usage to Pi's convention.

  // Manual access to Grok harness features that are otherwise model-driven. Prompts go straight to Grok, outside Pi's loop.
  // Only what Pi has no native surface for. Escape cancels, /new starts fresh, reconnect is automatic,
  // and Pi's thinking level sets Grok's reasoning effort, so those are not commands here.
  // Two-level completion: the subcommand, then its arguments. Pi passes everything typed after "/grok ".
  // The first-level descriptions are the lines that used to print above the editor. They stay in the menu under it.
  const COMPLETIONS: Record<string, { args: { value: string; description: string }[]; description: string }> = {
    login: { description: 'sign in to Grok Build (device code)', args: [] },
    perms: { description: '(yolo | auto | ask | read-only)', args: [{ value: 'yolo', description: 'allow edits, shell, and Grok permission prompts' }, { value: 'auto', description: 'mirror Pi\'s tool set' }, { value: 'ask', description: 'confirm each edit or shell call' }, { value: 'read-only', description: 'deny edits and shell' }] },
    plan: { description: '(on | off)', args: [{ value: 'on', description: 'enter plan mode' }, { value: 'off', description: 'leave plan mode' }] },
    goal: { description: '(<objective> | status | pause | resume | clear)', args: [{ value: 'status', description: 'current goal' }, { value: 'pause', description: '' }, { value: 'resume', description: '' }, { value: 'clear', description: '' }] },
    compact: { description: '(note)', args: [] },
    extensions: { description: '(list | block <name> | unblock <name>)', args: [{ value: 'list', description: 'show blocked Pi extensions' }, { value: 'block', description: 'withhold a Pi extension from Grok' }, { value: 'unblock', description: 'lend a Pi extension to Grok again' }] },
    debug: { description: '(brilliant information)', args: [] },
  };
  pi.registerCommand('grok', {
    description: 'login | perms | plan | goal | compact | extensions | debug',
    getArgumentCompletions: (prefix) => {
      const [head, ...rest] = prefix.split(/\s+/);
      if (rest.length === 0) {
        const items = Object.entries(COMPLETIONS).filter(([name]) => name.startsWith(head)).map(([name, c]) => ({ value: name, label: name, description: c.description }));
        return items.length ? items : null;
      }
      const sub = COMPLETIONS[head]; if (!sub) return null;
      const argPrefix = rest.join(' ');
      const items = sub.args.filter((a) => a.value.startsWith(argPrefix)).map((a) => ({ value: `${head} ${a.value}`, label: a.value, description: a.description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [verb, ...rest] = args.trim().split(/\s+/); const tail = rest.join(' ');
      const session = current;
      // A custom *entry*: rendered at once even mid-turn (Pi holds custom *messages* until the turn ends, and
      // presents them to the model as user messages). Entries never enter model context.
      const show = (title: string, body: string) => pi.appendEntry(COMMAND_ENTRY, { title, body });
      try {
        if (!verb) return;
        if (verb === 'login') {
          // Runs in the background: approval in the browser can take minutes, and Pi's input stays free meanwhile.
          void grokLogin(({ url, code }) => {
            show('Grok login', `Open ${url}\nConfirm the code ${code}. Grok may open the page itself.`);
            ctx.ui.notify(`Grok login: confirm code ${code} at ${url}`, 'info');
          }).then(
            () => ctx.ui.notify('Grok login: signed in. Send your message again.', 'info'),
            (error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'),
          );
          return;
        }
        if (!session) throw new Error('No Grok model session. Select a grok/* model first.');
        switch (verb) {
          case 'debug': {
            const u = session.usageTotals; const denied = session.hookLog.filter((h) => h.decision === 'deny').length;
            const piToolAttributions = getPiToolAttributions();
            const blockedPiToolNames = blockedToolNamesForExtensions(blockedPiExtensions, piToolAttributions);
            const withheldPiTools = sortedNames(session.piToolNames.filter((toolName) => blockedPiToolNames.has(toolName)));
            show('Grok debug', [
              `gateway: ${config.url} (${connection.isOpen ? 'connected' : 'not connected'}${connection.launchedGateway ? `, started by this Pi as pid ${connection.launchedGateway}` : ''}${connection.lastDrop ? `, last drop: ${connection.lastDrop}` : ''}; auto-start ${config.autoStartGateway ? 'on' : 'off'})`,
              `grok session: ${session.grokSessionId ?? '(none yet; first message creates it)'}`,
              `mode: ${session.mode}${session.promptActive ? ' (turn running)' : ''}; pi perms: ${session.permissionMode}; grok mode: ${session.grokMode}`,
              `grok context: ${session.lastContextTokens != null ? `${session.lastContextTokens.toLocaleString()} / ${contextWindowFor(session.grokModel).toLocaleString()}` : 'unknown'}`,
              `usage: ${u.turns} turns, ${u.inputTokens.toLocaleString()} in (${u.cachedReadTokens.toLocaleString()} cached), ${u.outputTokens.toLocaleString()} out, $${u.costUsd.toFixed(3)}`,
              // Tool lines describe the tool list a Grok session took at its start; none exists before the first message.
              ...(session.grokSessionId ? [
                `lent Pi tools: ${session.piToolRoutes.length ? session.piToolRoutes.map((route) => (route.exposedName === route.originalName ? callableName(route) : `${callableName(route)} → ${route.originalName}`)).join(', ') : 'none'}`,
                `withheld Pi extension tools: ${withheldPiTools.join(', ') || 'none'}`,
              ] : []),
              `blocked Pi extensions: ${blockedPiExtensions.size ? sortedNames(blockedPiExtensions).join(', ') : 'none'}`,
              `recent hook decisions: ${session.hookLog.length} (${denied} denied); pending lent-tool calls: ${session.pendingToolCallIds.length}`,
              `Grok tool calls seen: ${session.toolCallsSeen} (pre_tool_use hooks; a grok-tools row holds up to ${config.toolBatchSize} calls)`,
            ].join('\n'));
            return;
          }
          case 'perms': {
            if (!tail) { ctx.ui.notify(`Grok permission mode: ${permissionMode}`, 'info'); return; }
            const chosen = tail === 'read-only' ? 'readonly' : tail;
            if (!['yolo', 'auto', 'ask', 'readonly'].includes(chosen)) throw new Error('Usage: /grok perms yolo | auto | ask | read-only');
            await writeConfig({ permissionMode: chosen as PiPermissionMode }); // save first: a failed write changes nothing
            permissionMode = chosen as PiPermissionMode; session.permissionMode = permissionMode;
            ctx.ui.notify(`Grok permission mode: ${permissionMode} (saved)${permissionMode === 'ask' && !ctx.hasUI ? ' (no UI: behaves as readonly)' : ''}`, 'info'); return;
          }
          case 'plan': { const mode = tail === 'off' ? 'default' : 'plan'; if (tail && !['on', 'off'].includes(tail)) throw new Error('Usage: /grok plan on | off'); await session.setMode(mode); ctx.ui.notify(`Grok session mode: ${mode}`, 'info'); return; }
          case 'goal': { flushTools(); try { const r = await session.runCommand(`/goal${tail ? ' ' + tail : ''}`, 600_000); show(`/goal${tail ? ' ' + tail : ''}`, r.text); } finally { flushTools(); } return; }
          case 'compact': { flushTools(); try { const r = await session.runCommand(`/compact${tail ? ' ' + tail : ''}`, 600_000); show('/compact', r.text || `done (${r.stopReason})`); } finally { flushTools(); } return; }
          case 'extensions':
            await handleExtensionsCommand({ args: rest, blockedPiExtensions, piTools: config.piTools, getToolNamesForExtension: (name) => toolNamesForExtension(name, getPiToolAttributions()), show, notify: (message) => ctx.ui.notify(message, 'info') });
            return;
          default: ctx.ui.notify(`Unknown /grok subcommand "${verb}".`, 'info');
        }
      } catch (error) { ctx.ui.notify(`Grok: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
    },
  });

  pi.on('session_start', (_event, ctx) => restore(ctx));
  // Flush batched rows while the old session or branch is still current.
  pi.on('session_before_tree', () => { flushTools(); });
  pi.on('session_tree', (_event, ctx) => { lastCtx = ctx; current?.detach(); current = configure(new GrokModelSession(connection, ctx.sessionManager.getSessionId(), ctx.cwd), ctx); });
  pi.on('session_shutdown', async () => { flushTools(); current?.detach(); current = undefined; await connection.close(); });
}
