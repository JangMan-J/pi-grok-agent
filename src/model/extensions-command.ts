import { writeConfig } from '../config.ts';
import { DEFAULT_BLOCKED_PI_EXTENSIONS, PI_EXTENSION_TOOL_NAMES, sortedNames, type PiToolPolicy } from '../tool-policy.ts';

type ShowCommandOutput = (title: string, body: string) => void;
type Notify = (message: string) => void;
type PersistBlockedPiExtensions = (blockedPiExtensions: string[]) => Promise<void>;

export interface ExtensionsCommandOptions {
  args: string[];
  blockedPiExtensions: Set<string>;
  piTools: PiToolPolicy;
  show: ShowCommandOutput;
  notify: Notify;
  persistBlockedPiExtensions?: PersistBlockedPiExtensions;
  getToolNamesForExtension?: (extensionName: string) => readonly string[];
}

function formatPiToolPolicy(policy: PiToolPolicy): string {
  return Array.isArray(policy) ? policy.join(', ') : policy;
}

function blockedPiExtensionsStatus(policy: PiToolPolicy): string {
  if (policy === 'extensions') return 'Active for new Grok sessions under piTools: extensions.';
  if (policy === 'all') return 'Inactive while piTools is all; every Pi tool is lent.';
  if (policy === 'none') return 'Inactive while piTools is none; no Pi tools are lent.';
  return 'Inactive while piTools is an explicit allow-list; named tools are lent verbatim.';
}

function blockedPiExtensionsChangeNote(policy: PiToolPolicy): string {
  if (policy === 'extensions') return 'applies to the next Grok session';
  if (policy === 'all') return 'currently ignored by piTools: all';
  if (policy === 'none') return 'currently ignored by piTools: none';
  return 'currently ignored by the explicit piTools allow-list';
}

async function defaultPersistBlockedPiExtensions(blockedPiExtensions: string[]): Promise<void> {
  await writeConfig({ blockedPiExtensions });
}

function formatExtensionTools(extensionName: string, getToolNamesForExtension?: (extensionName: string) => readonly string[]): string {
  const toolNames = getToolNamesForExtension?.(extensionName) ?? PI_EXTENSION_TOOL_NAMES[extensionName] ?? [];
  return toolNames.length ? `${extensionName} (${toolNames.length} tools: ${toolNames.join(', ')})` : `${extensionName} (unknown tools until pi-grok-agent learns this extension)`;
}

export async function handleExtensionsCommand({ args, blockedPiExtensions, piTools, show, notify, persistBlockedPiExtensions = defaultPersistBlockedPiExtensions, getToolNamesForExtension }: ExtensionsCommandOptions): Promise<void> {
  const [action, name] = [args[0], args.slice(1).join(' ').trim()];
  if (!action || action === 'list') {
    const blockedExtensionNames = sortedNames(blockedPiExtensions);
    const defaultBlockedExtensions = blockedExtensionNames.filter((extensionName) => DEFAULT_BLOCKED_PI_EXTENSIONS.has(extensionName));
    const userBlockedExtensions = blockedExtensionNames.filter((extensionName) => !DEFAULT_BLOCKED_PI_EXTENSIONS.has(extensionName));
    const unblockedDefaultExtensions = sortedNames([...DEFAULT_BLOCKED_PI_EXTENSIONS].filter((extensionName) => !blockedPiExtensions.has(extensionName)));
    show('Grok blocked Pi extensions', [
      `Current piTools: ${formatPiToolPolicy(piTools)}.`,
      blockedPiExtensionsStatus(piTools),
      `Blocked under extensions (${blockedExtensionNames.length}): ${blockedExtensionNames.length ? blockedExtensionNames.map((extensionName) => formatExtensionTools(extensionName, getToolNamesForExtension)).join('; ') : 'none'}`,
      userBlockedExtensions.length ? `  added by you: ${userBlockedExtensions.join(', ')}` : '',
      `  package defaults: ${defaultBlockedExtensions.join(', ') || 'none'}`,
      unblockedDefaultExtensions.length ? `  unblocked package defaults: ${unblockedDefaultExtensions.join(', ')}` : '',
      'Existing Grok sessions keep the tool list they already received.',
    ].filter(Boolean).join('\n'));
    return;
  }
  if (action !== 'block' && action !== 'unblock') throw new Error('Usage: /grok extensions list | block <extension> | unblock <extension>');
  if (!name) throw new Error(`Usage: /grok extensions ${action} <extension>`);
  if (action === 'block') blockedPiExtensions.add(name);
  else blockedPiExtensions.delete(name);
  await persistBlockedPiExtensions(sortedNames(blockedPiExtensions));
  notify(`Grok blocked Pi extensions: ${action === 'block' ? 'blocked' : 'unblocked'} ${name} (${blockedPiExtensionsChangeNote(piTools)}).`);
}
