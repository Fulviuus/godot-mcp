// Opt-in end-to-end smoke test that drives the toolchain-dependent tools against
// a real Godot install. This is NOT part of `npm test` (it isn't a *.test.mjs
// file); run it explicitly:
//
//   node test/live-smoke.mjs [path-to-project]
//
// It will download a Godot editor + export templates if none are found, so it
// needs network access (or set GODOT_BIN to a local binary). By default it uses
// a temporary copy of the test fixture.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StdioClient, FIXTURE } from './_client.mjs';

const log = (...a) => console.log('[live-smoke]', ...a);

async function main() {
  const argProject = process.argv[2];
  let project = argProject;
  if (!project) {
    project = await fs.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-live-'));
    await fs.cp(FIXTURE, project, { recursive: true });
    log('using temp project', project);
  }

  const client = new StdioClient();
  await client.initialize();

  const step = async (name, fn) => {
    log('▶', name);
    const out = await fn();
    if (out?.isError) throw new Error(`${name} failed: ${out.text}`);
    log('  ✓', (out?.text ?? '').split('\n')[0].slice(0, 120));
    return out;
  };

  try {
    await step('setup', () => client.callText('godot_setup', { project_root: project }));
    await step('doctor', () => client.callText('godot_doctor', { project_root: project }));
    await step('build', () => client.callText('godot_build', { project_root: project }));
    await step('api_search', () => client.callText('godot_api_search', { project_root: project, query: 'CharacterBody2D' }));
    await step('api_doc', () => client.callText('godot_api_doc', { project_root: project, class_name: 'Node2D', members: false }));

    const run = await step('run (live)', () => client.callText('godot_run', { project_root: project, live: true }));
    log('   ', run.text.replace(/\n/g, ' | '));

    // Give the window a moment to come up before live control.
    await new Promise((r) => setTimeout(r, 2500));

    await step('engine_info', () => client.callText('godot_engine_info', {}));
    await step('scene_tree', () => client.callText('godot_scene_tree', {}));
    await step('eval', () => client.callText('godot_eval', { expression: 'Engine.get_frames_per_second()' }));

    const shot = await step('screenshot', () => client.callText('godot_screenshot', { embed: false }));
    log('   ', shot.text);

    await step('stop', () => client.callText('godot_stop', {}));
    log('ALL STEPS PASSED');
  } finally {
    client.close();
    if (!argProject) await fs.rm(project, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[live-smoke] FAILED:', err.message);
  process.exit(1);
});
