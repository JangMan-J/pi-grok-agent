// Grok client hooks (x.ai/hooks) for the model provider. Grok keeps executing on its own harness;
// these run on Pi's side around each native call:
//   pre_tool_use  -> gate: mirror Pi's tool capabilities onto Grok's tools, plus configured deny/allow
//   post_tool_use -> enrich: run a check after an edit and hand Grok the findings as additionalContext
//   stop          -> hold: run an acceptance command; non-zero output blocks the stop with a reason
import { execFile } from 'node:child_process';
import type { HookSettings } from '../config.ts';

export type HookRun = {
  hookCallbackId: string;
  hookEventName: 'pre_tool_use' | 'post_tool_use' | 'stop' | string;
  sessionId: string;
  cwd: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  durationMs?: number;
  reason?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
};
export type HookReply = { decision?: 'continue' | 'deny' | 'block'; reason?: string; additionalContext?: string; continue?: boolean; stopReason?: string };

/**
 * Grok stamps every `tool_call` with `_meta["x.ai/tool"]`: its canonical kind (snake_case `ToolKind`) and a
 * `read_only` flag, both exhaustive on Grok's side. That is the primary classification. The name table below is
 * the fallback for calls that arrive without a stamp.
 */
export type GrokToolStamp = { name?: string; kind?: string; read_only?: boolean; namespace?: string };
export type Capability = 'read' | 'write' | 'shell' | 'mcp' | 'other';
const KIND_CAPABILITY: Record<string, Capability> = {
  read: 'read', search: 'read', list_dir: 'read', list: 'read', lsp: 'read', memory_search: 'read', memory_get: 'read',
  edit: 'write', write: 'write', delete: 'write', move: 'write',
  execute: 'shell',
  // MCP and plugin tools dispatch through `use_tool`; the hook's toolName is the qualified `server__tool`.
  // Grok stamps the dispatcher as mutating and does not forward the server's readOnlyHint, so Pi cannot tell.
  use_tool: 'mcp', search_tool: 'read',
};
/** `server__tool` -> server name, for MCP-dispatched calls. */
export function mcpServerOf(tool: string): string | undefined {
  const i = tool.indexOf('__');
  return i > 0 ? tool.slice(0, i) : undefined;
}
/** Grok native tool names by the Pi capability they need (fallback when no stamp is available). */
export const GROK_TOOL_CLASSES = {
  read: /^(hashline_read|read_file|read|list_dir|ls|hashline_grep|grep|glob|search_tool|codebase_search)$/,
  write: /^(hashline_edit|search_replace|edit|apply_patch|write|write_file|delete_file|move_file)$/,
  shell: /^(run_terminal_command|run_terminal_cmd|bash)$/,
};
/** Capability a Grok call needs: stamp kind first, then the name table, then `other`. */
export function classify(tool: string, stamp?: GrokToolStamp): Capability {
  if (stamp?.kind && KIND_CAPABILITY[stamp.kind]) return KIND_CAPABILITY[stamp.kind];
  if (GROK_TOOL_CLASSES.write.test(tool)) return 'write';
  if (GROK_TOOL_CLASSES.shell.test(tool)) return 'shell';
  if (GROK_TOOL_CLASSES.read.test(tool)) return 'read';
  if (mcpServerOf(tool)) return 'mcp';
  return 'other';
}

export type PiCapabilities = { read: boolean; write: boolean; shell: boolean };

/** What Pi's own loop may do, from the tool list Pi handed the model. */
export function capabilitiesFrom(piToolNames: string[]): PiCapabilities {
  const has = (n: string) => piToolNames.includes(n);
  return { read: has('read') || has('grep') || has('find') || has('ls'), write: has('edit') || has('write'), shell: has('bash') };
}

function matchesAny(patterns: string[] | undefined, name: string): boolean {
  return (patterns ?? []).some((p) => { try { return new RegExp(`^(?:${p})$`).test(name); } catch { return p === name; } });
}

export type Verdict = { allow: true } | { allow: false; reason: string };

/**
 * pre_tool_use: deny when Pi itself may not do this, or when configured.
 * An explicit deny wins over an allow entry; an allow entry wins over the capability mirror.
 */
/** Read-only marker a server can place in a tool's `_meta` (Grok forwards `_meta`, not `annotations`). */
export function metaSaysReadOnly(meta: unknown): boolean {
  const m = (meta ?? {}) as Record<string, unknown>;
  const hint = m.readOnlyHint ?? m['pi/readOnly'] ?? (m.annotations as Record<string, unknown> | undefined)?.readOnlyHint;
  return hint === true;
}

