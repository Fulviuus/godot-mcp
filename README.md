# godot-mcp-server

An [MCP](https://modelcontextprotocol.io) server that gives AI coding agents
first-class access to the [Godot](https://godotengine.org) game engine: project
inspection, `project.godot` editing, scene/script parsing, headless exports,
running games with **live control** (eval, scene-tree inspection, hot reload and
screenshots), and version-accurate API documentation search.

It targets **Godot 4.7** and works without the editor open — agents drive Godot
through its command line and a small in-game bridge. An optional desktop app
manages the server and wires it into your AI agents in one click.

It ships **180+ tools**: a native suite (28 `godot_*` tools for project/build/run/
docs) plus a vendored **full-control suite** (154 `game_*`/scene/editor tools) for
deep runtime and editor manipulation — see
[Full-control tool suite](#full-control-tool-suite).

> This is the Godot counterpart to
> [defold-mcp](https://github.com/Fulviuus/defold-mcp), built with the same
> architecture.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Tools](#tools)
- [The live-control bridge](#the-live-control-bridge)
- [Full-control tool suite](#full-control-tool-suite)
- [Desktop app](#desktop-app)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

## Features

- **Project parsing** — turn `project.godot`, `.tscn`/`.tres` scenes and
  `.gd`/`.cs` scripts into structured JSON (node trees, signals, exports,
  connections, outlines).
- **Toolchain management** — resolve the project's target version, download and
  cache the matching editor binary and export templates, or use a binary you
  already have (`GODOT_BIN`).
- **Build pipeline** — headless import (compile check), multi-mode exports
  (release/debug/pack) from your presets, clean, and a `doctor` diagnostic.
- **Runtime control** — launch games as child processes, stream logs, stop them,
  and (with the bridge) inspect the live scene tree, evaluate expressions, set
  node properties, hot-reload scripts, and capture screenshots.
- **API docs** — search and read the Godot class reference for the exact engine
  version in use (generated locally via `--doctool`, with a GitHub fallback).
- **Two transports** — stdio (default) or HTTP, so multiple agents can share one
  server.
- **Desktop manager** — an optional Tauri app: live console, start/stop, and
  one-click MCP setup for 9 AI agents.

## Requirements

- **Node.js 18+**
- A **Godot 4.x** editor binary — the server can download one automatically, or
  you can point it at an existing install with `GODOT_BIN`.
- Network access for the first toolchain/doc download (not needed afterwards, or
  at all if you set `GODOT_BIN` and skip docs search).

## Install

```bash
git clone https://github.com/Fulviuus/godot-mcp.git && cd godot-mcp
npm install
npm run build      # generates dist/index.js
npm test           # runs the test suite (optional)
```

## Configuration

Add the server to your MCP client. For a stdio config (Claude Code / Claude
Desktop style):

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/path/to/godot-mcp/dist/index.js"],
      "env": { "GODOT_PROJECT_ROOT": "/path/to/your/game" }
    }
  }
}
```

Or run it over HTTP (shared by multiple agents):

```bash
node dist/index.js --transport http --port 7878
# then point clients at http://127.0.0.1:7878/mcp
```

> Don't want to edit config files by hand? The [desktop app](#desktop-app) writes
> the right config into each agent for you.

### CLI options

| Flag | Default | Purpose |
| --- | --- | --- |
| `--transport <stdio\|http>` | `stdio` | Transport to serve on. |
| `--host <host>` | `127.0.0.1` | HTTP bind host. |
| `--port <port>` | `7878` | HTTP bind port. |
| `--exit-with-parent` | off | Exit when the controlling stdin/parent closes. |
| `--version`, `--help` | — | Print version / usage. |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `GODOT_PROJECT_ROOT` | Default project root (folder with `project.godot`). |
| `GODOT_BIN` | Path to a pre-installed Godot editor binary; skips downloads. |
| `GODOT_MCP_CACHE_DIR` | Where to cache editors/templates/docs (default `~/.cache/godot-mcp`). |
| `GODOT_MCP_MONO` | Set to `1` to use the .NET/Mono build. |
| `GODOT_MCP_LOG_LEVEL` | `debug` / `info` / `warn` / `error`. |
| `GODOT_PATH` | Godot executable for the full-control suite (falls back to `GODOT_BIN`, then PATH). |
| `GODOT_MCP_ADVANCED` | Set to `0` to disable the vendored full-control suite (register only the 28 native tools). |

Most tools also accept a `project_root` and `version` argument to override the
defaults per call.

## Tools

The **native suite** is 28 tools across eight areas. Every native tool accepts
`response_format: "markdown" | "json"`. (The vendored full-control suite adds 154
more — see the [next section](#full-control-tool-suite).)

| Area | Tools |
| --- | --- |
| **Project** | `godot_project_info`, `godot_get_settings`, `godot_set_setting`, `godot_list_addons` |
| **Resources** | `godot_list_resources`, `godot_parse_resource`, `godot_create_resource`, `godot_find_references` |
| **Build** | `godot_setup`, `godot_build`, `godot_export`, `godot_clean`, `godot_doctor` |
| **Runtime** | `godot_run`, `godot_stop`, `godot_game_logs`, `godot_list_games` |
| **Live engine** | `godot_engine_info`, `godot_scene_tree`, `godot_eval`, `godot_set_node_property`, `godot_hot_reload`, `godot_engine_command` |
| **Editor** | `godot_validate_script`, `godot_install_bridge` |
| **Screenshot** | `godot_screenshot` |
| **Docs** | `godot_api_search`, `godot_api_doc` |

A typical agent flow:

```text
godot_project_info            → understand the project
godot_setup                   → provision editor + templates + bridge
godot_build                   → confirm it imports/compiles
godot_run live:true           → launch with live control
godot_scene_tree / godot_eval → inspect the running game
godot_hot_reload              → apply script changes without restarting
godot_screenshot              → see the result
godot_export preset:"Linux"   → produce a build
```

## The live-control bridge

Godot's headless mode can't render and has no general runtime RPC, so live
control is provided by a tiny **bridge addon** (`addons/godot_mcp`) that
`godot_setup` (or `godot_run live:true`) installs into your project. It registers
an autoload that, *only when a port is provided*, opens a localhost TCP socket
speaking newline-delimited JSON. The server uses it for `godot_eval`,
`godot_scene_tree`, `godot_set_node_property`, `godot_hot_reload` and
`godot_screenshot`. It is inert during normal runs and easy to remove (delete the
`addons/godot_mcp` folder and the `MCPBridge` autoload).

## Full-control tool suite

Alongside the native tools, the server registers a **154-tool full-control
suite** vendored from [tugcantopaloglu/godot-mcp](https://github.com/tugcantopaloglu/godot-mcp)
(MIT), which extends [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp)
(MIT). It gives agents deep runtime and editor manipulation across networking,
3D/2D rendering, UI controls, audio, animation trees, physics, signals, file
I/O, runtime GDScript `eval`, node inspection/mutation, project creation and
more. Names are unprefixed (`game_eval`, `run_project`, `read_scene`,
`game_set_property`, `game_raycast`, `game_light_3d`, …) so they never collide
with the `godot_*` native tools.

It works through two channels, both driven by Godot-side engines shipped with the
server (`src/advanced/scripts/`):

- **Headless operations** (`godot_operations.gd`) — scene/resource/file/project
  tools run `godot --headless --script godot_operations.gd`; no running game
  needed. (Scene ops like `read_scene` need the project imported once — open it
  in the editor, or run `godot_build` / `godot --import`.)
- **Live interaction** (`mcp_interaction_server.gd`) — the ~120 `game_*` runtime
  tools talk to a TCP autoload (port **9090**) inside the running game. Call
  `run_project` to launch the game; it installs that autoload and connects
  automatically. (This is separate from the native `godot_run` bridge; use the
  suite that matches the tools you're calling.)

Set `GODOT_MCP_ADVANCED=0` to register only the 28 native tools. Point the suite
at your engine with `GODOT_PATH` (or reuse `GODOT_BIN`).

> Attribution and license terms for the vendored code are in
> [NOTICE](NOTICE); the vendored files carry source headers and everything is
> MIT-licensed.

## Desktop app

`desktop/` is an optional [Tauri](https://tauri.app) control panel (the Godot
counterpart to the defold-mcp manager). It supervises the server and connects it
to your agents without touching config files by hand:

- **Console** — a live stream of everything the server does (tool calls, export
  output, game logs, listener status).
- **Server control** — start/stop the server in Streamable HTTP mode on a chosen
  host/port (default `127.0.0.1:9820`), with a status pill showing the live tool
  count and PID.
- **Agent auto-configuration** — pick an agent and click **Configure**: the app
  merges a `godot` entry into that agent's own MCP config file (backing it up
  first) in the client's correct dialect, over HTTP or stdio. Supported agents:
  Claude Code, Claude Desktop, OpenAI Codex, Cursor, Gemini CLI, VS Code
  (Copilot), Windsurf, Cline, Zed. Files it can't safely edit (e.g. JSONC with
  comments) are never modified — it shows a paste-ready snippet instead.

The server is bundled into the app, so end users only need Node installed. See
[desktop/README.md](desktop/README.md) to build and run it.

## Architecture

```
src/
├── index.ts            Entry point: server construction, stdio/HTTP, lifecycle
├── http.ts             Streamable HTTP transport + /health
├── constants.ts        Versions, release-asset naming, cache locations
├── context.ts          Project-root resolution, res:// ↔ filesystem mapping
├── state.ts            Running-game registry + log buffers
├── util/               Parsers & helpers (ini, scene, gdscript, csharp, fs, http)
├── services/           Engine-facing logic (toolchain, processes, engine bridge,
│                       refdoc, screenshot, editor, templates)
└── tools/              MCP tool modules (project, resources, build, run, engine,
                        editor, screenshot, docs) + shared registration

desktop/                Optional Tauri desktop manager (see desktop/README.md)
test/                   node --test suite + a minimal Godot fixture project
```

The engine-specific layers map cleanly onto Godot: the `godot` editor binary +
export templates replace Defold's `bob.jar`; the text scene format replaces
protobuf; GDScript/C# replace Lua; and the bridge replaces Defold's TCP engine
service.

## Development

```bash
npm run dev          # run from source with tsx
npm run build        # type-check + emit dist/
npm test             # unit + server (stdio) + http tests
npm run bundle:server  # esbuild single-file bundle (used by the desktop app)
```

The toolchain-dependent flow (setup → build → run → eval → screenshot → export)
is covered by an opt-in smoke test that needs a real Godot install:

```bash
node test/live-smoke.mjs            # uses a temp copy of the fixture
node test/live-smoke.mjs /my/game   # or your own project
```

Desktop app (Rust/Tauri) tests:

```bash
cd desktop/src-tauri && cargo test   # config writers, merging, backups
```

## Credits

- The **full-control tool suite** (`src/advanced/`) is vendored from
  [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp) by
  [Tugcan Topaloglu](https://github.com/tugcantopaloglu), which extends
  [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by
  [Solomon Elias (Coding-Solo)](https://github.com/Coding-Solo). Both are MIT
  licensed. See [NOTICE](NOTICE).
- The native suite, transports, toolchain automation, tests, desktop app and
  packaging are original to this project, which mirrors the architecture of
  [defold-mcp](https://github.com/Fulviuus/defold-mcp).

## License

MIT — see [LICENSE](LICENSE). Vendored components are MIT; see [NOTICE](NOTICE).
