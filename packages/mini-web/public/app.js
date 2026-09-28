"use strict";

// 极简会话页：左会话、中消息流、下输入。codex 与 grok 共用，差异只在后端驱动。

const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
};

const state = {
  tool: "",
  label: "",
  groups: [],
  selection: { provider: "", modelId: "" },
  sessions: [],
  active: "",
  es: null,
  busy: false,
  cwd: localStorage.getItem("mcca.mini.cwd") || "",
  dir: { path: "", parent: "" },
};

const turn = { user: null, thinking: null, assistant: null, tools: new Map(), renderQueued: false };

// ── markdown（够用即可：代码块、标题、列表、引用、行内 code/粗斜体/链接）──────

function inline(parent, text) {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/;
  let rest = String(text || "");
  for (;;) {
    const hit = pattern.exec(rest);
    if (!hit) { parent.appendChild(document.createTextNode(rest)); return parent; }
    if (hit.index) parent.appendChild(document.createTextNode(rest.slice(0, hit.index)));
    const token = hit[0];
    if (token[0] === "`") {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith("*")) {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    } else {
      const split = token.slice(1, -1).indexOf("](");
      const label = token.slice(1, split);
      let href = token.slice(split + 2, -1);
      if (!/^https?:\/\//i.test(href)) href = "";
      const link = document.createElement(href ? "a" : "span");
      link.textContent = label;
      if (href) { link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; }
      parent.appendChild(link);
    }
    rest = rest.slice(hit.index + token.length);
  }
}

function renderMarkdown(host, text) {
  host.textContent = "";
  const blocks = String(text || "").split(/```/);
  blocks.forEach((chunk, index) => {
    if (index % 2 === 1) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = chunk.replace(/^[a-z0-9+#.-]*\n/i, "").replace(/\s+$/, "");
      pre.appendChild(code);
      host.appendChild(pre);
      return;
    }
    if (!chunk.trim()) return;
    let list = null;
    for (const line of chunk.replace(/\r/g, "").split("\n")) {
      const row = line.trim();
      if (!row) { list = null; continue; }
      const heading = /^(#{1,4})\s+(.*)$/.exec(row);
      const bullet = /^[-*+]\s+(.*)$/.exec(row);
      const numbered = /^\d+[.)]\s+(.*)$/.exec(row);
      const quote = /^>\s?(.*)$/.exec(row);
      let el;
      if (heading) {
        list = null;
        el = document.createElement("h4");
        inline(el, heading[2]);
      } else if (bullet || numbered) {
        const wantOrder = Boolean(numbered);
        if (!list || list.tagName === "OL" !== wantOrder) {
          list = document.createElement(wantOrder ? "ol" : "ul");
          host.appendChild(list);
        }
        el = document.createElement("li");
        inline(el, (bullet || numbered)[1]);
        list.appendChild(el);
        continue;
      } else if (quote) {
        list = null;
        el = document.createElement("blockquote");
        inline(el, quote[1]);
      } else {
        list = null;
        el = document.createElement("p");
        inline(el, row);
      }
      host.appendChild(el);
    }
  });
}

function when(ms) {
  const diff = Date.now() - Number(ms || 0);
  if (!Number.isFinite(diff) || diff < 0) return "";
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 时`;
  return `${Math.floor(diff / 86400000)} 天`;
}

// ── 消息流 ────────────────────────────────────────────────────────

function log() { return $("log"); }

function node(className, text) {
  const el = document.createElement("div");
  el.className = className;
  if (text != null) el.textContent = text;
  log().appendChild(el);
  return el;
}

function scrollDown() {
  const host = log();
  host.scrollTop = host.scrollHeight;
}

function closeTurn() {
  turn.thinking = null;
  turn.assistant = null;
  turn.tools.clear();
}

function appendUser(text) {
  const row = node("msg user");
  const body = document.createElement("div");
  renderMarkdown(body, text);
  row.appendChild(body);
  scrollDown();
}

function ensureThinking() {
  if (turn.thinking) return turn.thinking;
  const box = document.createElement("details");
  box.className = "think";
  const summary = document.createElement("summary");
  summary.textContent = "在想";
  const body = document.createElement("div");
  body.className = "think-body";
  box.append(summary, body);
  log().appendChild(box);
  turn.thinking = { box, body, text: "" };
  return turn.thinking;
}

function ensureAssistant() {
  if (turn.assistant) return turn.assistant;
  const row = node("msg assistant");
  const body = document.createElement("div");
  body.className = "body";
  row.appendChild(body);
  turn.assistant = { row, body, text: "" };
  return turn.assistant;
}

function flushAssistant() {
  if (turn.renderQueued || !turn.assistant) return;
  turn.renderQueued = true;
  requestAnimationFrame(() => {
    turn.renderQueued = false;
    if (turn.assistant) renderMarkdown(turn.assistant.body, turn.assistant.text);
    scrollDown();
  });
}

function toolRow(event) {
  const key = event.callId || `tool-${Date.now()}-${Math.random()}`;
  let row = turn.tools.get(key);
  if (!row) {
    const box = document.createElement("details");
    box.className = "tool";
    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = event.name || "tool";
    const args = document.createElement("span");
    args.className = "tool-args";
    args.textContent = String(event.args || "").replace(/\s+/g, " ").slice(0, 160);
    summary.append(name, args);
    const body = document.createElement("pre");
    body.className = "tool-out";
    box.append(summary, body);
    log().appendChild(box);
    row = { box, body, out: "" };
    turn.tools.set(key, row);
    if (turn.assistant) { turn.assistant = null; }
  }
  if (event.phase === "output" || (event.phase === "end" && event.output)) {
    row.out += (row.out ? "\n" : "") + String(event.output || "");
    row.body.textContent = row.out.slice(-8000);
    if (event.phase === "end") row.box.open = row.out.length < 1200 && Boolean(event.isError);
  }
  if (event.isError) row.box.classList.add("is-error");
  scrollDown();
  return row;
}

function noteLine(text, level) {
  const row = node("note" + (level ? ` is-${level}` : ""), text);
  return row;
}

function applyEvent(event) {
  if (!event || !event.type) return;
  switch (event.type) {
    case "user":
      closeTurn();
      appendUser(event.text);
      break;
    case "turn-start":
      closeTurn();
      setBusy(true);
      break;
    case "thinking-delta":
      ensureThinking().text += event.text || "";
      ensureThinking().body.textContent = ensureThinking().text;
      break;
    case "thinking-end":
      if (turn.thinking) turn.thinking = null;
      break;
    case "assistant-delta": {
      const block = ensureAssistant();
      block.text += event.text || "";
      flushAssistant();
      break;
    }
    case "assistant-end":
      if (event.error) noteLine(event.error, "error");
      if (turn.assistant) { renderMarkdown(turn.assistant.body, turn.assistant.text); turn.assistant = null; }
      if (turn.thinking) turn.thinking = null;
      break;
    case "turn-end":
      closeTurn();
      setBusy(false);
      loadSessions().catch(() => {});
      break;
    case "tool":
      toolRow(event);
      break;
    case "status":
      if (event.text) noteLine(event.text, event.level || "info");
      break;
    case "usage":
      if (event.totalTokens) $("hint").textContent = `${event.totalTokens.toLocaleString()} tokens${event.contextWindow ? ` / ${event.contextWindow.toLocaleString()}` : ""}`;
      break;
    default:
      break;
  }
}

function setBusy(busy) {
  state.busy = busy;
  $("stop").disabled = !busy;
  $("send").disabled = busy || !state.active;
  $("input").readOnly = false;
  if (busy) $("hint").textContent = "正在回答…";
  else if (/^正在回答/.test($("hint").textContent)) $("hint").textContent = "";
}

// ── 会话 ──────────────────────────────────────────────────────────

function renderSessions() {
  const host = $("sessions");
  host.textContent = "";
  for (const row of state.sessions) {
    const li = document.createElement("li");
    li.className = "session" + (row.id === state.active ? " is-active" : "");
    li.onclick = () => openSession(row.id);
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = row.title || "会话";
    const meta = document.createElement("span");
    meta.className = "session-meta";
    const cwd = String(row.cwd || "").split(/[\\/]/).filter(Boolean).pop();
    meta.textContent = [cwd, row.running ? "运行中" : when(row.updatedAt)].filter(Boolean).join(" · ");
    const del = document.createElement("button");
    del.className = "session-del";
    del.textContent = "×";
    del.title = "删除";
    del.onclick = (event) => { event.stopPropagation(); removeSession(row.id); };
    li.append(title, meta, del);
    host.appendChild(li);
  }
  if (!state.sessions.length) {
    const li = document.createElement("li");
    li.className = "session-empty";
    li.textContent = "还没有会话";
    host.appendChild(li);
  }
}

async function loadSessions() {
  const data = await api("/api/sessions");
  state.sessions = data.sessions || [];
  renderSessions();
}

function closeStream() {
  if (state.es) { state.es.close(); state.es = null; }
}

// 回合是否还在跑：从后往前找第一个真正的边界事件，忽略 usage / status /
// prompt-queue 这类信息帧（新会话刚建时就可能只有一帧 prompt-queue）。
function turnOpen(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = (events[i] && events[i].type) || "";
    if (type === "turn-end" || type === "assistant-end" || type === "user") return false;
    if (type === "turn-start" || type === "assistant-start" || type === "assistant-delta" || type === "thinking-delta" || type === "tool") return true;
  }
  return false;
}

async function openSession(id) {
  closeStream();
  state.active = id;
  localStorage.setItem("mcca.mini.session", id);
  log().textContent = "";
  closeTurn();
  $("empty").hidden = true;
  setBusy(false);
  renderSessions();
  const history = await api(`/api/sessions/${encodeURIComponent(id)}/history`);
  const events = (history.events || []).map((row) => row.event || row);
  for (const event of events) applyEvent(event);
  setBusy(turnOpen(events));
  const since = (history.events || []).length;
  state.es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream?since=${since}`);
  state.es.onmessage = (message) => {
    let event = null;
    try { event = JSON.parse(message.data); } catch { return; }
    applyEvent(event);
  };
  state.es.onerror = () => { $("hint").textContent = "连接断了，正在重连…"; };
}

async function newSession() {
  const choice = currentChoice();
  if (!choice.provider || !choice.modelId) { flash("先选服务商和模型"); return; }
  if (!state.cwd) { flash("先点右上角选一个目录"); return; }
  const created = await api("/api/sessions", { method: "POST", body: { cwd: state.cwd, provider: choice.provider, modelId: choice.modelId } });
  if (!created.id) { flash("建不起来：" + (created.error || "没有返回编号")); return; }
  await loadSessions().catch(() => {});
  await openSession(created.id);
  $("input").focus();
}

async function removeSession(id) {
  await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (state.active === id) { closeStream(); state.active = ""; log().textContent = ""; $("empty").hidden = false; }
  await loadSessions();
}

async function send() {
  const text = $("input").value.trim();
  if (!text || !state.active) return;
  if (state.busy) { flash("这一轮还没答完"); return; }
  $("input").value = "";
  const previous = $("hint").textContent;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.active)}/prompt`, { method: "POST", body: { text } });
    setBusy(true);
  } catch (error) {
    $("input").value = text;
    flash(error.message);
    $("hint").textContent = previous;
  }
}

