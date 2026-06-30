//! Manages AI coding-agent launch configurations and the processes spawned from
//! them. An agent config is a named command template; placeholders are filled in
//! with the running server URL and project root at launch time.

use std::collections::HashMap;
use std::process::{Child, Command};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    /// Command template. Supports {url}, {host}, {port} and {project} placeholders.
    pub command: String,
    #[serde(default)]
    pub working_dir: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AgentStatus {
    pub id: String,
    pub name: String,
    pub running: bool,
    pub pid: Option<u32>,
}

#[derive(Default)]
pub struct AgentManager {
    configs: Vec<AgentConfig>,
    running: HashMap<String, Child>,
    counter: u64,
}

pub struct LaunchContext<'a> {
    pub url: &'a str,
    pub host: &'a str,
    pub port: u16,
    pub project: Option<&'a str>,
}

impl AgentManager {
    pub fn new() -> Self {
        // A couple of sensible defaults pointing at common MCP-capable agents.
        AgentManager {
            configs: vec![
                AgentConfig {
                    id: "claude-code".into(),
                    name: "Claude Code".into(),
                    command: "claude mcp add --transport http godot {url}".into(),
                    working_dir: None,
                },
                AgentConfig {
                    id: "inspector".into(),
                    name: "MCP Inspector".into(),
                    command: "npx @modelcontextprotocol/inspector".into(),
                    working_dir: None,
                },
            ],
            running: HashMap::new(),
            counter: 0,
        }
    }

    pub fn list(&mut self) -> Vec<AgentStatus> {
        // Reap finished processes before reporting.
        let finished: Vec<String> = self
            .running
            .iter_mut()
            .filter_map(|(id, child)| match child.try_wait() {
                Ok(Some(_)) => Some(id.clone()),
                _ => None,
            })
            .collect();
        for id in finished {
            self.running.remove(&id);
        }

        self.configs
            .iter()
            .map(|c| AgentStatus {
                id: c.id.clone(),
                name: c.name.clone(),
                running: self.running.contains_key(&c.id),
                pid: self.running.get(&c.id).map(|child| child.id()),
            })
            .collect()
    }

    pub fn configs(&self) -> Vec<AgentConfig> {
        self.configs.clone()
    }

    pub fn add(
        &mut self,
        name: String,
        command: String,
        working_dir: Option<String>,
    ) -> AgentConfig {
        self.counter += 1;
        let cfg = AgentConfig {
            id: format!("agent-{}", self.counter),
            name,
            command,
            working_dir,
        };
        self.configs.push(cfg.clone());
        cfg
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if let Some(mut child) = self.running.remove(id) {
            let _ = child.kill();
        }
        let before = self.configs.len();
        self.configs.retain(|c| c.id != id);
        if self.configs.len() == before {
            return Err(format!("No agent with id {id}"));
        }
        Ok(())
    }

    pub fn launch(&mut self, id: &str, ctx: LaunchContext) -> Result<AgentStatus, String> {
        let cfg = self
            .configs
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("No agent with id {id}"))?
            .clone();

        if self.running.contains_key(id) {
            return Err(format!("Agent {} is already running", cfg.name));
        }

        let rendered = cfg
            .command
            .replace("{url}", ctx.url)
            .replace("{host}", ctx.host)
            .replace("{port}", &ctx.port.to_string())
            .replace("{project}", ctx.project.unwrap_or(""));

        let mut command = shell_command(&rendered);
        let work_dir = cfg
            .working_dir
            .clone()
            .or_else(|| ctx.project.map(|s| s.to_string()));
        if let Some(dir) = work_dir {
            command.current_dir(dir);
        }

        let child = command
            .spawn()
            .map_err(|e| format!("Failed to launch {}: {e}", cfg.name))?;
        self.running.insert(cfg.id.clone(), child);

        Ok(AgentStatus {
            id: cfg.id.clone(),
            name: cfg.name,
            running: true,
            pid: self.running.get(id).map(|c| c.id()),
        })
    }

    pub fn stop(&mut self, id: &str) -> Result<(), String> {
        if let Some(mut child) = self.running.remove(id) {
            let _ = child.kill();
            let _ = child.wait();
            Ok(())
        } else {
            Err(format!("Agent {id} is not running"))
        }
    }
}

/// Build a Command that runs `line` through the platform shell.
fn shell_command(line: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(line);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(line);
        c
    }
}