export function capabilityGate(piToolNames: string[], settings: HookSettings, toolMeta?: (tool: string) => unknown): (tool: string, stamp?: GrokToolStamp) => Verdict {
  const caps = capabilitiesFrom(piToolNames);
  return (tool, stamp) => {
    if (matchesAny(settings.denyGrokTools, tool)) return { allow: false, reason: `Pi policy denies ${tool} in this session.` };
    if (matchesAny(settings.allowGrokTools, tool)) return { allow: true };
    const need = classify(tool, stamp);
    if (need === 'write' && !caps.write) return { allow: false, reason: 'This Pi session is read-only: no file edits or writes. Report findings instead.' };
    if (need === 'shell' && !caps.shell) return { allow: false, reason: 'This Pi session has no shell access. Use file and search tools instead.' };
    if (need === 'read' && !caps.read) return { allow: false, reason: 'This Pi session cannot read files.' };
    if (need === 'mcp' && !caps.write && !caps.shell) {
      if (metaSaysReadOnly(toolMeta?.(tool))) return { allow: true };
      const server = mcpServerOf(tool) ?? '';
      if (matchesAny(settings.mcpReadOnlyServers, server)) return { allow: true };
      return { allow: false, reason: `This Pi session is read-only and cannot verify that MCP tool ${tool} only reads. Report what you would call instead.` };
    }
    // A stamped kind we do not classify (task, workflow, deploy_app, ...) that Grok itself marks as mutating:
    // in a read-only Pi session that is still a workspace or external mutation, so deny it.
    if (need === 'other' && stamp && stamp.read_only === false && !caps.write && !caps.shell) return { allow: false, reason: `This Pi session is read-only; ${tool} (${stamp.kind ?? 'unknown kind'}) can mutate state.` };
    return { allow: true };
  };
}

/** The file a Grok edit call targets, from its input. */
export function editedFile(input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  return [i.file_path, i.target_file, i.path, i.absolute_path].find((v): v is string => typeof v === 'string');
}

// Syntax-only TypeScript check: strip types with Node's own stripper, then parse as an ES module without running it.
const TS_SYNTAX_CHECK = 'const {stripTypeScriptTypes}=require("node:module");const vm=require("node:vm");new vm.SourceTextModule(stripTypeScriptTypes(require("fs").readFileSync(process.argv[1],"utf8")))';
const BUILTIN_CHECKS: { test: RegExp; command: string[] }[] = [
  { test: /\.(ts|mts|cts)$/, command: ['node', '--no-warnings', '--experimental-vm-modules', '-e', TS_SYNTAX_CHECK, '{file}'] },
  { test: /\.(js|mjs|cjs)$/, command: ['node', '--check', '{file}'] },
  { test: /\.py$/, command: ['python3', '-m', 'py_compile', '{file}'] },
  { test: /\.json$/, command: ['node', '-e', 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))', '{file}'] },
  { test: /\.rs$/, command: ['rustfmt', '--check', '--edition', '2021', '{file}'] },
];

export type RunResult = { ok: boolean; output: string; command: string };

export function run(argv: string[], cwd: string, timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !error, output: error && !output ? String(error.message) : output, command: argv.join(' ') });
    });
  });
}

/** post_tool_use after an edit: built-in syntax check or the configured command. Findings are returned as text for additionalContext. */
export async function postEditContext(input: unknown, cwd: string, settings: HookSettings): Promise<string | undefined> {
  const file = editedFile(input);
  if (!file) return undefined;
  let argv: string[] | undefined;
  if (settings.postEditCheck) argv = ['bash', '-lc', settings.postEditCheck.replaceAll('{file}', file)];
  else { const builtin = BUILTIN_CHECKS.find((c) => c.test.test(file)); if (builtin) argv = builtin.command.map((a) => a.replaceAll('{file}', file)); }
  if (!argv) return undefined;
  const result = await run(argv, cwd);
  if (result.ok) return undefined;
  return `Check failed after editing ${file} (${result.command}):\n${result.output.slice(0, 4000)}`;
}

/** stop: run the acceptance command; non-zero blocks the stop with the output as the reason. */
export async function stopGate(event: HookRun, settings: HookSettings): Promise<HookReply> {
  if (!settings.stopCheck || event.reason !== 'end_turn') return { decision: 'continue' };
  const result = await run(['bash', '-lc', settings.stopCheck], event.cwd, 600_000);
  if (result.ok) return { decision: 'continue' };
  return { decision: 'block', reason: `Acceptance check failed (${settings.stopCheck}):\n${result.output.slice(0, 8000)}\nFix the cause, rerun the check, then finish.` };
}
