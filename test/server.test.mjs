// End-to-end tests over the MCP stdio transport. These exercise tools that do
// not require a Godot binary or network access (project/resource/editor file
// operations). Toolchain-dependent tools (setup/build/export/run/docs) are
// covered by test/live-smoke.mjs, which is opt-in.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StdioClient, FIXTURE } from './_client.mjs';

let client;
let tempProject;

before(async () => {
  client = new StdioClient();
  await client.initialize();
  // A writable copy of the fixture for mutation tests.
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'godot-mcp-test-'));
  await fs.cp(FIXTURE, tempProject, { recursive: true });
});

after(async () => {
  client?.close();
  if (tempProject) await fs.rm(tempProject, { recursive: true, force: true }).catch(() => {});
});

test('tools/list exposes the expected surface', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.length >= 25, `expected many tools, got ${names.length}`);
  for (const expected of [
    'godot_project_info',
    'godot_get_settings',
    'godot_set_setting',
    'godot_list_resources',
    'godot_parse_resource',
    'godot_create_resource',
    'godot_find_references',
    'godot_setup',
    'godot_export',
    'godot_run',
    'godot_hot_reload',
    'godot_screenshot',
    'godot_api_search',
    'godot_api_doc',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test('godot_project_info summarises the fixture', async () => {
  const { data, isError } = await client.callJson('godot_project_info', { project_root: FIXTURE });
  assert.equal(isError, false);
  assert.equal(data.name, 'MCP Fixture');
  assert.equal(data.engine_version, '4.7');
  assert.equal(data.main_scene, 'res://main/main.tscn');
  assert.ok(data.autoloads.some((a) => a.name === 'GameState'));
  assert.ok(data.input_actions.includes('jump'));
  assert.ok(data.resource_counts.gdscripts >= 3);
  assert.ok(data.resource_counts.csharp >= 1);
});

test('godot_get_settings can filter by section', async () => {
  const { data } = await client.callJson('godot_get_settings', { project_root: FIXTURE, section: 'application' });
  assert.ok(data.items.every((e) => e.section === 'application'));
  assert.ok(data.items.some((e) => e.key === 'config/name'));
});

test('godot_list_resources filters by extension', async () => {
  const { data } = await client.callJson('godot_list_resources', { project_root: FIXTURE, extension: 'gd', limit: 100 });
  assert.ok(data.items.includes('res://main/player.gd'));
  assert.ok(data.items.every((p) => p.endsWith('.gd')));
});

test('godot_parse_resource handles scenes, gdscript and csharp', async () => {
  const scene = await client.callJson('godot_parse_resource', { project_root: FIXTURE, resource: 'res://main/player.tscn' });
  assert.equal(scene.data.kind, 'scene');
  assert.equal(scene.data.nodes.length, 3);

  const gd = await client.callJson('godot_parse_resource', { project_root: FIXTURE, resource: 'main/player.gd' });
  assert.equal(gd.data.className, 'Player');

  const cs = await client.callJson('godot_parse_resource', { project_root: FIXTURE, resource: 'scripts/Enemy.cs' });
  assert.equal(cs.data.className, 'Enemy');
});

test('godot_parse_resource errors on a missing resource', async () => {
  const { isError, text } = await client.callText('godot_parse_resource', { project_root: FIXTURE, resource: 'res://nope.tscn' });
  assert.equal(isError, true);
  assert.match(text, /not found/i);
});

test('godot_find_references locates users of a script', async () => {
  const { data } = await client.callJson('godot_find_references', { project_root: FIXTURE, resource: 'res://main/player.gd' });
  const refs = data.items.map((m) => m.resource);
  assert.ok(refs.includes('res://main/player.tscn'));
});

test('godot_set_setting round-trips through project.godot', async () => {
  const set = await client.callText('godot_set_setting', {
    project_root: tempProject,
    section: 'application',
    key: 'config/name',
    value: 'Renamed Fixture',
  });
  assert.equal(set.isError, false);
  const { data } = await client.callJson('godot_project_info', { project_root: tempProject });
  assert.equal(data.name, 'Renamed Fixture');
  // Unrelated settings survive the rewrite.
  assert.equal(data.main_scene, 'res://main/main.tscn');
  assert.ok(data.input_actions.includes('jump'));
});

test('godot_create_resource writes a new script', async () => {
  const res = await client.callText('godot_create_resource', {
    project_root: tempProject,
    resource: 'res://scripts/new_thing.gd',
    kind: 'gdscript',
    base: 'Node2D',
    class_name: 'NewThing',
  });
  assert.equal(res.isError, false);
  const written = await fs.readFile(path.join(tempProject, 'scripts', 'new_thing.gd'), 'utf8');
  assert.match(written, /class_name NewThing/);
  assert.match(written, /extends Node2D/);

  const parsed = await client.callJson('godot_parse_resource', { project_root: tempProject, resource: 'scripts/new_thing.gd' });
  assert.equal(parsed.data.className, 'NewThing');
});

test('godot_install_bridge installs the addon and autoload', async () => {
  const res = await client.callText('godot_install_bridge', { project_root: tempProject });
  assert.equal(res.isError, false);
  const bridge = await fs.readFile(path.join(tempProject, 'addons', 'godot_mcp', 'mcp_bridge.gd'), 'utf8');
  assert.match(bridge, /TCPServer/);
  const { data } = await client.callJson('godot_project_info', { project_root: tempProject });
  assert.ok(data.autoloads.some((a) => a.name === 'MCPBridge'));
});

test('godot_list_games is empty before anything runs', async () => {
  const { data } = await client.callJson('godot_list_games', {});
  assert.deepEqual(data.games, []);
});
