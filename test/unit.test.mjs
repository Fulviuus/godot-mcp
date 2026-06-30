// Unit tests for the pure parsing/utility layer (no server, no Godot binary).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE } from './_client.mjs';

import {
  parseConfig,
  serializeConfig,
  getRaw,
  setRaw,
  decodeValue,
  encodeValue,
  splitArgs,
} from '../dist/util/ini.js';
import { parseScene, collectReferencedPaths } from '../dist/util/scene.js';
import { parseGdScript } from '../dist/util/gdscript.js';
import { parseCSharp } from '../dist/util/csharp.js';
import {
  editorAssetName,
  templatesAssetName,
  parseVersionTag,
  versionTag,
  templatesDirName,
} from '../dist/constants.js';
import { normalizeResourcePath, resourceToAbsolute, absoluteToResource } from '../dist/context.js';

const read = (p) => readFileSync(path.join(FIXTURE, p), 'utf8');

test('ini: parses project.godot values', () => {
  const cfg = parseConfig(read('project.godot'));
  assert.equal(decodeValue(getRaw(cfg, 'application', 'config/name')), 'MCP Fixture');
  const features = decodeValue(getRaw(cfg, 'application', 'config/features'));
  assert.ok(Array.isArray(features) && features.includes('4.7'));
  assert.equal(decodeValue(getRaw(cfg, 'rendering', 'renderer/rendering_method')), 'forward_plus');
});

test('ini: preserves multi-line input action on round-trip', () => {
  const cfg = parseConfig(read('project.godot'));
  const jump = getRaw(cfg, 'input', 'jump');
  assert.ok(jump.includes('events'), 'jump action should retain its multi-line body');
  const out = serializeConfig(cfg);
  const reparsed = parseConfig(out);
  assert.equal(getRaw(reparsed, 'input', 'jump'), jump);
});

test('ini: setRaw then serialize keeps other values intact', () => {
  const cfg = parseConfig(read('project.godot'));
  setRaw(cfg, 'application', 'config/name', '"Renamed"');
  const reparsed = parseConfig(serializeConfig(cfg));
  assert.equal(decodeValue(getRaw(reparsed, 'application', 'config/name')), 'Renamed');
  assert.equal(decodeValue(getRaw(reparsed, 'application', 'run/main_scene')), 'res://main/main.tscn');
});

test('ini: value encode/decode round-trips', () => {
  assert.equal(decodeValue(encodeValue('a "quote"')), 'a "quote"');
  assert.equal(decodeValue('42'), 42);
  assert.equal(decodeValue('true'), true);
  assert.deepEqual(decodeValue('PackedStringArray("a", "b")'), ['a', 'b']);
  assert.deepEqual(splitArgs('1, "a,b", Vector2(2, 3)'), ['1', '"a,b"', 'Vector2(2, 3)']);
});

test('scene: parses a .tscn node tree', () => {
  const scene = parseScene(read('main/player.tscn'));
  assert.equal(scene.kind, 'scene');
  assert.equal(scene.format, 3);
  assert.equal(scene.extResources.length, 1);
  assert.equal(scene.extResources[0].path, 'res://main/player.gd');
  assert.equal(scene.subResources[0].type, 'RectangleShape2D');
  const names = scene.nodes.map((n) => n.name);
  assert.deepEqual(names, ['Player', 'Sprite2D', 'CollisionShape2D']);
  assert.equal(scene.nodes[0].path, '.');
  assert.equal(scene.nodes[1].path, 'Sprite2D');
  assert.equal(scene.connections[0].signal, 'died');
});

test('scene: parses a .tres resource', () => {
  const res = parseScene(read('data/level_one.tres'));
  assert.equal(res.kind, 'resource');
  assert.equal(res.resource.level_name, 'Tutorial');
  assert.equal(res.resource.enemy_count, 8);
  assert.ok(collectReferencedPaths(res).includes('res://scripts/level_data.gd'));
});

test('scene: instanced child node resolves nested path', () => {
  const scene = parseScene(read('main/main.tscn'));
  const camera = scene.nodes.find((n) => n.name === 'Camera2D');
  assert.equal(camera.path, 'Player/Camera2D');
  const player = scene.nodes.find((n) => n.name === 'Player');
  assert.ok(player.instance, 'player node should be an instance');
});

test('gdscript: outlines player.gd', () => {
  const o = parseGdScript(read('main/player.gd'));
  assert.equal(o.className, 'Player');
  assert.equal(o.extends, 'CharacterBody2D');
  assert.deepEqual(o.signals.map((s) => s.name).sort(), ['died', 'health_changed']);
  assert.deepEqual(o.constants.map((c) => c.name).sort(), ['GRAVITY', 'MAX_HEALTH']);
  assert.deepEqual(o.enums.map((e) => e.name), ['State']);
  const exported = o.variables.filter((v) => v.exported).map((v) => v.name).sort();
  assert.deepEqual(exported, ['jump_velocity', 'speed', 'starting_health']);
  const fns = o.functions.map((f) => f.name);
  assert.ok(fns.includes('_physics_process') && fns.includes('take_damage'));
  const describe = o.functions.find((f) => f.name === 'describe');
  assert.equal(describe.isStatic, true);
  assert.equal(describe.returnType, 'String');
});

test('csharp: outlines Enemy.cs', () => {
  const o = parseCSharp(read('scripts/Enemy.cs'));
  assert.equal(o.className, 'Enemy');
  assert.equal(o.extends, 'CharacterBody2D');
  assert.ok(o.signals.some((s) => s.name === 'Defeated'));
  const exported = o.variables.filter((v) => v.exported).map((v) => v.name).sort();
  assert.deepEqual(exported, ['ScoreValue', 'Speed']);
  assert.ok(o.constants.some((c) => c.name === 'MaxHealth'));
  const fns = o.functions.map((f) => f.name);
  assert.ok(fns.includes('_Ready') && fns.includes('TakeDamage'));
  assert.equal(o.functions.find((f) => f.name === 'Describe').isStatic, true);
});

test('constants: release asset names match Godot conventions', () => {
  const spec = parseVersionTag('4.7-stable');
  assert.equal(versionTag(spec), '4.7-stable');
  assert.equal(editorAssetName(spec, 'linux', 'x86_64', false), 'Godot_v4.7-stable_linux.x86_64.zip');
  assert.equal(editorAssetName(spec, 'windows', 'x86_64', false), 'Godot_v4.7-stable_win64.exe.zip');
  assert.equal(editorAssetName(spec, 'macos', 'arm64', false), 'Godot_v4.7-stable_macos.universal.zip');
  assert.equal(editorAssetName(spec, 'linux', 'x86_64', true), 'Godot_v4.7-stable_mono_linux_x86_64.zip');
  assert.equal(templatesAssetName(spec, false), 'Godot_v4.7-stable_export_templates.tpz');
  assert.equal(templatesAssetName(spec, true), 'Godot_v4.7-stable_mono_export_templates.tpz');
  assert.equal(templatesDirName(spec, false), '4.7.stable');
  assert.equal(templatesDirName(spec, true), '4.7.stable.mono');
});

test('context: resource path conversion round-trips and blocks traversal', () => {
  const root = FIXTURE;
  assert.equal(normalizeResourcePath('main/player.gd'), 'res://main/player.gd');
  assert.equal(normalizeResourcePath('res://main/player.gd'), 'res://main/player.gd');
  const abs = resourceToAbsolute(root, 'res://main/player.gd');
  assert.equal(absoluteToResource(root, abs), 'res://main/player.gd');
  assert.throws(() => resourceToAbsolute(root, 'res://../escape.gd'));
});
