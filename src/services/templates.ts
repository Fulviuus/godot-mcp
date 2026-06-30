/**
 * Static text templates: starter content for `create_resource`, and the source
 * of the `godot_mcp` bridge addon that, when installed as an autoload, gives the
 * server a live TCP control channel into a running game (eval, scene-tree dumps,
 * hot reload and screenshots).
 */

export type ResourceKind = 'gdscript' | 'csharp' | 'scene' | 'resource';

export interface TemplateOptions {
  /** For scripts: the base class to `extends` (e.g. "Node2D"). */
  base?: string;
  /** For scripts: optional `class_name`. */
  className?: string;
  /** For scenes: the root node type (e.g. "Node2D"). */
  rootType?: string;
  /** For scenes: the root node name. */
  rootName?: string;
}

export function gdScriptTemplate(options: TemplateOptions = {}): string {
  const base = options.base ?? 'Node';
  const lines: string[] = [];
  if (options.className) lines.push(`class_name ${options.className}`);
  lines.push(`extends ${base}`, '', '', 'func _ready() -> void:', '\tpass', '');
  return lines.join('\n');
}

export function csharpTemplate(options: TemplateOptions = {}): string {
  const base = options.base ?? 'Node';
  const className = options.className ?? 'NewScript';
  return [
    'using Godot;',
    '',
    `public partial class ${className} : ${base}`,
    '{',
    '    public override void _Ready()',
    '    {',
    '    }',
    '}',
    '',
  ].join('\n');
}

export function sceneTemplate(options: TemplateOptions = {}): string {
  const rootType = options.rootType ?? 'Node2D';
  const rootName = options.rootName ?? rootType;
  return [
    '[gd_scene format=3]',
    '',
    `[node name="${rootName}" type="${rootType}"]`,
    '',
  ].join('\n');
}

export function resourceTemplate(): string {
  return ['[gd_resource type="Resource" format=3]', '', '[resource]', '', ''].join('\n');
}

export function templateFor(kind: ResourceKind, options: TemplateOptions = {}): string {
  switch (kind) {
    case 'gdscript':
      return gdScriptTemplate(options);
    case 'csharp':
      return csharpTemplate(options);
    case 'scene':
      return sceneTemplate(options);
    case 'resource':
      return resourceTemplate();
  }
}

/** plugin.cfg for the installable bridge addon. */
export const BRIDGE_PLUGIN_CFG = `[plugin]

name="Godot MCP Bridge"
description="Live control bridge for godot-mcp-server. Opens a localhost TCP port (set via the GODOT_MCP_BRIDGE_PORT env var or --mcp-bridge-port=PORT user arg) that the MCP server uses for eval, scene-tree inspection, hot reload and screenshots."
author="godot-mcp"
version="1.0.0"
script="plugin.gd"
`;

/** Minimal EditorPlugin so the addon can be toggled in the editor UI. */
export const BRIDGE_PLUGIN_GD = `@tool
extends EditorPlugin
# The bridge runs at game runtime via the MCPBridge autoload; this EditorPlugin
# exists only so the addon shows up and can be enabled in Project Settings.
`;

/**
 * The runtime bridge autoload. It only starts listening when a port is provided
 * via the GODOT_MCP_BRIDGE_PORT env var or a --mcp-bridge-port=PORT user arg, so
 * it is inert during ordinary runs. Protocol: newline-delimited JSON requests,
 * one newline-delimited JSON reply each.
 */
