/**
 * Build pipeline tools: provisioning the toolchain (setup), importing resources
 * (build), exporting bundles (export), cleaning derived files, and diagnostics.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveProjectRoot, resourceToAbsolute } from '../context.js';
import { fail } from '../util/errors.js';
import { exists } from '../util/fswalk.js';
import { parseConfig, serializeConfig, getRaw, setRaw, decodeValue } from '../util/ini.js';
import { log } from '../util/log.js';
import { cleanProject, importProject } from '../services/editor.js';
import { runGodot } from '../services/processes.js';
import {
  BRIDGE_AUTOLOAD_GD,
  BRIDGE_FILES,
  BRIDGE_PLUGIN_CFG,
  BRIDGE_PLUGIN_GD,
} from '../services/templates.js';
import {
  editorDataDir,
  ensureEditor,
  ensureExportTemplates,
  isMonoProject,
  readExportPresets,
  resolveVersionSpec,
  templatesInstallDir,
} from '../services/toolchain.js';
import { versionTag } from '../constants.js';
import {
  register,
  respond,
  text,
  projectRootParam,
  versionParam,
  responseFormatParam,
  type Server,
} from './shared.js';

/** True when the godot_mcp bridge addon is installed in a project. */
export async function isBridgeInstalled(root: string): Promise<boolean> {
  return exists(path.join(root, BRIDGE_FILES.autoloadGd));
}

/** Install the godot_mcp bridge addon and register its autoload. */
export async function installBridge(root: string): Promise<void> {
  const addonDir = path.join(root, 'addons', 'godot_mcp');
  await fs.mkdir(addonDir, { recursive: true });
  await fs.writeFile(path.join(root, BRIDGE_FILES.pluginCfg), BRIDGE_PLUGIN_CFG);
  await fs.writeFile(path.join(root, BRIDGE_FILES.pluginGd), BRIDGE_PLUGIN_GD);
  await fs.writeFile(path.join(root, BRIDGE_FILES.autoloadGd), BRIDGE_AUTOLOAD_GD);

  const projectFile = path.join(root, 'project.godot');
  const cfg = parseConfig(await fs.readFile(projectFile, 'utf8'));
  const autoloadValue = `"*res://${BRIDGE_FILES.autoloadGd}"`;
  if (getRaw(cfg, 'autoload', BRIDGE_FILES.autoloadName) !== autoloadValue) {
    setRaw(cfg, 'autoload', BRIDGE_FILES.autoloadName, autoloadValue);
    await fs.writeFile(projectFile, serializeConfig(cfg));
  }
}

