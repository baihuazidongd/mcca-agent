/* pi web — 原生前端（像素 RPG 风）。 */
"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  sessionId: null,
  sessions: [],
  groups: [],
  levels: [],
  model: null, // {provider, modelId}
  thinking: null,
  thinkingExplicit: false, // 用户是否主动选过思考强度（false = pi 默认自选，UI 标「默认·X」）
  pulledLevels: [], // 「拉取」从活模型取到的真实可选思考级别（切模型后清空）
  streaming: false,
  es: null, // EventSource
  streamBubble: null, // 当前流式回复气泡（assistant-start 创建，end 收口）
  streamThink: null, // 当前流式思考块（首个 thinking-delta 创建，end 收口折叠）
  streamStart: 0, // 流式起始（performance.now，tok 速度计时）
  streamTokens: null, // 服务端随 delta 携带的部分用量（累计输出 tok）
  streamSpeedAt: 0, // 上次刷新速度显示的时刻（节流）
  avgTok: { tokens: 0, seconds: 0 }, // 会话平均生成速度（Σ输出 tok ÷ Σ解码秒，参考 DSH 统计条）
  replaying: false, // 历史回放中：跳过逐条滚动/链接化，降低切换会话的卡顿
  providers: [],
  editingProvider: null, // 当前设置弹窗编辑的服务商 id 或 null（新建）
  workspaces: [], // [{path, title, default?, custom?, derived?, count}]
  workspace: null, // 当前选中的工作区 path（null = 默认第一个）
  pfApi: "openai-completions", // 服务商表单的协议（自绘下拉）
  dd: {}, // 自绘下拉实例 {workspace, model, thinking, api}
  presetView: null, // /api/presets 视图
  editingPreset: null, // 预设编辑草稿 {id?, name, rules: [{id?, content, enabled}]}
  subagents: [],
  editingAgent: null,
  sessionSubagents: { agents: [], runs: [] },
  selectedRunAgent: null,
  stickBottom: true, // 用户向上翻阅历史时置 false，流式输出不再强制滚底
  pendingAttach: [], // 待发送附件：{kind:"image",name,mime,data} | {kind:"text",name,text}
  diffAll: [], // 当前会话全部改动文件（面板只显示最近 3 个）
  compactionModel: null, // 压缩/摘要用的省钱模型（null = 跟随会话模型）
};
const AGENT_STATUS_LABEL = {
  working: "工作中",
  completed: "已结束",
  stopped: "已关闭",
  failed: "失败",
  unknown: "状态待确认",
};
const AGENT_ROLES_ZH = {
  delegate: { title: "委派助手", description: "处理轻量委派任务，沿用主代理模型，默认不主动读取文件。" },
  oracle: { title: "决策顾问", description: "结合完整上下文分析复杂问题，检查决策一致性，避免偏离已确认的目标和约束。" },
  researcher: { title: "调研助手", description: "自主检索网络资料，评估信息来源，整理与任务相关的调研结论。" },
  reviewer: { title: "审查助手", description: "审查代码改动、实施计划和解决方案，检查代码质量及问题修复是否符合要求。" },
  scout: { title: "代码侦察", description: "快速查找代码入口和相关实现，梳理依赖关系，提供精简的代码上下文。" },
  worker: { title: "执行助手", description: "执行开发任务，修改代码、修复问题并验证结果，也可承接决策顾问确认的实施方案。" },
};
const AGENT_SOURCE_ZH = { builtin: "内置", package: "扩展包", user: "个人配置", project: "项目配置" };
function agentTitle(name) {
  return AGENT_ROLES_ZH[name]?.title || name || "子代理";
}
function agentDescription(agent) {
  return agent.source === "builtin" && AGENT_ROLES_ZH[agent.name]
    ? AGENT_ROLES_ZH[agent.name].description : (agent.description || "");
}
function cwdQuery() {
  return state.workspace ? `?cwd=${encodeURIComponent(state.workspace)}` : "";
}
function agentPayload() {
  const name = $("agent-name").value.trim();
  const description = $("agent-desc").value.trim();
  const model = $("agent-model").value.trim();
  const fallbackModels = $("agent-fallbacks").value.trim();
  const thinking = $("agent-thinking").value;
  const tools = $("agent-tools").value.trim();
  const systemPrompt = $("agent-prompt").value;
  const scope = $("agent-scope").value || "user";
  return {
    name,
    agent: name,
    description,
    model: model || undefined,
    fallbackModels: fallbackModels || undefined,
    thinking: thinking || undefined,
    tools: tools || undefined,
    systemPrompt,
    scope,
    agentScope: scope,
    cwd: state.workspace || undefined,
  };
}
function setAgentMsg(text) {
  const box = $("agent-msg");
  if (box) box.textContent = text || "";
}
function fillAgentModelOptions() {
  const sel = $("agent-model");
  if (!sel) return;
  const current = sel.value;
  const options = [el("option", { value: "" }, "继承")];
  for (const group of state.groups || []) {
    for (const model of group.models || []) {
      const value = `${group.id}/${model.id}`;
      options.push(el("option", { value }, `${group.name || group.id} / ${model.name || model.id}`));
    }
  }
  sel.replaceChildren(...options);
  if ([...sel.options].some((option) => option.value === current)) sel.value = current;
}
async function loadSubagents() {
  const r = await api("/api/subagents" + cwdQuery());
  state.subagents = r.agents || [];
  fillAgentModelOptions();
  renderAgentList();
  renderAgentDock();
}
function renderAgentList() {
  const box = $("agents-list");
  if (!box) return;
  box.replaceChildren(...state.subagents.map((agent) => el(
    "button",
    { class: "agent-row" + (state.editingAgent && state.editingAgent.name === agent.name ? " active" : ""), onclick: () => editAgent(agent) },
    el("div", {}, agentTitle(agent.name) + (agent.disabled ? " · 已关闭" : " · 已启用")),
    el("div", { class: "agent-description" }, agentDescription(agent)),
    el("div", { class: "src" }, `${agent.name} · ${AGENT_SOURCE_ZH[agent.source] || agent.source || ""} · ${agent.scope === "project" ? "当前项目" : "个人"}`),
  )));
}
function blankAgentForm() {
  state.editingAgent = null;
  $("agent-name").value = "";
  $("agent-name").readOnly = false;
  $("agent-desc").value = "";
  $("agent-model").value = "";
  $("agent-fallbacks").value = "";
  $("agent-thinking").value = "";
  $("agent-prompt").value = "";
  $("agent-tools").value = "";
  $("agent-scope").value = "user";
  setAgentMsg("");
  renderAgentList();
}
function editAgent(agent) {
  state.editingAgent = agent;
  $("agent-name").value = agent.name || "";
  $("agent-name").readOnly = Boolean(agent.name);
  $("agent-desc").value = agentDescription(agent);
  fillAgentModelOptions();
  $("agent-model").value = agent.model || "";
  $("agent-fallbacks").value = (agent.fallbackModels || []).join(",");
  $("agent-thinking").value = agent.thinking || "";
  $("agent-prompt").value = agent.systemPrompt || "";
  $("agent-tools").value = (agent.tools || []).join(",");
  $("agent-scope").value = agent.scope === "project" ? "project" : "user";
  setAgentMsg("");
  renderAgentList();
}
async function saveAgent() {
  const payload = agentPayload();
  if (!payload.name) return setAgentMsg("请填写名称");
  if (!state.editingAgent && !payload.description) return setAgentMsg("新建需要描述");
  try {
    setAgentMsg("");
    await api("/api/subagents", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, action: state.editingAgent ? "update" : "create" }),
    });
    await loadSubagents();
    const next = state.subagents.find((agent) => agent.name === payload.name);
    if (next) editAgent(next);
    else blankAgentForm();
  } catch (error) {
    setAgentMsg(error.message);
  }
}
async function setAgentEnabled(enabled) {
  const payload = agentPayload();
  if (!payload.name) return setAgentMsg("请先选择子代理");
  try {
    await api("/api/subagents", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: enabled ? "enable" : "disable", name: payload.name, agent: payload.name, agentScope: payload.agentScope, cwd: payload.cwd }),
    });
    await loadSubagents();
    const next = state.subagents.find((agent) => agent.name === payload.name);
    if (next) editAgent(next);
  } catch (error) {
    setAgentMsg(error.message);
  }
}
function isSubagentHistoryItem(item) {
  return Boolean(item && (item.child || /^subagent[-_]/i.test(String(item.title || "")) || /^subagent[-_]/i.test(String(item.name || ""))));
}
function selectedAgentRun(name, childId) {
  const runs = (state.sessionSubagents.runs || []).filter((run) => run.agent === name);
  return childId ? runs.find((run) => run.childSessionId === childId || run.id === childId)
    : runs.find((run) => run.status === "working") || runs[0];
}
function agentElapsed(run, now = Date.now()) {
  if (!run?.startedAt) return "耗时待确认";
  const end = run.endedAt || (run.status === "working" ? now : 0);
  if (!end) return "耗时待确认";
  const seconds = Math.max(0, Math.floor((end - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600
    ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
    : `${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
function updateAgentMetrics() {
  for (const node of document.querySelectorAll("[data-agent-timer]")) {
    const run = (state.sessionSubagents.runs || []).find((item) => item.id === node.dataset.agentTimer);
    node.textContent = agentElapsed(run);
  }
  if (!$("agent-run-dlg").open) return;
  const run = selectedAgentRun(state.selectedRunAgent, state.selectedChildId);
  const status = run?.stopRequested ? "正在停止" : AGENT_STATUS_LABEL[run?.status] || "状态待确认";
  $("agent-run-title").textContent = agentTitle(state.selectedRunAgent) + " · " + status;
  const summary = $("agent-run-summary");
  if (summary) summary.textContent = [
    "耗时：" + agentElapsed(run),
    "模型：" + (run?.model || "未记录"),
    run?.thinking ? "思考：" + ({ off: "关闭", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" }[run.thinking] || run.thinking) : "",
    run?.startedAt ? "开始：" + new Date(run.startedAt).toLocaleString("zh-CN", { hour12: false }) : "",
  ].filter(Boolean).join(" · ");
  const stop = $("agent-run-stop");
  stop.disabled = !run || run.status !== "working" || run.stopRequested;
  stop.dataset.runId = run?.status === "working" ? run.id : "";
  stop.textContent = run?.stopRequested ? "正在停止…" : "停止任务";
}
function renderAgentDock() {
  const box = $("agent-dock");
  if (!box) return;
  const agents = state.sessionSubagents.agents || [];
  box.hidden = !state.sessionId || agents.length === 0;
  box.replaceChildren(...agents.map((agent) => {
    const run = selectedAgentRun(agent.name);
    const status = run?.stopRequested ? "正在停止" : AGENT_STATUS_LABEL[agent.status] || AGENT_STATUS_LABEL.unknown;
    const conv = (agent.conversations && agent.conversations[0]) || null;
    return el(
      "button",
      {
        type: "button",
        class: "agent-cell " + (agent.status || "unknown"),
        title: agentTitle(agent.name) + "（" + agent.name + "） · " + status,
        onclick: () => openAgentRuns(agent.name, run?.childSessionId || agent.sessionId || (conv && conv.sessionId)),
      },
      agentAvatarImg(agent.name, 52),
      el("span", { class: "nm" }, agentTitle(agent.name)),
      el("span", { class: "tm", "data-agent-timer": run?.id || "" }, agentElapsed(run)),
    );
  }));
  updateAgentMetrics();
}
async function loadSessionSubagents() {
  if (!state.sessionId) {
    state.sessionSubagents = { agents: [], runs: [] };
    renderAgentDock();
    return;
  }
  try {
    const parentId = state.sessionId;
    const snapshot = await api(`/api/sessions/${encodeURIComponent(parentId)}/subagents`);
    if (state.sessionId !== parentId) return;
    state.sessionSubagents = snapshot || { agents: [], runs: [] };
    renderAgentDock();
  } catch {
    // 会话尚未建立时保持现有图标
  }
}
function applySubagentSnapshot(event) {
  const prev = Object.fromEntries((state.sessionSubagents.agents || []).map((agent) => [agent.name || agent.agent, agent]));
  const agents = (event.agents || []).map((agent) => {
    const old = prev[agent.name || agent.agent];
    return {
      ...agent,
      conversations: (agent.conversations && agent.conversations.length) ? agent.conversations : ((old && old.conversations) || []),
      sessionId: agent.sessionId || (old && old.sessionId) || "",
    };
  });
  state.sessionSubagents = {
    agents,
    runs: event.runs || state.sessionSubagents.runs || [],
  };
  renderAgentDock();
}
function threadNodes(events) {
  const nodes = [];
  for (const event of events || []) {
    if (event.type === "user" && event.text) {
      const userDiv = el("div", { class: "agent-msg user md" });
      renderMarkdown(userDiv, event.text);
      nodes.push(userDiv);
    }
    if (event.type === "assistant-end" && (event.text || event.error)) {
      const wrap = el("div", { class: "agent-msg assistant" });
      if (event.error) wrap.append(el("div", { class: "agent-err" }, "⚠ " + event.error));
      if (event.text) {
        const body = el("div", { class: "md" });
        renderMarkdown(body, event.text);
        wrap.append(body);
        for (const img of body.querySelectorAll("img")) {
          img.addEventListener("click", () => showLightbox(img.src, img.alt || img.title || ""));
        }
      }
      nodes.push(wrap);
    }
  }
  return nodes.length ? nodes : [el("p", { class: "dim" }, "还没有子代理对话")];
}
async function openAgentRuns(name, childId) {
  const agent = (state.sessionSubagents.agents || []).find((item) => item.name === name || item.agent === name) || { name, conversations: [] };
  const conversations = agent.conversations || [];
  const sessionId = childId || agent.sessionId || (conversations[0] && conversations[0].sessionId);
  state.selectedRunAgent = name;
  state.selectedChildId = sessionId || null;
  $("agent-run-title").textContent = agentTitle(name) + " · " + (AGENT_STATUS_LABEL[agent.status] || AGENT_STATUS_LABEL.unknown);
  const body = $("agent-run-body");
  const queue = conversations.length > 1 ? el("div", { class: "agent-queue" }, ...conversations.map((item, index) => el(
    "button",
    { class: "agent-q" + (item.sessionId === sessionId ? " on" : ""), onclick: () => openAgentRuns(name, item.sessionId) },
    "对话 " + (index + 1),
  ))) : null;
  const thread = el("div", { class: "agent-thread" }, el("p", { class: "dim" }, "加载对话…"));
  body.replaceChildren(...[queue, el("div", { id: "agent-run-summary", class: "agent-run-summary" }), thread].filter(Boolean));
  const working = selectedAgentRun(name, sessionId);
  $("agent-run-stop").disabled = !working;
  $("agent-run-stop").dataset.runId = working ? working.id : "";
  $("agent-run-dlg").showModal();
  updateAgentMetrics();
  const fallbackRun = selectedAgentRun(name, sessionId);
  if (!sessionId || !state.sessionId) {
    if (fallbackRun && (fallbackRun.task || fallbackRun.result)) {
      thread.replaceChildren(...threadNodes([
        fallbackRun.task ? { type: "user", text: fallbackRun.task } : null,
        fallbackRun.result ? { type: "assistant-end", text: fallbackRun.result } : null,
      ].filter(Boolean)));
      return;
    }
    thread.replaceChildren(el("p", { class: "dim" }, "还没有对应的子代理对话"));
    return;
  }
  try {
    const transcript = await api("/api/sessions/" + encodeURIComponent(state.sessionId) + "/subagents/" + encodeURIComponent(sessionId) + "/transcript");
    thread.replaceChildren(...threadNodes(transcript.events));
  } catch (error) {
    if (fallbackRun && (fallbackRun.task || fallbackRun.result)) {
      thread.replaceChildren(...threadNodes([
        fallbackRun.task ? { type: "user", text: fallbackRun.task } : null,
        fallbackRun.result ? { type: "assistant-end", text: fallbackRun.result } : null,
      ].filter(Boolean)));
      return;
    }
    thread.replaceChildren(el("p", { class: "dim" }, "加载失败：" + error.message));
  }
}
async function stopSelectedAgent() {
  const runId = $("agent-run-stop").dataset.runId;
  if (!runId || !state.sessionId) return;
  $("agent-run-stop").disabled = true;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/subagents/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    await loadSessionSubagents();
    updateAgentMetrics();
  } catch (error) {
    toast("停止失败：" + error.message);
    updateAgentMetrics();
  }
}
async function syncAgentStatus() {
  await Promise.all([loadSubagents(), loadSessionSubagents()]);
}
window.syncAgentStatus = syncAgentStatus;


// ── 像素头像（16×16 网格，shape-rendering 保持锯齿感） ─────────────

const AVATAR_ASSISTANT = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
  '<rect x="4" y="1" width="8" height="2" fill="#aab3c2"/><rect x="3" y="3" width="10" height="2" fill="#c3cad6"/>' +
  '<rect x="3" y="5" width="2" height="4" fill="#c3cad6"/><rect x="11" y="5" width="2" height="4" fill="#c3cad6"/>' +
  '<rect x="5" y="4" width="6" height="7" fill="#f0d8b4"/>' +
  '<rect x="4" y="5" width="1" height="3" fill="#8f99ab"/><rect x="11" y="5" width="1" height="3" fill="#8f99ab"/>' +
  '<rect x="6" y="6" width="1" height="2" fill="#2b2b3a"/><rect x="9" y="6" width="1" height="2" fill="#2b2b3a"/>' +
  '<rect x="7" y="8" width="2" height="1" fill="#d9a06b"/>' +
  '<rect x="4" y="12" width="8" height="4" fill="#3a5aa8"/>' +
  '<rect x="7" y="12" width="2" height="3" fill="#2c4178"/>' +
  '<rect x="3" y="13" width="1" height="3" fill="#e8c56a"/><rect x="12" y="13" width="1" height="3" fill="#e8c56a"/>' +
  "</svg>");

const AVATAR_USER = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">' +
  '<rect x="4" y="2" width="8" height="2" fill="#7a4f28"/><rect x="3" y="4" width="10" height="2" fill="#8a5c30"/>' +
  '<rect x="5" y="4" width="6" height="7" fill="#e8c39a"/>' +
  '<rect x="4" y="6" width="1" height="2" fill="#8a5c30"/><rect x="11" y="6" width="1" height="2" fill="#8a5c30"/>' +
  '<rect x="6" y="6" width="1" height="2" fill="#2b2b3a"/><rect x="9" y="6" width="1" height="2" fill="#2b2b3a"/>' +
  '<rect x="7" y="8" width="2" height="1" fill="#c98b5a"/>' +
  '<rect x="4" y="12" width="8" height="4" fill="#5d9450"/>' +
  '<rect x="7" y="12" width="2" height="3" fill="#4a7c3f"/>' +
  "</svg>");

/** 容量解析：支持 128000 / 256k / 1m（大小写、kb/mb 亦可），非法返回 undefined。 */
function parseCapacity(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return undefined;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(k|m|kb|mb)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const mult = m[2] === "k" || m[2] === "kb" ? 1000 : m[2] === "m" || m[2] === "mb" ? 1000000 : 1;
  const v = Math.round(n * mult);
  return v > 0 ? v : undefined;
}

/** 容量回显：整千显示 k、整百万显示 m，其余原样（262144 保持精确）。 */
function formatCapacity(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n % 1000000 === 0) return `${n / 1000000}m`;
  if (n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

function avatarImg(kind, size = 34, sessionId) {
  const img = document.createElement("img");
  img.src = kind === "user" ? AVATAR_USER : assistantAvatarSrc(sessionId);
  img.width = size;
  img.height = size;
  img.className = "pixelated c-avatar";
  img.alt = kind === "user" ? "你" : "PI 编程助手";
  return img;
}

// ── 像素角色头像（GameCoaster 素材）：主角每会话随机，子代理固定，idle 序列帧动画 ──

state.avatars = { main: [], agents: [], roles: {} };

/** 稳定字符串 hash → 非负整数。 */
function strHash(text) {
  let h = 5381;
  for (let i = 0; i < String(text).length; i++) h = ((h << 5) + h + String(text).charCodeAt(i)) >>> 0;
  return h;
}

/** 从列表里按 key 确定性取一个（同一 key 永远同一组帧）。 */
function hashPick(list, key) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[strHash(key) % list.length];
}

function assistantAvatarFrames(sessionId) {
  return hashPick(state.avatars.main, sessionId || state.sessionId || "pi") || null;
}

/** 子代理固定头像帧：内置角色一一定死，自定义代理按名字固定。 */
function agentAvatarFrames(name) {
  const role = state.avatars.roles && state.avatars.roles[name];
  if (role) return role;
  return hashPick(state.avatars.agents, name);
}

// 全局帧轮播 ticker：一个定时器驱动所有在册头像；img 离开 DOM 自动注销
const avatarAnims = new Set();
let avatarTicker = 0;
function registerAvatarAnim(img, frames) {
  if (!Array.isArray(frames) || frames.length < 2) return;
  const entry = { img, frames, i: 0 };
  img.src = `/avatars/${frames[0]}`;
  avatarAnims.add(entry);
  if (!avatarTicker) avatarTicker = setInterval(avatarTick, 220);
}
function avatarTick() {
  for (const entry of [...avatarAnims]) {
    if (!entry.img.isConnected) {
      avatarAnims.delete(entry);
      continue;
    }
    entry.i = (entry.i + 1) % entry.frames.length;
    entry.img.src = `/avatars/${entry.frames[entry.i]}`;
  }
  if (!avatarAnims.size && avatarTicker) {
    clearInterval(avatarTicker);
    avatarTicker = 0;
  }
}

function avatarImg(kind, size = 34, sessionId) {
  const img = document.createElement("img");
  if (kind === "user") {
    img.src = AVATAR_USER;
  } else {
    const frames = assistantAvatarFrames(sessionId);
    if (frames) registerAvatarAnim(img, frames);
    else img.src = AVATAR_ASSISTANT;
  }
  img.width = size;
  img.height = size;
  img.className = "pixelated c-avatar";
  img.alt = kind === "user" ? "你" : "PI 编程助手";
  return img;
}

function agentAvatarImg(name, size = 24) {
  const img = document.createElement("img");
  const frames = agentAvatarFrames(name);
  if (frames) registerAvatarAnim(img, frames);
  else img.src = AVATAR_ASSISTANT;
  img.width = size;
  img.height = size;
  img.className = "pixelated";
  img.alt = agentTitle(name);
  return img;
}

async function loadAvatars() {
  try {
    const m = await fetch("/avatars/manifest.json").then((r) => r.json());
    if (m && Array.isArray(m.main) && m.main.length) {
      state.avatars = m;
      renderSessions();     // 会话列表换头像
      renderAgentDock();    // 子代理坞换头像
    }
  } catch { /* 没素材就用默认像素小人 */ }
}

// ── 基础设施 ───────────────────────────────────────────────────────

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
}

let toastTimer;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/** 诊断上报：关键交互/页面错误打到服务端日志（排查浏览器环境问题用）。 */
function report(data) {
  try {
    fetch("/api/client-error", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ at: Date.now(), ua: navigator.userAgent.slice(0, 80), ...data }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* 上报失败不影响功能 */ }
}

window.addEventListener("error", (e) => report({ event: "page-error", message: String(e.message).slice(0, 300), file: String(e.filename).slice(-40), line: e.lineno }));
window.addEventListener("unhandledrejection", (e) => report({ event: "page-reject", message: String(e.reason && e.reason.message || e.reason).slice(0, 300) }));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

// ── 自绘下拉（替代原生 select） ────────────────────────────────────
//
// 菜单以 fixed 定位挂在 body/portal 顶层：不受任何 overflow 容器裁剪，
// 视口装不下时自动向上翻，打开一个会关掉其它的。

let currentMenuClose = null;
function closeCurrentMenu() {
  if (currentMenuClose) currentMenuClose();
}

function makeDropdown(container, opts) {
  const root = el("div", { class: "dd" });
  const btn = el("button", { class: "dd-btn", type: "button" });
  let menu = null;

  const close = () => {
    if (menu) {
      menu.remove();
      menu = null;
    }
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);
    if (currentMenuClose === close) currentMenuClose = null;
  };
  const onOutside = (e) => {
    if (root.contains(e.target) || (menu && menu.contains(e.target))) return;
    close();
  };
  const onScroll = (e) => {
    // 菜单自身的滚动不算（长列表要看）
    if (menu && e.target instanceof Node && menu.contains(e.target)) return;
    close();
  };

  const openMenu = () => {
    closeCurrentMenu();
    menu = el("div", { class: "dd-menu" + (opts.menuClass ? ` ${opts.menuClass}` : "") });
    if (opts.buildMenu) {
      opts.buildMenu(menu, close);
      if (!menu.children.length) menu.append(el("div", { class: "dd-empty" }, opts.emptyText || "（空）"));
    } else {
      const options = opts.getOptions();
      if (!options.length) menu.append(el("div", { class: "dd-empty" }, opts.emptyText || "（空）"));
      let lastGroup = null;
      for (const opt of options) {
        if (opt.group && opt.group !== lastGroup) {
          menu.append(el("div", { class: "dd-group" }, opt.group));
          lastGroup = opt.group;
        }
        const item = el("div", {
          class: "dd-item" + (opt.value === opts.getValue() && !opt.action ? " selected" : "") + (opt.action ? " action" : ""),
          title: opt.title || opt.label,
        }, opt.label);
        item.addEventListener("click", () => {
          close();
          opts.onPick(opt.value);
        });
        menu.append(item);
      }
    }
    const portal = opts.portal || document.body;
    portal.append(menu);

    // fixed 定位：按按钮矩形计算，视口越界自动收窄/上翻
    const rect = btn.getBoundingClientRect();
    const width = Math.max(rect.width, opts.menuMinWidth || 220);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.visibility = "hidden";
    menu.style.position = "fixed";
    // 先挂载量高度
    const menuH = Math.min(menu.offsetHeight, opts.menuMaxHeight || 320);
    menu.style.maxHeight = `${menuH}px`;
    // 内容自适应宽度（横排多列菜单）：总宽夹在视口内
    let w = width;
    if (opts.sizeToContent) {
      menu.style.maxWidth = `${vw - 16}px`;
      w = Math.min(menu.scrollWidth, vw - 16);
      menu.style.width = `${w}px`;
    } else {
      menu.style.width = `${width}px`;
    }
    if (opts.openRight) {
      // 起点固定：左缘贴按钮右缘，绝不左移覆盖其他区域
      let left = rect.right + 4;
      // 右边界：默认视口，可指定边界元素（如聊天面板右缘）
      const bound = opts.boundaryEl
        ? opts.boundaryEl.getBoundingClientRect().right - 8
        : vw - 8;
      if (opts.sizeToContent) {
        // 宽度放不下 → 菜单自身裁剪（列内横向滚动），起点不动
        w = Math.max(120, Math.min(menu.scrollWidth, bound - left));
        menu.style.width = `${w}px`;
      } else if (left + w > bound) {
        left = Math.max(8, bound - w);
      }
      menu.style.left = `${left}px`;
      let top = rect.top;
      if (opts.alignBottom) top = rect.bottom - menuH; // 菜单底边与按钮底边对齐
      top = Math.max(8, Math.min(top, vh - menuH - 8));
      menu.style.top = `${top}px`;
    } else {
      let left = opts.alignRight ? rect.right - w : rect.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      menu.style.left = `${left}px`;
      let top = rect.bottom + 4;
      if (top + menuH > vh - 8) top = Math.max(8, rect.top - menuH - 4);
      menu.style.top = `${top}px`;
    }
    menu.style.visibility = "";
    const sel = menu.querySelector(".dd-item.selected");
    if (sel) sel.scrollIntoView({ block: "nearest", inline: "nearest" });

    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    currentMenuClose = close;
  };

  btn.addEventListener("click", () => {
    if (menu) close();
    else openMenu();
  });
  root.append(btn);
  container.replaceChildren(root);
  const api = {
    refresh: () => {
      const current = opts.getOptions().find((o) => o.value === opts.getValue() && !o.action);
      const raw = current ? current.label : opts.placeholder || "—";
      const label = opts.displayLabel ? opts.displayLabel(current, raw) : raw;
      const kids = [];
      if (opts.leftLabel) kids.push(el("span", { class: "dd-key" }, opts.leftLabel));
      kids.push(el("span", { class: "dd-label" }, label));
      if (!opts.noCaret) kids.push(el("span", { class: "dd-caret" }, "▾"));
      btn.replaceChildren(...kids);
      // 有实际选中值（非占位/非动作项）→ 高亮按钮，一眼看出"已选择"
      btn.classList.toggle("dd-set", !!(current && current.value !== "" && !current.action));
      if (opts.verticalLabel) {
        btn.title = label; // 悬浮看完整名
        // 竖排溢出时底部渐隐（比硬省略号柔和）
        const labelEl = btn.querySelector(".dd-label");
        requestAnimationFrame(() => {
          if (!labelEl) return;
          labelEl.classList.toggle("v-clip", labelEl.scrollHeight > labelEl.clientHeight + 1);
        });
      }
    },
    close,
  };
  return api;
}

// ── 确认 / 输入弹窗（替代原生 confirm / prompt） ──────────────────

let askResolve = null;
function wireAsk() {
  const dlg = $("ask-dlg");
  const finish = (value) => {
    const resolve = askResolve;
    askResolve = null;
    dlg.close();
    if (resolve) resolve(value);
  };
  $("ask-ok").addEventListener("click", () => {
    const input = $("ask-input");
    finish(input.hidden ? true : input.value);
  });
  $("ask-cancel").addEventListener("click", () => finish(null));
  dlg.addEventListener("cancel", () => finish(null));
  $("ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("ask-ok").click();
    }
  });
  // Edge/Chrome 的“保存的信息”自动填充气泡：只读字段不会触发建议，
  // 聚焦时才放开，失焦再锁回去。
  $("ask-input").addEventListener("focus", () => { $("ask-input").readOnly = false; });
  $("ask-input").addEventListener("blur", () => { $("ask-input").readOnly = true; });
}

function uiAsk(opts) {
  return new Promise((resolve) => {
    askResolve = resolve;
    $("ask-title").textContent = opts.title;
    $("ask-msg").textContent = opts.message || "";
    const inp = $("ask-input");
    inp.hidden = !opts.input;
    inp.readOnly = true;
    inp.value = opts.initialValue || "";
    const ok = $("ask-ok");
    ok.textContent = opts.okText || "确定";
    ok.classList.toggle("danger", Boolean(opts.danger));
    ok.classList.toggle("primary", !opts.danger);
    $("ask-dlg").showModal();
    if (opts.input) {
      inp.focus();
      inp.readOnly = false;
      inp.select();
    }
  });
}

function uiConfirm(title, message, opts) {
  opts = opts || {};
  return uiAsk({ title: title, message: message, okText: opts.okText || "删除", danger: true }).then((v) => v === true);
}

function uiPrompt(title, placeholder, initialValue) {
  return uiAsk({ title: title, message: placeholder || "", input: true, initialValue: initialValue || "", okText: "确定" }).then((v) => (v === null ? null : String(v).trim() || null));
}

function timeOf(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return "昨天";
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function clockNow() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 流式期间的滚底：用户上翻后（stickBottom=false）不再打扰。 */
function scrollBottom() {
  if (!state.stickBottom || state.replaying) return; // 回放期间统一滚，避免逐条强制重排
  const t = $("transcript");
  t.scrollTop = t.scrollHeight;
}

/** 用户主动回到底部（发送消息 / 点置底 / 换会话）：恢复跟随。 */
function forceScrollBottom() {
  state.stickBottom = true;
  const btn = $("btn-jump-bottom");
  if (btn) btn.hidden = true;
  const t = $("transcript");
  t.scrollTop = t.scrollHeight;
}

/** 距底部超过阈值即视为「上翻」，显示置底按钮。 */
function bindScrollWatch() {
  const t = $("transcript");
  t.addEventListener("scroll", () => {
    const dist = t.scrollHeight - t.scrollTop - t.clientHeight;
    state.stickBottom = dist < 48;
    const btn = $("btn-jump-bottom");
    if (btn) btn.hidden = state.stickBottom;
  }, { passive: true });
}

// ── 书签栏（对话定位）：扫描当前视图的用户消息，点击跳转 ────────────

/** 距书签栏垂直中心越近，边框越亮（滚动/重绘后重涂）。 */
let bmPaintRaf = 0;
function paintBmGlow() {
  const bar = $("bookmark-bar");
  if (!bar || bar.hidden) return;
  const rect = bar.getBoundingClientRect();
  const cy = rect.top + rect.height / 2;
  const max = Math.max(1, rect.height / 2);
  for (const item of bar.querySelectorAll(".bm-item")) {
    const r = item.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - cy);
    const t = Math.max(0, 1 - d / max); // 0（边缘）→ 1（正中）
    item.style.borderColor = `rgba(212, 160, 23, ${(0.16 + t * 0.84).toFixed(3)})`;
    item.style.boxShadow = `0 0 0 1px rgba(232, 197, 106, ${(t * t).toFixed(3)})`;
  }
}
function scheduleBmGlow() {
  if (bmPaintRaf) return;
  bmPaintRaf = requestAnimationFrame(() => {
    bmPaintRaf = 0;
    paintBmGlow();
  });
}

/** 书签即时 tooltip：悬浮立刻显示（原生 title 有延迟）。 */
function bindBmTip() {
  const tip = document.createElement("div");
  tip.id = "bm-tip";
  document.body.append(tip);
  const bar = $("bookmark-bar");
  bar.addEventListener("mouseover", (e) => {
    const item = e.target.closest(".bm-item");
    if (!item || !item.dataset.tip) return;
    tip.textContent = item.dataset.tip;
    tip.style.display = "block";
    const r = item.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.right + 8, y = r.top + r.height / 2 - th / 2;
    if (x + tw > window.innerWidth - 8) x = r.left - tw - 8; // 右边放不下换左边
    y = Math.max(8, Math.min(y, window.innerHeight - th - 8));
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  });
  bar.addEventListener("mouseout", (e) => {
    if (e.target.closest(".bm-item")) tip.style.display = "none";
  });
  bar.addEventListener("scroll", () => { tip.style.display = "none"; }, { passive: true });
}

function rebuildBookmarks() {
  const bar = $("bookmark-bar");
  if (!bar) return;
  bar.replaceChildren();
  bar.append(el("div", { class: "bm-head" }, "定位"));
  const rows = [...$("transcript").querySelectorAll(".chat-row.user")];
  if (rows.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  for (const row of rows) {
    const msg = row.querySelector(".msg");
    const text = ((msg ? msg.textContent : "") || "").trim().replace(/\s+/g, " ");
    const item = el("button", { class: "bm-item" }, text.slice(0, 2) || "…");
    item.dataset.tip = text.slice(0, 500) || "（空）";
    item.onclick = function () {
      row.scrollIntoView({ block: "start" });
      row.classList.remove("bm-hit");
      void row.offsetWidth; // 重启动画
      row.classList.add("bm-hit");
      setTimeout(() => row.classList.remove("bm-hit"), 1600);
    };
    bar.append(item);
  }
  bar.scrollTop = bar.scrollHeight; // 默认停在最新
  scheduleBmGlow();
}

// ── 消息富文本：Markdown / 图片 / 链接 / 可点击路径 ────────────────

const PATH_RE = /(?:[A-Za-z]:[\\/](?:[^\s"'`<>|*?:]+[\\/])*[^\s"'`<>|*?:]*)|(?:\/(?:[\w.@+-]+\/)+[\w.@+-]*)|(?:[\w.@-]+(?:[\\/][\w.@-]+)+)/g;
const TRAILING = /[.,;:)\]}'"]+$/;

function sessionCwd() {
  const s = state.sessions.find((x) => x.id === state.sessionId);
  return s ? s.cwd : null;
}

/** 把渲染后的 DOM 里的文本路径替换为可点击链接（存在性经服务端确认）。 */
async function linkifyPaths(scope) {
  const candidates = new Map(); // raw → {path, kind}|null
  const nodes = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    PATH_RE.lastIndex = 0;
    if (PATH_RE.test(node.textContent)) nodes.push(node);
    PATH_RE.lastIndex = 0;
  }
  if (!nodes.length) return;
  const cwd = sessionCwd() || "";

  async function resolveCandidate(raw) {
    if (candidates.has(raw)) return candidates.get(raw);
    let out = null;
    try {
      const abs = await api("/api/fs/exists?path=" + encodeURIComponent(raw));
      if (abs.file || abs.dir) out = { path: abs.path, kind: abs.dir ? "dir" : "file" };
      if (!out && !/^[A-Za-z]:/.test(raw) && !raw.startsWith("/")) {
        const joined = cwd.replace(/[\\/]+$/, "") + "\\" + raw;
        const rel = await api("/api/fs/exists?path=" + encodeURIComponent(joined));
        if (rel.file || rel.dir) out = { path: rel.path, kind: rel.dir ? "dir" : "file" };
      }
    } catch (e) {
      out = null;
    }
    candidates.set(raw, out);
    return out;
  }

  const pending = [];
  for (const node of nodes) {
    PATH_RE.lastIndex = 0;
    const text = node.textContent;
    let m;
    while ((m = PATH_RE.exec(text))) {
      const token = m[0].replace(TRAILING, "");
      if (token.length >= 3) pending.push(token);
    }
  }
  await Promise.all(Array.from(new Set(pending)).map(resolveCandidate));

  for (const node of nodes) {
    const text = node.textContent;
    PATH_RE.lastIndex = 0;
    let m;
    let fragments = null;
    let cursor = 0;
    while ((m = PATH_RE.exec(text))) {
      const start = m.index;
      const trimmed = m[0].replace(TRAILING, "");
      const trail = m[0].slice(trimmed.length);
      const hit = candidates.get(trimmed);
      if (!hit) continue;
      fragments = fragments || [];
      if (start > cursor) fragments.push({ text: text.slice(cursor, start) });
      const isHtml = /\.html?$/i.test(hit.path);
      const link = el("span", {
        class: "path-link " + hit.kind,
        title: (hit.kind === "dir" ? "进入目录：" : isHtml ? "预览 HTML：" : "查看文件：") + hit.path,
        onclick: function () {
          if (hit.kind === "dir") openFileExplorer(hit.path);
          else if (isHtml) openHtmlPreview({ path: hit.path, title: hit.path.split(/[\\/]/).pop() });
          else window.open("/api/file?path=" + encodeURIComponent(hit.path), "_blank");
        },
      }, trimmed);
      fragments.push({ node: link });
      cursor = start + trimmed.length;
      if (trail) fragments.push({ text: trail });
      cursor += trail.length;
    }
    if (fragments) {
      if (cursor < text.length) fragments.push({ text: text.slice(cursor) });
      const frag = document.createDocumentFragment();
      for (const f of fragments) {
        if (f.node) frag.append(f.node);
        else frag.append(document.createTextNode(f.text));
      }
      node.replaceWith(frag);
    }
  }
}

