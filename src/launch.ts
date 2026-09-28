// Start the gateway that ships with this package when nothing listens on its loopback endpoint, so a user needs only
// `pi install npm:pi-grok-agent`. The gateway runs detached and outlives Pi: every Pi process on the machine shares it.
// Two Pi processes that start one at the same time are safe: the gateway binds its port before it touches a leader,
// so the loser exits with EADDRINUSE and both connect to the winner.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The gateway entry point for this install. Node refuses to strip TypeScript under node_modules, so an npm install runs the compiled copy. */
export function gatewayEntry(root = packageRoot): string {
  const source = join(root, 'scripts', 'server.ts');
  const compiled = join(root, 'dist', 'scripts', 'server.js');
  if (root.includes(`${sep}node_modules${sep}`) || !existsSync(source)) return compiled;
  return source;
}

/** True when something accepts TCP connections on the endpoint's host and port. */
export function endpointListening(endpoint: string, timeoutMs = 1000): Promise<boolean> {
  const url = new URL(endpoint);
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(url.port || 80) });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Start the gateway detached, logging to `<agentDir>/grok-ws.log`, and wait until its port accepts connections. Returns its pid. */
export async function launchGateway(endpoint: string, logDir: string, timeoutMs = 30_000): Promise<number | undefined> {
  const entry = gatewayEntry();
  if (!existsSync(entry)) throw new Error(`Grok gateway not found at ${entry}. Run npm run build in the package, or start the gateway yourself.`);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(logDir, 'grok-ws.log'), 'a', 0o600);
  // Inside Pi, execPath is the Node binary that runs Pi. A single-file Pi build would be Pi itself; use `node` then.
  const nodeBinary = /^node(\.exe)?$/.test(basename(process.execPath)) ? process.execPath : 'node';
  const child = spawn(nodeBinary, [entry], { detached: true, stdio: ['ignore', log, log], cwd: homedir(), env: process.env });
  child.unref();
  // Exited without a port: usually another Pi's launch won the port a moment earlier, so keep waiting a few seconds for it.
  let exitedAt: number | undefined;
  child.once('exit', () => { exitedAt = Date.now(); });
  child.once('error', () => { exitedAt = Date.now(); });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (exitedAt === undefined || Date.now() - exitedAt < 5000)) {
    if (await endpointListening(endpoint, 500)) return exitedAt === undefined ? child.pid : undefined;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Grok gateway did not start within ${Math.round(timeoutMs / 1000)}s. See ${join(logDir, 'grok-ws.log')}.`);
}