async function stop() {
  if (!state.active) return;
  const result = await api(`/api/sessions/${encodeURIComponent(state.active)}/stop`, { method: "POST" }).catch((error) => ({ error: error.message }));
  if (result && result.error) flash(result.error);
  setBusy(false);
}

// ── 顶栏 ──────────────────────────────────────────────────────────

function currentChoice() {
  return { provider: $("provider").value, modelId: $("model").value };
}

function renderProviders() {
  const provider = $("provider");
  const model = $("model");
  const keep = currentChoice();
  provider.textContent = "";
  for (const group of state.groups) {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = group.name;
    provider.appendChild(option);
  }
  const chosen = state.groups.find((group) => group.id === (keep.provider || state.selection.provider)) || state.groups[0];
  provider.value = chosen ? chosen.id : "";
  const models = chosen ? chosen.models : [];
  const wantModel = keep.modelId || state.selection.modelId;
  model.textContent = "";
  for (const row of models) {
    const option = document.createElement("option");
    option.value = row.id;
    option.textContent = row.name;
    model.appendChild(option);
  }
  if (models.some((row) => row.id === wantModel)) model.value = wantModel;
}

async function saveChoice() {
  const choice = currentChoice();
  state.selection = choice;
  const result = await api("/api/provider", { method: "POST", body: choice }).catch((error) => ({ error: error.message }));
  if (result && result.error) flash(result.error);
}