/** 本地图片引用预处理：非 http 的图片地址改写为 /file 服务，绕开净化器剥除。 */
function preprocessLocalImages(mdText) {
  return String(mdText || "").replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (all, alt, src) {
    if (/^https?:/i.test(src)) return all;
    const full = /^[A-Za-z]:[\/]/.test(src) || src.startsWith("/") ? src : cwdJoin(sessionCwd(), src);
    return `![${alt}](/api/file?path=${encodeURIComponent(full)})`;
  });
}

// ── HTML 预览（对话内查看 AI 写的页面） ────────────────────────────

let htmlBlobUrl = null;

/** 图片灯箱：全屏看原图，点击任意处关闭。 */
function showLightbox(src, caption) {
  let box = $("img-lightbox");
  if (!box) {
    box = el("div", { id: "img-lightbox" });
    const img = document.createElement("img");
    img.alt = "";
    const cap = el("div", { class: "lb-caption" });
    box.append(img, cap);
    box.addEventListener("click", () => box.classList.remove("show"));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") box.classList.remove("show");
    });
    document.body.append(box);
  }
  box.querySelector("img").src = src;
  box.querySelector(".lb-caption").textContent = caption;
  box.classList.add("show");
}

function openHtmlPreview({ path, code, title }) {
  const frame = $("html-frame");
  $("html-title").textContent = title || "HTML 预览";
  if (path) {
    frame.removeAttribute("srcdoc");
    frame.src = `/api/preview?path=${encodeURIComponent(path)}`;
  } else {
    frame.removeAttribute("src");
    frame.srcdoc = code || "";
  }
  $("html-dlg").showModal();
}

