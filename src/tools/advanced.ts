/**
 * Integration of the vendored "full control" tool suite (149+ tools) from
 * tugcantopaloglu/godot-mcp (MIT), which itself extends Coding-Solo/godot-mcp.
 * See src/advanced/ and the NOTICE file for attribution.
 *
 * The vendored `GodotServer` class exposes the tools as data
 * (`getToolDefinitions()`) plus a dispatcher (`callTool(name, args)`). Here we
 * bridge that to this server's registration layer: each tool's JSON-Schema
 * input is converted to a Zod shape and registered via `register`, with a
 * handler that delegates to the shared, persistent `GodotServer` singleton.
 *
 * The singleton matters for the runtime `game_*` tools: they hold the launched
 * game process and its TCP connection, which must persist across MCP requests
 * (including the stateless HTTP transport, where a fresh server is built per
 * request but shares this module-level instance).
 */

import { z } from 'zod';
import { GodotServer } from '../advanced/godot-server.js';
import { log } from '../util/log.js';
import { register, type Server, type ToolResult } from './shared.js';

/** Shape of a single tool definition returned by the vendored server. */
interface AdvancedToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  required?: string[];
  default?: unknown;
}

let singleton: GodotServer | null = null;
let detection: Promise<void> | null = null;

/** Lazily construct the shared GodotServer, honouring GODOT_BIN as GODOT_PATH. */
function getGodotServer(): GodotServer {
  if (!singleton) {
    if (process.env.GODOT_BIN && !process.env.GODOT_PATH) {
      process.env.GODOT_PATH = process.env.GODOT_BIN;
    }
    // Seed the Godot path from env so process-launching tools (run_project,
    // launch_editor) have it immediately; the constructor validates it.
    const godotPath = process.env.GODOT_PATH || process.env.GODOT_BIN;
    singleton = new GodotServer(godotPath ? { godotPath } : undefined);
  }
  return singleton;
}

/**
 * Ensure the Godot executable has been resolved once. The embedded server no
 * longer runs the original startup routine that did this, and some handlers
 * (run_project, launch_editor) spawn Godot directly rather than through the
 * lazily-detecting operation runner. detectGodotPath is idempotent.
 */
function ensureGodotDetected(godot: GodotServer): Promise<void> {
  if (!detection) {
    const detect = (godot as unknown as { detectGodotPath?: () => Promise<void> }).detectGodotPath;
    detection = detect ? detect.call(godot).catch(() => undefined) : Promise.resolve();
  }
  return detection;
}

/** Convert a single JSON-Schema property node into a Zod type. */
function propertyToZod(schema: JsonSchema): z.ZodTypeAny {
  let zt: z.ZodTypeAny;

  const stringEnum =
    schema.enum && schema.enum.length > 0 && schema.enum.every((v) => typeof v === 'string')
      ? (schema.enum as string[])
      : null;

  switch (schema.type) {
    case 'string':
      zt = stringEnum ? z.enum(stringEnum as [string, ...string[]]) : z.string();
      break;
    case 'number':
    case 'integer':
      zt = z.number();
      break;
    case 'boolean':
      zt = z.boolean();
      break;
    case 'array':
      zt = z.array(schema.items ? propertyToZod(schema.items) : z.any());
      break;
    case 'object':
      zt = schema.properties ? z.object(shapeFromProperties(schema)) : z.record(z.any());
      break;
    default:
      zt = z.any();
  }

  if (schema.description) zt = zt.describe(schema.description);
  if (schema.default !== undefined) zt = zt.default(schema.default as never);
  return zt;
}

function shapeFromProperties(schema: JsonSchema): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let zt = propertyToZod(prop);
    // Optional unless explicitly required (a default already implies optional).
    if (!required.has(key) && prop.default === undefined) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

/** Convert a tool's top-level inputSchema into a Zod raw shape for registration. */
export function jsonSchemaToShape(inputSchema: JsonSchema | undefined): z.ZodRawShape {
  if (!inputSchema || inputSchema.type !== 'object' || !inputSchema.properties) return {};
  return shapeFromProperties(inputSchema);
}

/**
 * Register every vendored tool on the given server. Returns the number
 * registered. Disabled by setting GODOT_MCP_ADVANCED=0 (the lean, native tool
 * set is then used on its own).
 */
export function registerAdvancedTools(server: Server): number {
  if (process.env.GODOT_MCP_ADVANCED === '0' || process.env.GODOT_MCP_ADVANCED === 'false') {
    return 0;
  }
  const godot = getGodotServer();
  const defs = godot.getToolDefinitions() as AdvancedToolDef[];
  let count = 0;
  for (const def of defs) {
    try {
      register(server, {
        name: def.name,
        title: def.name,
        description: def.description,
        schema: jsonSchemaToShape(def.inputSchema),
        handler: async (args) => {
          await ensureGodotDetected(godot);
          return (await godot.callTool(def.name, args)) as ToolResult;
        },
      });
      count++;
    } catch (err) {
      log.warn(`advanced tool "${def.name}" failed to register: ${(err as Error).message}`);
    }
  }
  return count;
}

/** Best-effort teardown of the running game/connection on server shutdown. */
export async function shutdownAdvanced(): Promise<void> {
  if (singleton && typeof (singleton as unknown as { cleanup?: () => Promise<void> }).cleanup === 'function') {
    try {
      await (singleton as unknown as { cleanup: () => Promise<void> }).cleanup();
    } catch {
      /* ignore */
    }
  }
}
