// Frontend logic for the Godot MCP desktop manager. Uses the global Tauri API
// (withGlobalTauri) to invoke Rust commands; degrades gracefully when opened in
// a plain browser for layout work.

const invoke = (cmd, args) => {
  if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke(cmd, args);
  return Promise.reject(new Error('Tauri API unavailable (open this through the desktop app).'));
};

const $ = (id) => document.getElementById(id);
const els = {
  badge: $('status-badge'),
  host: $('host'),
  port: $('port'),
  project: $('project'),
  godotBin: $('godot-bin'),
  start: $('start-btn'),
  stop: $('stop-btn'),
  url: $('server-url'),
  copyUrl: $('copy-url'),
  agentList: $('agent-list'),
  addForm: $('add-agent'),
  agentName: $('agent-name'),
  agentCmd: $('agent-cmd'),
  config: $('config-snippet'),
  copyConfig: $('copy-config'),
  logs: $('logs'),
  follow: $('follow'),
};

let currentUrl = '';
let httpSnippet = '';

function setRunning(status) {
  const running = !!status.running;
  els.badge.textContent = running ? 'running' : 'stopped';
  els.badge.className = `badge ${running ? 'badge-on' : 'badge-off'}`;
  els.start.disabled = running;
  els.stop.disabled = !running;
  for (const input of [els.host, els.port, els.project, els.godotBin]) input.disabled = running;
  currentUrl = status.url || '';
  els.url.textContent = running ? currentUrl : '';
  els.copyUrl.hidden = !running;
  if (running && status.project_root) els.project.value = status.project_root;
}

async function refreshStatus() {
  try {
    setRunning(await invoke('server_status'));
  } catch {
    /* ignore when not in app */
  }
}

async function refreshLogs() {
  try {
    const lines = await invoke('server_logs', { tail: 300 });
    els.logs.textContent = lines.join('\n');
    if (els.follow.checked) els.logs.scrollTop = els.logs.scrollHeight;
  } catch {
    /* ignore */
  }
}

function agentRow(agent) {
  const li = document.createElement('li');
  li.className = 'agent';
  li.innerHTML = `
    <div class="agent-meta">
      <span class="agent-name"><span class="dot ${agent.running ? 'on' : ''}"></span> ${escapeHtml(agent.name)}</span>
    </div>
    <div class="agent-actions">
      <button class="primary small" data-act="launch" ${agent.running ? 'disabled' : ''}>Launch</button>
      <button class="ghost small" data-act="stop" ${agent.running ? '' : 'disabled'}>Stop</button>
      <button class="link" data-act="remove">remove</button>
    </div>`;
  li.querySelector('[data-act="launch"]').onclick = () => guard(invoke('launch_agent', { id: agent.id }));
  li.querySelector('[data-act="stop"]').onclick = () => guard(invoke('stop_agent', { id: agent.id }));
  li.querySelector('[data-act="remove"]').onclick = () => guard(invoke('remove_agent', { id: agent.id }));
  return li;
}

async function refreshAgents() {
  try {
    const agents = await invoke('list_agents');
    els.agentList.replaceChildren(...agents.map(agentRow));
  } catch {
    /* ignore */
  }
}

async function refreshConfig() {
  try {
    const cfg = await invoke('client_config');
    httpSnippet = JSON.stringify(cfg.http, null, 2);
    els.config.textContent = httpSnippet;
  } catch {
    /* ignore */
  }
}

async function guard(promise) {
  try {
    await promise;
    await Promise.all([refreshStatus(), refreshAgents(), refreshConfig()]);
  } catch (err) {
    alert(err.message || String(err));
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'copied!';
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    /* ignore */
  }
}

els.start.onclick = () =>
  guard(
    invoke('start_server', {
      host: els.host.value.trim() || '127.0.0.1',
      port: Number(els.port.value) || 7878,
      projectRoot: els.project.value.trim() || null,
      godotBin: els.godotBin.value.trim() || null,
    }),
  );

els.stop.onclick = () => guard(invoke('stop_server'));
els.copyUrl.onclick = () => copyText(currentUrl, els.copyUrl);
els.copyConfig.onclick = () => copyText(httpSnippet, els.copyConfig);

els.addForm.onsubmit = (e) => {
  e.preventDefault();
  guard(
    invoke('add_agent', { name: els.agentName.value.trim(), command: els.agentCmd.value.trim(), workingDir: null }).then(
      () => {
        els.agentName.value = '';
        els.agentCmd.value = '';
      },
    ),
  );
};

// Initial load + polling.
refreshStatus();
refreshAgents();
refreshConfig();
setInterval(() => {
  refreshStatus();
  refreshLogs();
  refreshAgents();
}, 1500);