function wireHtmlPreview() {
  $("html-close").addEventListener("click", () => $("html-dlg").close());
  $("html-dlg").addEventListener("close", () => {
    const frame = $("html-frame");
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
  });
  $("html-open").addEventListener("click", () => {
    const frame = $("html-frame");
    const srcdoc = frame.getAttribute("srcdoc");
    if (srcdoc !== null) {
      const url = URL.createObjectURL(new Blob([srcdoc], { type: "text/html" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      const m = String(frame.src || "").match(/[?&]path=([^&]*)/);
      if (m) window.open(`/api/preview?path=${m[1]}`, "_blank", "noopener");
    }
  });
}

/** assistant 气泡：Markdown → 净化 HTML → 链接/图片/路径后处理。 */
function renderMarkdown(bubble, text) {
  let html = "";
  try {
    html = marked.parse(preprocessLocalImages(text), { breaks: true, gfm: true, async: false });
  } catch (e) {
    bubble.textContent = text || "";
    return;
  }
  bubble.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
  bubble.classList.add("md");
  for (const a of bubble.querySelectorAll("a[href]")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  // 对话内图片：点击全屏灯箱看原图
  for (const img of bubble.querySelectorAll("img")) {
    img.addEventListener("click", () => showLightbox(img.src, img.alt || img.title || ""));
  }
  // html 代码块右上角加预览按钮（沙箱 iframe 内渲染）
  for (const code of bubble.querySelectorAll("pre > code.language-html, pre > code.language-xml")) {
    const pre = code.parentElement;
    if (pre.querySelector(".html-preview-btn")) continue;
    const btn = el("button", { class: "html-preview-btn", type: "button" }, "▶ 预览");
    btn.onclick = function () {
      openHtmlPreview({ code: code.textContent, title: "HTML 代码块预览" });
    };
    pre.append(btn);
  }
  if (!state.replaying) linkifyPaths(bubble); // 回放期间跳过，结束后整树统一链接化
}

function cwdJoin(dir, rel) {
  if (!dir) return rel;
  return dir.replace(/[\\/]+$/, "") + "\\" + rel;
}

// ── 文件浏览弹窗（点目录进入，点文件新窗查看） ──────────────────────

let filesDir = null;
async function openFileExplorer(dir) {
  filesDir = dir || filesDir || sessionCwd() || null;
  if (!filesDir) return;
  try {
    const r = await api("/api/fs/list?path=" + encodeURIComponent(filesDir));
    filesDir = r.cwd;
    renderFiles(r);
    if (!$("files-dlg").open) $("files-dlg").showModal();
  } catch (e) {
    toast("打不开目录：" + e.message);
  }
}

function renderFiles(r) {
  const crumbs = $("files-crumbs");
  crumbs.replaceChildren();
  const parts = r.cwd.split(/[\\/]/).filter(Boolean);
  let acc = "";
  for (let i = 0; i < parts.length; i += 1) {
    acc += (i === 0 ? "" : "\\") + parts[i];
    if (i > 0) crumbs.append(el("span", { class: "crumb-sep" }, " > "));
    crumbs.append(el("span", {
      class: "crumb" + (i === parts.length - 1 ? " current" : ""),
      onclick: (function (p) { return function () { openFileExplorer(p); }; })(acc),
    }, parts[i]));
  }
  const list = $("files-list");
  list.replaceChildren();
  const parent = r.cwd.replace(/[\\/][^\\/]+$/, "");
  if (parent && parent.length > 2) {
    list.append(el("li", {
      class: "file-row dir",
      onclick: (function (p) { return function () { openFileExplorer(p); }; })(parent),
    }, ".. (上一级)"));
  }
  for (const entry of r.entries) {
    const child = r.cwd.replace(/[\\/]+$/, "") + "\\" + entry.name;
    list.append(el("li", {
      class: "file-row " + (entry.dir ? "dir" : "file"),
      onclick: (function (p, isDir) {
        return function () {
          if (isDir) openFileExplorer(p);
          else window.open("/api/file?path=" + encodeURIComponent(p), "_blank");
        };
      })(child, entry.dir),
    }, entry.dir ? entry.name + "/" : entry.name + "  (" + Math.max(1, Math.round(entry.size / 1024)) + " KB)"));
  }
  if (!r.entries.length) list.append(el("li", { class: "file-row" }, "（空目录）"));
}

// ── 会话列表 ───────────────────────────────────────────────────────

async function loadSessions() {
  const { sessions } = await api("/api/sessions");
  state.sessions = (sessions || []).filter((item) => !isSubagentHistoryItem(item));
  renderSessions();
  // 页头标题跟随服务端（首条消息后服务端会派生标题）
  const current = sessions.find((s) => s.id === state.sessionId);
  if (current && current.title) $("session-title").textContent = current.title;
  const envSessions = $("env-sessions");
  if (envSessions) envSessions.textContent = String(sessions.length);
}

// ── 工作区 ─────────────────────────────────────────────────────────

async function loadWorkspaces() {
  const { workspaces } = await api("/api/workspaces");
  state.workspaces = workspaces;
  // 保持当前选择；失效（派生条目消失）时回落默认工作区
  if (!workspaces.some((w) => w.path === state.workspace)) {
    state.workspace = (workspaces.find((w) => w.default) || workspaces[0])?.path ?? null;
  }
  renderWorkspaces();
}

function renderWorkspaces() {
  if (state.dd.workspace) state.dd.workspace.refresh();
}

async function addWorkspace() {
  const dir = await uiPrompt("添加工作区", "工作区目录的完整路径（例如 D:\\projects\\demo）");
  if (dir === null) return;
  try {
    await api("/api/workspaces", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    await loadWorkspaces();
    // 用注册表的规范化路径（服务端 path.resolve 过），别用手输原串——
    // 尾斜杠/大小写差异会让会话过滤 find 失败而显示全部工作区的会话
    const added = state.workspaces.find((w) => w.path.replace(/[\\/]+$/, "").toLowerCase() === String(dir).replace(/[\\/]+$/, "").toLowerCase());
    state.workspace = added ? added.path : state.workspace;
    renderWorkspaces();
    renderSessions();
    toast(`工作区「${dir}」已添加`);
  } catch (e) {
    toast(`添加工作区失败：${e.message}`);
  }
}

async function removeCurrentWorkspace() {
  const ws = state.workspaces.find((w) => w.path === state.workspace);
  if (!ws) return;
  if (ws.default) {
    toast("默认工作区不可删除");
    return;
  }
  if (!(await uiConfirm("移除工作区", `从列表移除「${ws.title}」？会话不受影响。`))) return;
  try {
    await api(`/api/workspaces?path=${encodeURIComponent(ws.path)}`, { method: "DELETE" });
    toast(`工作区「${ws.title}」已移除`);
    await loadWorkspaces();
    renderSessions();
  } catch (e) {
    toast(`移除失败：${e.message}`);
  }
}

// ── 上次浏览位置的记忆（localStorage；刷新后回到最后的工作区与会话） ──

const LAST_WS_KEY = "pi-web.last.workspace";
const LAST_SESSION_KEY = "pi-web.last.session";

function rememberLast({ workspace, sessionId } = {}) {
  try {
    if (workspace !== undefined) localStorage.setItem(LAST_WS_KEY, workspace || "");
    if (sessionId !== undefined) {
      if (sessionId) localStorage.setItem(LAST_SESSION_KEY, sessionId);
      else localStorage.removeItem(LAST_SESSION_KEY);
    }
  } catch { /* 隐私模式等存不了就算了，不影响功能 */ }
}

function lastRemembered() {
  try {
    return { workspace: localStorage.getItem(LAST_WS_KEY), sessionId: localStorage.getItem(LAST_SESSION_KEY) };
  } catch {
    return { workspace: null, sessionId: null };
  }
}

function renderSessions() {
  const ul = $("session-list");
  ul.replaceChildren();
  // 选中的工作区过滤（cwd 匹配，大小写/尾斜杠不敏感）
  const norm = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  const ws = state.workspaces.find((w) => norm(w.path) === norm(state.workspace));
  const scoped = ws ? state.sessions.filter((s) => norm(s.cwd) === norm(ws.path)) : [];
  const list = scoped;
  if (!list.length) {
    ul.append(el("li", { class: "empty" }, ws ? "这个工作区还没有会话" : "还没有会话"));
    return;
  }
  for (const s of list) {
    const li = el("li", {
      class: s.id === state.sessionId ? "active" : "",
      onclick: () => openSession(s.id),
      title: s.title || s.id,
    });
    li.append(avatarImg("assistant", 26, s.id));
    const body = el("div", { class: "s-body" });
    body.append(el("div", { class: "s-title" }, s.title || s.id.slice(0, 8)));
    body.append(el("div", { class: "s-time" }, timeOf(s.updatedAt)));
    li.append(body);
    if (s.running) li.append(el("span", { class: "s-time", title: "运行中" }, "●"));
    li.append(el("button", {
      class: "del", title: "删除会话",
      onclick: (e) => { e.stopPropagation(); removeSession(s.id); },
    }, "✕"));
    ul.append(li);
  }
}

async function newSession() {
  try {
    const cwd = state.workspace || undefined;
    const { id } = await api("/api/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(cwd ? { cwd } : {}),
    });
    state.sessionId = id;
    $("transcript").replaceChildren();
    state.streamBubble = null;
    state.streamThink = null;
    clearStreamStatus();
    $("session-title").textContent = "新会话";
    // 新会话默认沿用上一次选择的模型
    if (state.model) {
      try {
        await api(`/api/sessions/${encodeURIComponent(id)}/model`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: state.model.provider, modelId: state.model.modelId }),
        });
      } catch { /* 切不上就落回默认模型 */ }
    }
    if (cwd && !state.workspaces.some((w) => w.path.replace(/[\\/]+$/, "").toLowerCase() === cwd.replace(/[\\/]+$/, "").toLowerCase())) {
      state.workspace = cwd; // 新目录：顺手加进工作区列表
      await loadWorkspaces();
    } else {
      await loadSessions();
    }
    await openSession(id, { keepTranscript: false }); // 新会话必须重建视图：清掉旧会话残留的消息和书签状态
    $("input").focus();
  } catch (e) {
    toast(`新建会话失败：${e.message}`);
  }
}

async function removeSession(id) {
  if (!(await uiConfirm("删除会话", "删除这个会话？其聊天记录一并移除。"))) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.sessionId === id) {
      state.sessionId = null;
      rememberLast({ sessionId: null });
      closeStream();
      $("transcript").replaceChildren();
      state.streamBubble = null;
      state.streamThink = null;
      clearStreamStatus();
      $("session-title").textContent = "选择或新建会话";
      $("btn-rename").hidden = true;
      $("input").disabled = true;
      $("btn-send").disabled = true;
    }
    await loadSessions();
  } catch (e) {
    toast(`删除失败：${e.message}`);
  }
}

