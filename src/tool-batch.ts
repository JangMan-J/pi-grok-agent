import { TOOL_BATCH_SIZE } from './config.ts';
import type { GrokToolRecord } from './model/session.ts';

/** Entry type for one flushed batch of routine native tool calls. */
export const TOOL_BATCH_ENTRY = 'grok-tools';

/**
 * A record worth its own transcript row: anything not a clean completion, a media
 * capture (it also feeds the `grok-media` message), or a post-edit check note.
 */
export function isInteresting(record: GrokToolRecord): boolean {
  return Boolean(record.status !== 'completed' || record.mediaPath || record.hookContext);
}

/**
 * Group routine native tool records into batch entries so a long autonomous burst
 * renders as one row per `size` calls instead of one row per call. Interesting records
 * are left to the caller to render alone. `flush()` emits whatever is buffered;
 * call it when the turn ends so no record sits invisible.
 */
export function createToolBatcher(
  append: (records: GrokToolRecord[]) => void,
  size: number = TOOL_BATCH_SIZE,
) {
  let pending: GrokToolRecord[] = [];
  const flush = () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    append(batch);
  };
  return {
    /** Returns true when the record was buffered (or flushed in a batch). */
    record(record: GrokToolRecord): boolean {
      if (isInteresting(record)) return false;
      pending.push(record);
      if (pending.length >= size) flush();
      return true;
    },
    flush,
    get pendingCount(): number {
      return pending.length;
    },
  };
}
