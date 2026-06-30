# Godot MCP — Desktop Manager

A small [Tauri](https://tauri.app) desktop app that supervises `godot-mcp-server`
and the AI coding agents that connect to it. It is a convenience wrapper around
the same server you can run from the command line — nothing here is required to
use the MCP server.

## What it does

- **Server control** — start/stop the server over the HTTP transport, set the
  default project root and (optionally) a Godot binary, and watch live logs.
- **Agents** — keep a list of agent launch commands (templates with `{url}`,
  `{host}`, `{port}`, `{project}` placeholders) and start/stop them pointed at
  the running server. Ships with entries for Claude Code and the MCP Inspector.
- **Client config** — copy a ready-to-paste MCP client snippet for the running
  server.

## Architecture

```
desktop/
├── ui/                     Static frontend (no bundler; uses window.__TAURI__)
│   ├── index.html
│   ├── main.js
│   └── styles.css
└── src-tauri/
    ├── src/
    │   ├── main.rs         Thin binary entry point
    │   ├── lib.rs          Tauri commands + shared state
    │   ├── server.rs       Supervises the godot-mcp-server child process
    │   └── agents.rs       Launches/stops agent processes
    ├── resources/
    │   └── server.cjs      Bundled server (generated; see below)
    ├── icons/
    ├── tauri.conf.json
    └── Cargo.toml
```

The Rust side spawns `node resources/server.cjs --transport http ...` and streams
its stdout/stderr into an in-memory log buffer the UI polls.

## Building

Requires the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/)
(Rust toolchain, and the platform webview libraries) plus Node 18+.

```bash
# from the repo root, build the TypeScript server once:
npm install && npm run build

# then, in desktop/:
cd desktop
npm install
npm run dev      # bundles server.cjs and launches the app in dev mode
npm run build    # produces a distributable bundle
```

`npm run dev` / `npm run build` first run `npm run bundle:server` (from the repo
root) to regenerate `src-tauri/resources/server.cjs` via esbuild.

To regenerate the full icon set from `app-icon.png`:

```bash
npm run icon
```

## Notes

- The app spawns the system `node` to run the server. Override it with the
  `GODOT_MCP_NODE` environment variable if needed.
- Agent commands are run through the platform shell, so they can be anything from
  a one-shot `claude mcp add ...` to launching a long-running tool.