async function renameSession() {
  const id = state.sessionId;
  if (!id) return;
  const current = state.sessions.find((s) => s.id === id)?.title || "";
  const title = await uiPrompt("重命名会话", "输入新标题", current);
  if (title === null) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/rename`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
    });
    $("session-title").textContent = title || current;
    await loadSessions();
  } catch (e) {
    toast(`重命名失败：${e.message}`);
  }
}

// ── 会话打开与流 ───────────────────────────────────────────────────

function closeStream() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
}

function chatRow(kind) {
  const row = el("div", { class: `chat-row ${kind}` });
  if (kind !== "user") row.append(avatarImg(kind, 34, state.sessionId)); // 用户侧不显示头像
  const col = el("div", { class: "bubble-col" });
  const meta = el("div", { class: "c-meta" },
    el("span", { class: "name" }, kind === "user" ? "你" : "PI 编程助手"),
    el("span", {}, clockNow()),
  );
  if (kind !== "user") meta.append(el("span", { class: "c-speed" }));
  col.append(meta);
  row.append(col);
  return { row, col };
}

// ── tok 速度（消息 meta 行的 .c-speed 标注） ────────────────────────

/** 速度数字格式：≥100 取整，≥10 一位小数，其余两位。 */
function fmtSpeed(v) {
  if (!Number.isFinite(v) || v <= 0) return "";
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** 结束标注：`N tok · X tok/s`（tokens/时长或现成速度缺一即只出有的那段）。 */
function speedBadge(tokens, tokPerSec) {
  const t = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : null;
  const s = fmtSpeed(tokPerSec);
  if (t === null && !s) return "";
  if (t !== null && s) return `${t} tok · ${s} tok/s`;
  return t !== null ? `${t} tok` : `${s} tok/s`;
}

function speedElOf(scope) {
  return scope instanceof Element ? scope.querySelector(".c-speed") : null;
}

/** 流式中：按累计 token ÷ 经历时间估速（≥300ms 才刷，避免抖屏）。 */
function tickStreamSpeed() {
  if (!state.streamBubble || state.streamTokens == null || !state.streamStart) return;
  const now = performance.now();
  if (now - state.streamSpeedAt < 300) return;
  state.streamSpeedAt = now;
  const seconds = (now - state.streamStart) / 1000;
  if (seconds < 0.5) return;
  const speedEl = speedElOf(state.streamBubble.closest(".chat-row"));
  if (speedEl) speedEl.textContent = `≈ ${fmtSpeed(state.streamTokens / seconds)} tok/s`;
}

/** 结束收口：优先服务端现成速度（历史回放），否则用本次流式实测时长。 */
function settleSpeed(scope, event) {
  const speedEl = speedElOf(scope);
  if (!speedEl) return;
  const tokens = event.usage?.output;
  let tokPerSec = Number.isFinite(event.tokPerSec) && event.tokPerSec > 0 ? event.tokPerSec : 0;
  if (!tokPerSec && state.streamStart && state.streamTokens != null) {
    const seconds = (performance.now() - state.streamStart) / 1000;
    if (seconds > 0) tokPerSec = state.streamTokens / seconds;
  }
  if (tokPerSec > 500) tokPerSec = 0; // 超过合理生成速度视为统计噪声，宁缺毋滥
  const text = speedBadge(tokens, tokPerSec);
  if (text) speedEl.textContent = text;
  // 会话平均速度（DSH 式加权平均）：只累计「既有 token 数又有时长」的消息
  if (tokPerSec > 0 && Number.isFinite(tokens) && tokens > 0) {
    state.avgTok.tokens += tokens;
    state.avgTok.seconds += tokens / tokPerSec;
    updateAvgSpeed();
  }
  state.streamStart = 0;
  state.streamTokens = null;
}

/** 任务计时上方：会话平均 tok 速度（同 DSH 统计条口径）。 */
function updateAvgSpeed() {
  const elx = $("avg-speed");
  if (!elx) return;
  const { tokens, seconds } = state.avgTok;
  const text = seconds > 0.5 ? fmtSpeed(tokens / seconds) : "";
  elx.hidden = !text;
  if (text) elx.textContent = `平均 ${text} tok/s`;
}

// ── 任务计时（上下文仪表左侧）：turn-start 起表，turn-end 收表 ───────

let taskTimerInt = 0;
let taskStartTs = 0;

function fmtElapsed(sec) {
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m}m${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
}

function startTaskTimer() {
  resetTaskTimer();
  const elx = $("task-timer");
  taskStartTs = Date.now();
  elx.hidden = false;
  elx.classList.remove("done");
  const tick = () => {
    elx.textContent = `任务中 ${fmtElapsed((Date.now() - taskStartTs) / 1000)}`;
  };
  tick();
  taskTimerInt = setInterval(tick, 500);
}

function finalizeTaskTimer() {
  if (taskTimerInt) {
    clearInterval(taskTimerInt);
    taskTimerInt = 0;
  }
  const elx = $("task-timer");
  if (elx.hidden || !taskStartTs) return;
  const elapsed = (Date.now() - taskStartTs) / 1000;
  taskStartTs = 0;
  elx.classList.add("done");
  elx.textContent = `任务 ${fmtElapsed(elapsed)}`;
}

function resetTaskTimer() {
  if (taskTimerInt) {
    clearInterval(taskTimerInt);
    taskTimerInt = 0;
  }
  taskStartTs = 0;
  const elx = $("task-timer");
  elx.hidden = true;
  elx.classList.remove("done");
}

// ── 流式状态提示（「请求中 1s」→「生成中 2s」，给用户等待感知） ─────

/** 在 transcript 末尾挂一个秒数递增的状态条；label 随阶段切换。 */
function setStreamStatus(label) {
  if (!state.streamStatus) {
    const elx = el("div", { class: "stream-status" });
    const chip = { el: elx, label, start: Date.now(), timer: 0 };
    chip.timer = setInterval(() => {
      const sec = Math.floor((Date.now() - chip.start) / 1000);
      elx.textContent = `${chip.label} ${sec}s…`;
      elx.classList.toggle("slow", sec >= 15);
    }, 1000);
    elx.textContent = `${label} 0s…`;
    state.streamStatus = chip;
  } else {
    state.streamStatus.label = label;
  }
  mountStreamStatus();
}

/** 状态条始终保持在 transcript 末尾（新行追加后重新挂载）。 */
function mountStreamStatus() {
  const chip = state.streamStatus;
  if (!chip) return;
  const sec = Math.floor((Date.now() - chip.start) / 1000);
  chip.el.textContent = `${chip.label} ${sec}s…`;
  chip.el.classList.toggle("slow", sec >= 15);
  $("transcript").append(chip.el); // append 对已存在节点 = 移动到末尾
  scrollBottom();
}

function clearStreamStatus() {
  const chip = state.streamStatus;
  if (!chip) return;
  clearInterval(chip.timer);
  chip.el.remove();
  state.streamStatus = null;
}

// ── 错误收纳（同状态码的错误合并计数：400×1 → 400×2 → …） ───────────

/** 从错误文本提取 4xx/5xx 状态码，取不到返回 null。 */
function errCode(text) {
  const m = String(text).match(/\b[45]\d{2}\b/);
  return m ? m[0] : null;
}

/**
 * 错误渲染成可折叠小签（⚠ 400×1，点开看完整报错）。
 * 与 transcript 里最后一条错误签同码时合并计数，返回 null 表示已收纳。
 */
function errChip(errorText) {
  const code = errCode(errorText);
  const chips = $("transcript").querySelectorAll("details.err-chip");
  const last = chips.length ? chips[chips.length - 1] : null;
  if (code && last && last.dataset.code === code) {
    const n = Number(last.dataset.count) + 1;
    last.dataset.count = String(n);
    last.querySelector("summary").textContent = `⚠ ${code}×${n}`;
    last.querySelector("pre").append(`\n────\n${errorText}`);
    return null;
  }
  return el("details", { class: "err-chip", "data-code": code || "", "data-count": "1" },
    el("summary", {}, `⚠ ${code || "错误"}×1`),
    el("pre", {}, String(errorText)));
}

// ── 思考块（与正文分开展示的可折叠 <details>） ──────────────────────

function makeThinkBlock(text) {
  return el("details", { class: "think" },
    el("summary", {}, "思考"),
    el("pre", {}, text || ""),
  );
}

/** 若本轮还没有思考块，在气泡前插入一个展开的「思考中…」块。 */
function ensureThinkBlock(bubble) {
  if (state.streamThink) return state.streamThink;
  const box = el("details", { class: "think", open: "" },
    el("summary", {}, "思考中…"),
    el("pre", {}),
  );
  bubble.parentElement.insertBefore(box, bubble);
  state.streamThink = box;
  return box;
}

function collapseThink(box) {
  box.open = false;
  box.querySelector("summary").textContent = "思考";
}

// ── 用户消息编辑重发（双击自己的消息；服务端开新分支，旧回复收起） ────

function bindUserEdit(row, col, msg, entryId) {
  msg.dataset.entry = entryId;
  msg.title = "双击编辑并重新发送";
  msg.addEventListener("dblclick", () => {
    report({ event: "edit-open", entryId });
    startEditUser(row, col, msg);
  });
}

function startEditUser(row, col, msg) {
  if (state.streaming) {
    // 兜底：本地 flag 卡住了，查服务端确认
    api(`/api/sessions/${encodeURIComponent(state.sessionId)}`)
      .then((s) => {
        if (s && !s.running) {
          setStreaming(false);
          startEditUser(row, col, msg);
        } else {
          toast("请先停止当前回复再编辑");
        }
      })
      .catch(() => toast("请先停止当前回复再编辑"));
    return;
  }
  if (row.querySelector(".edit-box")) return;
  const original = msg.textContent;
  const ta = el("textarea", { class: "edit-ta" });
  ta.value = original;
  const sendBtn = el("button", { class: "btn small primary" }, "重发 ▸");
  const cancelBtn = el("button", { class: "btn small" }, "取消");
  const box = el("div", { class: "edit-box" }, ta, el("div", { class: "edit-actions" }, cancelBtn, sendBtn));
  const close = () => {
    box.remove();
    msg.hidden = false;
  };
  cancelBtn.onclick = close;
  sendBtn.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return close();
    // 内容没改也照常重发（用户可能只是想让 AI 重新回一次）
    report({ event: "edit-click", entryId: msg.dataset.entry, unchanged: text === original });
    sendBtn.disabled = true;
    sendBtn.textContent = "重发中…";
    setStreaming(true);
    setStreamStatus("请求中"); // 点击瞬间即有感知
    try {
      await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/edit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId: msg.dataset.entry, text }),
      });
      report({ event: "edit-ok", entryId: msg.dataset.entry });
      box.remove();
      loadSessions();
    } catch (e) {
      report({ event: "edit-fail", entryId: msg.dataset.entry, error: String(e.message).slice(0, 200) });
      toast(`重发失败：${e.message}`);
      clearStreamStatus();
      setStreaming(false);
      sendBtn.disabled = false;
      sendBtn.textContent = "重发 ▸";
    }
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
    if (e.key === "Escape") close();
  });
  ta.addEventListener("input", () => autoGrow(ta));
  msg.hidden = true;
  col.insertBefore(box, msg);
  autoGrow(ta);
  ta.focus();
}

function renderEvent(event) {
  switch (event.type) {
    case "user": {
      const { row, col } = chatRow("user");
      const msg = el("div", { class: "msg" }, event.text);
      if (event.id) bindUserEdit(row, col, msg, event.id);
      col.append(msg);
      row.append(col);
      mountStreamStatus(); // 状态条保持在末尾（用户消息行之后）
      rebuildBookmarks();
      return row;
    }
    case "user-id": {
      // 重发落盘后服务端补推条目 id：绑定到最后一条同文本、还没有 id 的用户消息
      for (const row of [...$("transcript").querySelectorAll(".chat-row.user")].reverse()) {
        const msg = row.querySelector(".msg");
        if (msg && !msg.dataset.entry && msg.textContent === event.text) {
          bindUserEdit(row, row.querySelector(".bubble-col"), msg, event.id);
          break;
        }
      }
      return null;
    }
    case "transcript-reset": {
      // 编辑重发后服务端按新分支重建视图
      state.streamBubble = null;
      state.streamThink = null;
      clearStreamStatus();
      const transcript = $("transcript");
      transcript.replaceChildren();
      state.replaying = true;
      for (const ev of event.events || []) appendEvent(ev);
      state.replaying = false;
      forceScrollBottom();
      rebuildBookmarks();
      void linkifyPaths(transcript);
      return null;
    }
    case "assistant-start": {
      const { row, col } = chatRow("assistant");
      const bubble = el("div", { class: "msg" }, el("span", { class: "cursor" }));
      col.append(bubble);
      row.append(col);
      state.streamBubble = bubble;
      state.streamThink = null;
      state.streamStart = performance.now();
      state.streamTokens = 0;
      state.streamSpeedAt = 0;
      return row;
    }
    case "thinking-delta": {
      const bubble = state.streamBubble;
      if (!bubble) return null;
      ensureThinkBlock(bubble);
      state.streamThink.querySelector("pre").append(event.text);
      setStreamStatus("生成中");
      scrollBottom();
      return null;
    }
    case "thinking-end": {
      if (state.streamThink) collapseThink(state.streamThink);
      return null;
    }
    case "assistant-delta": {
      const bubble = state.streamBubble;
      if (!bubble) return null;
      if (typeof event.tokens === "number") state.streamTokens = event.tokens;
      const cursor = bubble.querySelector(".cursor");
      const span = el("span");
      span.textContent = event.text;
      bubble.insertBefore(span, cursor);
      setStreamStatus("生成中");
      tickStreamSpeed();
      scrollBottom();
      return null;
    }
    case "assistant-end": {
      const bubble = state.streamBubble;
      state.streamBubble = null;
      clearStreamStatus();
      if (!bubble) {
        // 无增量（一次性返回 / 历史回放）：补一整条
        const { row, col } = chatRow("assistant");
        if (event.thinking) col.append(makeThinkBlock(event.thinking));
        if (event.error || (event.text || "").trim()) {
          // 没正文也没错误就别渲染空气泡（只有思考/工具调用的回合）
          const fresh = el("div", { class: "msg" });
          if (event.error) {
            fresh.classList.add("error");
            fresh.append(errChip(event.error) || el("span", { class: "dim" }, "（同上）"));
          } else {
            renderMarkdown(fresh, event.text || "");
          }
          col.append(fresh);
        }
        row.append(col);
        settleSpeed(row, event);
        refreshContext();
        return row;
      }
      const text = event.text !== undefined ? event.text : bubble.textContent;
      const row = bubble.closest(".chat-row");
      if (event.thinking) {
        ensureThinkBlock(bubble);
        state.streamThink.querySelector("pre").replaceChildren(event.thinking);
        collapseThink(state.streamThink);
      }
      state.streamThink = null;
      bubble.replaceChildren();
      bubble.classList.remove("md");
      if (event.error) {
        bubble.classList.add("error");
        bubble.append(errChip(event.error) || el("span", { class: "dim" }, "（同上）"));
      } else {
        renderMarkdown(bubble, text || "");
        if (!bubble.hasChildNodes()) bubble.remove(); // 空回合不渲染空气泡
      }
      settleSpeed(row, event);
      refreshContext();
      scrollBottom();
      return null;
    }
    case "tool": {
      if (event.phase === "end" && (event.name === "write" || event.name === "edit")) {
        refreshDiff();
      }
      if (event.phase === "start") {
        const d = el("details", { class: "tool", "data-call": event.callId });
        d.append(el("summary", {}, el("span", { class: "name" }, event.name), " 运行中…"));
        if (event.args) d.append(el("pre", {}, String(event.args).slice(0, 4000)));
        return d;
      }
      const existing = $("transcript").querySelector(`details[data-call="${CSS.escape(event.callId)}"]`);
      const node = existing || el("details", { class: "tool", "data-call": event.callId });
      node.classList.toggle("err", Boolean(event.isError));
      node.replaceChildren(
        el("summary", {}, el("span", { class: "name" }, event.name), event.isError ? " 失败" : " 完成"),
        el("pre", {}, String(event.output || (event.isError ? "（出错）" : "（无输出）")).slice(0, 4000)),
      );
      if (Array.isArray(event.images) && event.images.length) {
        const box = el("div", { class: "tool-images" });
        for (const im of event.images) {
          const img = document.createElement("img");
          img.src = `data:${im.mime};base64,${im.data}`;
          img.className = "tool-thumb pixelated";
          img.loading = "lazy";
          img.onclick = function () { window.open(img.src, "_blank"); };
          box.append(img);
        }
        node.append(box);
      }
      return existing ? null : node;
    }
    case "turn-start":
      startTaskTimer();
      return null;
    case "retry": {
      // 每次重试提示替换上一条；结束时移除（最终失败由错误签呈现）
      $("transcript").querySelectorAll(".retry-note").forEach((n) => n.remove());
      if (event.phase !== "start") return null;
      const code = errCode(event.error) || "请求";
      const sec = Math.max(1, Math.round((event.delayMs || 0) / 1000));
      return el("div", { class: "retry-note" },
        `⏳ ${code} 失败，${sec}s 后第 ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"} 次重试…`);
    }
    case "turn-end":
      setStreaming(false);
      clearStreamStatus();
      finalizeTaskTimer();
      refreshDiff();
      refreshContext();
      return null;
    case "compact": {
      // 压缩提示行：start 出现，end 替换为结果（自动/手动压缩都会推）
      if (event.phase === "start") startCompactUi();
      else stopCompactUi();
      $("transcript").querySelectorAll(".compact-note").forEach((n) => n.remove());
      if (event.phase === "start") {
        return el("div", { class: "retry-note compact-note" }, "🗜 正在压缩上下文…");
      }
      refreshContext();
      if (event.aborted) return null;
      if (event.failed) {
        return el("div", { class: "retry-note compact-note" }, "🗜 压缩失败" + (event.error ? `：${String(event.error).slice(0, 120)}` : ""));
      }
      return el("div", { class: "retry-note compact-note" }, "🗜 上下文已压缩");
    }
    case "title":
      $("session-title").textContent = event.title;
      loadSessions();
      return null;
    case "model":
      state.model = { provider: event.provider, modelId: event.modelId };
      state.pulledLevels = loadPulledLevels(state.model); // 新模型 → 该模型拉取过的级别
      renderModelPicker();
      renderThinkingPicker();
      refreshContext(); // 窗口大小随模型变
      return null;
    case "thinking":
      state.thinking = event.level;
      state.thinkingExplicit = event.explicit === true;
      renderThinkingPicker();
      return null;
    default:
      return null;
  }
}

