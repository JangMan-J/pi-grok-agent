// WebSocket transport to the Grok gateway: one JSON-RPC message per frame, bearer secret in the header.
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';
import WebSocket from 'ws';

export type ConnectionOptions = { url: string; secret: string };

export function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a ws:// or wss:// endpoint without credentials, query, or fragment.');
  }
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Use wss:// for a non-loopback server.');
  }
  return url.toString();
}

/** One JSON-RPC message per WebSocket frame; no Pi filesystem/terminal bridge. */
export async function openSocket(options: ConnectionOptions, signal?: AbortSignal): Promise<{ stream: Stream; close(): void; closed: Promise<void> }> {
  signal?.throwIfAborted();
  const url = validateEndpoint(options.url);
  if (!options.secret.trim()) throw new Error('Grok WebSocket secret is missing.');
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${options.secret}` },
    handshakeTimeout: 10_000,
    maxPayload: 16 * 1024 * 1024,
    followRedirects: false,
  });
  let input: ReadableStreamDefaultController<AnyMessage>;
  let ended = false;
  const end = (error?: Error) => {
    if (ended) return;
    ended = true;
    if (error) input.error(error); else input.close();
  };
  const readable = new ReadableStream<AnyMessage>({
    start(controller) { input = controller; },
    cancel() { ended = true; socket.terminate(); }
  });
  socket.on('message', (data) => {
    if (ended) return;
    try { input.enqueue(JSON.parse(data.toString())); }
    catch { end(new Error('Invalid JSON from Grok WebSocket.')); socket.terminate(); }
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  socket.on('close', () => { end(); resolveClosed(); });
  socket.on('error', () => end(new Error('Grok WebSocket connection failed. Check the endpoint, server, and secret.')));
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { signal?.removeEventListener('abort', abort); socket.off('open', opened); socket.off('error', failed); socket.off('close', closed); };
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); socket.terminate(); reject(new Error('Grok WebSocket handshake failed. Check the endpoint, server, and secret.')); };
    const closed = () => { cleanup(); reject(new Error('Grok WebSocket closed during connection.')); };
    const abort = () => { cleanup(); socket.terminate(); reject(new Error('Grok connection cancelled.')); };
    socket.once('open', opened); socket.once('error', failed); socket.once('close', closed);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  return {
    stream: {
      readable,
      writable: new WritableStream<AnyMessage>({
        write(message) {
          return new Promise<void>((resolve, reject) => {
            socket.send(JSON.stringify(message), (error) => error ? reject(new Error('Grok WebSocket send failed.')) : resolve());
          });
        },
        close() { socket.close(); },
        abort() { socket.terminate(); },
      }),
    },
    close() { socket.terminate(); },
    closed,
  };
}
