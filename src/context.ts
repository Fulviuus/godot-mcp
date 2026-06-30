/**
 * Project root resolution and `res://` <-> filesystem path conversion. Every
 * tool that touches a project funnels through `resolveProjectRoot` so that the
 * project can be supplied per-call, via env, or discovered from the cwd.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV, PROJECT_MARKER, RES_PREFIX } from './constants.js';
import { ToolError } from './util/errors.js';
import { exists } from './util/fswalk.js';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function findProjectUp(start: string): Promise<string | undefined> {
  let dir = path.resolve(start);
  for (;;) {
    if (await exists(path.join(dir, PROJECT_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface ResolveOptions {
  /** When false, the directory need not contain project.godot (used by `setup`). */
  requireProject?: boolean;
}

/**
 * Resolve a project root using this priority:
 *   1. explicit `input` argument
 *   2. $GODOT_PROJECT_ROOT
 *   3. upward search from the current working directory for project.godot
 */
export async function resolveProjectRoot(input?: string, options: ResolveOptions = {}): Promise<string> {
  const { requireProject = true } = options;

  let root: string | undefined;
  if (input && input.trim()) {
    root = path.resolve(expandHome(input.trim()));
  } else if (process.env[ENV.projectRoot]?.trim()) {
    root = path.resolve(expandHome(process.env[ENV.projectRoot]!.trim()));
  } else {
    root = (await findProjectUp(process.cwd())) ?? process.cwd();
  }

  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    throw new ToolError(`Project root does not exist: ${root}`, {
      code: 'no_project',
      hint: `Pass project_root or set ${ENV.projectRoot}.`,
    });
  }
  if (!stat.isDirectory()) {
    throw new ToolError(`Project root is not a directory: ${root}`, { code: 'no_project' });
  }

  if (requireProject && !(await exists(path.join(root, PROJECT_MARKER)))) {
    throw new ToolError(`No ${PROJECT_MARKER} found in ${root}`, {
      code: 'no_project',
      hint: `Point project_root at a Godot project folder (one containing ${PROJECT_MARKER}).`,
    });
  }
  return root;
}

/** Normalises any user path into a canonical `res://...` resource path. */
export function normalizeResourcePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  if (s.startsWith(RES_PREFIX)) {
    s = s.slice(RES_PREFIX.length);
  }
  s = s.replace(/^\/+/, '');
  return RES_PREFIX + s;
}

/** Converts a `res://` path to an absolute filesystem path, guarding traversal. */
export function resourceToAbsolute(root: string, resourcePath: string): string {
  const normalized = normalizeResourcePath(resourcePath).slice(RES_PREFIX.length);
  const abs = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new ToolError(`Resource path escapes the project: ${resourcePath}`, { code: 'path_escape' });
  }
  return abs;
}

/** Converts an absolute path back to a `res://` resource path. */
export function absoluteToResource(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(abs)).split(path.sep).join('/');
  return RES_PREFIX + rel.replace(/^\/+/, '');
}

/** True when a resource path lives inside the project. */
export function isInsideProject(root: string, abs: string): boolean {
  const rootResolved = path.resolve(root);
  const target = path.resolve(abs);
  return target === rootResolved || target.startsWith(rootResolved + path.sep);
}