function appendEvent(event) {
  if (event.type === "subagents") {
    applySubagentSnapshot(event);
    return;
  }
  if (event.type === "subagents-config") {
    loadSubagents();
    return;
  }
  const node = renderEvent(event);
  if (node) {
    $("transcript").append(node);
    scrollBottom();
  }
}

async function openSession(id, { keepTranscript } = {}) {
  closeStream();
  state.sessionId = id;
  state.pulledLevels = [];
  state.sessionSubagents = { agents: [], runs: [] };
  $("agent-run-dlg").close();
  renderAgentDock();
  loadSessionSubagents();
  state.streamBubble = null;
  state.streamThink = null;
  clearStreamStatus();
  state.streamStart = 0;
  state.streamTokens = null;
  resetTaskTimer(); // 切会话：清掉上一会话的任务计时
  // 会话归属的工作区与当前选择不一致时，切过去（会话可见）
  const meta = state.sessions.find((s) => s.id === id);
  if (meta?.cwd && !state.workspaces.some((w) => w.path === state.workspace && w.path.toLowerCase() === String(meta.cwd).toLowerCase())) {
    if (state.workspaces.some((w) => w.path.toLowerCase() === String(meta.cwd).toLowerCase())) {
      state.workspace = meta.cwd;
      renderWorkspaces();
    }
  }
  rememberLast({ workspace: state.workspace, sessionId: id });
  renderSessions();
  try {
    const { session, events } = await api(`/api/sessions/${encodeURIComponent(id)}/history`);
    $("session-title").textContent = session.title || id.slice(0, 8);
    $("btn-rename").hidden = false;
    $("input").disabled = false;
    $("btn-send").disabled = false;
    state.model = session.model;
    state.pulledLevels = loadPulledLevels(state.model); // 刷新后恢复该模型拉取过的级别
    state.thinking = session.thinkingLevel;
    state.thinkingExplicit = session.thinkingExplicit === true;
    renderModelPicker();
    renderThinkingPicker();
    refreshDiff();
    refreshContext();
    // 关键：恢复流式状态。切走再切回（或刷新页面）后本地 flag 丢了，
    // 若该会话后台仍在跑任务，必须把按钮恢复成「■ 任务中」，否则
    // 显示「发送 ▸」，一点发送就会把正在跑的任务打断
    setStreaming(session.running === true);
    if (!keepTranscript) {
      const transcript = $("transcript");
      transcript.replaceChildren();
      state.avgTok = { tokens: 0, seconds: 0 }; // 平均速度随会话重置，回放时按消息重建
      updateAvgSpeed();
      stopCompactUi(); // 切会话清掉压缩计时
      state.stickBottom = true; // 回放期间跟随，回放完落在底部
      // 回放模式：跳过逐条 scrollBottom（几百次强制重排是切换卡顿的主因）
      // 和逐条路径链接化（几十上百个并发 fs 请求），结束后统一补一次
      state.replaying = true;
      for (const frame of events) appendEvent(frame.event);
      state.replaying = false;
      forceScrollBottom();
      rebuildBookmarks();
      void linkifyPaths(transcript); // 整树一次，候选路径去重后统一解析
    }
    // SSE 实时流（history 与 stream 之间的间隙事件会重复：以「boot:seq」去重，
    // 裸 seq 在服务器重启后会撞上旧进程的已见集合，把新事件整段丢弃）
    const seen = new Set(events.map((f) => f.id || f.seq));
    const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream`);
    state.es = es;
    es.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      const key = frame.id || frame.seq;
      if (seen.has(key)) return;
      seen.add(key);
      appendEvent(frame.event);
    };
    loadSessionSubagents();
  } catch (e) {
    toast(`打开会话失败：${e.message}`);
  }
}

// ── 发送 / 停止 ────────────────────────────────────────────────────

function setStreaming(on) {
  state.streaming = on;
  // 发送按钮即任务开关：任务进行中显示「■ 任务中」，点击打断
  const btn = $("btn-send");
  btn.classList.toggle("streaming", on);
  btn.textContent = on ? "■ 任务中" : "发送 ▸";
  btn.title = on ? "点击打断当前任务" : "";
}

async function send() {
  // 任务进行中：发送按钮即「打断」
  if (state.streaming) {
    await stop();
    return;
  }
  const input = $("input");
  const text = input.value.trim();
  if (!text && state.pendingAttach.length === 0) return;
  if (!state.sessionId) return;
  // 附件并入消息：图片走 prompt images，文本文件以代码块拼进正文
  const images = [];
  let full = text;
  for (const a of state.pendingAttach) {
    if (a.kind === "image") images.push({ type: "image", data: a.data, mimeType: a.mime });
    else full += `\n\n---\n附件「${a.name}」：\n\`\`\`\n${a.text}\n\`\`\``;
  }
  state.pendingAttach = [];
  renderAttachments();
  input.value = "";
  autoGrow(input);
  setStreaming(true);
  forceScrollBottom(); // 发送 = 用户在底部，恢复跟随
  setStreamStatus("请求中"); // 点击瞬间即有感知（会话冷启动时 POST 可能挂很久）
  try {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: full, ...(images.length ? { images } : {}) }),
    });
    loadSessions();
    syncAgentStatus();
  } catch (e) {
    toast(`发送失败：${e.message}`);
    clearStreamStatus();
    // 409 = 服务端任务其实还在跑（本地 flag 过期）：恢复「■ 任务中」而不是清掉
    if (/\b409\b|任务进行中/.test(e.message)) setStreaming(true);
    else setStreaming(false);
  }
}

// ── 附件（粘贴 / 拖入图片和文件） ──────────────────────────────────

const ATTACH_LIMITS = { maxFiles: 8, maxImageChars: 12_000_000, maxTextChars: 400_000 };

function readFileAs(file, as) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("读取失败"));
    if (as === "dataurl") r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