export function registerBuildTools(server: Server): void {
  register(server, {
    name: 'godot_setup',
    title: 'Set up toolchain',
    description:
      'Provision the Godot toolchain for a project: resolve the target version, download/locate the editor binary, install matching export templates, and (by default) install the godot_mcp live-control bridge addon. Safe to run repeatedly.',
    schema: {
      project_root: projectRootParam,
      version: versionParam,
      install_templates: z.boolean().default(true).describe('Download and install export templates.'),
      install_bridge: z.boolean().default(true).describe('Install the godot_mcp bridge addon for live control.'),
      response_format: responseFormatParam,
    },
    annotations: { idempotentHint: true, openWorldHint: true },
    handler: async ({ project_root, version, install_templates, install_bridge, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const spec = await resolveVersionSpec(version, root);
      const mono = await isMonoProject(root);
      const progress: string[] = [];
      const onProgress = (m: string) => {
        progress.push(m);
        log.info(m);
      };

      const engine = await ensureEditor(spec, mono, onProgress);
      let templatesDir: string | undefined;
      if (install_templates) {
        templatesDir = await ensureExportTemplates(spec, mono, onProgress);
      }
      if (install_bridge) {
        await installBridge(root);
        onProgress('Installed godot_mcp bridge addon');
      }

      const data = {
        project_root: root,
        version: versionTag(spec),
        mono,
        editor_binary: engine.binary,
        editor_source: engine.source,
        export_templates: templatesDir ?? null,
        bridge_installed: install_bridge,
      };
      return respond(response_format, data, () =>
        [
          `Toolchain ready for ${data.version}${mono ? ' (.NET)' : ''}.`,
          `- Editor: ${engine.binary} (${engine.source})`,
          `- Export templates: ${templatesDir ?? 'skipped'}`,
          `- Bridge addon: ${install_bridge ? 'installed' : 'skipped'}`,
        ].join('\n'),
      );
    },
  });

  register(server, {
    name: 'godot_build',
    title: 'Build (import resources)',
    description:
      'Import/reimport the project headlessly, compiling scripts and generating the .godot cache. Surfaces script and scene errors. This is the Godot equivalent of a compile check.',
    schema: { project_root: projectRootParam, version: versionParam, response_format: responseFormatParam },
    annotations: {},
    handler: async ({ project_root, version, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const spec = await resolveVersionSpec(version, root);
      const engine = await ensureEditor(spec, await isMonoProject(root), (m) => log.info(m));
      const result = await importProject(engine.binary, root);
      return respond(response_format, result, () => {
        const head = result.ok ? '✓ Import succeeded' : '✗ Import reported problems';
        const diag = result.diagnostics.length
          ? '\n\nDiagnostics:\n' + result.diagnostics.map((d) => `  ${d}`).join('\n')
          : '';
        return `${head} (${result.durationMs}ms).${diag}`;
      });
    },
  });

  register(server, {
    name: 'godot_export',
    title: 'Export bundle',
    description:
      'Export a project using a preset from export_presets.cfg. Mode "release"/"debug" produce a runnable bundle; "pack" produces a .pck/.zip data pack. With no preset, lists the available presets.',
    schema: {
      project_root: projectRootParam,
      version: versionParam,
      preset: z.string().optional().describe('Export preset name (as in export_presets.cfg). Omit to list presets.'),
      mode: z.enum(['release', 'debug', 'pack']).default('debug').describe('Export mode.'),
      output: z
        .string()
        .optional()
        .describe('Output file path (absolute, res://, or project-relative). Defaults to the preset\'s export_path.'),
      response_format: responseFormatParam,
    },
    annotations: { openWorldHint: true },
    handler: async ({ project_root, version, preset, mode, output, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const presets = await readExportPresets(root);

      if (!preset) {
        if (presets.length === 0) {
          fail('No export presets defined. Add one in the Godot editor (Project → Export) first.', {
            code: 'no_presets',
          });
        }
        return respond(response_format, { presets }, () =>
          'Available export presets:\n' +
          presets.map((p) => `- "${p.name}" [${p.platform}]${p.runnable ? ' runnable' : ''} → ${p.exportPath || '(no path)'}`).join('\n'),
        );
      }

      const match = presets.find((p) => p.name === preset);
      if (!match) {
        fail(`Preset "${preset}" not found. Available: ${presets.map((p) => p.name).join(', ') || '(none)'}.`, {
          code: 'no_preset',
        });
      }

      const spec = await resolveVersionSpec(version, root);
      const mono = await isMonoProject(root);
      const engine = await ensureEditor(spec, mono, (m) => log.info(m));
      await ensureExportTemplates(spec, mono, (m) => log.info(m));

      const outPath = resolveOutput(root, output ?? match!.exportPath ?? `export/${preset}`);
      await fs.mkdir(path.dirname(outPath), { recursive: true });

      const flag = mode === 'release' ? '--export-release' : mode === 'pack' ? '--export-pack' : '--export-debug';
      const res = await runGodot(
        engine.binary,
        ['--headless', '--path', root, flag, preset, outPath],
        { cwd: root, timeoutMs: 600_000 },
      );
      const produced = await exists(outPath);
      const data = {
        preset,
        mode,
        output: outPath,
        produced,
        exit_code: res.code,
        stderr_tail: res.stderr.split(/\r?\n/).filter(Boolean).slice(-20),
      };
      return respond(response_format, data, () =>
        [
          produced && res.code === 0 ? `✓ Exported "${preset}" (${mode})` : `✗ Export of "${preset}" failed`,
          `Output: ${outPath} (${produced ? 'created' : 'missing'})`,
          res.code !== 0 ? `Exit code: ${res.code}` : '',
          data.stderr_tail.length ? '\n' + data.stderr_tail.join('\n') : '',
        ].filter(Boolean).join('\n'),
      );
    },
  });

  register(server, {
    name: 'godot_clean',
    title: 'Clean project',
    description: 'Remove generated artifacts: the .godot cache, legacy .import folder, and optionally the export/ output.',
    schema: {
      project_root: projectRootParam,
      include_exports: z.boolean().default(false).describe('Also delete the export/ directory.'),
    },
    annotations: { destructiveHint: true },
    handler: async ({ project_root, include_exports }) => {
      const root = await resolveProjectRoot(project_root);
      const removed = await cleanProject(root, include_exports);
      return text(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing to clean.');
    },
  });

  register(server, {
    name: 'godot_doctor',
    title: 'Diagnose setup',
    description:
      'Run diagnostics: confirm a usable editor binary, version alignment with the project, export template availability, and whether the project imports cleanly.',
    schema: { project_root: projectRootParam, version: versionParam, response_format: responseFormatParam },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ project_root, version, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const checks: { name: string; ok: boolean; detail: string }[] = [];

      const spec = await resolveVersionSpec(version, root);
      checks.push({ name: 'Target version', ok: true, detail: versionTag(spec) });

      const mono = await isMonoProject(root);
      checks.push({ name: 'Build flavour', ok: true, detail: mono ? '.NET / Mono' : 'standard' });

      let binary = '';
      try {
        const engine = await ensureEditor(spec, mono, (m) => log.info(m));
        binary = engine.binary;
        checks.push({ name: 'Editor binary', ok: true, detail: `${engine.binary} (${engine.source})` });
      } catch (err) {
        checks.push({ name: 'Editor binary', ok: false, detail: (err as Error).message });
      }

      const tplDir = templatesInstallDir(spec, mono);
      const tplOk = await exists(tplDir);
      checks.push({
        name: 'Export templates',
        ok: tplOk,
        detail: tplOk ? tplDir : `missing (${tplDir}) — run godot_setup`,
      });
      checks.push({ name: 'Editor data dir', ok: true, detail: editorDataDir() });

      const cfgFeatures = await projectFeatures(root);
      if (cfgFeatures && !cfgFeatures.startsWith(spec.number)) {
        checks.push({
          name: 'Version alignment',
          ok: false,
          detail: `project declares ${cfgFeatures} but resolving to ${versionTag(spec)}`,
        });
      } else {
        checks.push({ name: 'Version alignment', ok: true, detail: cfgFeatures ?? 'unspecified' });
      }

      if (binary) {
        const result = await importProject(binary, root, 120_000);
        checks.push({
          name: 'Project imports',
          ok: result.ok,
          detail: result.ok ? 'clean' : `${result.diagnostics.length} diagnostic(s): ${result.diagnostics.slice(0, 3).join(' | ')}`,
        });
      }

      const allOk = checks.every((c) => c.ok);
      return respond(response_format, { ok: allOk, checks }, () =>
        `Doctor: ${allOk ? 'all good' : 'issues found'}\n\n` +
        checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n'),
      );
    },
  });
}

function resolveOutput(root: string, out: string): string {
  if (out.startsWith('res://')) return resourceToAbsolute(root, out);
  return path.isAbsolute(out) ? out : path.join(root, out);
}

async function projectFeatures(root: string): Promise<string | undefined> {
  try {
    const cfg = parseConfig(await fs.readFile(path.join(root, 'project.godot'), 'utf8'));
    const decoded = decodeValue(getRaw(cfg, 'application', 'config/features') ?? '');
    const list = Array.isArray(decoded) ? decoded.map(String) : [];
    return list.find((f) => /^\d+\.\d+/.test(f));
  } catch {
    return undefined;
  }
}
