// Child stderr and framing errors. Rotates so a noisy child cannot fill the disk.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Transform, type Writable } from 'node:stream';

export const STDIO_LOG_NAME = 'grok-stdio.log';
/** A few MB. The previous file is kept as grok-stdio.log.1. */
export const STDIO_LOG_MAX_BYTES = 2 * 1024 * 1024;

export function appendStdioLog(path: string, line: string, maxBytes = STDIO_LOG_MAX_BYTES): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (existsSync(path) && statSync(path).size >= maxBytes) renameSync(path, `${path}.1`);
  } catch { /* a concurrent writer may have rotated it */ }
  appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`);
}

function isJsonLine(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** A warning glued to the next frame still yields the JSON object. The prefix is skipped. */
function takeJson(line: string): { json?: string; skip?: string } {
  const trimmed = line.trim();
  if (!trimmed) return {};
  if (isJsonLine(trimmed)) return { json: trimmed };
  const marker = trimmed.indexOf('{"jsonrpc"');
  if (marker >= 0 && isJsonLine(trimmed.slice(marker))) return { json: trimmed.slice(marker), skip: trimmed.slice(0, marker) };
  return { skip: trimmed };
}

/** Pass only full JSON lines. A warning or a truncated frame is logged and skipped. */
export function jsonLineTransform(onSkip: (line: string) => void): Transform {
  let buffer = '';
  const keep = (line: string, out: string[]) => {
    const taken = takeJson(line);
    if (taken.skip) onSkip(taken.skip.length > 500 ? `${taken.skip.slice(0, 500)}…` : taken.skip);
    if (taken.json) out.push(taken.json);
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      const kept: string[] = [];
      for (const line of parts) keep(line, kept);
      if (kept.length) callback(null, Buffer.from(`${kept.join('\n')}\n`));
      else callback();
    },
    flush(callback) {
      const leftover = buffer;
      buffer = '';
      if (!leftover.trim()) { callback(); return; }
      const kept: string[] = [];
      keep(leftover, kept);
      if (kept.length) callback(null, Buffer.from(`${kept.join('\n')}\n`));
      else callback();
    },
  });
}

/**
 * Queue stdin writes. `write` returning false means the kernel buffer is full;
 * the callback runs after `drain`, so the next line waits instead of being dropped.
 */
export function enqueueWrite(stdin: Writable, chunk: string | Buffer, state: { chain: Promise<void> }): Promise<void> {
  const run = state.chain.then(() => new Promise<void>((resolve, reject) => {
    if (stdin.destroyed || !stdin.writable) { reject(new Error('Grok stdin is closed')); return; }
    stdin.write(chunk, (error) => error ? reject(error) : resolve());
  }));
  state.chain = run.then(() => undefined, () => undefined);
  return run;
}
