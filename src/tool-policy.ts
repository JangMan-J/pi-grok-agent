/** Which Pi tools the `grok` model provider offers to Grok in addition to Grok's own harness tools. */
export type PiToolPolicy = 'none' | 'extensions' | 'all' | string[];

/** Metadata Pi can provide before model-provider transcript serialization strips tool ownership. */
export interface PiToolAttribution {
  name: string;
  namespaceName?: string;
  sourceInfo?: {
    path?: string;
    source?: string;
    scope?: string;
    origin?: string;
    baseDir?: string;
  };
  readOnlyHint?: boolean;
}

export interface PiToolRoute {
  originalName: string;
  exposedName: string;
  attribution?: PiToolAttribution;
}

/** Pi core tool names: Grok has a native equivalent for each, so `extensions` never lends them. */
export const PI_CORE_TOOL_NAMES = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

/**
 * Known Pi extension/tool-surface ownership. Runtime ToolInfo attribution is preferred; this registry
 * remains as a fallback for extensions that do not yet declare a namespace and for synthetic conflict surfaces.
 */
export const PI_EXTENSION_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  'pi-lens': [
    'symbol_search',
    'project_report',
    'module_report',
    'read_symbol',
    'read_enclosing',
    'lens_diagnostics',
    'lens_diagnostic_mark',
    'effective_config',
    'ast_grep_search',
    'ast_grep_replace',
    'ast_grep_outline',
    'lsp_navigation',
    'pi_lens_activate_tools',
  ],
  codemode: ['codemode'],
  'image-generation': ['generate_image'],
};

/** Extensions or tool surfaces whose tools duplicate/disrupt Grok's native harness under `piTools: extensions`. */
export const DEFAULT_BLOCKED_PI_EXTENSIONS = new Set(['pi-lens', 'codemode', 'image-generation']);

const PI_TOOL_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  intercom: [
    'Send messages to other local Pi sessions. Use this for coordination with explicit local Pi sessions, not as a substitute for doing the current work yourself.',
    'Prefer list-cwd to find peers in the current project, then non-blocking send. Use ask only when a reply is required. Use handover or openProjectPaneIfMissing only when the user explicitly wants delegation or a new pane.',
    'Do not send secrets or large raw file contents; summarize and name files instead.',
  ].join(' '),
};

