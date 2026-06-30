/**
 * Filesystem walking utilities used to enumerate Godot project resources.
 * Honours `.gdignore` directories and skips Godot's `.godot/` metadata folder.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Directories never worth descending into when enumerating resources. */
const ALWAYS_SKIP = new Set(['.godot', '.git', '.import', 'node_modules', '.svn']);

export interface WalkOptions {
  /** Extensions (with leading dot) to include. When omitted, every file is returned. */
  extensions?: string[];
  /** Hard cap on the number of files returned (defence against huge trees). */
  limit?: number;
  /** When true, follow into directories that contain a `.gdignore` file. */
  includeIgnored?: boolean;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively collect absolute file paths under `root`. Directories containing a
 * `.gdignore` file are skipped (Godot's convention for excluding a folder from
 * the resource system) unless `includeIgnored` is set.
 */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const { extensions, limit = Infinity, includeIgnored = false } = options;
  const exts = extensions ? new Set(extensions.map((e) => e.toLowerCase())) : null;
  const out: string[] = [];

  async function recurse(dir: string): Promise<void> {
    if (out.length >= limit) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (!includeIgnored && entries.some((e) => e.isFile() && e.name === '.gdignore')) {
      return;
    }

    // Stable ordering keeps tool output deterministic across platforms.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name)) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        if (exts && !exts.has(path.extname(entry.name).toLowerCase())) continue;
        out.push(full);
      }
    }
  }

  await recurse(root);
  return out;
}
