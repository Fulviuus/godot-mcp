/**
 * Locating and provisioning the Godot toolchain: resolving which engine version
 * a project targets, finding a usable editor binary (env override, PATH, cache,
 * or download), and installing matching export templates.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import {
  ENV,
  RELEASES_API,
  cacheDir,
  detectPlatform,
  editorAssetName,
  parseVersionTag,
  releaseBaseUrl,
  templatesAssetName,
  templatesDirName,
  versionTag,
  type VersionSpec,
} from '../constants.js';
import { resourceToAbsolute } from '../context.js';
import { ToolError } from '../util/errors.js';
import { exists, isDirectory } from '../util/fswalk.js';
import { downloadToFile, fetchJson } from '../util/http.js';
import { parseConfig, decodeValue, getRaw } from '../util/ini.js';
import { log } from '../util/log.js';
import { runGodot } from './processes.js';

export interface ResolvedEngine {
  spec: VersionSpec;
  mono: boolean;
  binary: string;
  /** Where the binary came from, for diagnostics. */
  source: 'env' | 'path' | 'cache' | 'download';
}

/** Godot's per-user editor data directory (where export templates live). */
export function editorDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Godot');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Godot');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'godot');
}

export function templatesInstallDir(spec: VersionSpec, mono: boolean): string {
  return path.join(editorDataDir(), 'export_templates', templatesDirName(spec, mono));
}

/** Whether the project (or env) wants the .NET/Mono build. */
export async function isMonoProject(root?: string): Promise<boolean> {
  const override = process.env[ENV.mono];
  if (override) return override === '1' || override.toLowerCase() === 'true';
  if (!root) return false;
  try {
    const cfg = parseConfig(await fs.readFile(path.join(root, 'project.godot'), 'utf8'));
    if (cfg.sections.some((s) => s.name === 'dotnet')) return true;
  } catch {
    /* ignore */
  }
  // A .csproj at the project root is the other strong signal.
  try {
    const entries = await fs.readdir(root);
    if (entries.some((e) => e.endsWith('.csproj') || e.endsWith('.sln'))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Reads the engine version a project targets from project.godot's features list. */
export async function resolveProjectVersionSpec(root: string): Promise<VersionSpec | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, 'project.godot'), 'utf8');
  } catch {
    return undefined;
  }
  const cfg = parseConfig(text);
  const raw = getRaw(cfg, 'application', 'config/features');
  if (raw) {
    const decoded = decodeValue(raw);
    const list = Array.isArray(decoded) ? decoded.map(String) : [];
    const version = list.find((f) => /^\d+\.\d+/.test(f));
    if (version) return { number: version, channel: 'stable' };
  }
  return undefined;
}

/** Resolves the most recent stable release tag from GitHub. */
export async function resolveLatestStable(): Promise<VersionSpec> {
  const releases = await fetchJson<Array<{ tag_name: string; prerelease: boolean }>>(
    `${RELEASES_API}?per_page=30`,
  );
  const stable = releases
    .map((r) => r.tag_name)
    .filter((t) => /-stable$/.test(t))
    .map(parseVersionTag);
  if (stable.length === 0) {
    throw new ToolError('Could not determine the latest stable Godot release.', { code: 'no_release' });
  }
  stable.sort((a, b) => compareVersionNumbers(b.number, a.number));
  return stable[0];
}

function compareVersionNumbers(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Resolve the target version. Concrete versions ("4.7", "4.6-rc1") are used
 * verbatim; "stable"/"latest"/unset fall back to the project's declared version,
 * then to the latest stable release.
 */
export async function resolveVersionSpec(version?: string, root?: string): Promise<VersionSpec> {
  if (version && version.trim() && !['stable', 'latest'].includes(version.trim().toLowerCase())) {
    return parseVersionTag(version.trim());
  }
  if (root) {
    const projectVersion = await resolveProjectVersionSpec(root);
    if (projectVersion) return projectVersion;
  }
  return resolveLatestStable();
}

async function checkBinaryVersion(binary: string): Promise<string | undefined> {
  const res = await runGodot(binary, ['--version'], { timeoutMs: 15_000 });
  const out = (res.stdout + res.stderr).trim();
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(out);
  return m ? m[1] : undefined;
}

async function findOnPath(): Promise<{ path: string; version?: string } | undefined> {
  const candidates = process.platform === 'win32' ? ['godot.exe', 'godot4.exe'] : ['godot4', 'godot'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of candidates) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (await exists(full)) {
        const version = await checkBinaryVersion(full);
        return { path: full, version };
      }
    }
  }
  return undefined;
}

/** Recursively locate the Godot executable inside an extracted editor archive. */
async function findEditorExecutable(dir: string, mono: boolean): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    const appName = mono ? 'Godot_mono.app' : 'Godot.app';
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop()!;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === appName || entry.name.endsWith('.app')) {
            const bin = path.join(full, 'Contents', 'MacOS', 'Godot');
            if (await exists(bin)) return bin;
          }
          stack.push(full);
        }
      }
    }
    return undefined;
  }

  const stack = [dir];
  const matches: string[] = [];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.startsWith('Godot_v')) {
        if (process.platform === 'win32') {
          if (entry.name.endsWith('.exe')) matches.push(full);
        } else if (!entry.name.includes('.') || entry.name.endsWith('.x86_64') || entry.name.endsWith('.arm64')) {
          matches.push(full);
        }
      }
    }
  }
  // Prefer the shortest path (top-level executable over nested duplicates).
  matches.sort((a, b) => a.length - b.length);
  return matches[0];
}

function extractZip(buffer: Buffer, destDir: string): Promise<void> {
  return (async () => {
    const files = unzipSync(new Uint8Array(buffer));
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/')) continue;
      const outPath = path.join(destDir, name);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, Buffer.from(data));
    }
  })();
}

