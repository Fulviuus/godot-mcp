/**
 * Process-wide mutable state shared between the run/engine tools and the
 * services that drive them: the registry of launched games and their captured
 * logs. Kept deliberately small and dependency-free so any module can import it
 * without creating cycles.
 */

import type { ChildProcess } from 'node:child_process';

export interface LogLine {
  ts: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

/** Bounded FIFO buffer of captured output lines. */
export class LogBuffer {
  private readonly lines: LogLine[] = [];
  constructor(private readonly capacity = 5000) {}

  push(stream: 'stdout' | 'stderr', text: string): void {
    for (const piece of text.split(/\r?\n/)) {
      if (piece.length === 0) continue;
      this.lines.push({ ts: Date.now(), stream, text: piece });
    }
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
  }

  /** Returns the most recent `count` lines, optionally filtered by stream. */
  tail(count: number, stream?: 'stdout' | 'stderr'): LogLine[] {
    const filtered = stream ? this.lines.filter((l) => l.stream === stream) : this.lines;
    return filtered.slice(Math.max(0, filtered.length - count));
  }

  get size(): number {
    return this.lines.length;
  }
}

export interface GameProcess {
  /** Short stable handle returned to the agent (e.g. "game-1"). */
  id: string;
  child: ChildProcess;
  pid: number;
  projectRoot: string;
  scene?: string;
  args: string[];
  startedAt: number;
  /** TCP port passed to `--remote-debug`, when remote control is enabled. */
  remoteDebugPort?: number;
  /** TCP port of the godot_mcp bridge autoload, when live control is enabled. */
  bridgePort?: number;
  logs: LogBuffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt?: number;
}

class RuntimeState {
  private readonly games = new Map<string, GameProcess>();
  private counter = 0;

  nextId(prefix = 'game'): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  register(game: GameProcess): void {
    this.games.set(game.id, game);
  }

  get(id: string): GameProcess | undefined {
    return this.games.get(id);
  }

  /** Returns the single running game when `id` is omitted and exactly one runs. */
  resolve(id?: string): GameProcess | undefined {
    if (id) return this.games.get(id);
    const running = this.list().filter((g) => g.exitCode === null && g.signal === null);
    if (running.length === 1) return running[0];
    return undefined;
  }

  list(): GameProcess[] {
    return [...this.games.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  remove(id: string): void {
    this.games.delete(id);
  }

  /** Kill every tracked process. Called on shutdown. */
  async killAll(): Promise<void> {
    for (const game of this.games.values()) {
      if (game.exitCode === null && game.signal === null) {
        try {
          game.child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export const runtime = new RuntimeState();
