// Minimal MCP stdio/HTTP client used by the test suite. Not a test file itself
// (the runner only picks up *.test.mjs), so it is safe to import from tests.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const FIXTURE = path.join(ROOT, 'test', 'fixture');
export const SERVER = path.join(ROOT, 'dist', 'index.js');

/** A JSON-RPC client speaking to the server over stdio. */
export class StdioClient {
  constructor(extraArgs = [], env = {}) {
    this.child = spawn('node', [SERVER, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GODOT_MCP_LOG_LEVEL: 'error', ...env },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', () => {});
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`request ${method} timed out`));
        }
      }, 20000);
    });
  }

  _notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    const res = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    this._notify('notifications/initialized', {});
    return res;
  }

  listTools() {
    return this._request('tools/list', {});
  }

  callTool(name, args = {}) {
    return this._request('tools/call', { name, arguments: args });
  }

  /** Convenience: returns the first text content block of a tool result. */
  async callText(name, args) {
    const res = await this.callTool(name, args);
    const block = (res.content || []).find((c) => c.type === 'text');
    return { text: block ? block.text : '', isError: !!res.isError, result: res };
  }

  /** Convenience: calls a tool with response_format json and parses it. */
  async callJson(name, args) {
    const { text, isError } = await this.callText(name, { ...args, response_format: 'json' });
    return { data: text ? JSON.parse(text) : undefined, isError };
  }

  close() {
    try {
      this.child.kill();
    } catch {
      // ignore
    }
  }
}
