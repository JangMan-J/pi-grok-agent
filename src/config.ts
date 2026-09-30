import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { validateEndpoint } from './client.ts';

export const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
export const configPath = join(agentDir, 'grok-ws.json');
export const defaultSecretFile = join(agentDir, 'grok-ws.secret');

/** Which Pi tools the `grok` model provider offers to Grok in addition to Grok's own harness tools. */
export type PiToolPolicy = 'none' | 'extensions' | 'all' | string[];
export const PI_CORE_TOOLS = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

/**
 * How the `grok` model provider answers Grok's native permission prompts when Pi has no UI (`-p`, Fabric workers).
 * `dialog` (default): ask in Pi's UI; without a UI, deny. `deny`: always reject. `allow`: always allow once.
 * `reads`: allow read-class prompts, deny the rest. Interactive Pi shows the dialog, unless `/grok perms` is `yolo`, which selects allow once.
 */
export type HeadlessPermissionPolicy = 'dialog' | 'deny' | 'reads' | 'allow';
/**
 * Grok-side permission mode for sessions the provider creates, independent of Pi's `/grok perms` gate.
 * `default`: Grok's normal rules. `auto`: Grok's auto permission mode (`_meta.autoMode`). A third value is accepted but not documented.
 */
export type GrokMode = 'default' | 'auto' | 'yolo';

/**
 * Gateway guard tiers, in milliseconds. Grok fails OPEN when a client hook times out and waits forever on a
 * permission prompt, so the gateway answers on Pi's behalf when Pi cannot. Each value is a deadline after which
 * the gateway answers fail-closed (deny / continue / reject) unless Pi has answered.
 */
export type GuardSettings = {
  /** No `pi/gate-ack` from Pi within this window: Pi is hung or gone. Default 5000. */
  ackMs?: number;
  /** Acked without dialog or check: a policy answer is expected promptly. Default 15000. */
  policyMs?: number;
  /** Acked with `check: true` (post_tool_use / stop running a command). Default 590000. */
  checkBudgetMs?: number;
  /** Acked with `dialog: true` (a human is deciding). Default 600000. */
  dialogMs?: number;
};
/** Grok's own client-hook deadline cap (`MAX_HOOK_TIMEOUT_SECS`); every guard tier for hooks must stay below it. */
export const GROK_HOOK_CAP_MS = 600_000;
/** Grok's deadline for pre_tool_use as registered by this package (`CLIENT_HOOKS`); ackMs and policyMs must stay below it. */
export const GATE_REGISTRATION_MS = 30_000;
const GUARD_DEFAULTS: Required<GuardSettings> = { ackMs: 5_000, policyMs: 15_000, checkBudgetMs: 590_000, dialogMs: 600_000 };

export function resolveGuard(settings: GuardSettings | undefined, env: NodeJS.ProcessEnv = process.env): Required<GuardSettings> {
  const pick = (key: keyof GuardSettings, envName: string): number => {
    const raw = env[envName] ?? settings?.[key];
    if (raw === undefined || raw === '') return GUARD_DEFAULTS[key];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`guard.${key} must be a positive number of milliseconds (got ${String(raw)}).`);
    return Math.floor(n);
  };
  const guard = { ackMs: pick('ackMs', 'PI_GROK_ACK_MS'), policyMs: pick('policyMs', 'PI_GROK_POLICY_MS'), checkBudgetMs: pick('checkBudgetMs', 'PI_GROK_CHECK_BUDGET_MS'), dialogMs: pick('dialogMs', 'PI_GROK_DIALOG_MS') };
  // A tier at or past Grok's own deadline would let Grok fail open first, which defeats the guard.
  if (guard.ackMs >= GATE_REGISTRATION_MS || guard.policyMs >= GATE_REGISTRATION_MS) throw new Error('guard.ackMs and guard.policyMs must be below the pre_tool_use registration deadline (' + GATE_REGISTRATION_MS + ' ms).');
  if (guard.checkBudgetMs >= GROK_HOOK_CAP_MS) throw new Error('guard.checkBudgetMs must be below Grok\'s hook cap (' + GROK_HOOK_CAP_MS + ' ms).');
  if (guard.ackMs > guard.policyMs) throw new Error('guard.ackMs must not exceed guard.policyMs.');
  return guard;
}

