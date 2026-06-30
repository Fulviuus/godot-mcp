/**
 * Screenshot tool. Captures the viewport of a running, windowed game through the
 * godot_mcp bridge and returns it both as an inline image and as a saved file.
 */

import { z } from 'zod';
import { fail } from '../util/errors.js';
import { captureGameScreenshot } from '../services/screenshot.js';
import { runtime } from '../state.js';
import { register, gameIdParam, type Server, type ToolResult } from './shared.js';

export function registerScreenshotTools(server: Server): void {
  register(server, {
    name: 'godot_screenshot',
    title: 'Screenshot game',
    description:
      'Capture the current frame of a running game (launched with godot_run live=true, non-headless) and return it as an image. Optionally also saves a PNG to disk.',
    schema: {
      game_id: gameIdParam,
      output: z.string().optional().describe('Optional path to save the PNG. Defaults to a temp file.'),
      embed: z.boolean().default(true).describe('Return the image inline in the response.'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ game_id, output, embed }) => {
      const game = runtime.resolve(game_id) ?? (game_id ? runtime.get(game_id) : undefined);
      if (!game) fail(game_id ? `No game with id "${game_id}".` : 'No single running game; pass game_id.', { code: 'no_game' });
      const shot = await captureGameScreenshot(game!, output);

      const result: ToolResult = {
        content: [
          {
            type: 'text',
            text: `Captured ${shot.width}×${shot.height} screenshot of ${game!.id} (${shot.bytes} bytes) → ${shot.path}`,
          },
        ],
      };
      if (embed) {
        result.content.push({ type: 'image', data: shot.base64, mimeType: 'image/png' });
      }
      return result;
    },
  });
}
