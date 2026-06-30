/**
 * Resource tools: enumerate, parse (scenes/resources/scripts), create from
 * templates, and find references across the project.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  absoluteToResource,
  normalizeResourcePath,
  resolveProjectRoot,
  resourceToAbsolute,
} from '../context.js';
import { fail } from '../util/errors.js';
import { exists, walkFiles } from '../util/fswalk.js';
import { parseScene, collectReferencedPaths, type ParsedScene, type SceneNode } from '../util/scene.js';
import { parseGdScript, type ScriptOutline } from '../util/gdscript.js';
import { parseCSharp } from '../util/csharp.js';
import { templateFor, type ResourceKind } from '../services/templates.js';
import {
  register,
  respond,
  text,
  projectRootParam,
  responseFormatParam,
  resourcePathParam,
  limitParam,
  offsetParam,
  paginate,
  paginationFooter,
  type Server,
} from './shared.js';

const SCENE_EXTS = new Set(['.tscn', '.scn', '.tres', '.res']);

export function registerResourceTools(server: Server): void {
  register(server, {
    name: 'godot_list_resources',
    title: 'List resources',
    description:
      'List project resources as res:// paths, optionally filtered by extension (e.g. ".tscn", ".gd"). Skips .godot/ and .gdignore-marked folders.',
    schema: {
      project_root: projectRootParam,
      extension: z
        .string()
        .optional()
        .describe('Filter to a single extension, with or without the leading dot (e.g. "tscn").'),
      response_format: responseFormatParam,
      limit: limitParam,
      offset: offsetParam,
    },
    annotations: { readOnlyHint: true },
    handler: async ({ project_root, extension, response_format, limit, offset }) => {
      const root = await resolveProjectRoot(project_root);
      const exts = extension ? [extension.startsWith('.') ? extension : `.${extension}`] : undefined;
      const files = await walkFiles(root, { extensions: exts, limit: 50000 });
      const resources = files.map((f) => absoluteToResource(root, f)).sort();
      const page = paginate(resources, limit, offset);
      return respond(response_format, page, () =>
        (page.items.join('\n') || '(no resources)') + '\n\n' + paginationFooter(page),
      );
    },
  });

  register(server, {
    name: 'godot_parse_resource',
    title: 'Parse resource',
    description:
      'Parse a resource into structured JSON-ish output. Scenes (.tscn) and resources (.tres) yield their node tree, ext/sub resources and connections; scripts (.gd/.cs) yield an outline of classes, functions, signals, exports and variables.',
    schema: {
      project_root: projectRootParam,
      resource: resourcePathParam,
      response_format: responseFormatParam,
    },
    annotations: { readOnlyHint: true },
    handler: async ({ project_root, resource, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const abs = resourceToAbsolute(root, resource);
      if (!(await exists(abs))) fail(`Resource not found: ${normalizeResourcePath(resource)}`, { code: 'enoent' });
      const ext = path.extname(abs).toLowerCase();
      const content = await fs.readFile(abs, 'utf8');

      if (SCENE_EXTS.has(ext)) {
        const scene = parseScene(content);
        return respond(response_format, scene, () => renderScene(normalizeResourcePath(resource), scene));
      }
      if (ext === '.gd') {
        const outline = parseGdScript(content);
        return respond(response_format, outline, () => renderOutline(normalizeResourcePath(resource), outline));
      }
      if (ext === '.cs') {
        const outline = parseCSharp(content);
        return respond(response_format, outline, () => renderOutline(normalizeResourcePath(resource), outline));
      }
      fail(`Unsupported resource type "${ext}". Parse supports .tscn/.scn/.tres/.res/.gd/.cs.`, {
        code: 'unsupported',
      });
    },
  });

  register(server, {
    name: 'godot_create_resource',
    title: 'Create resource',
    description:
      'Create a new resource from a template: a GDScript (gdscript) or C# (csharp) script, a scene (scene) or a generic resource (resource). Fails if the target exists unless overwrite=true.',
    schema: {
      project_root: projectRootParam,
      resource: resourcePathParam,
      kind: z.enum(['gdscript', 'csharp', 'scene', 'resource']).describe('What to create.'),
      base: z.string().optional().describe('For scripts: the class to extend (e.g. "Node2D"). For scenes: ignored.'),
      class_name: z.string().optional().describe('For scripts: an optional class_name to declare.'),
      root_type: z.string().optional().describe('For scenes: the root node type (default "Node2D").'),
      root_name: z.string().optional().describe('For scenes: the root node name.'),
      overwrite: z.boolean().default(false).describe('Overwrite an existing file.'),
    },
    annotations: {},
    handler: async ({ project_root, resource, kind, base, class_name, root_type, root_name, overwrite }) => {
      const root = await resolveProjectRoot(project_root);
      const abs = resourceToAbsolute(root, resource);
      const expectedExt = { gdscript: '.gd', csharp: '.cs', scene: '.tscn', resource: '.tres' }[kind as ResourceKind];
      if (path.extname(abs).toLowerCase() !== expectedExt) {
        fail(`A "${kind}" resource must end in ${expectedExt}; got "${normalizeResourcePath(resource)}".`);
      }
      if ((await exists(abs)) && !overwrite) {
        fail(`Resource already exists: ${normalizeResourcePath(resource)} (pass overwrite=true to replace).`, {
          code: 'exists',
        });
      }
      const body = templateFor(kind as ResourceKind, {
        base,
        className: class_name ?? (kind === 'csharp' ? path.basename(abs, '.cs') : undefined),
        rootType: root_type,
        rootName: root_name,
      });
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body);
      return text(`Created ${normalizeResourcePath(resource)} (${kind}).\n\n${body}`);
    },
  });

  register(server, {
    name: 'godot_find_references',
    title: 'Find references',
    description:
      'Find resources that reference a given resource, by scanning scenes, resources and scripts for its res:// path, filename, UID, or preload/load usage.',
    schema: {
      project_root: projectRootParam,
      resource: resourcePathParam,
      response_format: responseFormatParam,
      limit: limitParam,
      offset: offsetParam,
    },
    annotations: { readOnlyHint: true },
    handler: async ({ project_root, resource, response_format, limit, offset }) => {
      const root = await resolveProjectRoot(project_root);
      const target = normalizeResourcePath(resource);
      const targetAbs = resourceToAbsolute(root, target);
      const baseName = path.basename(targetAbs);

      // Resolve the target's UID (if it declares one) to catch uid:// references.
      let uid: string | undefined;
      if (await exists(targetAbs)) {
        const head = (await fs.readFile(targetAbs, 'utf8')).slice(0, 2000);
        uid = /uid="(uid:\/\/[^"]+)"/.exec(head)?.[1];
      }

      const candidates = await walkFiles(root, {
        extensions: ['.tscn', '.scn', '.tres', '.res', '.gd', '.cs', '.godot', '.cfg'],
        limit: 50000,
      });
      const matches: { resource: string; lines: { line: number; text: string }[] }[] = [];
      for (const file of candidates) {
        if (path.resolve(file) === path.resolve(targetAbs)) continue;
        const content = await fs.readFile(file, 'utf8').catch(() => '');
        if (!content) continue;
        const hitLines: { line: number; text: string }[] = [];
        content.split(/\r?\n/).forEach((lineText, i) => {
          if (
            lineText.includes(target) ||
            (uid && lineText.includes(uid)) ||
            new RegExp(`(preload|load)\\(\\s*["'][^"']*${escapeRe(baseName)}["']`).test(lineText)
          ) {
            hitLines.push({ line: i + 1, text: lineText.trim().slice(0, 200) });
          }
        });
        if (hitLines.length) matches.push({ resource: absoluteToResource(root, file), lines: hitLines });
      }

      const page = paginate(matches, limit, offset);
      return respond(response_format, { target, uid, ...page }, () => {
        if (matches.length === 0) return `No references to ${target} found.`;
        const blocks = page.items.map(
          (m) => `## ${m.resource}\n` + m.lines.map((l) => `  ${l.line}: ${l.text}`).join('\n'),
        );
        return `References to ${target}:\n\n` + blocks.join('\n\n') + '\n\n' + paginationFooter(page);
      });
    },
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderScene(resPath: string, scene: ParsedScene): string {
  const lines: string[] = [`# ${resPath}`, `Kind: ${scene.kind}` + (scene.format ? ` (format ${scene.format})` : '')];
  if (scene.uid) lines.push(`UID: ${scene.uid}`);

  if (scene.extResources.length) {
    lines.push(`\n## External resources (${scene.extResources.length})`);
    for (const ext of scene.extResources) {
      lines.push(`- [${ext.id}] ${ext.type ?? '?'} ${ext.path ?? ext.uid ?? ''}`);
    }
  }
  if (scene.subResources.length) {
    lines.push(`\n## Sub-resources (${scene.subResources.length})`);
    for (const sub of scene.subResources) lines.push(`- [${sub.id}] ${sub.type ?? '?'}`);
  }

  if (scene.kind === 'scene') {
    lines.push(`\n## Node tree (${scene.nodes.length} nodes)`);
    lines.push(renderNodeTree(scene.nodes));
    if (scene.connections.length) {
      lines.push(`\n## Signal connections (${scene.connections.length})`);
      for (const c of scene.connections) {
        lines.push(`- ${c.from}.${c.signal} → ${c.to}.${c.method}()`);
      }
    }
  } else if (scene.resource) {
    lines.push('\n## Resource properties');
    for (const [k, v] of Object.entries(scene.resource)) lines.push(`- ${k} = ${formatValue(v)}`);
  }
  return lines.join('\n');
}

function renderNodeTree(nodes: SceneNode[]): string {
  // Order is the file order, which is already parent-before-child in Godot.
  const out: string[] = [];
  for (const node of nodes) {
    const depth = node.path === '.' ? 0 : node.path.split('/').length;
    const indent = '  '.repeat(depth);
    const scriptRef = node.properties.script ? ' [script]' : '';
    const inst = node.instance ? ` (instance ${node.instance})` : '';
    out.push(`${indent}- ${node.name} : ${node.type ?? 'inherited'}${scriptRef}${inst}`);
  }
  return out.join('\n');
}

function renderOutline(resPath: string, outline: ScriptOutline): string {
  const lines: string[] = [`# ${resPath}`, `Language: ${outline.language}`];
  if (outline.className) lines.push(`class_name ${outline.className}`);
  if (outline.extends) lines.push(`extends ${outline.extends}`);
  if (outline.isTool) lines.push('@tool');

  const section = (title: string, items: string[]) => {
    if (items.length) lines.push(`\n## ${title} (${items.length})`, ...items);
  };

  section('Signals', outline.signals.map((s) => `- ${s.name}(${s.params.map(fmtParam).join(', ')})  :${s.line}`));
  section('Constants', outline.constants.map((c) => `- ${c.name}${c.value ? ` = ${c.value}` : ''}  :${c.line}`));
  section('Enums', outline.enums.map((e) => `- ${e.name}  :${e.line}`));
  section(
    'Exported variables',
    outline.variables.filter((v) => v.exported).map((v) => `- ${fmtVar(v)}  :${v.line}`),
  );
  section(
    'Variables',
    outline.variables.filter((v) => !v.exported).map((v) => `- ${fmtVar(v)}  :${v.line}`),
  );
  section(
    'Functions',
    outline.functions.map(
      (f) =>
        `- ${f.isStatic ? 'static ' : ''}${f.name}(${f.params.map(fmtParam).join(', ')})${f.returnType ? ` -> ${f.returnType}` : ''}` +
        `${f.annotations.length ? ` ${f.annotations.join(' ')}` : ''}  :${f.line}`,
    ),
  );
  section('Inner classes', outline.innerClasses.map((c) => `- ${c.name}${c.extends ? ` extends ${c.extends}` : ''}  :${c.line}`));

  return lines.join('\n');
}

function fmtParam(p: { name: string; type?: string; default?: string }): string {
  let s = p.name;
  if (p.type) s += `: ${p.type}`;
  if (p.default) s += ` = ${p.default}`;
  return s;
}
function fmtVar(v: { name: string; type?: string; default?: string }): string {
  let s = v.name;
  if (v.type) s += `: ${v.type}`;
  if (v.default) s += ` = ${v.default}`;
  return s;
}
function formatValue(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

// Re-export for the engine tool, which renders a live scene tree similarly.
export { collectReferencedPaths };