/**
 * Ensure an editor binary is available for `spec`. Order of preference:
 * $GODOT_BIN → matching binary on PATH → cached download → fresh download.
 */
export async function ensureEditor(
  spec: VersionSpec,
  mono: boolean,
  onProgress?: (msg: string) => void,
): Promise<ResolvedEngine> {
  const envBin = process.env[ENV.binary];
  if (envBin && envBin.trim()) {
    const resolved = path.resolve(envBin.trim());
    if (!(await exists(resolved))) {
      throw new ToolError(`${ENV.binary} points to a missing file: ${resolved}`, { code: 'no_binary' });
    }
    return { spec, mono, binary: resolved, source: 'env' };
  }

  const onPath = await findOnPath();
  if (onPath && onPath.version && onPath.version.startsWith(spec.number)) {
    return { spec, mono, binary: onPath.path, source: 'path' };
  }

  const editorRoot = path.join(cacheDir(), 'editors', `${versionTag(spec)}${mono ? '-mono' : ''}`);
  const cachedMarker = path.join(editorRoot, '.binary-path');
  if (await exists(cachedMarker)) {
    const cached = (await fs.readFile(cachedMarker, 'utf8')).trim();
    if (await exists(cached)) {
      return { spec, mono, binary: cached, source: 'cache' };
    }
  }

  const { platform, arch } = detectPlatform();
  const asset = editorAssetName(spec, platform, arch, mono);
  const url = `${releaseBaseUrl(spec)}/${asset}`;
  const downloadPath = path.join(cacheDir(), 'downloads', asset);

  onProgress?.(`Downloading editor ${asset}`);
  if (!(await exists(downloadPath))) {
    await downloadToFile(url, downloadPath, {
      onProgress: (recv, total) => {
        if (total) onProgress?.(`Editor ${Math.round((recv / total) * 100)}%`);
      },
    });
  }

  onProgress?.('Extracting editor');
  await fs.mkdir(editorRoot, { recursive: true });
  await extractZip(await fs.readFile(downloadPath), editorRoot);

  const binary = await findEditorExecutable(editorRoot, mono);
  if (!binary) {
    throw new ToolError(`Could not locate the Godot executable in ${editorRoot}`, { code: 'extract_failed' });
  }
  if (process.platform !== 'win32') {
    await fs.chmod(binary, 0o755).catch(() => undefined);
  }
  await fs.writeFile(cachedMarker, binary);
  log.info(`editor ready: ${binary}`);
  return { spec, mono, binary, source: 'download' };
}

/** Ensure export templates for `spec` are installed in the editor data dir. */
export async function ensureExportTemplates(
  spec: VersionSpec,
  mono: boolean,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const installDir = templatesInstallDir(spec, mono);
  if (await isDirectory(installDir)) {
    const entries = await fs.readdir(installDir).catch(() => []);
    if (entries.length > 0) return installDir;
  }

  const asset = templatesAssetName(spec, mono);
  const url = `${releaseBaseUrl(spec)}/${asset}`;
  const downloadPath = path.join(cacheDir(), 'downloads', asset);

  onProgress?.(`Downloading export templates ${asset}`);
  if (!(await exists(downloadPath))) {
    await downloadToFile(url, downloadPath, {
      onProgress: (recv, total) => {
        if (total) onProgress?.(`Templates ${Math.round((recv / total) * 100)}%`);
      },
    });
  }

  onProgress?.('Installing export templates');
  await fs.mkdir(installDir, { recursive: true });
  // A .tpz is a zip whose entries live under a top-level `templates/` folder.
  const files = unzipSync(new Uint8Array(await fs.readFile(downloadPath)));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const rel = name.replace(/^templates\//, '');
    const outPath = path.join(installDir, rel);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, Buffer.from(data));
  }
  log.info(`export templates installed: ${installDir}`);
  return installDir;
}

/** Convenience used by tools: resolve version + mono, then ensure the editor. */
export async function resolveEngine(
  options: { version?: string; root?: string; mono?: boolean } = {},
  onProgress?: (msg: string) => void,
): Promise<ResolvedEngine> {
  const spec = await resolveVersionSpec(options.version, options.root);
  const mono = options.mono ?? (await isMonoProject(options.root));
  return ensureEditor(spec, mono, onProgress);
}

/** Reads export presets defined in a project, used by the build/export tools. */
export interface ExportPreset {
  index: number;
  name: string;
  platform: string;
  runnable: boolean;
  exportPath: string;
}

export async function readExportPresets(root: string): Promise<ExportPreset[]> {
  const file = path.join(root, 'export_presets.cfg');
  if (!(await exists(file))) return [];
  const cfg = parseConfig(await fs.readFile(file, 'utf8'));
  const presets: ExportPreset[] = [];
  for (const section of cfg.sections) {
    const m = /^preset\.(\d+)$/.exec(section.name);
    if (!m) continue;
    const get = (key: string) => section.entries.find((e) => e.key === key)?.raw;
    presets.push({
      index: Number(m[1]),
      name: String(decodeValue(get('name') ?? '""')),
      platform: String(decodeValue(get('platform') ?? '""')),
      runnable: decodeValue(get('runnable') ?? 'false') === true,
      exportPath: String(decodeValue(get('export_path') ?? '""')),
    });
  }
  return presets.sort((a, b) => a.index - b.index);
}

/** Absolute path of a preset's configured export output, if any. */
export function presetOutputPath(root: string, preset: ExportPreset): string | undefined {
  if (!preset.exportPath) return undefined;
  if (preset.exportPath.startsWith('res://')) return resourceToAbsolute(root, preset.exportPath);
  return path.isAbsolute(preset.exportPath) ? preset.exportPath : path.join(root, preset.exportPath);
}
