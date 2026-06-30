/**
 * HTTP (Streamable HTTP) transport. Runs the MCP server over HTTP so multiple
 * agents can share one process. Sessions are stateless per request: a fresh
 * McpServer/transport pair handles each call, while all engine/runtime state
 * lives in the shared `runtime` singleton, so launched games persist across
 * requests and clients.
 */

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from './util/log.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Factory that builds a fully-registered server instance. */
  createServer: () => McpServer;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function startHttpServer(options: HttpOptions): Promise<http.Server> {
  const { host, port, createServer } = options;

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'godot-mcp-server' }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. POST JSON-RPC to /mcp.' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: 'Use POST for /mcp.' }));
      return;
    }

    // Stateless: build a server + transport per request; shared state is global.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error(`HTTP request failed: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      log.info(`HTTP transport listening on http://${host}:${port}/mcp`);
      resolve(httpServer);
    });
  });
}
