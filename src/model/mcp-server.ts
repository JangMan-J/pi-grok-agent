import { createServer, type ServerResponse } from 'node:http';
import type { SessionHandlers } from './connection.ts';

function endJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Connection-local HTTP MCP. Routes exist before session/new can ask for tools/list. */
export async function startMcpServer(handlersFor: (serverId: string) => SessionHandlers | undefined) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith('/mcp/')) { endJson(res, 404, { error: 'not found' }); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
    const handlers = handlersFor(path.slice('/mcp/'.length));
    if (!handlers?.onMcp) { endJson(res, 404, { error: 'unknown MCP token' }); return; }
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      let message: any;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { endJson(res, 400, { error: 'invalid JSON' }); return; }
      if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
        endJson(res, 400, { error: 'expected a JSON-RPC message' }); return;
      }
      if (message.id == null) { res.writeHead(202); res.end(); return; }
      try {
        const result = await handlers.onMcp(message);
        endJson(res, 200, { jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        endJson(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
