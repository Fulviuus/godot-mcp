/**
 * Spawning and supervising Godot processes: one-shot commands (build, export,
 * import, doctool) whose output we capture and return, and long-running game
 * launches that we register in the runtime state and stream logs from.
 */

import { spawn } from 'node:child_process';
import { runtime, LogBuffer, type GameProcess } from '../state.js';
import { log } from '../util/log.js';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  command: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many ms. 0 / undefined disables the timeout. */
  timeoutMs?: number;
  /** Cap captured output to this many bytes per stream. */
  maxBuffer?: number;
  /** Data fed to the process stdin, then closed. */
  input?: string;
}

/**
 * Run a Godot command to completion, capturing stdout/stderr. Used for builds,
 * exports, imports and doctool — anything that should finish and report back.
 */
export function runGodot(binary: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cwd, env, timeoutMs = 0, maxBuffer = 8 * 1024 * 1024, input } = options;
  const started = Date.now();
  const command = [binary, ...args].join(' ');
  log.debug(`run: ${command}`);

  return new Promise<RunResult>((resolve) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const append = (target: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (target === 'out') {
        if (stdout.length < maxBuffer) stdout += text;
      } else if (stderr.length < maxBuffer) {
        stderr += text;
      }
    };

    child.stdout?.on('data', (c) => append('out', c));
    child.stderr?.on('data', (c) => append('err', c));

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    if (input !== undefined) {
      child.stdin?.write(input);
    }
    child.stdin?.end();

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        timedOut,
        durationMs: Date.now() - started,
        command,
      });
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        command,
      });
    });
  });
}

export interface LaunchOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  scene?: string;
  remoteDebugPort?: number;
  bridgePort?: number;
  idPrefix?: string;
}

/**
 * Launch a game as a long-running process, register it in the runtime state and
 * tee its output into a bounded log buffer. Returns the registered handle.
 */
export function launchGame(binary: string, args: string[], options: LaunchOptions = {}): GameProcess {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const game: GameProcess = {
    id: runtime.nextId(options.idPrefix),
    child,
    pid: child.pid ?? -1,
    projectRoot: options.cwd ?? process.cwd(),
    scene: options.scene,
    args,
    startedAt: Date.now(),
    remoteDebugPort: options.remoteDebugPort,
    bridgePort: options.bridgePort,
    logs: new LogBuffer(),
    exitCode: null,
    signal: null,
  };

  child.stdout?.on('data', (c: Buffer) => game.logs.push('stdout', c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => game.logs.push('stderr', c.toString('utf8')));

  child.on('exit', (code, signal) => {
    game.exitCode = code;
    game.signal = signal;
    game.exitedAt = Date.now();
    log.info(`game ${game.id} exited (code=${code} signal=${signal})`);
  });
  child.on('error', (err) => {
    game.logs.push('stderr', `[spawn error] ${err.message}`);
    game.exitCode = -1;
    game.exitedAt = Date.now();
  });

  runtime.register(game);
  log.info(`launched game ${game.id} pid=${game.pid}`);
  return game;
}

/** Terminate a running game, escalating to SIGKILL after a grace period. */
export async function stopGame(game: GameProcess, graceMs = 3000): Promise<void> {
  if (game.exitCode !== null || game.signal !== null) return;
  game.child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        game.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, graceMs);
    game.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
