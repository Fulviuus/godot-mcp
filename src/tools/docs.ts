/**
 * Documentation tools backed by the Godot class reference (generated locally via
 * --doctool, with a GitHub fallback): full-text-ish search and per-class lookup.
 */

import { z } from 'zod';
import { resolveProjectRoot } from '../context.js';
import { log } from '../util/log.js';
import { ensureEditor, isMonoProject, resolveVersionSpec } from '../services/toolchain.js';
import { getClassDoc, searchClasses, type ClassDoc } from '../services/refdoc.js';
import { versionTag } from '../constants.js';
import {
  register,
  respond,
  projectRootParam,
  versionParam,
  responseFormatParam,
  limitParam,
  type Server,
} from './shared.js';

/** Resolve a version + a (possibly downloaded) editor binary for doc generation. */
async function resolveDocEngine(project_root: string | undefined, version: string | undefined) {
  // A project is helpful for version detection but not required for docs.
  let root: string | undefined;
  try {
    root = await resolveProjectRoot(project_root);
  } catch {
    root = undefined;
  }
  const spec = await resolveVersionSpec(version, root);
  let binary: string | undefined;
  try {
    const engine = await ensureEditor(spec, await isMonoProject(root), (m) => log.info(m));
    binary = engine.binary;
  } catch {
    binary = undefined; // search needs it; single-class lookup can use GitHub.
  }
  return { spec, binary };
}

export function registerDocTools(server: Server): void {
  register(server, {
    name: 'godot_api_search',
    title: 'Search API docs',
    description:
      'Search the Godot class reference for the target version: matches class names, brief descriptions, and method/member/signal names. Returns ranked hits.',
    schema: {
      query: z.string().min(1).describe('What to search for, e.g. "CharacterBody2D", "move_and_slide", "tween".'),
      project_root: projectRootParam,
      version: versionParam,
      limit: limitParam,
      response_format: responseFormatParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ query, project_root, version, limit, response_format }) => {
      const { spec, binary } = await resolveDocEngine(project_root, version);
      const hits = await searchClasses(spec, query, binary, limit);
      return respond(response_format, { version: versionTag(spec), query, hits }, () => {
        if (hits.length === 0) return `No matches for "${query}" in Godot ${versionTag(spec)}.`;
        return (
          `Results for "${query}" (Godot ${versionTag(spec)}):\n\n` +
          hits
            .map((h) =>
              h.kind === 'class'
                ? `- ${h.name}${h.inherits ? ` < ${h.inherits}` : ''} — ${h.brief || '(no description)'}`
                : `- ${h.name}.${h.member} (${h.kind})`,
            )
            .join('\n')
        );
      });
    },
  });

  register(server, {
    name: 'godot_api_doc',
    title: 'Get class documentation',
    description:
      'Return the reference documentation for a Godot class: inheritance, description, methods, properties, signals and constants.',
    schema: {
      class_name: z.string().min(1).describe('Exact class name, e.g. "Node2D" (case-sensitive).'),
      project_root: projectRootParam,
      version: versionParam,
      members: z.boolean().default(true).describe('Include methods/properties/signals (off for just the summary).'),
      response_format: responseFormatParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ class_name, project_root, version, members, response_format }) => {
      const { spec, binary } = await resolveDocEngine(project_root, version);
      const doc = await getClassDoc(spec, class_name, binary);
      return respond(response_format, doc, () => renderDoc(doc, members));
    },
  });
}

function renderDoc(doc: ClassDoc, members: boolean): string {
  const lines: string[] = [`# ${doc.name}${doc.inherits ? ` < ${doc.inherits}` : ''}`];
  if (doc.brief) lines.push(`\n${doc.brief}`);
  if (doc.description && doc.description !== doc.brief) lines.push(`\n${doc.description}`);

  if (members) {
    if (doc.members.length) {
      lines.push(`\n## Properties (${doc.members.length})`);
      for (const m of doc.members) {
        lines.push(`- ${m.name}: ${m.type}${m.default ? ` = ${m.default}` : ''}${m.description ? ` — ${firstLine(m.description)}` : ''}`);
      }
    }
    if (doc.methods.length) {
      lines.push(`\n## Methods (${doc.methods.length})`);
      for (const m of doc.methods) {
        const params = m.params.map((p) => `${p.name}: ${p.type}`).join(', ');
        lines.push(`- ${m.returnType} ${m.name}(${params})${m.description ? ` — ${firstLine(m.description)}` : ''}`);
      }
    }
    if (doc.signals.length) {
      lines.push(`\n## Signals (${doc.signals.length})`);
      for (const s of doc.signals) {
        lines.push(`- ${s.name}(${s.params.map((p) => `${p.name}: ${p.type}`).join(', ')})${s.description ? ` — ${firstLine(s.description)}` : ''}`);
      }
    }
    if (doc.constants.length) {
      lines.push(`\n## Constants (${doc.constants.length})`);
      for (const c of doc.constants) lines.push(`- ${c.name} = ${c.value}${c.description ? ` — ${firstLine(c.description)}` : ''}`);
    }
  }
  return lines.join('\n');
}

function firstLine(s: string): string {
  const line = s.split('\n')[0].trim();
  return line.length > 160 ? line.slice(0, 157) + '...' : line;
}
