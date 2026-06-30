/**
 * Editor-side operations driven through the Godot binary in headless mode:
 * importing/reimporting a project's resources, validating GDScript, and opening
 * the project once to generate the `.godot/` metadata folder.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeResourcePath } from '../context.js';
import { exists } from '../util/fswalk.js';
import { runGodot, type RunResult } from './processes.js';

export interface EditorActionResult {
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Lines that look like errors/warnings, extracted from the output. */
  diagnostics: string[];
}

const DIAGNOSTIC_RE = /\b(ERROR|SCRIPT ERROR|WARNING|Parse Error|Failed|Cannot|error:)\b/i;

function summarize(res: RunResult): EditorActionResult {
  const diagnostics = (res.stdout + '\n' + res.stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && DIAGNOSTIC_RE.test(l))
    .slice(0, 100);
  return {
    ok: res.code === 0 && !res.timedOut,
    durationMs: res.durationMs,
    stdout: res.stdout,
    stderr: res.stderr,
    diagnostics,
  };
}

/**
 * Reimport a project's resources. `--import` opens the editor headlessly, waits
 * for the import pass, then quits — also generating `.godot/` if missing.
 */
export async function importProject(binary: string, root: string, timeoutMs = 180_000): Promise<EditorActionResult> {
  const res = await runGodot(binary, ['--headless', '--path', root, '--import'], { cwd: root, timeoutMs });
  return summarize(res);
}

/**
 * Open the project once headlessly and quit. Cheaper than a full import; enough
 * to materialise `.godot/` and surface project-load errors.
 */
export async function openProject(binary: string, root: string, timeoutMs = 120_000): Promise<EditorActionResult> {
  const res = await runGodot(binary, ['--headless', '--path', root, '--editor', '--quit'], { cwd: root, timeoutMs });
  return summarize(res);
}

/**
 * Validate a single GDScript file using `--check-only --script`. Returns parse
 * errors in `diagnostics`. The script path may be a res:// path or relative.
 */
export async function validateScript(
  binary: string,
  root: string,
  scriptPath: string,
  timeoutMs = 60_000,
): Promise<EditorActionResult> {
  const resPath = normalizeResourcePath(scriptPath);
  const res = await runGodot(
    binary,
    ['--headless', '--path', root, '--check-only', '--script', resPath, '--quit'],
    { cwd: root, timeoutMs },
  );
  return summarize(res);
}

/** True once a project has a generated `.godot/` metadata directory. */
export async function hasImportedMetadata(root: string): Promise<boolean> {
  return exists(path.join(root, '.godot'));
}

/** Remove generated/derived artifacts. Returns the paths that were deleted. */
export async function cleanProject(root: string, alsoExport = false): Promise<string[]> {
  const removed: string[] = [];
  const targets = ['.godot', '.import'];
  for (const target of targets) {
    const full = path.join(root, target);
    if (await exists(full)) {
      await fs.rm(full, { recursive: true, force: true });
      removed.push(target);
    }
  }
  if (alsoExport) {
    const exportDir = path.join(root, 'export');
    if (await exists(exportDir)) {
      await fs.rm(exportDir, { recursive: true, force: true });
      removed.push('export');
    }
  }
  return removed;
}