async function addAttachments(files) {
  for (const f of files) {
    if (state.pendingAttach.length >= ATTACH_LIMITS.maxFiles) {
      toast(`附件最多 ${ATTACH_LIMITS.maxFiles} 个`);
      break;
    }
    const name = f.name || "clipboard";
    if (f.type.startsWith("image/")) {
      try {
        const url = await readFileAs(f, "dataurl");
        const data = String(url).slice(String(url).indexOf(",") + 1);
        if (data.length > ATTACH_LIMITS.maxImageChars) {
          toast(`「${name}」过大（上限约 9MB）`);
          continue;
        }
        state.pendingAttach.push({ kind: "image", name, mime: f.type, data });
      } catch (e) {
        toast(`「${name}」读取失败：${e.message}`);
      }
    } else {
      try {
        let text = await readFileAs(f, "text");
        if (text.length > ATTACH_LIMITS.maxTextChars) {
          text = text.slice(0, ATTACH_LIMITS.maxTextChars) + `\n…（超出 ${ATTACH_LIMITS.maxTextChars} 字符已截断）`;
        }
        state.pendingAttach.push({ kind: "text", name, text });
      } catch (e) {
        toast(`「${name}」不是文本文件，已跳过`);
      }
    }
  }
  renderAttachments();
}

function renderAttachments() {
  const row = $("attach-row");
  if (!row) return;
  row.replaceChildren();
  if (state.pendingAttach.length === 0) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  for (const [i, a] of state.pendingAttach.entries()) {
    const chip = el("div", { class: "attach-chip", title: a.name });
    if (a.kind === "image") {
      const img = document.createElement("img");
      img.src = `data:${a.mime};base64,${a.data}`;
      chip.append(img);
    }
    chip.append(el("span", { class: "nm" }, a.name));
    const rm = el("button", { class: "rm", title: "移除" }, "✕");
    rm.onclick = function () {
      state.pendingAttach.splice(i, 1);
      renderAttachments();
    };
    chip.append(rm);
    row.append(chip);
  }
}

function bindAttachInput() {
  const input = $("input");
  // 粘贴：clipboard 里的文件（截图 / 复制的图片 / 文件）
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    void addAttachments(files);
  });
  // 拖放
  input.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
  });
  input.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    void addAttachments(files);
  });
}

async function stop() {
  if (!state.sessionId) return;
  clearStreamStatus();
  try {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/stop`, { method: "POST" });
  } catch (e) {
    toast(`停止失败：${e.message}`);
  }
}

/** 手动压缩上下文：点击上下文仪表浮出的「压缩」字样。 */
async function doCompact() {
  if (!state.sessionId) {
    toast("先打开会话");
    return;
  }
  if (compactTimerInt) return; // 已在压缩中
  startCompactUi();            // POST 可能落后于 SSE start，先起表
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/compact`, { method: "POST" });
    if (!r.ok) {
      toast(`压缩失败：${r.error || "未知错误"}`);
      stopCompactUi();
    }
    // 成功提示由 SSE compact-end 事件负责（start/end 覆盖手动+自动两种）
  } catch (e) {
    toast(`压缩失败：${e.message}`);
    stopCompactUi();
  }
}

/** 压缩计时：仪表整块变成「压缩中 Xs…」，结束时还原并刷新上下文。 */
let compactTimerInt = 0;
let compactArmTimer = 0; // 浮现「压缩」后 5s 未点击自动还原

function toggleCompactArm() {
  const meter = $("ctx-meter");
  const arm = !meter.classList.contains("compact-arm");
  meter.classList.toggle("compact-arm", arm);
  $("ctx-compact").hidden = !arm;
  clearTimeout(compactArmTimer);
  compactArmTimer = 0;
  if (arm) compactArmTimer = setTimeout(disarmCompact, 5000);
}

function disarmCompact() {
  if (compactTimerInt) return; // 压缩进行中不还原，等结束
  clearTimeout(compactArmTimer);
  compactArmTimer = 0;
  const meter = $("ctx-meter");
  const chip = $("ctx-compact");
  if (meter) meter.classList.remove("compact-arm");
  if (chip) chip.hidden = true;
}

function startCompactUi() {
  const meter = $("ctx-meter");
  const chip = $("ctx-compact");
  if (!chip || compactTimerInt) return;
  clearTimeout(compactArmTimer);
  compactArmTimer = 0;
  meter.classList.add("compact-arm", "compacting");
  chip.hidden = false;
  const start = Date.now();
  const tick = () => { chip.textContent = `压缩中 ${Math.floor((Date.now() - start) / 1000)}s…`; };
  tick();
  compactTimerInt = setInterval(tick, 1000);
}

function stopCompactUi() {
  clearInterval(compactTimerInt);
  compactTimerInt = 0;
  clearTimeout(compactArmTimer);
  compactArmTimer = 0;
  const meter = $("ctx-meter");
  const chip = $("ctx-compact");
  if (meter) meter.classList.remove("compact-arm", "compacting");
  if (chip) {
    chip.hidden = true;
    chip.textContent = "压缩";
  }
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
}

// ── 模型 / 思考强度 ────────────────────────────────────────────────

async function loadModels() {
  const { groups, levels } = await api("/api/models");
  state.groups = groups;
  state.levels = levels || [];
  renderModelPicker();
  renderThinkingPicker();
}

function renderModelPicker() {
  if (state.dd.model) state.dd.model.refresh();
}

function modelOptions() {
  const out = [];
  for (const g of state.groups) {
    for (const m of g.models) {
      out.push({
        value: `${g.id}/${m.id}`,
        label: m.reasoning ? `${m.name}（思考）` : m.name,
        group: g.name,
      });
    }
  }
  return out;
}

/** 模型菜单：每个服务商一列横排，列头是服务商名；滚轮横滚。 */
function buildModelMenu(menu, close) {
  // 滚轮上下 → 菜单左右翻动
  menu.addEventListener("wheel", (e) => {
    if (menu.scrollWidth <= menu.clientWidth) return;
    e.preventDefault();
    menu.scrollLeft += (e.deltaY || 0) + (e.deltaX || 0);
  }, { passive: false });
  for (const g of state.groups) {
    const col = el("div", { class: "model-col" });
    for (const m of g.models) {
      const selected = state.model && state.model.provider === g.id && state.model.modelId === m.id;
      const item = el("div", {
        class: "dd-item" + (selected ? " selected" : ""),
        title: `${g.name} / ${m.name}`,
      }, m.reasoning ? `${m.name}（思考）` : m.name);
      item.addEventListener("click", () => {
        close();
        onModelChange(`${g.id}/${m.id}`);
      });
      col.append(item);
    }
    // 服务商名置底：粘在列底部，与模型按钮底边对齐
    col.append(el("div", { class: "model-col-head", title: g.name }, g.name));
    menu.append(col);
  }
}

async function onModelChange(value) {
  const parts = String(value).split("/", 2);
  const provider = parts[0];
  const modelId = parts[1];
  if (!provider || !state.sessionId) {
    if (state.dd.model) state.dd.model.refresh();
    return;
  }
  try {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/model`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider, modelId: modelId }),
    });
    state.model = { provider: provider, modelId: modelId };
    state.pulledLevels = loadPulledLevels(state.model); // 换模型 → 换用该模型拉取过的级别
    renderThinkingPicker();
    toast("模型已切换");
  } catch (e) {
    toast(`切换模型失败：${e.message}`);
  }
  if (state.dd.model) state.dd.model.refresh();
}

/** 拉取到的思考级别按模型缓存到 localStorage（刷新后不丢）。 */
const PULLED_LEVELS_KEY = "pi-web.pulledLevels";

function loadPulledLevels(model = state.model) {
  try {
    const list = JSON.parse(localStorage.getItem(PULLED_LEVELS_KEY) || "{}")[JSON.stringify(model)];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function savePulledLevels(model = state.model, levels = state.pulledLevels) {
  try {
    const all = JSON.parse(localStorage.getItem(PULLED_LEVELS_KEY) || "{}");
    if (Array.isArray(levels) && levels.length) all[JSON.stringify(model)] = levels;
    else delete all[JSON.stringify(model)];
    localStorage.setItem(PULLED_LEVELS_KEY, JSON.stringify(all));
  } catch { /* 存不了就算了，只影响刷新后的级别列表 */ }
}

function renderThinkingPicker() {
  if (state.dd.thinking) state.dd.thinking.refresh();
}

function thinkingOptions() {
  // 优先用「拉取」拿到的活模型级别，其次模型目录声明，最后兜底
  let efforts = state.pulledLevels.length ? state.pulledLevels
    : (currentModel()?.efforts?.length ? currentModel().efforts : ["off", "medium", "high"]);
  // 会话当前的实际级别（可能来自目录声明之外）始终保留在列表里，避免刷新后显示被清空
  if (state.thinking && !efforts.includes(state.thinking)) efforts = [...efforts, state.thinking];
  const names = Object.fromEntries(state.levels || []);
  return efforts.map((level) => ({ value: level, label: names[level] || level }));
}

function currentModel() {
  if (!state.model) return null;
  const g = state.groups.find((x) => x.id === state.model.provider);
  return g?.models.find((m) => m.id === state.model.modelId) || null;
}

// ── 压缩模型（省钱模型）选择 ────────────────────────────────────────

async function loadCompactionModel() {
  try {
    const r = await api("/api/compaction-model");
    state.compactionModel = r.compactionModel || null;
  } catch { /* 读不到就用默认 */ }
  if (state.dd.compactModel) state.dd.compactModel.refresh();
}

async function onCompactionModelChange(value) {
  try {
    const r = await api("/api/compaction-model", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(value ? { provider: value.split("/", 1)[0], modelId: value.slice(value.indexOf("/") + 1) } : {}),
    });
    if (!r.ok) throw new Error(r.error || "保存失败");
    state.compactionModel = r.compactionModel || null;
    toast(value ? "压缩将使用所选模型" : "压缩已恢复为跟随会话模型");
  } catch (e) {
    toast(`压缩模型设置失败：${e.message}`);
  }
  if (state.dd.compactModel) state.dd.compactModel.refresh();
}

async function onThinkingChange(level) {
  if (!state.sessionId) return;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/thinking`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: level }),
    });
    state.thinking = r.level ?? level;
    state.thinkingExplicit = true;
  } catch (e) {
    toast(`设置思考强度失败：${e.message}`);
  }
  if (state.dd.thinking) state.dd.thinking.refresh();
}

// ── 上下文占用仪表（标签栏右侧） ───────────────────────────────────

let ctxLoading = false;
let ctxPending = false;

/** 拉取上下文占用并刷新仪表；在途时合并尾部刷新，不排队堆积。 */
async function refreshContext() {
  if (!state.sessionId) {
    $("ctx-meter").hidden = true;
    return;
  }
  if (ctxLoading) {
    ctxPending = true;
    return;
  }
  ctxLoading = true;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/context`);
    renderCtxMeter(r.ok ? r : null);
  } catch {
    // 静默：仪表是辅助信息，不打扰
  } finally {
    ctxLoading = false;
    if (ctxPending) {
      ctxPending = false;
      refreshContext();
    }
  }
}

/** token 数展示：≥1000 用 k。 */
function fmtTok(n) {
  if (!Number.isFinite(n)) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n));
}

function renderCtxMeter(info) {
  const meter = $("ctx-meter");
  if (!info || !info.ok || !info.contextWindow) {
    meter.hidden = true;
    return;
  }
  meter.hidden = false;
  const pct = Number.isFinite(info.percent) ? info.percent : null;
  const fill = meter.querySelector(".ctx-bar i");
  const pctEl = meter.querySelector(".ctx-pct");
  const pop = meter.querySelector(".ctx-pop");
  meter.classList.toggle("warn", pct !== null && pct >= 60 && pct < 85);
  meter.classList.toggle("over", pct !== null && pct >= 85);
  fill.style.width = `${Math.max(0, Math.min(100, pct ?? 0))}%`;
  pctEl.textContent = pct === null ? "估算中" : `${pct.toFixed(1)}%`;
  const win = info.contextWindow;
  const row = (label, tok) => {
    const p = Number.isFinite(tok) ? ` (${((tok / win) * 100).toFixed(1)}%)` : "";
    return el("div", { class: "row" }, el("span", {}, label), el("b", {}, `${fmtTok(tok)} tok${p}`));
  };
  const parts = info.parts || {};
  const rows = [
    row("系统提示词", parts.system),
    row("工具", parts.tools),
    row("预设", parts.presets),
    row("历史消息", parts.history),
  ];
  // 缓存命中：最后一条 assistant 消息的 provider 用量（全 0 = 该 provider 不上报，不显示）
  const c = info.cache;
  if (c && (c.read + c.write + c.input) > 0) {
    const denom = c.read + c.write + c.input;
    const rate = (c.read / denom) * 100;
    rows.push(el("div", { class: "row cache" },
      el("span", {}, "缓存命中"),
      el("b", {}, `${fmtTok(c.read)} tok（${rate.toFixed(1)}%）`)));
  }
  rows.push(
    el("div", { class: "row sum" },
      el("span", {}, "合计"),
      el("b", {}, `${fmtTok(info.total)} / ${fmtTok(win)} tok${pct === null ? "" : `（${pct.toFixed(1)}%）`}`)),
    el("div", { class: "note" }, "分项为 chars/4 估算；总量、缓存以 provider 回报的 usage 为准"),
  );
  pop.replaceChildren(...rows);
}

// ── 右栏：当前对话 DIFF ────────────────────────────────────────────

let diffLoading = false;
async function refreshDiff() {
  if (!state.sessionId || diffLoading) return;
  diffLoading = true;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/diff`);
    const files = r.files || [];
    state.diffAll = files; // 全量留给「全部」视图
    const ul = $("diff-list");
    ul.replaceChildren();
    $("diff-empty").hidden = files.length > 0;
    // 面板只显示最近 3 个，全部改动走「全部」按钮
    for (const f of files.slice(-3)) {
      const name = f.path.split(/[\/]/).pop();
      ul.append(el("li", {
        class: "diff-file",
        title: `${f.path}　+${f.additions} −${f.deletions}`,
        onclick: () => openDiffDialog(f),
      }, name, el("span", { class: "add" }, ` +${f.additions}`), el("span", { class: "del" }, ` −${f.deletions}`)));
    }
  } catch {
    // 面板刷新失败不打扰
  } finally {
    diffLoading = false;
  }
}

function openDiffDialog(file, fromList) {
  $("diff-title").textContent = file.path;
  $("diff-back").hidden = !fromList;
  const body = $("diff-body");
  body.replaceChildren();
  for (const line of file.patch.split("\n")) {
    const cls = line.startsWith("+++") || line.startsWith("---") ? "ln-meta"
      : line.startsWith("@@") ? "ln-hunk"
      : line.startsWith("+") ? "ln-add"
      : line.startsWith("-") ? "ln-del" : "";
    const span = el("span", { class: cls });
    span.textContent = line || " ";
    body.append(span);
  }
  $("diff-dlg").showModal();
}

/** 全部改动列表（对话框内的列表视图，点条目看单个 diff）。 */
function openAllDiffDialog() {
  const files = state.diffAll || [];
  $("diff-title").textContent = `全部改动（${files.length}）`;
  $("diff-back").hidden = true;
  const body = $("diff-body");
  body.replaceChildren();
  if (!files.length) {
    const span = el("span");
    span.textContent = "本会话还没有文件改动";
    body.append(span);
  }
  for (const f of files) {
    const span = el("span", {
      class: "diff-all-row",
      title: `${f.path}　+${f.additions} −${f.deletions}`,
      onclick: () => openDiffDialog(f, true),
    });
    span.textContent = `${f.path}　+${f.additions} −${f.deletions}`;
    body.append(span);
  }
  $("diff-dlg").showModal();
}

// ── 右栏：运行环境 ─────────────────────────────────────────────────

// ── 预设（整个模块收在左下角「⚙ 设置」菜单里） ──────────────────────

