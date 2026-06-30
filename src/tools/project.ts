/**
 * Project inspection and `project.godot` editing tools.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from '../context.js';
import { fail } from '../util/errors.js';
import { exists, walkFiles } from '../util/fswalk.js';
import {
  parseConfig,
  serializeConfig,
  setRaw,
  decodeValue,
  encodeValue,
  getRaw,
} from '../util/ini.js';
import { z } from 'zod';
import {
  register,
  respond,
  text,
  projectRootParam,
  responseFormatParam,
  limitParam,
  offsetParam,
  paginate,
  paginationFooter,
  type Server,
} from './shared.js';

async function readProjectConfig(root: string) {
  const file = path.join(root, 'project.godot');
  const raw = await fs.readFile(file, 'utf8');
  return { file, config: parseConfig(raw), raw };
}

const RESOURCE_CATEGORIES: Record<string, string> = {
  '.tscn': 'scenes',
  '.scn': 'scenes',
  '.gd': 'gdscripts',
  '.cs': 'csharp',
  '.tres': 'resources',
  '.res': 'resources',
  '.gdshader': 'shaders',
  '.png': 'images',
  '.jpg': 'images',
  '.jpeg': 'images',
  '.svg': 'images',
  '.ogg': 'audio',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.glb': 'models',
  '.gltf': 'models',
  '.obj': 'models',
  '.ttf': 'fonts',
  '.otf': 'fonts',
};

export function registerProjectTools(server: Server): void {
  register(server, {
    name: 'godot_project_info',
    title: 'Project info',
    description:
      'Summarise a Godot project: name, target engine version, main scene, autoloads, input actions, enabled features and a resource-type breakdown.',
    schema: { project_root: projectRootParam, response_format: responseFormatParam },
    annotations: { readOnlyHint: true },
    handler: async ({ project_root, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const { config } = await readProjectConfig(root);

      const name = decodeStr(getRaw(config, 'application', 'config/name')) || path.basename(root);
      const description = decodeStr(getRaw(config, 'application', 'config/description'));
      const mainScene = decodeStr(getRaw(config, 'application', 'run/main_scene'));
      const features = decodeArr(getRaw(config, 'application', 'config/features'));
      const version = features.find((f) => /^\d+\.\d+/.test(f)) ?? 'unknown';
      const renderer = decodeStr(getRaw(config, 'rendering', 'renderer/rendering_method')) || features.find((f) => /forward|mobile|compat/i.test(f)) || 'default';

      const autoloads = (config.sections.find((s) => s.name === 'autoload')?.entries ?? []).map((e) => ({
        name: e.key,
        path: stripAutoloadStar(decodeStr(e.raw)),
      }));
      const inputActions = (config.sections.find((s) => s.name === 'input')?.entries ?? []).map((e) => e.key);

      const files = await walkFiles(root, { limit: 20000 });
      const counts: Record<string, number> = {};
      for (const f of files) {
        const cat = RESOURCE_CATEGORIES[path.extname(f).toLowerCase()];
        if (cat) counts[cat] = (counts[cat] ?? 0) + 1;
      }

      const data = {
        project_root: root,
        name,
        description,
        engine_version: version,
        renderer,
        main_scene: mainScene,
        features,
        autoloads,
        input_actions: inputActions,
        resource_counts: counts,
        imported: await exists(path.join(root, '.godot')),
      };

      return respond(response_format, data, () => {
        const lines = [
          `# ${name}`,
          description ? `\n${description}\n` : '',
          `- Root: ${root}`,
          `- Engine version: ${version}`,
          `- Renderer: ${renderer}`,
          `- Main scene: ${mainScene || '(none)'}`,
          `- Imported (.godot present): ${data.imported ? 'yes' : 'no'}`,
          features.length ? `- Features: ${features.join(', ')}` : '',
          autoloads.length ? `\n## Autoloads (${autoloads.length})\n` + autoloads.map((a) => `- ${a.name} → ${a.path}`).join('\n') : '',
          inputActions.length ? `\n## Input actions (${inputActions.length})\n` + inputActions.map((a) => `- ${a}`).join('\n') : '',
          '\n## Resources',
          ...Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `- ${k}: ${v}`),
        ];
        return lines.filter((l) => l !== '').join('\n');
      });
    },
  });

  register(server, {
    name: 'godot_get_settings',
    title: 'Get project settings',
    description: 'List project.godot settings as section/key/value entries, optionally filtered to one section.',
    schema: {
      project_root: projectRootParam,
      section: z.string().optional().describe('Only return settings from this section (e.g. "display", "rendering").'),
      response_format: responseFormatParam,
      limit: limitParam,
      offset: offsetParam,
    },
    annotations: { readOnlyHint: true },
    handler: async ({ project_root, section, response_format, limit, offset }) => {
      const root = await resolveProjectRoot(project_root);
      const { config } = await readProjectConfig(root);
      const all: { section: string; key: string; value: unknown; raw: string }[] = [];
      for (const sec of config.sections) {
        if (section && sec.name !== section) continue;
        for (const entry of sec.entries) {
          all.push({ section: sec.name || '(global)', key: entry.key, value: decodeValue(entry.raw), raw: entry.raw });
        }
      }
      const page = paginate(all, limit, offset);
      return respond(response_format, page, () => {
        const lines = page.items.map((e) => `[${e.section}] ${e.key} = ${e.raw}`);
        return (lines.join('\n') || '(no settings)') + '\n\n' + paginationFooter(page);
      });
    },
  });

  register(server, {
    name: 'godot_set_setting',
    title: 'Set project setting',
    description:
      'Set or add a setting in project.godot. The section is created if missing. Use type="raw" to write a Godot literal verbatim (e.g. a Vector2 or PackedStringArray).',
    schema: {
      project_root: projectRootParam,
      section: z.string().min(1).describe('Section name without brackets, e.g. "display".'),
      key: z.string().min(1).describe('Key, which may contain slashes, e.g. "window/size/viewport_width".'),
      value: z.string().describe('The value to write, interpreted according to "type".'),
      type: z
        .enum(['string', 'int', 'float', 'bool', 'raw'])
        .default('string')
        .describe('How to encode value. "raw" writes it verbatim as a Godot variant literal.'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ project_root, section, key, value, type }) => {
      const root = await resolveProjectRoot(project_root);
      const { file, config } = await readProjectConfig(root);
      let raw: string;
      switch (type) {
        case 'raw':
          raw = value;
          break;
        case 'int': {
          const n = Number.parseInt(value, 10);
          if (Number.isNaN(n)) fail(`"${value}" is not an integer.`);
          raw = String(n);
          break;
        }
        case 'float': {
          const n = Number.parseFloat(value);
          if (Number.isNaN(n)) fail(`"${value}" is not a number.`);
          raw = String(n);
          break;
        }
        case 'bool':
          raw = /^(true|1|yes)$/i.test(value.trim()) ? 'true' : 'false';
          break;
        default:
          raw = encodeValue(value);
      }
      setRaw(config, section, key, raw);
      await fs.writeFile(file, serializeConfig(config));
      return text(`Set [${section}] ${key} = ${raw}\nWrote ${file}`);
    },
  });

  register(server, {
    name: 'godot_list_addons',
    title: 'List addons',
    description: 'List installed editor addons under addons/, with their plugin.cfg metadata and enabled state.',
    schema: { project_root: projectRootParam, response_format: responseFormatParam },
    annotations: { readOnlyHint: true },
    handler: async ({ project_root, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const addonsDir = path.join(root, 'addons');
      const enabled = new Set(
        decodeArr(getRaw((await readProjectConfig(root)).config, 'editor_plugins', 'enabled')).map(String),
      );
      const addons: { name: string; folder: string; version?: string; description?: string; enabled: boolean }[] = [];
      if (await exists(addonsDir)) {
        for (const entry of await fs.readdir(addonsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cfgPath = path.join(addonsDir, entry.name, 'plugin.cfg');
          if (!(await exists(cfgPath))) continue;
          const cfg = parseConfig(await fs.readFile(cfgPath, 'utf8'));
          const get = (k: string) => decodeStr(getRaw(cfg, 'plugin', k));
          addons.push({
            name: get('name') || entry.name,
            folder: `res://addons/${entry.name}`,
            version: get('version'),
            description: get('description'),
            enabled: enabled.has(`res://addons/${entry.name}/plugin.cfg`),
          });
        }
      }
      return respond(response_format, { addons }, () =>
        addons.length === 0
          ? 'No addons installed.'
          : addons.map((a) => `- ${a.name}${a.version ? ` v${a.version}` : ''} [${a.enabled ? 'enabled' : 'disabled'}] (${a.folder})`).join('\n'),
      );
    },
  });
}

function decodeStr(raw: string | undefined): string {
  if (raw === undefined) return '';
  const v = decodeValue(raw);
  return typeof v === 'string' ? v : String(v);
}

function decodeArr(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const v = decodeValue(raw);
  return Array.isArray(v) ? v.map(String) : [];
}

function stripAutoloadStar(p: string): string {
  return p.replace(/^\*/, '');
}
