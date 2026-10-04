// Plain-language failures for the stdio child. Each message names the cause and the next action.
export const SIGNED_OUT_MESSAGE = 'Grok Build is not signed in. Run /grok login, approve the code in your browser, then send the message again.';

/** initialize 30s, session/new|load 60s, set_mode/set_config 10s, session/prompt none. Other requests 30s. */
const DEADLINES_MS: Record<string, number | undefined> = {
  initialize: 30_000,
  authenticate: 30_000,
  'session/new': 60_000,
  'session/load': 60_000,
  'session/prompt': undefined,
  'session/set_mode': 10_000,
  'session/set_config_option': 10_000,
};
const DEFAULT_DEADLINE_MS = 30_000;

export function deadlineFor(method: string, overrides?: Partial<Record<string, number>>): number | undefined {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, method)) return overrides[method];
  if (Object.prototype.hasOwnProperty.call(DEADLINES_MS, method)) return DEADLINES_MS[method];
  return DEFAULT_DEADLINE_MS;
}

export function timeoutMessage(method: string, ms: number): string {
  return `Grok did not answer ${method} within ${ms / 1000}s. The child was stopped. Send the message again; the next turn starts a new child and reloads the stored Grok session.`;
}

export function cancelTimeoutMessage(ms: number): string {
  return `Grok did not acknowledge session/cancel within ${ms / 1000}s. The child was stopped. Send the message again; the next turn starts a new child and reloads the stored Grok session.`;
}

function stderrTail(stderr: string): string {
  const lines = stderr.trim().split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0).slice(-10);
  return lines.length ? `\nLast stderr:\n${lines.join('\n')}` : '';
}

export function spawnFailureMessage(binary: string, error: NodeJS.ErrnoException, stderr = ''): string {
  const tail = stderrTail(stderr);
  if (error.code === 'ENOENT') return `Cannot start Grok: \`${binary}\` was not found. Install Grok Build and put \`grok\` on PATH, or set PI_GROK_BINARY to the executable.${tail}`;
  if (error.code === 'EACCES') return `Cannot start Grok: \`${binary}\` is not executable. Set PI_GROK_BINARY to a Grok Build binary you can run.${tail}`;
  return `Cannot start Grok: \`${binary}\` failed to start (${error.code ?? error.message}).${tail}`;
}

export function childExitMessage(binary: string, code: number | null, signal: NodeJS.Signals | null, stderr: string, phase: 'startup' | 'running'): string {
  const how = signal ? `signal ${signal}` : `exit code ${code}`;
  const tail = stderrTail(stderr);
  const looksOld = code === 2 || /unknown (option|flag|command)|usage:/i.test(stderr);
  if (phase === 'startup' && looksOld) {
    return `Grok at \`${binary}\` stopped during startup (${how}) and does not provide \`agent --no-leader stdio\`. Install Grok Build 1.0.46 or newer, or set PI_GROK_BINARY to that executable.${tail}`;
  }
  if (phase === 'startup') return `Grok at \`${binary}\` stopped during startup (${how}).${tail}`;
  return `Grok child \`${binary}\` ended (${how}).${tail}\nSend the message again. The next turn starts a new child and reloads the stored Grok session.`;
}

/** session/load failed because that id is not on disk. Timeouts and transport errors are not this. */
export function isMissingSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session (was )?not found|no such session|unknown session|session does not exist/i.test(message);
}

export function isTransportClose(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ACP connection closed|connection closed|EPIPE|ECONNRESET|ERR_STREAM|socket hang up|the operation was aborted/i.test(message);
}

export function leashStallMessage(stallMs: number): string {
  return `[grok stopped by pi-grok-leash: stall after ${stallMs} ms; no unguarded tool ran]`;
}

export function leashDeadlineMessage(method: string, id: unknown, ms: number): string {
  return `[pi-grok-leash denied ${method} ${String(id)} after ${ms} ms: Pi did not answer]`;
}

export function leashStartMessage(path: string, detail: string, stderr = ''): string {
  return `Cannot start pi-grok-leash: \`${path}\` ${detail}. Run \`npm run build:leash\`, or set PI_GROK_LEASH to the executable.${stderrTail(stderr)}`;
}

export function isExplained(message: string): boolean {
  return /^(Cannot start Grok|Grok at |Grok child |Grok Build is not signed in|Grok did not answer |Grok did not acknowledge |Grok connection cancelled|Cannot start pi-grok-leash|\[grok stopped by pi-grok-leash:)/.test(message);
}

export function missingSessionNote(sessionId: string): string {
  return `[grok session ${sessionId} not found; started a new one]`;
}

/**
 * Sessions live under ~/.grok/sessions/<encoded-cwd>/<id>/ (user guide 17-sessions.md).
 * A stored id from another cwd is a different directory, so Pi starts a new session.
 */
export function storedSessionAction(saved: { grokSessionId?: string; cwd?: string } | undefined, cwd: string): { grokSessionId?: string; notice?: string } {
  if (!saved?.grokSessionId) return {};
  if (saved.cwd === cwd) return { grokSessionId: saved.grokSessionId };
  return { notice: `[grok session ${saved.grokSessionId} belongs to ${saved.cwd}; started a new one]` };
}

export type ChildExitRecord = { at: string; code: number | null; signal: NodeJS.Signals | null };

export function formatExitRecord(exit: ChildExitRecord): string {
  const how = exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`;
  return `${exit.at} ${how}`;
}

export function formatUptime(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}
