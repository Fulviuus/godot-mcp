/**
 * Live engine-control tools. These talk to a running game through the godot_mcp
 * bridge (enable it with godot_run live=true): engine info, scene-tree dumps,
 * expression eval, node property mutation, hot reload, and a raw command escape
 * hatch.
 */

import { z } from 'zod';
import { fail } from '../util/errors.js';
import { normalizeResourcePath } from '../context.js';
import {
  evalExpression,
  getEngineInfo,
  getSceneTree,
  pingBridge,
  reloadInEngine,
  sendBridgeCommand,
  setNodeProperty,
} from '../services/engine.js';
import { runtime, type GameProcess } from '../state.js';
import {
  register,
  respond,
  json,
  responseFormatParam,
  gameIdParam,
  type Server,
} from './shared.js';

async function resolveBridge(gameId?: string): Promise<{ game: GameProcess; port: number }> {
  const game = runtime.resolve(gameId);
  if (!game) {
    fail(gameId ? `No game with id "${gameId}".` : 'No single running game; pass game_id.', { code: 'no_game' });
  }
  if (game!.exitCode !== null) fail(`Game ${game!.id} is not running.`, { code: 'not_running' });
  if (!game!.bridgePort) {
    fail(`Game ${game!.id} has no live bridge. Relaunch with godot_run live=true.`, { code: 'no_bridge' });
  }
  if (!(await pingBridge(game!.bridgePort))) {
    fail(`The godot_mcp bridge for ${game!.id} is not responding.`, {
      code: 'bridge_unreachable',
      hint: 'Make sure godot_setup installed the addon and the game finished loading.',
    });
  }
  return { game: game!, port: game!.bridgePort! };
}

function renderTree(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { name?: string; type?: string; script?: string; children?: unknown[] };
  const indent = '  '.repeat(depth);
  let line = `${indent}- ${n.name ?? '?'} : ${n.type ?? '?'}${n.script ? ` [${n.script}]` : ''}`;
  if (Array.isArray(n.children)) {
    line += '\n' + n.children.map((c) => renderTree(c, depth + 1)).join('\n');
  }
  return line;
}

export function registerEngineTools(server: Server): void {
  register(server, {
    name: 'godot_engine_info',
    title: 'Engine info',
    description: 'Query a running game via its bridge: engine version, FPS, frame count, current scene and node count.',
    schema: { game_id: gameIdParam, response_format: responseFormatParam },
    annotations: { readOnlyHint: true },
    handler: async ({ game_id, response_format }) => {
      const { game, port } = await resolveBridge(game_id);
      const info = await getEngineInfo(port);
      return respond(response_format, { id: game.id, ...info }, () =>
        Object.entries(info).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'),
      );
    },
  });

  register(server, {
    name: 'godot_scene_tree',
    title: 'Live scene tree',
    description: 'Dump the live scene tree of a running game (node names, types and attached scripts).',
    schema: {
      game_id: gameIdParam,
      max_depth: z.number().int().min(1).max(1000).default(100).describe('Maximum tree depth to walk.'),
      response_format: responseFormatParam,
    },
    annotations: { readOnlyHint: true },
    handler: async ({ game_id, max_depth, response_format }) => {
      const { port } = await resolveBridge(game_id);
      const tree = await getSceneTree(port, max_depth);
      return respond(response_format, tree, () => renderTree(tree) || '(empty scene)');
    },
  });

  register(server, {
    name: 'godot_eval',
    title: 'Evaluate expression',
    description:
      'Evaluate a Godot Expression in the running game and return the result as a string. The inputs "tree" (SceneTree), "root" (the window) and "scene" (current scene root) are available, and self refers to the bridge node. Example: "scene.get_node(\\"Player\\").position".',
    schema: {
      game_id: gameIdParam,
      expression: z.string().min(1).describe('A Godot Expression to evaluate.'),
      response_format: responseFormatParam,
    },
    annotations: {},
    handler: async ({ game_id, expression, response_format }) => {
      const { port } = await resolveBridge(game_id);
      const result = await evalExpression(port, expression);
      return respond(response_format, { expression, result }, () => result);
    },
  });

  register(server, {
    name: 'godot_set_node_property',
    title: 'Set node property',
    description: 'Set a property on a node in the running scene by node path (e.g. "Player", "Player/Sprite2D").',
    schema: {
      game_id: gameIdParam,
      node: z.string().min(1).describe('Node path relative to the scene root.'),
      property: z.string().min(1).describe('Property name, e.g. "visible", "position".'),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('New value (string/number/bool).'),
      response_format: responseFormatParam,
    },
    annotations: {},
    handler: async ({ game_id, node, property, value, response_format }) => {
      const { port } = await resolveBridge(game_id);
      const result = await setNodeProperty(port, node, property, value);
      return respond(response_format, { node, property, value, result }, () => `${node}.${property} = ${result}`);
    },
  });

  register(server, {
    name: 'godot_hot_reload',
    title: 'Hot reload',
    description:
      'Reload GDScript files and/or the current scene in the running game without restarting it. Pass script res:// paths to reload, and/or reload_scene=true to reinstantiate the current scene.',
    schema: {
      game_id: gameIdParam,
      scripts: z.array(z.string()).default([]).describe('Script resource paths to reload (res:// or relative).'),
      reload_scene: z.boolean().default(false).describe('Reinstantiate the current scene.'),
      response_format: responseFormatParam,
    },
    annotations: {},
    handler: async ({ game_id, scripts, reload_scene, response_format }) => {
      const { port } = await resolveBridge(game_id);
      const normalized = scripts.map((s) => normalizeResourcePath(s));
      if (normalized.length === 0 && !reload_scene) {
        fail('Nothing to reload: pass scripts and/or reload_scene=true.');
      }
      const reloaded = await reloadInEngine(port, { scripts: normalized, reloadScene: reload_scene });
      return respond(response_format, { reloaded }, () => `Reloaded: ${reloaded.join(', ') || '(nothing)'}`);
    },
  });

  register(server, {
    name: 'godot_engine_command',
    title: 'Raw engine command',
    description:
      'Send a raw JSON command to the godot_mcp bridge (advanced). Supported commands: ping, info, scene_tree, eval, set_property, reload, screenshot, quit. Payload is merged into the request.',
    schema: {
      game_id: gameIdParam,
      command: z.string().min(1).describe('The bridge command name.'),
      payload: z.record(z.any()).default({}).describe('Extra JSON fields merged into the request.'),
    },
    annotations: {},
    handler: async ({ game_id, command, payload }) => {
      const { port } = await resolveBridge(game_id);
      const reply = await sendBridgeCommand(port, { cmd: command, ...payload }, 15_000);
      return json(reply);
    },
  });
}
