/**
 * Screenshot capture. Godot's headless mode uses a dummy renderer that produces
 * no image, so real screenshots come from a *running, windowed* game via the
 * godot_mcp bridge: we ask the bridge to grab the viewport, it returns PNG bytes
 * as base64, and we decode them to disk.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from '../util/errors.js';
import { captureScreenshot, pingBridge } from './engine.js';
import type { GameProcess } from '../state.js';

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  bytes: number;
  base64: string;
}

function defaultOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(os.tmpdir(), `godot-mcp-screenshot-${stamp}.png`);
}

/**
 * Capture a screenshot from a running game through its bridge. Writes a PNG to
 * `outPath` (or a temp file) and returns the path plus dimensions and the raw
 * base64 (so a tool can also embed it as an image content block).
 */
export async function captureGameScreenshot(game: GameProcess, outPath?: string): Promise<ScreenshotResult> {
  if (game.exitCode !== null || game.signal !== null) {
    throw new ToolError(`Game ${game.id} is not running.`, { code: 'not_running' });
  }
  if (!game.bridgePort) {
    throw new ToolError(`Game ${game.id} was not launched with live control.`, {
      code: 'no_bridge',
      hint: 'Relaunch with godot_run live=true to enable screenshots.',
    });
  }
  if (!(await pingBridge(game.bridgePort))) {
    throw new ToolError(`The godot_mcp bridge for game ${game.id} is not responding.`, {
      code: 'bridge_unreachable',
      hint: 'Ensure the godot_mcp addon is installed (godot_setup) and the game finished loading.',
    });
  }

  const shot = await captureScreenshot(game.bridgePort);
  if (!shot.pngBase64) {
    throw new ToolError('Bridge returned an empty image (is the game running with a real window?).', {
      code: 'empty_image',
    });
  }

  const buffer = Buffer.from(shot.pngBase64, 'base64');
  const dest = outPath ? path.resolve(outPath) : defaultOutputPath();
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buffer);

  return {
    path: dest,
    width: shot.width,
    height: shot.height,
    bytes: buffer.byteLength,
    base64: shot.pngBase64,
  };
}