/** Optional overrides for the Grok-side hook layers. Regexes match Grok tool names. */
export type HookSettings = {
  /** Extra Grok tools to deny at pre_tool_use, beyond the capability mirror. */
  denyGrokTools?: string[];
  /** Grok tools to allow even when the capability mirror would deny them. */
  allowGrokTools?: string[];
  /**
   * MCP servers (plugin or configured) whose tools count as read-only in a read-only Pi session.
   * Grok 1.0.41 drops MCP `annotations` (readOnlyHint), so per-tool hints are only honored from `_meta`.
   */
  mcpReadOnlyServers?: string[];
  /** Command run after a Grok edit; `{file}` is replaced. Non-zero exit output becomes additionalContext. Default: built-in syntax checks. */
  postEditCheck?: string;
  /** Command run when Grok wants to end its turn; non-zero exit blocks the stop with the output as reason. */
  stopCheck?: string;
};

/** The gateway's shared secret, or undefined when the file does not exist yet. Other read errors propagate. */
export async function readSecretFile(secretFile: string): Promise<string | undefined> {
  try { return (await readFile(secretFile, 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function readConfig() {
  let settings: { url?: string; secretFile?: string; piTools?: PiToolPolicy; hooks?: HookSettings; headlessPermissions?: HeadlessPermissionPolicy; guard?: GuardSettings; mediaDir?: string; grokMode?: GrokMode; autoStartGateway?: boolean } = {};
  try { settings = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const url = validateEndpoint(process.env.GROK_ACP_URL || settings.url || 'ws://127.0.0.1:2419/ws');
  const configuredFile = settings.secretFile || defaultSecretFile;
  const secretFile = configuredFile.startsWith('~/') ? join(homedir(), configuredFile.slice(2)) : configuredFile;
  if (!isAbsolute(secretFile)) throw new Error('grok-ws secretFile must be absolute or start with ~/.');
  // A missing secret file is not a load error: Pi exits on any extension load failure, and the gateway that creates
  // the file may not have run yet. The connection reads the file again when it opens (`readSecretFile`).
  const secret = process.env.GROK_AGENT_SECRET || (await readSecretFile(secretFile)) || '';
  const piTools: PiToolPolicy = process.env.PI_GROK_PI_TOOLS ? parsePolicy(process.env.PI_GROK_PI_TOOLS) : settings.piTools ?? 'extensions';
  const hooks: HookSettings = { ...settings.hooks };
  if (process.env.PI_GROK_STOP_CHECK) hooks.stopCheck = process.env.PI_GROK_STOP_CHECK;
  if (process.env.PI_GROK_POST_EDIT_CHECK) hooks.postEditCheck = process.env.PI_GROK_POST_EDIT_CHECK;
  if (process.env.PI_GROK_DENY_TOOLS) hooks.denyGrokTools = process.env.PI_GROK_DENY_TOOLS.split(',').map((s) => s.trim()).filter(Boolean);
  const headlessPermissions = (process.env.PI_GROK_HEADLESS_PERMISSIONS as HeadlessPermissionPolicy | undefined) ?? settings.headlessPermissions ?? 'dialog';
  if (!['dialog', 'deny', 'reads', 'allow'].includes(headlessPermissions)) throw new Error(`headlessPermissions must be dialog, deny, reads, or allow (got ${headlessPermissions}).`);
  const guard = resolveGuard(settings.guard);
  // Where Pi copies Grok's generated media. Relative paths resolve against the Pi session cwd. Empty string disables the copy.
  const mediaDir = process.env.PI_GROK_MEDIA_DIR ?? settings.mediaDir ?? '.pi/grok-images';
  const grokMode = (process.env.PI_GROK_GROK_MODE as GrokMode | undefined) ?? settings.grokMode ?? 'default';
  if (!['default', 'auto', 'yolo'].includes(grokMode)) throw new Error(`grokMode must be default, auto, or yolo (got ${grokMode}).`);
  // Start the bundled gateway when nothing listens on the endpoint. PI_GROK_AUTOSTART=0 or autoStartGateway: false turns it off.
  const autoStartGateway = process.env.PI_GROK_AUTOSTART ? !['0', 'false', 'no', 'off'].includes(process.env.PI_GROK_AUTOSTART.toLowerCase()) : settings.autoStartGateway ?? true;
  return { url, secret, secretFile, piTools, hooks, headlessPermissions, guard, mediaDir, grokMode, autoStartGateway };
}

function parsePolicy(value: string): PiToolPolicy {
  if (value === 'none' || value === 'extensions' || value === 'all') return value;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function selectPiTools<T extends { name: string }>(tools: T[], policy: PiToolPolicy): T[] {
  if (policy === 'none') return [];
  if (policy === 'all') return tools;
  if (policy === 'extensions') return tools.filter((t) => !PI_CORE_TOOLS.has(t.name));
  const allowed = new Set(policy);
  return tools.filter((t) => allowed.has(t.name));
}