function renderCwd() {
  $("cwd-name").textContent = state.cwd ? state.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] : "选目录";
  $("cwd-name").title = state.cwd || "还没选目录";
}

let flashTimer = null;
function flash(text) {
  $("hint").textContent = text;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (!state.busy) $("hint").textContent = ""; }, 5000);
}

// ── 目录浏览 ──────────────────────────────────────────────────────

async function browse(dir) {
  const data = await api(`/api/fs/list?path=${encodeURIComponent(dir || "")}`);
  state.dir = { path: data.cwd, parent: data.parent || "" };
  $("dir-path").textContent = data.cwd;
  $("dir-current").textContent = data.cwd;
  const host = $("dir-list");
  host.textContent = "";
  for (const row of data.entries) {
    const li = document.createElement("li");
    li.textContent = row.name;
    li.onclick = () => browse(row.full || `${data.cwd}/${row.name}`.replace(/\\/g, "/"));
    host.appendChild(li);
  }
  if (!data.entries.length) {
    const li = document.createElement("li");
    li.className = "dir-empty";
    li.textContent = "这层没有子目录";
    host.appendChild(li);
  }
}

function openDirModal() {
  $("dir-modal").hidden = false;
  browse(state.cwd || "");
}

// ── 启动 ──────────────────────────────────────────────────────────

