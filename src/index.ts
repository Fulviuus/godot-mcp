#!/usr/bin/env node
/**
 * godot-mcp-server entry point.
 *
 * Builds an MCP server exposing the Godot tool surface and serves it over stdio
 * (default) or HTTP. Handles argument parsing, graceful shutdown, and — when
 * launched as a child of a supervising process — exiting when the parent dies.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { runtime } from './state.js';
import { log, setLogLevel } from './util/log.js';
import { startHttpServer } from './http.js';
import { registerProjectTools } from './tools/project.js';
import { registerResourceTools } from './tools/resources.js';
import { registerBuildTools } from './tools/build.js';
import { registerRunTools } from './tools/run.js';
import { registerEngineTools } from './tools/engine.js';
import { registerEditorTools } from './tools/editor.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerDocTools } from './tools/docs.js';
import { registerAdvancedTools, shutdownAdvanced } from './tools/advanced.js';

/** Construct a fully-registered server instance. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for working with Godot projects: inspect project.godot, parse scenes/scripts, set up the engine toolchain, export bundles, run games with live control (eval, scene tree, hot reload, screenshots) and search the class reference.',
    },
  );

  registerProjectTools(server);
  registerResourceTools(server);
  registerBuildTools(server);
  registerRunTools(server);
  registerEngineTools(server);
  registerEditorTools(server);
  registerScreenshotTools(server);
  registerDocTools(server);
  // Vendored "full control" suite (149+ game_*/scene/editor tools). Set
  // GODOT_MCP_ADVANCED=0 to register only the native tools above.
  const advancedCount = registerAdvancedTools(server);
  log.debug(`registered ${advancedCount} advanced tools`);
  return server;
}

interface CliOptions {
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  exitWithParent: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    transport: 'stdio',
    host: process.env.GODOT_MCP_HOST ?? '127.0.0.1',
    port: Number(process.env.GODOT_MCP_PORT ?? 7878),
    exitWithParent: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--transport': {
        const value = next();
        if (value !== 'stdio' && value !== 'http') {
          fatal(`Invalid --transport "${value}". Use "stdio" or "http".`);
        }
        options.transport = value;
        break;
      }
      case '--host':
        options.host = next();
        break;
      case '--port': {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0 || value > 65535) fatal(`Invalid --port.`);
        options.port = value;
        break;
      }
      case '--exit-with-parent':
        options.exitWithParent = true;
        break;
      case '--version':
        process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
        process.exit(0);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        fatal(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      `${SERVER_NAME} ${SERVER_VERSION}`,
      '',
      'Usage: godot-mcp-server [options]',
      '',
      'Options:',
      '  --transport <stdio|http>  Transport to serve on (default: stdio)',
      '  --host <host>             HTTP bind host (default: 127.0.0.1)',
      '  --port <port>             HTTP bind port (default: 7878)',
      '  --exit-with-parent        Exit when the controlling stdin/parent closes',
      '  --version                 Print version and exit',
      '  -h, --help                Show this help',
      '',
      'Environment:',
      '  GODOT_PROJECT_ROOT        Default project root',
      '  GODOT_BIN                 Path to a pre-installed Godot editor binary',
      '  GODOT_MCP_CACHE_DIR       Cache dir for downloaded engines/templates/docs',
      '  GODOT_MCP_MONO            Set to 1 to use the .NET/Mono build',
      '  GODOT_MCP_LOG_LEVEL       debug|info|warn|error (default: info)',
      '',
    ].join('\n'),
  );
}

function fatal(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  if (process.env.GODOT_MCP_LOG_LEVEL) {
    setLogLevel(process.env.GODOT_MCP_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error');
  }
  const options = parseArgs(process.argv.slice(2));

  let shuttingDown = false;
  let httpServer: import('node:http').Server | undefined;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${reason})`);
    // Hard-exit backstop: never linger holding the port if a close() stalls on
    // keep-alive connections. Guarantees SIGTERM/parent-death frees the port.
    setTimeout(() => process.exit(0), 1500).unref();
    try {
      await runtime.killAll();
      await shutdownAdvanced();
      if (httpServer) {
        // Force lingering keep-alive sockets closed so close() can complete.
        httpServer.closeAllConnections?.();
        await new Promise<void>((r) => httpServer!.close(() => r()));
      }
    } catch {
      /* best effort — the hard-exit timer will finish the job */
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception: ${err.stack ?? err.message}`);
  });

  if (options.transport === 'http') {
    httpServer = await startHttpServer({
      host: options.host,
      port: options.port,
      createServer,
    });
    if (options.exitWithParent) watchParent(shutdown);
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
    // When our controlling stream closes, the parent is gone — exit cleanly.
    process.stdin.on('end', () => void shutdown('stdin closed'));
    process.stdin.on('close', () => void shutdown('stdin closed'));
  }
}

/** Poll for the parent process disappearing (HTTP mode supervised launch). */
function watchParent(shutdown: (reason: string) => void): void {
  const ppid = process.ppid;
  setInterval(() => {
    try {
      process.kill(ppid, 0);
    } catch {
      shutdown('parent exited');
    }
  }, 2000).unref();
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
