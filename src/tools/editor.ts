/**
 * Editor-side tools that run the Godot binary headlessly: validating GDScript
 * for parse errors and (re)installing the live-control bridge addon.
 */

import { resolveProjectRoot } from '../context.js';
import { log } from '../util/log.js';
import { validateScript } from '../services/editor.js';
import { ensureEditor, isMonoProject, resolveVersionSpec } from '../services/toolchain.js';
import { installBridge } from './build.js';
import {
  register,
  respond,
  text,
  projectRootParam,
  versionParam,
  responseFormatParam,
  resourcePathParam,
  type Server,
} from './shared.js';

export function registerEditorTools(server: Server): void {
  register(server, {
    name: 'godot_validate_script',
    title: 'Validate script',
    description:
      'Parse a GDScript file headlessly with --check-only and report any parse/compile errors without running the game.',
    schema: {
      project_root: projectRootParam,
      version: versionParam,
      script: resourcePathParam,
      response_format: responseFormatParam,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ project_root, version, script, response_format }) => {
      const root = await resolveProjectRoot(project_root);
      const spec = await resolveVersionSpec(version, root);
      const engine = await ensureEditor(spec, await isMonoProject(root), (m) => log.info(m));
      const result = await validateScript(engine.binary, root, script);
      return respond(response_format, result, () => {
        if (result.ok && result.diagnostics.length === 0) return `✓ ${script} parsed with no errors.`;
        return `✗ ${script} has problems:\n` + result.diagnostics.map((d) => `  ${d}`).join('\n');
      });
    },
  });

  register(server, {
    name: 'godot_install_bridge',
    title: 'Install bridge addon',
    description:
      'Install (or refresh) the godot_mcp live-control bridge addon and its autoload in the project. Normally handled by godot_setup or godot_run, but available explicitly.',
    schema: { project_root: projectRootParam },
    annotations: { idempotentHint: true },
    handler: async ({ project_root }) => {
      const root = await resolveProjectRoot(project_root);
      await installBridge(root);
      return text('Installed godot_mcp bridge addon (addons/godot_mcp) and registered the MCPBridge autoload.');
    },
  });
}
