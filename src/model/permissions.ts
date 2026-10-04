// Answers Grok's native permission prompts for the model provider.
// Interactive Pi: the existing dialog. Headless Pi: a configured policy, never a silent allow by default.
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HeadlessPermissionPolicy } from '../config.ts';

type Answer = (request: RequestPermissionRequest, extend?: () => void, signal?: AbortSignal) => Promise<RequestPermissionResponse>;

/** Interactive: Grok's permission prompt as a Pi selection dialog. Dismissal cancels; Grok treats that as a rejection. */
export function permissionDialog(ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>): Answer {
  return async (request, extend, signal) => {
    if (!ctx.hasUI || signal?.aborted) return { outcome: { outcome: 'cancelled' } };
    const labels = request.options.map((option, i) => `${i + 1}. ${option.name} (${option.kind})`);
    const details = JSON.stringify(request.toolCall.rawInput ?? {}, null, 2).slice(0, 4000);
    extend?.();
    const selected = await ctx.ui.select(`Grok: ${request.toolCall.title}\n${details}`, labels, { signal });
    const index = selected === undefined ? -1 : labels.indexOf(selected);
    if (index < 0) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: request.options[index].optionId } };
  };
}

const READ_KINDS = new Set(['read', 'search', 'fetch', 'think']);

function pick(request: RequestPermissionRequest, kind: 'allow_once' | 'reject_once'): RequestPermissionResponse {
  const option = request.options.find((o) => o.kind === kind) ?? request.options.find((o) => o.kind.startsWith(kind.split('_')[0]));
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}

export function headlessPermission(policy: HeadlessPermissionPolicy): Answer {
  return async (request) => {
    switch (policy) {
      case 'allow': return pick(request, 'allow_once');
      case 'reads': return READ_KINDS.has(request.toolCall.kind ?? 'other') ? pick(request, 'allow_once') : pick(request, 'reject_once');
      case 'deny': return pick(request, 'reject_once');
      default: return { outcome: { outcome: 'cancelled' } };
    }
  };
}

/**
 * Dialog when Pi has a UI, otherwise the headless policy.
 * `/grok perms yolo` selects allow once and does not open a dialog. The mode is read per request.
 */
export function permissionAnswer(hasUI: boolean, dialog: Answer, policy: HeadlessPermissionPolicy, mode: () => 'yolo' | 'auto' | 'ask' | 'readonly' = () => 'auto'): Answer {
  const base = hasUI ? dialog : headlessPermission(policy);
  const allow = headlessPermission('allow');
  return (request, extend, signal) => (mode() === 'yolo' ? allow(request) : base(request, extend, signal));
}
