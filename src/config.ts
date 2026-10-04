import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BLOCKED_PI_EXTENSIONS, type PiToolPolicy } from './tool-policy.ts';

export const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
export const configPath = join(agentDir, 'grok-ws.json');

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
 * Pi-side permission mode for Grok's native tools (`/grok perms`). Persisted as `permissionMode` in
 * `grok-ws.json` and applied to every session at load. `auto` mirrors Pi's tool set; `readonly` denies
 * writes and shell; `ask` confirms each edit or shell call; `yolo` allows them with no dialog.
 */
export type PiPermissionMode = 'yolo' | 'auto' | 'ask' | 'readonly';

export function parsePermissionMode(value: unknown): PiPermissionMode {
  if (value === 'yolo' || value === 'auto' || value === 'ask' || value === 'readonly') return value;
  throw new Error(`permissionMode must be yolo, auto, ask, or readonly (got ${JSON.stringify(value)}).`);
}

/** Default routine native tool batch size. */
export const TOOL_BATCH_SIZE = 10;

/** Validated `toolBatchSize` from `grok-ws.json`: routine native tool completions per `grok-tools` batch row. */
export function parseToolBatchSize(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new Error(`toolBatchSize must be a positive integer (got ${JSON.stringify(value)}).`);
}

/** Legacy guard settings remain validated for config compatibility, but stdio-direct does not arm timers. */
export type GuardSettings = {
  /** Legacy acknowledgement window. Default 5000. */
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

export async function readConfig() {
  let settings: { piTools?: PiToolPolicy; blockedPiExtensions?: string[]; permissionMode?: PiPermissionMode; toolBatchSize?: number; hooks?: HookSettings; headlessPermissions?: HeadlessPermissionPolicy; guard?: GuardSettings; mediaDir?: string; grokMode?: GrokMode } = {};
  try { settings = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const piTools: PiToolPolicy = process.env.PI_GROK_PI_TOOLS ? parsePolicy(process.env.PI_GROK_PI_TOOLS) : settings.piTools ?? 'extensions';
  // Effective blocked Pi extensions: the stored list is authoritative when present (the `/grok extensions`
  // command seeds it from DEFAULT_BLOCKED_PI_EXTENSIONS on first edit); otherwise the package default applies.
  const blockedPiExtensions: string[] = Array.isArray(settings.blockedPiExtensions) ? settings.blockedPiExtensions : [...DEFAULT_BLOCKED_PI_EXTENSIONS];
  const hooks: HookSettings = { ...settings.hooks };
  if (process.env.PI_GROK_STOP_CHECK) hooks.stopCheck = process.env.PI_GROK_STOP_CHECK;
  if (process.env.PI_GROK_POST_EDIT_CHECK) hooks.postEditCheck = process.env.PI_GROK_POST_EDIT_CHECK;
  if (process.env.PI_GROK_DENY_TOOLS) hooks.denyGrokTools = process.env.PI_GROK_DENY_TOOLS.split(',').map((s) => s.trim()).filter(Boolean);
  const permissionMode = parsePermissionMode(settings.permissionMode ?? 'auto');
  const toolBatchSize = parseToolBatchSize(settings.toolBatchSize ?? TOOL_BATCH_SIZE);
  const headlessPermissions = (process.env.PI_GROK_HEADLESS_PERMISSIONS as HeadlessPermissionPolicy | undefined) ?? settings.headlessPermissions ?? 'dialog';
  if (!['dialog', 'deny', 'reads', 'allow'].includes(headlessPermissions)) throw new Error(`headlessPermissions must be dialog, deny, reads, or allow (got ${headlessPermissions}).`);
  const guard = resolveGuard(settings.guard);
  // Where Pi copies Grok's generated media. Relative paths resolve against the Pi session cwd. Empty string disables the copy.
  const mediaDir = process.env.PI_GROK_MEDIA_DIR ?? settings.mediaDir ?? '.pi/grok-images';
  const grokMode = (process.env.PI_GROK_GROK_MODE as GrokMode | undefined) ?? settings.grokMode ?? 'default';
  if (!['default', 'auto', 'yolo'].includes(grokMode)) throw new Error(`grokMode must be default, auto, or yolo (got ${grokMode}).`);
  return { piTools, blockedPiExtensions, permissionMode, toolBatchSize, hooks, headlessPermissions, guard, mediaDir, grokMode };
}

/**
 * Merge keys into `grok-ws.json`, preserving the rest. Creates the file when absent. Used by `/grok extensions`
 * to persist blocked-extension edits. Not concurrency-safe against another writer, which does not happen here:
 * one interactive Pi session edits its own config.
 */
export async function writeConfig(patch: Record<string, unknown>): Promise<void> {
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(configPath, JSON.stringify({ ...current, ...patch }, null, 2) + '\n');
}

function parsePolicy(value: string): PiToolPolicy {
  if (value === 'none' || value === 'extensions' || value === 'all') return value;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