export const BRIDGE_AUTOLOAD_GD = String.raw`extends Node
## godot-mcp live control bridge.
##
## Listens on a localhost TCP port and answers newline-delimited JSON commands
## from godot-mcp-server. Inert unless a port is configured.

var _server: TCPServer = null
var _peer: StreamPeerTCP = null
var _buffer: String = ""
var _port: int = 0

func _ready() -> void:
	_port = _resolve_port()
	if _port <= 0:
		return
	_server = TCPServer.new()
	var err := _server.listen(_port, "127.0.0.1")
	if err != OK:
		push_warning("[godot-mcp] bridge failed to listen on %d: %d" % [_port, err])
		_server = null
		return
	print("[godot-mcp] bridge listening on 127.0.0.1:%d" % _port)

func _resolve_port() -> int:
	var env := OS.get_environment("GODOT_MCP_BRIDGE_PORT")
	if env != "" and env.is_valid_int():
		return env.to_int()
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--mcp-bridge-port="):
			var v := arg.get_slice("=", 1)
			if v.is_valid_int():
				return v.to_int()
	return 0

func _process(_delta: float) -> void:
	if _server == null:
		return
	if _peer == null and _server.is_connection_available():
		_peer = _server.take_connection()
	if _peer == null:
		return
	_peer.poll()
	if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_peer = null
		_buffer = ""
		return
	var available := _peer.get_available_bytes()
	if available > 0:
		var chunk := _peer.get_data(available)
		if chunk[0] == OK:
			_buffer += (chunk[1] as PackedByteArray).get_string_from_utf8()
	while _buffer.contains("\n"):
		var idx := _buffer.find("\n")
		var line := _buffer.substr(0, idx)
		_buffer = _buffer.substr(idx + 1)
		if line.strip_edges() != "":
			_handle_line(line)

func _handle_line(line: String) -> void:
	var parsed = JSON.parse_string(line)
	if typeof(parsed) != TYPE_DICTIONARY:
		_reply({"ok": false, "error": "invalid request"})
		return
	var id = parsed.get("id", null)
	var reply := _dispatch(parsed)
	if id != null:
		reply["id"] = id
	_reply(reply)

func _dispatch(req: Dictionary) -> Dictionary:
	var cmd := String(req.get("cmd", ""))
	match cmd:
		"ping":
			return {"ok": true, "pong": true}
		"info":
			return {"ok": true, "info": _engine_info()}
		"scene_tree":
			return {"ok": true, "tree": _dump_tree(get_tree().current_scene, int(req.get("max_depth", 100)))}
		"eval":
			return _eval(String(req.get("expression", "")))
		"set_property":
			return _set_property(String(req.get("node", "")), String(req.get("property", "")), req.get("value"))
		"reload":
			return _reload(req)
		"screenshot":
			return _screenshot()
		"quit":
			get_tree().quit()
			return {"ok": true}
		_:
			return {"ok": false, "error": "unknown command: " + cmd}

func _engine_info() -> Dictionary:
	var scene := get_tree().current_scene
	return {
		"version": Engine.get_version_info(),
		"frames": Engine.get_frames_drawn(),
		"fps": Engine.get_frames_per_second(),
		"current_scene": scene.scene_file_path if scene else "",
		"node_count": get_tree().get_node_count(),
	}

func _dump_tree(node: Node, max_depth: int, depth: int = 0) -> Dictionary:
	if node == null:
		return {}
	var data := {
		"name": node.name,
		"type": node.get_class(),
		"path": str(node.get_path()),
	}
	if node.get_script() != null:
		data["script"] = node.get_script().resource_path
	if depth < max_depth:
		var children := []
		for child in node.get_children():
			children.append(_dump_tree(child, max_depth, depth + 1))
		if children.size() > 0:
			data["children"] = children
	return data

func _eval(expression: String) -> Dictionary:
	if expression.strip_edges() == "":
		return {"ok": false, "error": "empty expression"}
	var expr := Expression.new()
	var err := expr.parse(expression, ["tree", "root", "scene"])
	if err != OK:
		return {"ok": false, "error": "parse error: " + expr.get_error_text()}
	var scene := get_tree().current_scene
	var result = expr.execute([get_tree(), get_tree().root, scene], self, true)
	if expr.has_execute_failed():
		return {"ok": false, "error": "execute failed: " + expr.get_error_text()}
	return {"ok": true, "result": str(result)}

func _set_property(node_path: String, property: String, value) -> Dictionary:
	var node := get_node_or_null(NodePath(node_path))
	if node == null:
		node = get_tree().current_scene.get_node_or_null(NodePath(node_path)) if get_tree().current_scene else null
	if node == null:
		return {"ok": false, "error": "node not found: " + node_path}
	node.set(property, value)
	return {"ok": true, "result": str(node.get(property))}

func _reload(req: Dictionary) -> Dictionary:
	var reloaded := []
	var scripts = req.get("scripts", [])
	if scripts is Array:
		for path in scripts:
			var res = ResourceLoader.load(str(path), "", ResourceLoader.CACHE_MODE_REPLACE)
			if res is GDScript:
				res.reload(true)
			reloaded.append(str(path))
	if bool(req.get("reload_scene", false)):
		get_tree().reload_current_scene()
		reloaded.append("<current_scene>")
	return {"ok": true, "reloaded": reloaded}

func _screenshot() -> Dictionary:
	var viewport := get_viewport()
	if viewport == null:
		return {"ok": false, "error": "no viewport"}
	var img := viewport.get_texture().get_image()
	if img == null:
		return {"ok": false, "error": "no image (headless?)"}
	var bytes := img.save_png_to_buffer()
	return {"ok": true, "png_base64": Marshalls.raw_to_base64(bytes), "width": img.get_width(), "height": img.get_height()}

func _reply(obj: Dictionary) -> void:
	if _peer == null:
		return
	var text := JSON.stringify(obj) + "\n"
	_peer.put_data(text.to_utf8_buffer())
`;

/** Relative paths used when installing the bridge into a project. */
export const BRIDGE_FILES = {
  pluginCfg: 'addons/godot_mcp/plugin.cfg',
  pluginGd: 'addons/godot_mcp/plugin.gd',
  autoloadGd: 'addons/godot_mcp/mcp_bridge.gd',
  autoloadName: 'MCPBridge',
} as const;