async function loadPresets() {
  state.presetView = await api("/api/presets");
  renderPresets();
}

function renderPresets() {
  const v = state.presetView;
  if (!v) return;
  const ul = $("preset-list");
  ul.replaceChildren();
  if (!v.presets.length) ul.append(el("li", { class: "rp-note" }, "还没有预设，点 ＋ 新建"));
  for (const p of v.presets) {
    ul.append(presetToggleRow(p));
  }
  // 上下文文件
  const cf = $("ctx-files");
  cf.replaceChildren();
  for (const f of v.contextFiles) {
    const row = el("div", { class: "switch-line" });
    const box = el("input", { type: "checkbox" });
    box.checked = f.enabled;
    box.addEventListener("change", () => savePresetsConfig({ [f.file === "AGENTS.md" ? "agentsMd" : "claudeMd"]: box.checked }));
    row.append(box, el("span", {}, f.file));
    if (!f.exists) {
      row.append(el("button", {
        class: "btn small",
        title: `在当前工作区创建 ${f.file}`,
        onclick: async () => {
          try {
            await api("/api/fs/write", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ file: f.file, content: "" }),
            });
            toast(`${f.file} 已创建`);
            await loadPresets();
          } catch (e) {
            toast(`创建失败：${e.message}`);
          }
        },
      }, "新建"));
    } else {
      row.append(el("span", { class: "rp-note" }, "已存在"));
    }
    cf.append(row);
  }
  const nc = $("no-compaction");
  nc.checked = v.noCompaction;
}

/** 预设行：勾选启用/停用，点名字进编辑器，✕ 删除（确认后）。 */
function presetToggleRow(p) {
  const li = el("li", {
    class: "preset-row" + (p.enabled ? " on" : ""),
    title: "点击编辑：" + p.name,
  });
  const box = el("input", { type: "checkbox", title: p.enabled ? "停用" : "启用" });
  box.checked = p.enabled;
  box.addEventListener("change", () => togglePreset(p.id, box.checked));
  const name = el("span", { class: "pname" }, p.name);
  name.addEventListener("click", (e) => {
    e.stopPropagation();
    openPresetEditor(p.id);
  });
  li.append(box, name);
  if (p.rules && p.rules.length) li.append(el("span", { class: "pcount" }, `${p.rules.length} 规则`));
  li.append(el("button", {
    class: "del",
    title: "删除预设",
    onclick: (e) => { e.stopPropagation(); deletePreset(p); },
  }, "✕"));
  return li;
}

async function deletePreset(p) {
  const ok = await uiAsk({
    title: "删除预设",
    message: `确定删除预设「${p.name}」？此操作不可撤销。`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    state.presetView.presets = state.presetView.presets.filter((x) => x.id !== p.id);
    state.presetView.defaultSelected = (state.presetView.defaultSelected || []).filter((id) => id !== p.id);
    await savePresetsConfig({});
    refreshContext();
    toast(`预设「${p.name}」已删除`);
  } catch (e) {
    toast(`删除失败：${e.message}`);
    await loadPresets(); // 失败回读服务端状态
  }
}

async function savePresetsConfig(patch) {
  const v = state.presetView;
  const body = Object.assign({
    presets: v.presets.map((p) => ({
      id: p.id, name: p.name, enabled: p.enabled,
      rules: p.rules.map((r) => ({ id: r.id, name: r.name, content: r.content, enabled: r.enabled })),
    })),
    defaultSelected: v.defaultSelected,
    agentsMd: (v.contextFiles.find((f) => f.file === "AGENTS.md") || {}).enabled || false,
    claudeMd: (v.contextFiles.find((f) => f.file === "CLAUDE.md") || {}).enabled || false,
    noCompaction: v.noCompaction,
  }, patch);
  state.presetView = await api("/api/presets/save", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  renderPresets();
}

async function togglePreset(id, enabled) {
  const p = state.presetView.presets.find((x) => x.id === id);
  const selected = new Set(state.presetView.defaultSelected || []);
  if (enabled) selected.add(id);
  else selected.delete(id);
  if (p) p.enabled = enabled;
  state.presetView.defaultSelected = [...selected];
  await savePresetsConfig({ defaultSelected: [...selected] });
  refreshContext();
  toast(enabled ? `预设「${p.name}」已启用（下一条消息生效）` : `预设「${p.name}」已停用`);
}

// ── 预设编辑器 ─────────────────────────────────────────────────────

function openPresetEditor(id) {
  const p = id ? state.presetView.presets.find((x) => x.id === id) : null;
  state.editingPreset = p
    ? { id: p.id, name: p.name, rules: p.rules.map((r) => ({ ...r })) }
    : { name: "", rules: [] };
  $("pd-title").textContent = p ? `编辑预设：${p.name}` : "新建预设";
  $("pd-name").value = state.editingPreset.name;
  renderPresetRules();
  $("preset-dlg").showModal();
}

function renderPresetRules() {
  const wrap = $("pd-rules");
  wrap.replaceChildren();
  const rules = state.editingPreset.rules;
  rules.forEach((rule, index) => {
    const box = el("input", { type: "checkbox", title: "启用" });
    box.checked = rule.enabled !== false;
    box.addEventListener("change", () => { rule.enabled = box.checked; });
    const ta = el("textarea", { placeholder: "规则内容（将注入系统提示词）" });
    ta.value = rule.content || "";
    ta.addEventListener("input", () => { rule.content = ta.value; });
    const del = el("button", { class: "del", title: "删除该规则", onclick: () => { state.editingPreset.rules.splice(index, 1); renderPresetRules(); } }, "✕");
    wrap.append(el("div", { class: "rule-row" }, box, ta, del));
  });
}

async function savePresetEditor() {
  const name = $("pd-name").value.trim();
  if (!name) return toast("需要预设名称");
  const draft = state.editingPreset;
  if (!draft.rules.length) draft.rules.push({ content: "", enabled: true });
  const p = state.presetView.presets.find((x) => x.id === draft.id);
  if (p) {
    p.name = name;
    p.rules = draft.rules.map((r, i) => ({ id: r.id || `rule-${Date.now()}-${i}`, content: r.content, enabled: r.enabled !== false }));
    p.enabled = draft.rules.some((r) => r.enabled !== false) ? p.enabled : false;
  } else {
    const id = `preset-${Date.now().toString(36)}`;
    state.presetView.presets.push({
      id, name, enabled: true,
      rules: draft.rules.map((r, i) => ({ id: `rule-${Date.now().toString(36)}-${i}`, content: r.content, enabled: r.enabled !== false })),
    });
    state.presetView.defaultSelected = [...(state.presetView.defaultSelected || []), id];
  }
  try {
    await savePresetsConfig({});
    $("preset-dlg").close();
    refreshContext();
    toast(`预设「${name}」已保存（下一条消息生效）`);
  } catch (e) {
    toast(`保存失败：${e.message}`);
  }
}

// ── 服务商设置 ─────────────────────────────────────────────────────

async function openSettings() {
  $("settings-dlg").showModal();
  await loadProviders();
  resetProviderForm();
}

async function loadProviders() {
  const { providers } = await api("/api/providers");
  state.providers = providers;
  renderProviders();
}

function renderProviders() {
  const wrap = $("provider-list");
  wrap.replaceChildren();
  for (const p of state.providers) {
    const row = el("div", {
      class: "provider-row" + (state.editingProvider === p.id ? " selected" : ""),
      onclick: () => editProvider(p.id),
    });
    row.append(el("span", { class: "name" }, p.id));
    if (p.shadowNative) row.append(el("span", { class: "tag" }, "覆盖内置"));
    row.append(el("span", { class: `tag ${p.active ? "ok" : "off"}` }, p.active ? "可用" : "未配置"));
    if (p.entry?.models?.length) row.append(el("span", { class: "tag" }, `${p.entry.models.length} 模型`));
    wrap.append(row);
  }
}

function resetProviderForm() {
  state.editingProvider = null;
  $("pf-title").textContent = "添加服务商";
  $("pf-id").value = "";
  $("pf-id").disabled = false;
  state.pfApi = "openai-completions";
  if (state.dd.api) state.dd.api.refresh();
  $("pf-baseurl").value = "";
  $("pf-key").value = "";
  $("pf-retry").value = "";
  $("pf-wait").value = "";
  $("pf-models").replaceChildren();
  setPfMsg("");
}

function setPfMsg(text, isError) {
  const elx = $("pf-msg");
  elx.textContent = text || "";
  elx.classList.toggle("error", Boolean(isError));
}

function editProvider(id) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  state.editingProvider = id; // 记住原 id：改名时作为 renameFrom 交给服务端迁移
  $("pf-title").textContent = `编辑服务商：${id}`;
  $("pf-id").value = id;
  $("pf-id").disabled = false; // 可改：保存时按 renameFrom 整体迁移旧条目
  state.pfApi = p.entry?.api || "openai-completions";
  if (state.dd.api) state.dd.api.refresh();
  $("pf-baseurl").value = p.entry?.baseUrl || "";
  $("pf-key").value = "";
  $("pf-retry").value = p.entry?.retryCount ?? "";
  $("pf-wait").value = p.entry?.retryWaitMs ? String(p.entry.retryWaitMs / 1000) : "";
  renderModelRows(p.entry?.models || []);
  setPfMsg(p.shadowNative ? "该 ID 与 pi 内置服务商同名：留空的字段继承内置目录默认。" : "");
  renderProviders();
  document.querySelector("#provider-list .provider-row.selected")?.scrollIntoView({ block: "nearest" });
}

function renderModelRows(models) {
  const wrap = $("pf-models");
  wrap.replaceChildren();
  for (const m of models) wrap.append(modelRow(m));
  if (!models.length) wrap.append(modelRow({ id: "" }));
}

function modelRow(m = {}) {
  // 上下文/最大输出/思考强度一律以真实值预填（可直接编辑）：
  // 端点披露了就用端点的，否则用保守默认（128K/16K）。
  const id = el("input", { placeholder: "模型 ID（必填）", autocomplete: "off", spellcheck: "false" });
  id.value = m.id || "";
  const name = el("input", { placeholder: "留空同 ID", autocomplete: "off", spellcheck: "false" });
  name.value = m.name && m.name !== m.id ? m.name : "";
  const ctx = el("input", { placeholder: "128000 / 256k / 1m", autocomplete: "off", spellcheck: "false" });
  ctx.value = formatCapacity(m.contextWindow ?? 128000);
  const max = el("input", { placeholder: "16384 / 32k", autocomplete: "off", spellcheck: "false" });
  max.value = formatCapacity(m.maxTokens ?? 16384);
  const efforts = el("input", { placeholder: "未指定级别", autocomplete: "off", spellcheck: "false" });
  if (m.thinkingEfforts !== undefined && m.thinkingEfforts !== false) efforts.value = m.thinkingEfforts;
  efforts.title = "逗号分隔的思考级别：off,minimal,low,medium,high,xhigh,max";
  let reasoning = Boolean(m.reasoning);
  let disabledThinking = m.thinkingEfforts === false;
  const thinkingNote = el("div", { class: "rp-note", role: "status" }, m.thinkingSource || "");
  const thinkingFetch = el("button", { type: "button", class: "btn small", title: "获取此模型的思考能力", onclick: async () => {
    const modelId = id.value.trim();
    if (!modelId) { thinkingNote.textContent = "请先填写模型 ID"; return; }
    const provider = $("pf-id").value.trim();
    const baseUrl = $("pf-baseurl").value.trim();
    thinkingFetch.disabled = true;
    thinkingNote.textContent = "正在获取…";
    try {
      const result = await api(`/api/providers/${encodeURIComponent(provider || "draft")}/discover/models`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: state.editingProvider || provider, baseUrl, apiKey: $("pf-key").value }),
        signal: AbortSignal.timeout(70000), // 慢端点：服务端 20s×3 重试，前端留足余量
      });
      if (!row.isConnected || id.value.trim() !== modelId || $("pf-baseurl").value.trim() !== baseUrl || $("pf-id").value.trim() !== provider) return;
      const found = result.models?.find((item) => item.id === modelId);
      if (!found) { thinkingNote.textContent = "服务商列表中未找到此模型"; return; }
      if (found.thinkingEfforts !== undefined) {
        efforts.value = found.thinkingEfforts === false ? "" : found.thinkingEfforts;
        syncChoices();
        disabledThinking = found.thinkingEfforts === false;
        reasoning = Boolean(found.reasoning);
        thinkingNote.textContent = `${found.thinkingSource || "服务商声明"}：${disabledThinking ? "不支持思考" : efforts.value}`;
      } else {
        if (found.reasoning === true) reasoning = true;
        thinkingNote.textContent = found.reasoning ? "支持思考，但未公布强度；可手动选择" : "服务商未公布思考能力；可手动选择";
      }
    } catch (error) { thinkingNote.textContent = "获取失败：" + error.message; }
    finally { thinkingFetch.disabled = false; }
  } }, "⟳ 获取思考强度");
  const choices = el("div", { class: "thinking-choices" });
  for (const [level, label] of state.levels || []) {
    const checkbox = el("input", { type: "checkbox" });
    checkbox.checked = efforts.value.split(",").includes(level);
    checkbox.addEventListener("change", () => {
      const selected = new Set(efforts.value.split(",").map((value) => value.trim()).filter(Boolean));
      if (checkbox.checked) selected.add(level); else selected.delete(level);
      efforts.value = (state.levels || []).map(([value]) => value).filter((value) => selected.has(value)).join(",");
      reasoning = [...selected].some((value) => value !== "off");
      disabledThinking = !reasoning;
    });
    choices.append(el("label", { class: "switch-line" }, checkbox, label));
  }
  const syncChoices = () => choices.querySelectorAll("input").forEach((checkbox, index) => {
    checkbox.checked = efforts.value.split(",").map((value) => value.trim()).includes(state.levels[index][0]);
  });
  efforts.addEventListener("input", syncChoices);
  // 容量非法输入实时标红
  const watchCapacity = (input) => {
    const check = () => {
      const t = input.value.trim();
      input.classList.toggle("invalid", t !== "" && parseCapacity(t) === undefined);
    };
    input.addEventListener("input", check);
    check();
  };
  watchCapacity(ctx);
  watchCapacity(max);

  const mkLabel = (text, input) => {
    const wrap = el("label", { class: "mf" });
    wrap.append(el("span", { class: "mf-label" }, text), input);
    return wrap;
  };

  const del = el("button", { class: "del", title: "移除该模型", onclick: () => row.remove() }, "✕");
  const row = el("div", { class: "model-row" });
  const line1 = el("div", { class: "model-line" },
    mkLabel("模型 ID（必填）", id),
    mkLabel("显示名（可选）", name),
    del,
  );
  const line2 = el("div", { class: "model-line" },
    mkLabel("上下文", ctx),
    mkLabel("最大输出", max),
    mkLabel("思考强度（off,low,high…）", efforts),
  );
  row.append(line1, line2, thinkingFetch, choices, thinkingNote);
  row._read = () => ({
    id: id.value,
    name: name.value,
    contextWindow: parseCapacity(ctx.value),
    maxTokens: parseCapacity(max.value),
    reasoning: Boolean(efforts.value.trim()) || reasoning,
    thinkingEfforts: efforts.value.trim() === "" ? (disabledThinking ? false : "") : efforts.value.trim(),
  });
  row._hasInvalid = () => Boolean(row.querySelector("input.invalid"));
  return row;
}

