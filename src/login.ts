// `/grok login`: run Grok Build's own device-code sign-in and report the URL and code to Pi. Grok stores the
// credential in ~/.grok/auth.json, as a `grok login` in a terminal would; Pi stores nothing.
import { spawn } from 'node:child_process';

export type DeviceCode = { url: string; code: string };

/** Pull the verification URL and user code from `grok login --device-auth` output. */
export function parseDeviceCode(output: string): DeviceCode | undefined {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  const url = plain.match(/https:\/\/\S+user_code=([A-Z0-9-]+)/);
  if (!url) return undefined;
  return { url: url[0], code: url[1] };
}

/**
 * Start the sign-in. `onCode` fires once with the URL and code; the promise settles when Grok's login exits.
 * Grok may also open the URL in a browser itself. The abort signal stops the login.
 */
export function grokLogin(onCode: (device: DeviceCode) => void, options: { binary?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  const binary = options.binary ?? process.env.PI_GROK_BINARY ?? 'grok';
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['login', '--device-auth'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = ''; let reported = false;
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (reported) return;
      const device = parseDeviceCode(output);
      if (device) { reported = true; onCode(device); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, options.timeoutMs ?? 15 * 60_000);
    options.signal?.addEventListener('abort', stop, { once: true });
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`Could not run ${binary} login: ${error.message}`)); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      if (code === 0) { resolve(); return; }
      const tail = output.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-2).join(' ').trim();
      reject(new Error(`Grok login ${signal ? 'stopped' : `failed (exit ${code})`}${tail ? `: ${tail}` : ''}`));
    });
  });
}
