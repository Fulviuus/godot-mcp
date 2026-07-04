// Tests for the vendored "full control" tool suite integration: the tool
// definitions load, the JSON-Schema -> Zod converter behaves, and the tools are
// exposed over the MCP server alongside the native ones. Runtime behaviour of
// the game_* tools needs a live Godot game and is not exercised here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { StdioClient } from './_client.mjs';
import { GodotServer } from '../dist/advanced/godot-server.js';
import { jsonSchemaToShape } from '../dist/tools/advanced.js';

test('vendored server exposes a large, unique tool set', () => {
  const defs = new GodotServer().getToolDefinitions();
  assert.ok(defs.length >= 150, `expected 150+ tools, got ${defs.length}`);
  const names = defs.map((d) => d.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const d of defs) {
    assert.equal(typeof d.name, 'string');
    assert.equal(typeof d.description, 'string');
    assert.equal(d.inputSchema.type, 'object');
  }
  for (const expected of ['game_eval', 'run_project', 'read_scene', 'game_set_property', 'create_project']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('jsonSchemaToShape converts required/optional/enum correctly', () => {
  const shape = jsonSchemaToShape({
    type: 'object',
    properties: {
      nodePath: { type: 'string', description: 'a path' },
      count: { type: 'number' },
      mode: { type: 'string', enum: ['a', 'b', 'c'] },
      flag: { type: 'boolean' },
    },
    required: ['nodePath'],
  });
  assert.deepEqual(Object.keys(shape).sort(), ['count', 'flag', 'mode', 'nodePath']);
  // required field parses when present and rejects when missing
  assert.equal(shape.nodePath.isOptional(), false);
  assert.equal(shape.count.isOptional(), true);
  // enum accepts a valid member and rejects others
  assert.equal(shape.mode.unwrap().parse('a'), 'a');
  assert.throws(() => shape.mode.unwrap().parse('z'));
});

test('jsonSchemaToShape tolerates empty / arg-less schemas', () => {
  assert.deepEqual(jsonSchemaToShape(undefined), {});
  assert.deepEqual(jsonSchemaToShape({ type: 'object' }), {});
});

let client;
before(async () => {
  client = new StdioClient();
  await client.initialize();
});
after(() => client?.close());

test('advanced tools are registered on the running server', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.length >= 180, `expected 180+ total tools, got ${names.length}`);
  // native suite still present
  assert.ok(names.includes('godot_project_info'));
  // advanced suite present across categories
  for (const expected of ['game_eval', 'game_raycast', 'game_http_request', 'game_light_3d', 'read_scene', 'run_project']) {
    assert.ok(names.includes(expected), `missing advanced tool ${expected}`);
  }
});

test('GODOT_MCP_ADVANCED=0 disables the vendored suite', async () => {
  const lean = new StdioClient([], { GODOT_MCP_ADVANCED: '0' });
  try {
    await lean.initialize();
    const { tools } = await lean.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.every((n) => n.startsWith('godot_')), 'only native tools should remain');
    assert.ok(!names.includes('game_eval'));
  } finally {
    lean.close();
  }
});
