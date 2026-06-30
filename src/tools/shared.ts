/**
 * Shared infrastructure for tool modules: a thin `register` helper over the MCP
 * SDK that standardises error handling, common Zod parameter shapes, pagination,
 * and helpers for building text/JSON/image responses.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toToolError, renderError } from '../util/errors.js';
import { log } from '../util/log.js';

export type Server = McpServer;

/** Names of every tool registered via `register`, for /health reporting. */
const registeredToolNames = new Set<string>();

/** Number of distinct tools the server exposes. */
export function toolCount(): number {
  return registeredToolNames.size;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  schema: Shape;
  annotations?: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult> | ToolResult;
}

/** Registers a tool, wrapping the handler so thrown errors become tool errors. */
export function register<Shape extends z.ZodRawShape>(server: Server, def: ToolDefinition<Shape>): void {
  registeredToolNames.add(def.name);
  const callback = async (args: unknown): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      const result = await def.handler(args as z.infer<z.ZodObject<Shape>>);
      log.debug(`tool ${def.name} ok (${Date.now() - started}ms)`);
      return result as CallToolResult;
    } catch (err) {
      const toolErr = toToolError(err);
      log.warn(`tool ${def.name} failed: ${toolErr.message.slice(0, 200)}`);
      return { content: [{ type: 'text', text: renderError(toolErr) }], isError: true };
    }
  };

  // The SDK's registerTool overloads infer awkwardly through this generic
  // wrapper; we validate handler shapes via ToolDefinition above and loosen only
  // the SDK call boundary itself.
  type RegisterFn = (
    name: string,
    config: { title: string; description: string; inputSchema: Shape; annotations: ToolAnnotations },
    cb: (args: unknown) => Promise<CallToolResult>,
  ) => void;
  (server.registerTool as unknown as RegisterFn)(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.schema,
      annotations: { title: def.title, ...def.annotations },
    },
    callback,
  );
}

// --- Response builders --------------------------------------------------------

export function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

export function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function image(base64: string, mimeType = 'image/png'): ToolResult {
  return { content: [{ type: 'image', data: base64, mimeType }] };
}

/** Returns JSON when the requested format is "json", otherwise the markdown. */
export function respond(format: ResponseFormat, data: unknown, markdown: () => string): ToolResult {
  return format === 'json' ? json(data) : text(markdown());
}

// --- Common parameters --------------------------------------------------------

export const projectRootParam = z
  .string()
  .optional()
  .describe('Path to the Godot project root (folder containing project.godot). Defaults to $GODOT_PROJECT_ROOT or an upward search from the working directory.');

export const versionParam = z
  .string()
  .optional()
  .describe('Godot version to use, e.g. "4.7", "4.7-stable", "stable"/"latest". Defaults to the project\'s declared version, then the latest stable release.');

export const responseFormatParam = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe('Output format. "markdown" is human-readable; "json" is structured.');
export type ResponseFormat = 'markdown' | 'json';

export const resourcePathParam = z
  .string()
  .describe('A resource path, e.g. "res://main/player.tscn" or "main/player.tscn".');

export const gameIdParam = z
  .string()
  .optional()
  .describe('Handle of a running game (e.g. "game-1"). Optional when exactly one game is running.');

export const limitParam = z.number().int().min(1).max(1000).default(100).describe('Maximum items to return.');
export const offsetParam = z.number().int().min(0).default(0).describe('Number of items to skip (for pagination).');

// --- Pagination ---------------------------------------------------------------

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export function paginate<T>(all: T[], limit: number, offset: number): Page<T> {
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, offset, limit, has_more: offset + items.length < all.length };
}

export function paginationFooter<T>(page: Page<T>): string {
  const end = page.offset + page.items.length;
  let line = `Showing ${page.items.length === 0 ? 0 : page.offset + 1}-${end} of ${page.total}.`;
  if (page.has_more) line += ` Pass offset=${end} for more.`;
  return line;
}
