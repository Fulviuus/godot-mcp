/**
 * Minimal stderr logger. Stdout is reserved for the MCP stdio transport, so all
 * diagnostics must go to stderr to avoid corrupting the protocol stream.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): number {
  const raw = (process.env.GODOT_MCP_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

let threshold = envLevel();

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  let line = `[${stamp}] [${level.toUpperCase()}] ${message}`;
  if (meta !== undefined) {
    try {
      line += ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
    } catch {
      line += ` ${String(meta)}`;
    }
  }
  process.stderr.write(line + '\n');
}

export const log = {
  debug: (m: string, meta?: unknown) => emit('debug', m, meta),
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),
};