function collectForm() {
  const models = [...$("pf-models").querySelectorAll(".model-row")].map((r) => r._read());
  return {
    id: $("pf-id").value.trim(),
    // 编辑已有服务商时带上原 id：改名则服务端整体迁移旧条目（含密钥与模型）
    ...(state.editingProvider ? { renameFrom: state.editingProvider } : {}),
    api: state.pfApi,
    baseUrl: $("pf-baseurl").value.trim(),
    apiKey: $("pf-key").value,
    models,
  };
}

async function saveProvider() {
  const draft = collectForm();
  if (!draft.id) return setPfMsg("需要服务商 ID", true);
  const retryRaw = $("pf-retry").value.trim();
  const waitRaw = $("pf-wait").value.trim();
  if (retryRaw && !/^\d+$/.test(retryRaw)) return setPfMsg("重试次数需为非负整数（留空 = 默认 5）", true);
  if (waitRaw && !(Number(waitRaw) > 0 && Number(waitRaw) <= 600)) return setPfMsg("重试等待需为 1–600 的秒数（留空 = 默认 15）", true);
  draft.retryCount = retryRaw === "" ? null : Number(retryRaw);
  draft.retryWaitSeconds = waitRaw === "" ? null : Number(waitRaw);
  const rows = [...$("pf-models").querySelectorAll(".model-row")];
  const badAt = rows.findIndex((r) => r._hasInvalid && r._hasInvalid());
  if (badAt >= 0) {
    return setPfMsg(`第 ${badAt + 1} 个模型的上下文/最大输出格式不对（支持 128000、256k、1m）`, true);
  }
  try {
    await api(`/api/providers/${encodeURIComponent(draft.id)}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    const oldId = state.editingProvider;
    const renamed = Boolean(oldId && oldId !== draft.id);
    setPfMsg("已保存 ✓");
    await loadProviders();
    await loadModels();
    editProvider(draft.id);
    toast(renamed ? `服务商已改名：「${oldId}」→「${draft.id}」` : `服务商「${draft.id}」已保存`);
  } catch (e) {
    setPfMsg(`保存失败：${e.message}`, true);
  }
}

async function deleteProvider() {
  const id = state.editingProvider;
  if (!id) return setPfMsg("先在上方选择要删除的服务商", true);
  if (!(await uiConfirm(`删除服务商「${id}」`, "其密钥与模型目录一并移除。"))) return;
  try {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(`服务商「${id}」已删除`);
    await loadProviders();
    await loadModels();
    resetProviderForm();
  } catch (e) {
    setPfMsg(`删除失败：${e.message}`, true);
  }
}

async function fetchModels() {
  const draft = collectForm();
  setPfMsg("获取中…");
  try {
    const r = await api("/api/providers/discover/models", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: state.editingProvider || undefined, baseUrl: draft.baseUrl, apiKey: draft.apiKey }),
    });
    const models = r.models || [];
    if (!models.length) {
      setPfMsg(r.error || "端点未返回任何模型", true);
      return;
    }
    setPfMsg(r.warning ? `端点探测失败（${r.error || r.warning}），已列出当前已配置的模型` : `获取到 ${models.length} 个模型，勾选要添加的。`);
    openFetchDialog(models);
  } catch (e) {
    setPfMsg(`获取失败：${e.message}`, true);
  }
}

// ── 候选模型弹窗：高亮已添加，勾选未添加的并入 ──────────────────────

function openFetchDialog(models) {
  const existingIds = new Set(
    [...$("pf-models").querySelectorAll(".model-row")].map((r) => r._read().id),
  );
  state.fetchEntries = models.map((m) => {
    const added = existingIds.has(m.id);
    return { m, added, checked: false };
  });
  renderFetchList();
  $("fetch-dlg").showModal();
}

function renderFetchList() {
  const ul = $("fetch-list");
  ul.replaceChildren();
  for (const entry of state.fetchEntries) {
    const li = el("li", {
      class: "fetch-item" + (entry.added ? " added" : ""),
      onclick: () => {
        if (entry.added) return;
        entry.checked = !entry.checked;
        box.checked = entry.checked;
        updateFetchHint();
      },
    });
    let box;
    if (entry.added) {
      li.append(el("span", { class: "fetch-badge" }, "已添加"));
    } else {
      box = el("input", { type: "checkbox" });
      box.checked = entry.checked;
      box.addEventListener("click", (e) => e.stopPropagation());
      box.addEventListener("change", () => {
        entry.checked = box.checked;
        updateFetchHint();
      });
      li.append(box);
    }
    li.append(el("span", { class: "fid", title: entry.m.id }, entry.m.id));
    const caps = [entry.m.contextWindow && `${entry.m.contextWindow} 上下文`, entry.m.maxTokens && `${entry.m.maxTokens} 输出`].filter(Boolean).join(" · ");
    if (caps) li.append(el("span", { class: "fcap" }, caps));
    ul.append(li);
  }
  updateFetchHint();
}

function allFetchChecked() {
  const unadded = state.fetchEntries.filter((e) => !e.added);
  return unadded.length > 0 && unadded.every((e) => e.checked);
}

function updateFetchHint() {
  const checked = state.fetchEntries.filter((e) => !e.added && e.checked).length;
  const addedCount = state.fetchEntries.filter((e) => e.added).length;
  $("fetch-hint").textContent = `已添加 ${addedCount} · 已勾选 ${checked}`;
  const toggle = $("fetch-toggle-all");
  if (toggle) toggle.textContent = allFetchChecked() ? "取消全选" : "全选";
}

function toggleFetchAll() {
  const target = !allFetchChecked();
  for (const e of state.fetchEntries) {
    if (!e.added) e.checked = target;
  }
  renderFetchList();
}

function adoptFetched() {
  const current = [...$("pf-models").querySelectorAll(".model-row")].map((r) => r._read());
  const picks = state.fetchEntries.filter((e) => e.checked && !e.added).map((e) => e.m);
  const byId = new Set(current.map((m) => m.id));
  const additions = picks.filter((m) => !byId.has(m.id));
  // renderModelRows 自己会 modelRow() 建行：这里必须传普通对象，
  // 传 DOM 行会被二次 modelRow() 读成空 id（「添加后全变空行」的根因）
  renderModelRows([...current, ...additions]);
  $("fetch-dlg").close();
  setPfMsg(`已添加 ${additions.length} 个模型。`);
}

// ── 装配 ───────────────────────────────────────────────────────────

function wire() {
  $("btn-new").addEventListener("click", newSession);
  $("btn-send").addEventListener("click", send);
  // 左下角「设置」弹出菜单：收拢服务商设置 / 子代理管理
  $("btn-settings-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    $("settings-menu").hidden = !$("settings-menu").hidden;
  });
  $("settings-menu").addEventListener("click", (e) => {
    const item = e.target.closest(".sm-item");
    if (!item) return;
    $("settings-menu").hidden = true;
    if (item.dataset.action === "providers") openSettings();
    else if (item.dataset.action === "agents") {
      void (async () => { await loadSubagents(); blankAgentForm(); $("agents-dlg").showModal(); })();
    }
    else if (item.dataset.action === "presets") {
      void (async () => { await loadPresets(); $("presets-dlg").showModal(); })();
    }
  });
  $("presets-close").addEventListener("click", () => $("presets-dlg").close());
  document.addEventListener("pointerdown", (e) => {
    if (!$("settings-menu").hidden && !$("settings-menu").contains(e.target) && e.target !== $("btn-settings-menu")) {
      $("settings-menu").hidden = true;
    }
  });
  $("btn-jump-bottom").addEventListener("click", forceScrollBottom);
  bindScrollWatch();
  $("bookmark-bar").addEventListener("scroll", scheduleBmGlow, { passive: true });
  window.addEventListener("resize", scheduleBmGlow);
  bindBmTip();
  wireHtmlPreview();
  void loadAvatars(); // GameCoaster 像素角色头像（加载完成后重绘列表/坞）
  // 上下文仪表：点击后整块替换成「压缩」字样，再点开始计时，结束自动刷新；
  // 点其他地方或 5 秒内没点压缩 → 自动还原成上下文显示
  $("ctx-meter").addEventListener("click", (e) => {
    if (e.target.closest("#ctx-compact") || compactTimerInt) return;
    toggleCompactArm();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#ctx-meter")) disarmCompact();
  });
  $("ctx-compact").addEventListener("click", (e) => {
    e.stopPropagation();
    doCompact();
  });
  $("btn-rename").addEventListener("click", renameSession);
  $("agents-close").addEventListener("click", () => $("agents-dlg").close());
  $("agent-new").addEventListener("click", blankAgentForm);
  $("agent-save").addEventListener("click", saveAgent);
  $("agent-enable").addEventListener("click", () => setAgentEnabled(true));
  $("agent-disable").addEventListener("click", () => setAgentEnabled(false));
  $("agent-run-close").addEventListener("click", () => $("agent-run-dlg").close());
  $("agent-run-stop").addEventListener("click", stopSelectedAgent);
  $("btn-add-preset").addEventListener("click", () => openPresetEditor(null));
  $("pd-close").addEventListener("click", () => $("preset-dlg").close());
  $("pd-add-rule").addEventListener("click", () => {
    state.editingPreset.rules.push({ content: "", enabled: true });
    renderPresetRules();
  });
  $("pd-save").addEventListener("click", savePresetEditor);
  $("no-compaction").addEventListener("change", async (e) => {
    try {
      await savePresetsConfig({ noCompaction: e.target.checked });
      toast(e.target.checked ? "上下文不压缩已开启（新会话生效）" : "上下文不压缩已关闭（新会话生效）");
    } catch (err) {
      toast(`保存失败：${err.message}`);
      $("no-compaction").checked = !e.target.checked;
    }
  });
  $("btn-settings-close").addEventListener("click", () => {
    closeCurrentMenu();
    $("settings-dlg").close();
  });
  $("settings-dlg").addEventListener("cancel", () => closeCurrentMenu());
  wireAsk();
  state.dd.model = makeDropdown($("model-picker"), {
    getOptions: modelOptions,
    getValue: () => (state.model ? `${state.model.provider}/${state.model.modelId}` : ""),
    onPick: onModelChange,
    placeholder: "选择模型",
    emptyText: "无可用模型，请在设置里添加服务商",
    leftLabel: "模型选择",
    alignRight: true, // 右栏内：菜单向左展开
    // 横排多列菜单：内容自适应宽度
    buildMenu: buildModelMenu,
    menuClass: "model-menu",
    sizeToContent: true,
    menuMaxHeight: 360,
  });
  state.dd.thinking = makeDropdown($("thinking-picker"), {
    getOptions: thinkingOptions,
    getValue: () => state.thinking || "",
    onPick: onThinkingChange,
    placeholder: "未设置",
    leftLabel: "思考强度",
    alignRight: true,
    menuMinWidth: 200,
  });
  // 压缩模型（省钱）：手动 + 自动压缩的摘要都走它；空 = 跟随会话模型
  state.dd.compactModel = makeDropdown($("compact-model-picker"), {
    getOptions: () => [{ value: "", label: "跟随会话模型" }, ...modelOptions()],
    getValue: () => (state.compactionModel ? `${state.compactionModel.provider}/${state.compactionModel.model}` : ""),
    onPick: onCompactionModelChange,
    placeholder: "跟随会话模型",
    emptyText: "无可用模型",
    leftLabel: "压缩模型",
    alignRight: true,
    menuMinWidth: 240,
  });
  void loadCompactionModel();
  state.dd.workspace = makeDropdown($("workspace-picker"), {
    getOptions: () => [
      { value: "__add__", label: "＋ 添加工作区…", action: true },
      { value: "__remove__", label: "移除当前工作区", action: true, title: state.workspace || "" },
      ].concat(state.workspaces.map((w) => ({
        value: w.path,
        label: `${w.title}${w.count ? `（${w.count}）` : ""}`,
        title: w.path,
      }))),
    getValue: () => state.workspace || "",
    onPick: (value) => {
      if (value === "__add__") {
        addWorkspace();
        return;
      }
      if (value === "__remove__") {
        removeCurrentWorkspace();
        return;
      }
      state.workspace = value;
      rememberLast({ workspace: value });
      renderWorkspaces();
      renderSessions();
    },
    placeholder: "选择工作区",
  });
  state.dd.api = makeDropdown($("pf-api"), {
    portal: $("settings-dlg"),
    getOptions: () => ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].map((v) => ({ value: v, label: v })),
    getValue: () => state.pfApi,
    onPick: (v) => {
      state.pfApi = v;
      if (state.dd.api) state.dd.api.refresh();
    },
  });
  $("pf-save").addEventListener("click", saveProvider);
  $("pf-delete").addEventListener("click", deleteProvider);
  $("pf-fetch").addEventListener("click", fetchModels);
  $("pf-add-model").addEventListener("click", () => $("pf-models").append(modelRow({})));
  $("pf-new").addEventListener("click", resetProviderForm);
  $("fetch-close").addEventListener("click", () => $("fetch-dlg").close());
  $("fetch-cancel").addEventListener("click", () => $("fetch-dlg").close());
  $("fetch-adopt").addEventListener("click", adoptFetched);
  $("files-close").addEventListener("click", function () { $("files-dlg").close(); });
  $("diff-close").addEventListener("click", function () { $("diff-dlg").close(); });
  $("diff-back").addEventListener("click", openAllDiffDialog);
  $("btn-diff-all").addEventListener("click", openAllDiffDialog);
  $("fetch-toggle-all").addEventListener("click", toggleFetchAll);
  const input = $("input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => autoGrow(input));
  bindAttachInput();
  input.disabled = true;
  $("btn-send").disabled = true;
}

// ── 启动覆盖层（加载完成前挡住半成品页面） ──────────────────────────

function bootText(text) {
  const elx = $("boot-text");
  if (elx) elx.textContent = text;
}

function closeBootOverlay(errorText) {
  const overlay = $("boot-overlay");
  if (!overlay) return;
  if (errorText) {
    // 失败时留在覆盖层上给出原因和重试，避免露出残缺页面
    bootText("初始化失败");
    overlay.querySelector(".boot-box").append(
      el("div", { class: "boot-error" }, errorText),
      el("button", { class: "btn", onclick: () => location.reload() }, "重试"),
    );
    return;
  }
  overlay.remove();
}

async function boot() {
  wire();
  setInterval(() => { if (!document.hidden) updateAgentMetrics(); }, 1000);
  try {
    bootText("加载工作区…");
    await loadWorkspaces();
    // 刷新后回到上次的工作区（仍存在才恢复）
    const last = lastRemembered();
    if (last.workspace && state.workspaces.some((w) => w.path === last.workspace)) {
      state.workspace = last.workspace;
      renderWorkspaces();
    }
    bootText("加载会话与模型…");
    await Promise.all([loadSessions(), loadModels(), loadPresets(), loadSubagents()]);
    // 回到上次点击的会话（已被删除就不恢复）
    bootText("恢复上次会话…");
    if (last.sessionId && state.sessions.some((s) => s.id === last.sessionId)) {
      await openSession(last.sessionId);
    }
    closeBootOverlay();
    setInterval(() => {
      if (document.hidden || !state.sessionId) return;
      loadSessionSubagents();
    }, 2500);
  } catch (e) {
    toast(`初始化失败：${e.message}`);
    closeBootOverlay(e.message);
  }
}

boot();
