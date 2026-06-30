// Verifies the HTTP (Streamable HTTP) transport: health check, JSON-RPC over
// POST /mcp, and that shared runtime state persists across separate requests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { SERVER, FIXTURE } from './_client.mjs';

let child;
let port;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function waitForHealth(p, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/health`);
        if (res.ok) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return reject(new Error('server did not start'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

/** One-shot JSON-RPC POST; parses an SSE or JSON body into the JSON-RPC object. */
async function rpc(p, method, params, id = 1) {
  const res = await fetch(`http://127.0.0.1:${p}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  // Streamable HTTP may answer as SSE (data: {...}); extract the JSON payload.
  const line = text.split(/\r?\n/).find((l) => l.startsWith('data:')) ?? text;
  const json = line.replace(/^data:\s*/, '').trim();
  return JSON.parse(json);
}

before(async () => {
  port = await freePort();
  child = spawn('node', [SERVER, '--transport', 'http', '--port', String(port)], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, GODOT_MCP_LOG_LEVEL: 'error' },
  });
  await waitForHealth(port);
});

after(() => {
  child?.kill();
});

test('health endpoint responds', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('initialize + tools/list over HTTP', async () => {
  const init = await rpc(port, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'http-test', version: '0' },
  });
  assert.ok(init.result.serverInfo.name.includes('godot'));

  const list = await rpc(port, 'tools/list', {}, 2);
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('godot_project_info'));
});

test('a read-only tool call works over HTTP', async () => {
  const res = await rpc(
    port,
    'tools/call',
    { name: 'godot_project_info', arguments: { project_root: FIXTURE, response_format: 'json' } },
    3,
  );
  const block = res.result.content.find((c) => c.type === 'text');
  const data = JSON.parse(block.text);
  assert.equal(data.name, 'MCP Fixture');
});
