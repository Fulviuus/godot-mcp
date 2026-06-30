/**
 * Client for the `godot_mcp` bridge autoload (see templates.ts). Each call opens
 * a short-lived TCP connection to the running game, sends one newline-delimited
 * JSON command and reads the newline-delimited JSON reply. The bridge serves one
 * peer at a time and re-accepts after each connection, so connect-per-command is
 * intentional and keeps no sockets around.
 */

import net from 'node:net';
import { ToolError } from '../util/errors.js';

let requestCounter = 0;

export interface BridgeReply {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface BridgeRequest {
  cmd: string;
  [key: string]: unknown;
}

export function sendBridgeCommand(
  port: number,
  request: BridgeRequest,
  timeoutMs = 8000,
  host = '127.0.0.1',
): Promise<BridgeReply> {
  return new Promise<BridgeReply>((resolve, reject) => {
    const id = ++requestCounter;
    const socket = net.createConnection({ port, host });
    let buffer = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new ToolError(`Bridge timed out after ${timeoutMs}ms on port ${port}`, { code: 'bridge_timeout' })));
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ ...request, id }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(line) as BridgeReply;
        finish(() => resolve(parsed));
      } catch (err) {
        finish(() => reject(new ToolError(`Malformed bridge reply: ${(err as Error).message}`, { code: 'bridge_parse' })));
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      finish(() =>
        reject(
          new ToolError(`Could not reach the godot_mcp bridge on port ${port}: ${err.message}`, {
            code: 'bridge_unreachable',
            hint: 'Run the game with live control enabled (godot_run live=true), and ensure the godot_mcp addon is installed via godot_setup.',
          }),
        ),
      );
    });
  });
}

/** Throws a ToolError if the reply is not ok. */
function expectOk(reply: BridgeReply): BridgeReply {
  if (!reply.ok) {
    throw new ToolError(reply.error ? `Bridge error: ${reply.error}` : 'Bridge command failed', {
      code: 'bridge_error',
    });
  }
  return reply;
}

export async function pingBridge(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const reply = await sendBridgeCommand(port, { cmd: 'ping' }, timeoutMs);
    return reply.ok === true && reply.pong === true;
  } catch {
    return false;
  }
}

export async function getEngineInfo(port: number): Promise<Record<string, unknown>> {
  const reply = expectOk(await sendBridgeCommand(port, { cmd: 'info' }));
  return (reply.info as Record<string, unknown>) ?? {};
}

export async function getSceneTree(port: number, maxDepth = 100): Promise<unknown> {
  const reply = expectOk(await sendBridgeCommand(port, { cmd: 'scene_tree', max_depth: maxDepth }));
  return reply.tree;
}

export async function evalExpression(port: number, expression: string): Promise<string> {
  const reply = expectOk(await sendBridgeCommand(port, { cmd: 'eval', expression }, 15_000));
  return String(reply.result ?? '');
}

export async function setNodeProperty(
  port: number,
  node: string,
  property: string,
  value: unknown,
): Promise<string> {
  const reply = expectOk(await sendBridgeCommand(port, { cmd: 'set_property', node, property, value }));
  return String(reply.result ?? '');
}

export async function reloadInEngine(
  port: number,
  options: { scripts?: string[]; reloadScene?: boolean },
): Promise<string[]> {
  const reply = expectOk(
    await sendBridgeCommand(port, {
      cmd: 'reload',
      scripts: options.scripts ?? [],
      reload_scene: options.reloadScene ?? false,
    }),
  );
  return (reply.reloaded as string[]) ?? [];
}

export interface BridgeScreenshot {
  pngBase64: string;
  width: number;
  height: number;
}

export async function captureScreenshot(port: number): Promise<BridgeScreenshot> {
  const reply = expectOk(await sendBridgeCommand(port, { cmd: 'screenshot' }, 15_000));
  return {
    pngBase64: String(reply.png_base64 ?? ''),
    width: Number(reply.width ?? 0),
    height: Number(reply.height ?? 0),
  };
}

/** Asks the running game to quit cleanly via the bridge. */
export async function quitViaBridge(port: number): Promise<void> {
  await sendBridgeCommand(port, { cmd: 'quit' }, 3000).catch(() => undefined);
}