async function boot() {
  const health = await api("/api/health").catch(() => ({ tool: "cli", label: "命令行" }));
  state.tool = health.tool;
  state.label = health.label;
  $("tool-name").textContent = health.label || "会话";
  document.title = `${health.label} · 简易会话`;
  const models = await api("/api/models").catch(() => ({ groups: [], selection: {} }));
  state.groups = models.groups || [];
  state.selection = models.selection || {};
  if (!state.groups.length) flash("pi 里还没有服务商，先去加一个");
  renderProviders();
  await loadSessions().catch((error) => flash(error.message));
  if (!state.cwd) {
    const workspaces = await api("/api/workspaces").catch(() => ({ workspaces: [] }));
    const first = (workspaces.workspaces || []).find((row) => row.default) || (workspaces.workspaces || [])[0];
    if (first) state.cwd = first.path;
  }
  renderCwd();
  const remember = localStorage.getItem("mcca.mini.session");
  const hit = state.sessions.find((row) => row.id === remember) || state.sessions[0];
  if (hit) openSession(hit.id).catch((error) => flash(error.message));
}

$("new-session").onclick = () => newSession().catch((error) => flash(error.message));
$("refresh-sessions").onclick = () => loadSessions().catch((error) => flash(error.message));
$("pick-cwd").onclick = openDirModal;
$("dir-close").onclick = () => { $("dir-modal").hidden = true; };
$("dir-up").onclick = () => browse(state.dir.parent);
$("dir-modal").onclick = (event) => { if (event.target === $("dir-modal")) $("dir-modal").hidden = true; };
$("dir-choose").onclick = async () => {
  state.cwd = state.dir.path;
  localStorage.setItem("mcca.mini.cwd", state.cwd);
  renderCwd();
  $("dir-modal").hidden = true;
  await api("/api/workspaces", { method: "POST", body: { path: state.cwd } }).catch(() => {});
};
$("provider").onchange = () => { renderProviders(); saveChoice(); };
$("model").onchange = saveChoice;
$("send").onclick = () => send().catch((error) => flash(error.message));
$("stop").onclick = () => stop().catch((error) => flash(error.message));
$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send().catch((error) => flash(error.message));
  }
});

boot();