export function sortedNames(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function lastPathSegment(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function stripKnownSourcePrefix(source: string): string {
  const withoutPrefix = source.replace(/^(?:npm|github|git|local|file):/u, '');
  if (/^[\w.-]+\/[\w.-]+\/[\w.-]+$/u.test(withoutPrefix)) return lastPathSegment(withoutPrefix);
  return withoutPrefix;
}

function syntheticBuiltinName(path: string | undefined): string | undefined {
  if (!path?.startsWith('builtin:')) return undefined;
  return path.slice('builtin:'.length).split(/[/:]/u)[0] || undefined;
}

export function normalizedExtensionName(name: string): string {
  return stripKnownSourcePrefix(name).replace(/^@([^/]+)\//u, '$1__');
}

function attributionByName(attributions: readonly PiToolAttribution[] | undefined): Map<string, PiToolAttribution> {
  return new Map((attributions ?? []).map((attribution) => [attribution.name, attribution]));
}

export function extensionNamesForTool(toolName: string, attributions?: readonly PiToolAttribution[]): Set<string> {
  const names = new Set<string>();
  for (const [extensionName, toolNames] of Object.entries(PI_EXTENSION_TOOL_NAMES)) {
    if (toolNames.includes(toolName)) names.add(extensionName);
  }
  const attribution = attributionByName(attributions).get(toolName);
  if (!attribution) return names;
  if (attribution.namespaceName) {
    names.add(attribution.namespaceName);
    names.add(normalizedExtensionName(attribution.namespaceName));
  }
  const sourceInfo = attribution.sourceInfo;
  if (sourceInfo?.source) {
    names.add(sourceInfo.source);
    names.add(normalizedExtensionName(sourceInfo.source));
  }
  const builtin = syntheticBuiltinName(sourceInfo?.path);
  if (builtin) names.add(builtin);
  if (sourceInfo?.baseDir) names.add(lastPathSegment(sourceInfo.baseDir));
  return names;
}

export function toolNamesForExtension(extensionName: string, attributions?: readonly PiToolAttribution[]): string[] {
  const names = new Set(PI_EXTENSION_TOOL_NAMES[extensionName] ?? []);
  const wanted = new Set([extensionName, normalizedExtensionName(extensionName)]);
  for (const attribution of attributions ?? []) {
    const candidates = extensionNamesForTool(attribution.name, attributions);
    if ([...wanted].some((name) => candidates.has(name))) names.add(attribution.name);
  }
  return sortedNames(names);
}

export function blockedToolNamesForExtensions(blockedPiExtensions: Iterable<string>, attributions?: readonly PiToolAttribution[]): Set<string> {
  const blockedExtensionNames = new Set<string>();
  for (const extensionName of blockedPiExtensions) {
    blockedExtensionNames.add(extensionName);
    blockedExtensionNames.add(normalizedExtensionName(extensionName));
  }
  const blockedToolNames = new Set<string>();
  for (const extensionName of blockedExtensionNames) {
    for (const toolName of PI_EXTENSION_TOOL_NAMES[extensionName] ?? []) blockedToolNames.add(toolName);
  }
  for (const attribution of attributions ?? []) {
    const candidates = extensionNamesForTool(attribution.name, attributions);
    if ([...blockedExtensionNames].some((name) => candidates.has(name))) blockedToolNames.add(attribution.name);
  }
  return blockedToolNames;
}

export function extensionNameForTool(toolName: string, attributions?: readonly PiToolAttribution[]): string | undefined {
  return sortedNames(extensionNamesForTool(toolName, attributions))[0];
}

export function selectPiTools<T extends { name: string }>(tools: T[], policy: PiToolPolicy, blockedPiExtensions: Iterable<string> = DEFAULT_BLOCKED_PI_EXTENSIONS, attributions?: readonly PiToolAttribution[]): T[] {
  if (policy === 'none') return [];
  if (policy === 'all') return tools;
  if (policy === 'extensions') {
    const blockedPiToolNames = blockedToolNamesForExtensions(blockedPiExtensions, attributions);
    return tools.filter((tool) => !PI_CORE_TOOL_NAMES.has(tool.name) && !blockedPiToolNames.has(tool.name));
  }
  const allowedPiToolNames = new Set(policy);
  return tools.filter((tool) => allowedPiToolNames.has(tool.name));
}

/** The MCP server name the lent tools are registered under. Grok qualifies each tool as `pi__<name>`. */
export const PI_MCP_SERVER_NAME = 'pi';

/**
 * Grok admits an MCP tool only when `<server>__<tool>` has exactly one `__`, no `___`, and a tool name of
 * ASCII letters, digits, `_`, and `-` (`qualify_mcp_tool_name`, per the docs bundled with Grok Build 1.0.46).
 * It skips any other tool with only a log line, so the model never sees it. A Pi name such as
 * `mcp__docs__search` is therefore listed as `mcp_docs_search`.
 */
function grokToolName(piToolName: string): string {
  return piToolName.replace(/[^A-Za-z0-9_-]/gu, '_').replace(/_{2,}/gu, '_').replace(/^_+|_+$/gu, '') || 'tool';
}

/** The name Grok's model passes to `use_tool` for a lent Pi tool. */
export function callableName(route: PiToolRoute): string {
  return `${PI_MCP_SERVER_NAME}__${route.exposedName}`;
}

export function createPiToolRoutes<T extends { name: string }>(tools: readonly T[], attributions?: readonly PiToolAttribution[]): PiToolRoute[] {
  const byName = attributionByName(attributions);
  const taken = new Set<string>();
  return tools.map((tool) => {
    const base = grokToolName(tool.name);
    let exposedName = base;
    for (let n = 2; taken.has(exposedName); n++) exposedName = `${base}_${n}`;
    taken.add(exposedName);
    return { originalName: tool.name, exposedName, attribution: byName.get(tool.name) };
  });
}

export function descriptionForPiTool(tool: { name: string; description: string }): string {
  return PI_TOOL_DESCRIPTION_OVERRIDES[tool.name] ?? tool.description;
}
