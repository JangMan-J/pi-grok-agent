// Mid-turn steering for Grok model sessions. Pi distinguishes Enter mid-turn (steer: inject into the
// running turn) from Alt+Enter (followUp: queue for after). A steered message reaches Grok through
// Grok's own `x.ai/interject`, which the running turn drains at its next safe point; it must NOT go
// through Pi's steer queue, or Pi would deliver it as a new prompt after the turn (follow-up semantics).
import type { ImageContent } from '@earendil-works/pi-ai';
import type { InputEvent, InputEventResult } from '@earendil-works/pi-coding-agent';
import { spillImageFile } from './provider.ts';

export interface SteerDeps {
  /** A Grok session exists to steer into (a turn may or may not be running; Grok queues safely). */
  hasGrokSession(): boolean;
  /** Send the text to the running Grok turn. */
  interject(text: string): Promise<unknown>;
  /** Persist a record so the steered text is visible in the transcript. */
  record(text: string): void;
  /** Tell the user something went wrong (optional). */
  notify?(text: string): void;
}

/** Render steered input (text plus any attached images) the way Grok receives it. Exported for tests. */
export function steerText(text: string, images?: ImageContent[]): string {
  const parts = [text.trim()];
  for (const image of images ?? []) {
    try { parts.push(`\n[attached image: ${spillImageFile(image.data, image.mimeType)} — read this file to view it]\n`); }
    catch { parts.push('\n[image: could not be attached]\n'); }
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Pi `input` handler. Takes over only the steer case for Grok sessions: anything else (idle, followUp,
 * extension commands, empty input) flows through Pi untouched.
 */
export function createSteerHandler(deps: SteerDeps): (event: InputEvent) => Promise<InputEventResult | void> {
  return async (event) => {
    if (event.streamingBehavior !== 'steer') return;
    if (event.text.startsWith('/')) return; // extension commands and prompt templates: Pi's queue expands them
    if (!event.text.trim() && !(event.images?.length)) return;
    if (!deps.hasGrokSession()) return;
    const text = steerText(event.text, event.images);
    try {
      await deps.interject(text);
      deps.record(text);
      return { action: 'handled' };
    } catch (error) {
      deps.notify?.(`Could not steer Grok's turn (${error instanceof Error ? error.message : String(error)}); queued normally.`);
      return { action: 'continue' };
    }
  };
}
