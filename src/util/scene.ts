/**
 * Parser for Godot's text scene/resource format (`.tscn` / `.tres`).
 *
 * The format is a sequence of bracketed headers, each optionally followed by
 * `key = value` property lines:
 *
 *   [gd_scene load_steps=3 format=3 uid="uid://abc"]
 *   [ext_resource type="Script" path="res://player.gd" id="1_x"]
 *   [sub_resource type="RectangleShape2D" id="Rect_y"]
 *   size = Vector2(32, 32)
 *   [node name="Player" type="CharacterBody2D"]
 *   script = ExtResource("1_x")
 *   [node name="Sprite" type="Sprite2D" parent="."]
 *   [connection signal="ready" from="." to="." method="_on_ready"]
 *
 * Values are Godot variant literals, decoded best-effort via ini.decodeValue.
 */

import { decodeValue } from './ini.js';

export interface ExtResource {
  id: string;
  type?: string;
  path?: string;
  uid?: string;
}

export interface SubResource {
  id: string;
  type?: string;
  properties: Record<string, unknown>;
}

export interface SceneNode {
  name: string;
  type?: string;
  /** Parent path relative to root ("." for root's direct children); undefined for root. */
  parent?: string;
  /** Full path from root, e.g. "Sprite/Collision". Root is ".". */
  path: string;
  /** ExtResource id of an instanced scene, when this node is an instance. */
  instance?: string;
  /** Names of resources/scripts referenced by this node's properties. */
  properties: Record<string, unknown>;
}

export interface SceneConnection {
  signal: string;
  from: string;
  to: string;
  method: string;
  flags?: number;
}

export interface ParsedScene {
  kind: 'scene' | 'resource' | 'unknown';
  /** Attributes of the leading [gd_scene]/[gd_resource] header. */
  header: Record<string, unknown>;
  format?: number;
  uid?: string;
  extResources: ExtResource[];
  subResources: SubResource[];
  nodes: SceneNode[];
  connections: SceneConnection[];
  /** For .tres: the [resource] block's properties. */
  resource?: Record<string, unknown>;
}

interface RawBlock {
  tag: string;
  attrs: Record<string, unknown>;
  props: Record<string, unknown>;
}

const HEADER_RE = /^\[([a-zA-Z_]+)(\s+.*?)?\]\s*$/;

/** Splits header attributes on top-level whitespace, respecting quotes/parens. */
function parseAttributes(text: string): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const trimmed = text.trim();
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
    if (i >= trimmed.length) break;
    const eq = trimmed.indexOf('=', i);
    if (eq === -1) break;
    const key = trimmed.slice(i, eq).trim();
    let j = eq + 1;
    let depth = 0;
    let inString = false;
    while (j < trimmed.length) {
      const ch = trimmed[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
      } else if (/\s/.test(ch) && depth === 0) {
        break;
      }
      j++;
    }
    attrs[key] = decodeValue(trimmed.slice(eq + 1, j));
    i = j;
  }
  return attrs;
}

function tokenizeBlocks(text: string): RawBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;
  let pendingKey: string | null = null;
  let pendingValue = '';

  const flushProp = () => {
    if (current && pendingKey !== null) {
      current.props[pendingKey] = decodeValue(pendingValue.trim());
    }
    pendingKey = null;
    pendingValue = '';
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const headerMatch = HEADER_RE.exec(line.trim());
    if (headerMatch) {
      flushProp();
      current = { tag: headerMatch[1], attrs: parseAttributes(headerMatch[2] ?? ''), props: {} };
      blocks.push(current);
      continue;
    }
    if (current === null) continue;

    // While the current value has unbalanced brackets/quotes, keep absorbing
    // lines (multi-line arrays/dictionaries) rather than starting a new property.
    if (pendingKey !== null && !isBalanced(pendingValue)) {
      pendingValue += '\n' + line;
      continue;
    }

    const eq = line.indexOf('=');
    const looksLikeAssignment = eq > 0 && /^[A-Za-z_][\w/.:]*\s*=/.test(line);
    if (looksLikeAssignment) {
      flushProp(); // commit the previous (now complete) property first
      pendingKey = line.slice(0, eq).trim();
      pendingValue = line.slice(eq + 1);
    } else if (pendingKey !== null) {
      // Continuation line that doesn't itself look like a new assignment.
      pendingValue += '\n' + line;
    }
  }
  flushProp();
  return blocks;
}

/** True when all (), [], {} and double quotes in `s` are balanced/closed. */
function isBalanced(s: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    }
  }
  return depth <= 0 && !inString;
}

export function parseScene(text: string): ParsedScene {
  const blocks = tokenizeBlocks(text);
  const result: ParsedScene = {
    kind: 'unknown',
    header: {},
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
  };

  for (const block of blocks) {
    switch (block.tag) {
      case 'gd_scene':
        result.kind = 'scene';
        result.header = block.attrs;
        result.format = numAttr(block.attrs.format);
        result.uid = strAttr(block.attrs.uid);
        break;
      case 'gd_resource':
        result.kind = 'resource';
        result.header = block.attrs;
        result.format = numAttr(block.attrs.format);
        result.uid = strAttr(block.attrs.uid);
        break;
      case 'ext_resource':
        result.extResources.push({
          id: strAttr(block.attrs.id) ?? '',
          type: strAttr(block.attrs.type),
          path: strAttr(block.attrs.path),
          uid: strAttr(block.attrs.uid),
        });
        break;
      case 'sub_resource':
        result.subResources.push({
          id: strAttr(block.attrs.id) ?? '',
          type: strAttr(block.attrs.type),
          properties: block.props,
        });
        break;
      case 'node': {
        const name = strAttr(block.attrs.name) ?? '';
        const parent = strAttr(block.attrs.parent);
        const path = parent === undefined ? '.' : parent === '.' ? name : `${parent}/${name}`;
        result.nodes.push({
          name,
          type: strAttr(block.attrs.type),
          parent,
          path,
          instance: extractResourceId(block.attrs.instance),
          properties: block.props,
        });
        break;
      }
      case 'connection':
        result.connections.push({
          signal: strAttr(block.attrs.signal) ?? '',
          from: strAttr(block.attrs.from) ?? '',
          to: strAttr(block.attrs.to) ?? '',
          method: strAttr(block.attrs.method) ?? '',
          flags: numAttr(block.attrs.flags),
        });
        break;
      case 'resource':
        result.resource = block.props;
        break;
      default:
        break;
    }
  }
  return result;
}

function strAttr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function numAttr(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Pulls the id out of `ExtResource("1_x")` / `SubResource("y")`. */
function extractResourceId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = /^(?:Ext|Sub)Resource\s*\(\s*"?([^")]+)"?\s*\)$/.exec(raw.trim());
  return m ? m[1] : undefined;
}

/** Returns res:// paths referenced anywhere in a scene (ext resources + props). */
export function collectReferencedPaths(scene: ParsedScene): string[] {
  const paths = new Set<string>();
  for (const ext of scene.extResources) {
    if (ext.path) paths.add(ext.path);
  }
  const scan = (props: Record<string, unknown>) => {
    for (const value of Object.values(props)) {
      if (typeof value === 'string') {
        const m = /res:\/\/[^"\s)]+/g;
        for (const found of value.matchAll(m)) paths.add(found[0]);
      }
    }
  };
  for (const node of scene.nodes) scan(node.properties);
  for (const sub of scene.subResources) scan(sub.properties);
  if (scene.resource) scan(scene.resource);
  return [...paths];
}
