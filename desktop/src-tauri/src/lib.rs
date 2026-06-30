//! Tauri application wiring: shared state, command handlers exposed to the UI,
//! and the entry point invoked by `main.rs`.

mod agents;
mod server;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use agents::{AgentConfig, AgentManager, AgentStatus, LaunchContext};
use server::{ServerManager, ServerStatus};

struct AppState {
    server: Mutex<ServerManager>,
    agents: Mutex<AgentManager>,
}

#[derive(Serialize)]
struct ClientConfig {
    /// A ready-to-paste MCP client config snippet (HTTP transport).
    http: serde_json::Value,
    /// A stdio variant for clients that prefer to spawn the server directly.
    stdio: serde_json::Value,
}

/// Resolve the bundled server.cjs path, falling back to a sibling dist build
/// during development.
fn server_js_path(app: &AppHandle) -> Result<String, String> {
    if let Ok(p) = app
        .path()
        .resolve("resources/server.cjs", tauri::path::BaseDirectory::Resource)
    {
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    // Dev fallback: ../../dist/index.js relative to the crate.
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("dist")
        .join("index.js");
    if dev.exists() {
        return Ok(dev.to_string_lossy().to_string());
    }
    Err("Could not locate server.cjs (run `npm run bundle:server` from the repo root).".into())
}

fn node_bin() -> String {
    std::env::var("GODOT_MCP_NODE").unwrap_or_else(|_| "node".to_string())
}

#[tauri::command]
fn start_server(
    app: AppHandle,
    state: State<AppState>,
    host: Option<String>,
    port: Option<u16>,
    project_root: Option<String>,
    godot_bin: Option<String>,
) -> Result<ServerStatus, String> {
    let server_js = server_js_path(&app)?;
    let mut server = state.server.lock().map_err(lock_err)?;
    server.start(
        &node_bin(),
        &server_js,
        host.unwrap_or_else(|| "127.0.0.1".to_string()),
        port.unwrap_or(7878),
        project_root,
        godot_bin,
    )
}

#[tauri::command]
fn stop_server(state: State<AppState>) -> Result<ServerStatus, String> {
    let mut server = state.server.lock().map_err(lock_err)?;
    server.stop()
}

#[tauri::command]
fn server_status(state: State<AppState>) -> Result<ServerStatus, String> {
    let mut server = state.server.lock().map_err(lock_err)?;
    server.is_running(); // reaps a dead child if needed
    Ok(server.status())
}

#[tauri::command]
fn server_logs(state: State<AppState>, tail: Option<usize>) -> Result<Vec<String>, String> {
    let server = state.server.lock().map_err(lock_err)?;
    Ok(server.logs(tail.unwrap_or(200)))
}

#[tauri::command]
fn list_agents(state: State<AppState>) -> Result<Vec<AgentStatus>, String> {
    let mut agents = state.agents.lock().map_err(lock_err)?;
    Ok(agents.list())
}

#[tauri::command]
fn agent_configs(state: State<AppState>) -> Result<Vec<AgentConfig>, String> {
    let agents = state.agents.lock().map_err(lock_err)?;
    Ok(agents.configs())
}

#[tauri::command]
fn add_agent(
    state: State<AppState>,
    name: String,
    command: String,
    working_dir: Option<String>,
) -> Result<AgentConfig, String> {
    let mut agents = state.agents.lock().map_err(lock_err)?;
    Ok(agents.add(name, command, working_dir))
}

#[tauri::command]
fn remove_agent(state: State<AppState>, id: String) -> Result<(), String> {
    let mut agents = state.agents.lock().map_err(lock_err)?;
    agents.remove(&id)
}

#[tauri::command]
fn launch_agent(state: State<AppState>, id: String) -> Result<AgentStatus, String> {
    let status = {
        let mut server = state.server.lock().map_err(lock_err)?;
        if !server.is_running() {
            return Err("Start the server before launching an agent.".into());
        }
        server.status()
    };
    let mut agents = state.agents.lock().map_err(lock_err)?;
    agents.launch(
        &id,
        LaunchContext {
            url: &status.url,
            host: &status.host,
            port: status.port,
            project: status.project_root.as_deref(),
        },
    )
}

#[tauri::command]
fn stop_agent(state: State<AppState>, id: String) -> Result<(), String> {
    let mut agents = state.agents.lock().map_err(lock_err)?;
    agents.stop(&id)
}

#[tauri::command]
fn client_config(state: State<AppState>) -> Result<ClientConfig, String> {
    let server = state.server.lock().map_err(lock_err)?;
    let status = server.status();
    let http = serde_json::json!({
        "mcpServers": {
            "godot": {
                "type": "http",
                "url": status.url,
            }
        }
    });
    let stdio = serde_json::json!({
        "mcpServers": {
            "godot": {
                "command": "node",
                "args": ["/absolute/path/to/godot-mcp/dist/index.js"],
                "env": {
                    "GODOT_PROJECT_ROOT": status.project_root.unwrap_or_default()
                }
            }
        }
    });
    Ok(ClientConfig { http, stdio })
}

fn lock_err<E>(_: E) -> String {
    "internal lock error".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            server: Mutex::new(ServerManager::new()),
            agents: Mutex::new(AgentManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            server_status,
            server_logs,
            list_agents,
            agent_configs,
            add_agent,
            remove_agent,
            launch_agent,
            stop_agent,
            client_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running godot-mcp desktop application");
}
