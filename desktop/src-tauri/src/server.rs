//! Supervises the godot-mcp-server child process: starts it over the HTTP
//! transport, captures its logs, reports status, and stops it cleanly.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;

const MAX_LOG_LINES: usize = 1000;

#[derive(Default)]
pub struct ServerManager {
    child: Option<Child>,
    port: u16,
    host: String,
    project_root: Option<String>,
    godot_bin: Option<String>,
    logs: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub host: String,
    pub url: String,
    pub project_root: Option<String>,
}

impl ServerManager {
    pub fn new() -> Self {
        ServerManager {
            host: "127.0.0.1".to_string(),
            port: 7878,
            logs: Arc::new(Mutex::new(VecDeque::new())),
            ..Default::default()
        }
    }

    fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
        if let Ok(mut guard) = logs.lock() {
            if guard.len() >= MAX_LOG_LINES {
                guard.pop_front();
            }
            guard.push_back(line);
        }
    }

    /// Start the server. `node_bin` is the Node executable, `server_js` the
    /// bundled server.cjs path resolved by the caller.
    pub fn start(
        &mut self,
        node_bin: &str,
        server_js: &str,
        host: String,
        port: u16,
        project_root: Option<String>,
        godot_bin: Option<String>,
    ) -> Result<ServerStatus, String> {
        if self.is_running() {
            return Err("Server is already running.".into());
        }

        let mut cmd = Command::new(node_bin);
        cmd.arg(server_js)
            .arg("--transport")
            .arg("http")
            .arg("--host")
            .arg(&host)
            .arg("--port")
            .arg(port.to_string())
            .arg("--exit-with-parent")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("GODOT_MCP_LOG_LEVEL", "info");

        if let Some(root) = &project_root {
            cmd.env("GODOT_PROJECT_ROOT", root);
        }
        if let Some(bin) = &godot_bin {
            if !bin.trim().is_empty() {
                cmd.env("GODOT_BIN", bin);
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to launch node ({node_bin}): {e}"))?;

        for stream in [
            child.stdout.take().map(Stream::Out),
            child.stderr.take().map(Stream::Err),
        ]
        .into_iter()
        .flatten()
        {
            let logs = Arc::clone(&self.logs);
            thread::spawn(move || stream.pump(&logs));
        }

        self.port = port;
        self.host = host;
        self.project_root = project_root;
        self.godot_bin = godot_bin;
        self.child = Some(child);

        Self::push_log(
            &self.logs,
            format!("[desktop] started server on {}:{}", self.host, self.port),
        );
        Ok(self.status())
    }

    pub fn stop(&mut self) -> Result<ServerStatus, String> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
            Self::push_log(&self.logs, "[desktop] stopped server".into());
        }
        Ok(self.status())
    }

    pub fn is_running(&mut self) -> bool {
        match self.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => {
                    self.child = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            },
            None => false,
        }
    }

    pub fn status(&self) -> ServerStatus {
        let pid = self.child.as_ref().map(|c| c.id());
        ServerStatus {
            running: pid.is_some(),
            pid,
            port: self.port,
            host: self.host.clone(),
            url: format!("http://{}:{}/mcp", self.host, self.port),
            project_root: self.project_root.clone(),
        }
    }

    pub fn logs(&self, tail: usize) -> Vec<String> {
        match self.logs.lock() {
            Ok(guard) => {
                let len = guard.len();
                let start = len.saturating_sub(tail);
                guard.iter().skip(start).cloned().collect()
            }
            Err(_) => Vec::new(),
        }
    }
}

/// Wraps a child stdout/stderr stream so both can be pumped with one routine.
enum Stream {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

impl Stream {
    fn pump(self, logs: &Arc<Mutex<VecDeque<String>>>) {
        match self {
            Stream::Out(s) => Self::read_lines(BufReader::new(s), logs, false),
            Stream::Err(s) => Self::read_lines(BufReader::new(s), logs, true),
        }
    }

    fn read_lines<R: BufRead>(reader: R, logs: &Arc<Mutex<VecDeque<String>>>, is_err: bool) {
        for line in reader.lines().map_while(Result::ok) {
            let prefixed = if is_err {
                format!("[err] {line}")
            } else {
                line
            };
            ServerManager::push_log(logs, prefixed);
        }
    }
}
