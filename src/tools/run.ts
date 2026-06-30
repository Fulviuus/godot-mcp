/**
 * Runtime tools: launch a game, stop it, stream its logs, and list running
 * games. Live control (the godot_mcp bridge) is opt-in via `live=true`.
 */

import net from 'node:net';
import { z } from 'zod';
import { resolveProjectRoot, normalizeResourcePath, resourceToAbsolute } from '../context.js';
import { fail } from '../util/errors.js';
import { exists } from '../util/fswalk.js';
import { log } from '../util/log.js';
import { launchGame, stopGame } from '../services/processes.js';
import { isMonoProject, resolveVersionSpec, ensureEditor } from '../services/toolchain.js';
import { pingBridge, quitViaBridge } from '../services/engine.js';
import { runtime, type GameProcess } from '../state.js';
import { installBridge, isBridgeInstalled } from './build.js';
import {
  register,
  respond,
  text,
  json,
  projectRootParam,
  versionParam,
  responseFormatParam,
  gameIdParam,
  type Server,
} from './shared.js';

/** Ask the OS for a free localhost TCP port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function gameSummary(game: GameProcess) {
  const running = game.exitCode === null && game.signal === null;
  return {
    id: game.id,
    pid: game.pid,
    running,
    scene: game.scene ?? null,
    bridge_port: game.bridgePort ?? null,
    started_at: new Date(game.startedAt).toISOString(),
    exited_at: game.exitedAt ? new Date(game.exitedAt).toISOString() : null,
    exit_code: game.exitCode,
    signal: game.signal,
    log_lines: game.logs.size,
  };
}

export function registerRunTools(server: Server): void {
  register(server, {
    name: 'godot_run',
    title: 'Run game',
    description:
      'Launch the project (or a specific scene) as a child process and return a handle. With live=true the godot_mcp bridge is enabled (auto-installed if needed) so you can inspect the scene tree, eval expressions, hot reload and screenshot the running game.',
    schema: {
      project_root: projectRootParam,
      version: versionParam,
      scene: z.string().optional().describe('A specific scene to run (res:// path). Defaults to the project main scene.'),
      live: z.boolean().default(true).describe('Enable the godot_mcp bridge for live control.'),
      headless: z.boolean().default(false).describe('Run with the headless/dummy renderer (no window; screenshots unavailable).'),
      resolution: z.string().optional().describe('Window size as WxH, e.g. "1280x720".'),
      position: z.string().optional().describe('Window position as X,Y.'),
      extra_args: z.array(z.string()).default([]).describe('Additional engine arguments.'),
      response_format: responseFormatParam,
    },
    annotations: { openWorldHint: true },
    handler: async ({ project_root, version, scene, live, headless, resolution, position, extra_args, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const spec = await resolveVersionSpec(version, root);
      const mono = await isMonoProject(root);
      const engine = await ensureEditor(spec, mono, (m) => log.info(m));

      const args = ['--path', root];
      if (headless) args.push('--headless');
      if (resolution) args.push('--resolution', resolution);
      if (position) args.push('--position', position);
      args.push(...extra_args);

      if (scene) {
        const resScene = normalizeResourcePath(scene);
        const absScene = resourceToAbsolute(root, resScene);
        if (!(await exists(absScene))) fail(`Scene not found: ${resScene}`, { code: 'enoent' });
        args.push(resScene);
      }

      let bridgePort: number | undefined;
      const env: NodeJS.ProcessEnv = {};
      if (live) {
        if (!(await isBridgeInstalled(root))) {
          await installBridge(root);
          log.info('auto-installed godot_mcp bridge for live run');
        }
        bridgePort = await getFreePort();
        env.GODOT_MCP_BRIDGE_PORT = String(bridgePort);
      }

      const game = launchGame(engine.binary, args, { cwd: root, env, scene: scene ?? undefined, bridgePort });

      // Give the engine a moment to start and surface immediate crashes.
      await new Promise((r) => setTimeout(r, 700));
      if (game.exitCode !== null) {
        const tail = game.logs.tail(30).map((l) => l.text).join('\n');
        fail(`Game ${game.id} exited immediately (code ${game.exitCode}).\n${tail}`, { code: 'launch_failed' });
      }

      let bridgeReady = false;
      if (bridgePort) {
        for (let i = 0; i < 10 && !bridgeReady; i++) {
          bridgeReady = await pingBridge(bridgePort, 500);
          if (!bridgeReady) await new Promise((r) => setTimeout(r, 400));
        }
      }

      const data = { ...gameSummary(game), bridge_ready: bridgeReady, editor: engine.binary };
      return respond(response_format, data, () =>
        [
          `Launched ${game.id} (pid ${game.pid}).`,
          scene ? `Scene: ${normalizeResourcePath(scene)}` : 'Running main scene.',
          live ? `Live bridge: ${bridgeReady ? `ready on port ${bridgePort}` : `starting on port ${bridgePort}`}` : 'Live bridge: disabled',
          'Use godot_game_logs to read output, godot_stop to terminate.',
        ].join('\n'),
      );
    },
  });

  register(server, {
    name: 'godot_stop',
    title: 'Stop game',
    description: 'Terminate a running game by handle (or the only running game). Attempts a clean bridge quit before SIGTERM/SIGKILL.',
    schema: { game_id: gameIdParam, response_format: responseFormatParam },
    annotations: { idempotentHint: true },
    handler: async ({ game_id, response_format }) => {
      const game = runtime.resolve(game_id);
      if (!game) {
        fail(game_id ? `No game with id "${game_id}".` : 'No single running game to stop; pass game_id.', {
          code: 'no_game',
        });
      }
      if (game!.exitCode !== null) {
        return text(`Game ${game!.id} already exited (code ${game!.exitCode}).`);
      }
      if (game!.bridgePort) await quitViaBridge(game!.bridgePort);
      await stopGame(game!);
      const data = gameSummary(game!);
      return respond(response_format, data, () => `Stopped ${game!.id} (exit ${game!.exitCode ?? 'signal ' + game!.signal}).`);
    },
  });

  register(server, {
    name: 'godot_game_logs',
    title: 'Game logs',
    description: 'Return recent stdout/stderr from a running or finished game.',
    schema: {
      game_id: gameIdParam,
      lines: z.number().int().min(1).max(2000).default(100).describe('How many trailing lines to return.'),
      stream: z.enum(['all', 'stdout', 'stderr']).default('all').describe('Which stream to include.'),
      response_format: responseFormatParam,
    },
    annotations: { readOnlyHint: true },
    handler: async ({ game_id, lines, stream, response_format }) => {
      const game = runtime.resolve(game_id) ?? (game_id ? runtime.get(game_id) : undefined);
      if (!game) fail(game_id ? `No game with id "${game_id}".` : 'No game to read; pass game_id.', { code: 'no_game' });
      const tail = game!.logs.tail(lines, stream === 'all' ? undefined : stream);
      if (response_format === 'json') {
        return json({ id: game!.id, lines: tail });
      }
      const body = tail.map((l) => `${l.stream === 'stderr' ? '[err] ' : ''}${l.text}`).join('\n');
      return text(body || '(no output captured)');
    },
  });

  register(server, {
    name: 'godot_list_games',
    title: 'List games',
    description: 'List all launched games this session, running and exited, with their handles and status.',
    schema: { response_format: responseFormatParam },
    annotations: { readOnlyHint: true },
    handler: async ({ response_format }) => {
      const games = runtime.list().map(gameSummary);
      return respond(response_format, { games }, () =>
        games.length === 0
          ? 'No games launched this session.'
          : games.map((g) => `- ${g.id}: ${g.running ? 'running' : `exited (${g.exit_code})`} pid=${g.pid}${g.scene ? ` scene=${g.scene}` : ''}`).join('\n'),
      );
    },
  });
}
