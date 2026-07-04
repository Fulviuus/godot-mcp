/**
 * Static configuration: server identity, environment variable names, cache
 * locations, and the rules for mapping a Godot version + platform to the
 * official GitHub release asset names.
 */

import os from 'node:os';
import path from 'node:path';

export const SERVER_NAME = 'godot-mcp-server';
export const SERVER_VERSION = '2.0.0';

/** Environment variables understood by the server. */
export const ENV = {
  projectRoot: 'GODOT_PROJECT_ROOT',
  cacheDir: 'GODOT_MCP_CACHE_DIR',
  /** Absolute path to a pre-installed Godot editor binary; bypasses downloads. */
  binary: 'GODOT_BIN',
  /** Force the .NET/Mono build when downloading ("1"/"true"). */
  mono: 'GODOT_MCP_MONO',
  logLevel: 'GODOT_MCP_LOG_LEVEL',
} as const;

/** The Godot resource scheme prefix. */
export const RES_PREFIX = 'res://';

/** Files that mark a directory as a Godot project root. */
export const PROJECT_MARKER = 'project.godot';

/** Resolve the cache directory used for downloaded engines, templates and docs. */
export function cacheDir(): string {
  const override = process.env[ENV.cacheDir];
  if (override && override.trim()) return path.resolve(expandTilde(override.trim()));
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'godot-mcp');
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export type GodotPlatform = 'linux' | 'windows' | 'macos';
export type GodotArch = 'x86_64' | 'x86_32' | 'arm64' | 'arm32';

/** Maps Node's process info to Godot's platform/arch identifiers. */
export function detectPlatform(): { platform: GodotPlatform; arch: GodotArch } {
  const platform: GodotPlatform =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  let arch: GodotArch = 'x86_64';
  switch (process.arch) {
    case 'arm64':
      arch = 'arm64';
      break;
    case 'arm':
      arch = 'arm32';
      break;
    case 'ia32':
      arch = 'x86_32';
      break;
    default:
      arch = 'x86_64';
  }
  return { platform, arch };
}

export interface VersionSpec {
  /** Numeric version, e.g. "4.7". */
  number: string;
  /** Release channel suffix, e.g. "stable", "rc1", "beta3". */
  channel: string;
}

/** "4.7-stable" → { number: "4.7", channel: "stable" }. */
export function parseVersionTag(tag: string): VersionSpec {
  const cleaned = tag.trim().replace(/^v/i, '');
  const dash = cleaned.indexOf('-');
  if (dash === -1) return { number: cleaned, channel: 'stable' };
  return { number: cleaned.slice(0, dash), channel: cleaned.slice(dash + 1) };
}

export function versionTag(spec: VersionSpec): string {
  return `${spec.number}-${spec.channel}`;
}

/** Base download URL for a release tag's assets. */
export function releaseBaseUrl(spec: VersionSpec): string {
  return `https://github.com/godotengine/godot/releases/download/${versionTag(spec)}`;
}

/**
 * Editor archive name, e.g. `Godot_v4.7-stable_linux.x86_64.zip` or
 * `Godot_v4.7-stable_mono_macos.universal.zip`.
 */
export function editorAssetName(
  spec: VersionSpec,
  platform: GodotPlatform,
  arch: GodotArch,
  mono: boolean,
): string {
  const tag = versionTag(spec);
  if (platform === 'macos') {
    // macOS ships a single universal build for both naming variants.
    const macSuffix = mono ? 'mono_macos.universal' : 'macos.universal';
    return `Godot_v${tag}_${macSuffix}.zip`;
  }
  if (platform === 'windows') {
    if (mono) {
      const winArch = arch === 'arm64' ? 'windows_arm64' : arch === 'x86_32' ? 'win32' : 'win64';
      return `Godot_v${tag}_mono_${winArch}.zip`;
    }
    const winArch = arch === 'arm64' ? 'windows_arm64.exe' : arch === 'x86_32' ? 'win32.exe' : 'win64.exe';
    return `Godot_v${tag}_${winArch}.zip`;
  }
  // linux
  const linuxArch =
    arch === 'arm64' ? 'arm64' : arch === 'arm32' ? 'arm32' : arch === 'x86_32' ? 'x86_32' : 'x86_64';
  return mono
    ? `Godot_v${tag}_mono_linux_${linuxArch}.zip`
    : `Godot_v${tag}_linux.${linuxArch}.zip`;
}

/** Export templates archive name (`.tpz`). */
export function templatesAssetName(spec: VersionSpec, mono: boolean): string {
  const tag = versionTag(spec);
  return mono ? `Godot_v${tag}_mono_export_templates.tpz` : `Godot_v${tag}_export_templates.tpz`;
}

/**
 * The directory name Godot uses for installed export templates, e.g.
 * `4.7.stable` or `4.7.stable.mono`.
 */
export function templatesDirName(spec: VersionSpec, mono: boolean): string {
  return `${spec.number}.${spec.channel}${mono ? '.mono' : ''}`;
}

/** GitHub API endpoint listing Godot releases (used to resolve "stable"/"latest"). */
export const RELEASES_API = 'https://api.github.com/repos/godotengine/godot/releases';
