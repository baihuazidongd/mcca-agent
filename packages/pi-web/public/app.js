/* pi web — 原生前端（像素 RPG 风）。 */
"use strict";

const $ = (id) => document.getElementById(id);
const RUNTIME = window.__MCCA_RUNTIME__ === "codex" || window.__MCCA_RUNTIME__ === "openhands" || window.__MCCA_RUNTIME__ === "grok" ? window.__MCCA_RUNTIME__ : "pi";
const STORE = RUNTIME === "pi" ? "pi-web" : `${RUNTIME}-web`;
const LAST_WS_KEY = `${STORE}.last.workspace`;
const LAST_SESSION_KEY = `${STORE}.last.session`;
const ORDER_KEY = `${STORE}.session.order`;
const SCROLL_KEY = `${STORE}.scroll`;
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
  streamTextNode: null, // 正文流式文本节点（合帧后整段写入，避免每 token 一个 span）
  streamTextFull: "", // 正文全文（DOM 里生成中只留尾部，收口时用)
  thinkFull: "", // 思考全文（同上）
  pendingThink: "", // 待落 DOM 的思考增量（合帧缓冲）
  pendingText: "", // 待落 DOM 的正文增量（合帧缓冲）
  streamFlushTimer: 0, // 合帧定时器
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
  bgTasks: [], // 运行中的工具（后台任务面板）
  selectedRunAgent: null,
  runningTasks: [], // 跨会话：正在跑的会话（旗帜用）
  doneTasks: {}, // 跨会话：跑完但还没打开的会话 { id: {title, at} }
  openSeq: 0, // 会话切换代际号（并发切换只让最后一次写 DOM）\n  sessionOrder: loadSessionOrder(), // 会话列表排序：workspace=按工作区分组（默认）/ recent=全部工作区按最近
  currentTurn: null, // 当前轮次容器 { el, body, lead, steps, tokens, seconds, startedAt }
  errChain: null, // 连续同类错误的合并链 { chip, code }（成功后断开）
  serverQueue: [], // 服务端待发队列视图（prompt-queue 事件 / 打开会话时同步）
  transcriptViews: new Map(), // 会话 id → 已渲染的 transcript 视图 { el, lastSeq, bootId, turn }
  currentView: null, // 当前挂载的视图
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
/** 已经是终态、不会再动的子代理 run 状态（与 subagent-runs.cjs 的 TERMINAL 对齐）。 */
const TERMINAL_RUN_STATUS = new Set(["completed", "stopped", "failed"]);
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
// 每个会话一个随机助手名（按会话 id 稳定哈希：刷新/重开不变）
const SESSION_NAMES = [
  "皮皮", "阿码", "豆豆", "小满", "汤圆", "团子", "麦麦", "橘子", "南瓜", "可可",
  "麻薯", "布丁", "芋圆", "阿飞", "呆呆", "铁锤", "胡萝卜", "小铃", "阿黎", "米糕",
];
const assistantNameCache = new Map();
function assistantName(sessionId) {
  const key = String(sessionId || "");
  if (assistantNameCache.has(key)) return assistantNameCache.get(key);
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const name = SESSION_NAMES[Math.abs(hash) % SESSION_NAMES.length];
  assistantNameCache.set(key, name);
  return name;
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
/**
 * 「派子代理」提示词开头的会话：这类会话是别的流程按模板建出来专门跑一次子任务的，
 * 在旗帜里跟真任务混在一起只会让人以为子代理泄漏了。旗帜不显示（会话列表照旧）。
 */
function isDispatchOnlySession(item) {
  const title = String((item && item.title) || "");
  return /(?:请)?用\s*subagent\s*工具派|派一个\s*worker\s*子代理|delegated subagent|sole job is to execute the task/i.test(title);
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
/** 运行中的工具行计时：1s 刷新「bash 12s 运行中…」，长时间命令能看出是在跑而不是卡死。 */
function tickToolTimers() {
  const now = Date.now();
  for (const row of document.querySelectorAll('#transcript details.tool[data-started-at]')) {
    const started = Number(row.dataset.startedAt) || 0;
    const chip = row.querySelector(".tool-timer");
    if (!started || !chip) continue;
    const sec = Math.max(0, Math.round((now - started) / 1000));
    chip.textContent = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
  }
}

function settlePendingToolRows() {
  for (const row of transcriptHost().querySelectorAll('details.tool[data-tool-state="running"]')) {
    row.dataset.toolState = "unknown";
    delete row.dataset.startedAt;
    row.querySelector(".tool-timer")?.remove();
    const summary = row.querySelector("summary");
    const name = summary?.querySelector(".name")?.textContent || "tool";
    summary?.replaceChildren(el("span", { class: "name" }, name), " 已结束，未收到结果");
  }
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
  // 线程底部的「子代理工作中…」跟着 run 状态走（每秒刷，别让用户猜是不是卡了）
  const watching = state.selectedChildId && agentThreadCache.get(String(state.selectedChildId));
  if (watching) markAgentThreadWorking(watching, String(state.selectedChildId));
}
// ── 后台任务面板（对话定位下面）：运行中的工具 + 超时机制状态 ──────
function fmtBgElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** 面板：一行一个运行中的工具；点击开详情。 */
function renderBgTasks() {
  const box = $("bg-tasks");
  if (!box) return;
  const tasks = state.bgTasks || [];
  box.hidden = tasks.length === 0;
  if (!tasks.length) {
    box.replaceChildren();
    return;
  }
  const now = Date.now();
  const rows = [
    el("div", { class: "bg-head" },
      el("span", { class: "bg-head-label" }, "后台"),
      el("b", { class: "bg-head-count" }, String(tasks.length)),
    ),
  ];
  rows.push(...tasks.map((t) => {
    const elapsed = now - (Number(t.startedAt) || now);
    const detached = t.background === true;
    const softMs = 5 * 60_000;
    const hardMs = Number(t.timeoutMs) > 0 ? Math.max(Number(t.timeoutMs), 60_000) : 30 * 60_000;
    const level = detached ? " detached" : (elapsed >= hardMs ? " over" : elapsed >= softMs ? " warn" : "");
    const progress = detached ? 0 : Math.min(100, Math.round(elapsed / hardMs * 100));
    const stateLabel = detached ? "后台" : (level.includes("over") ? "超时" : level.includes("warn") ? "较慢" : "运行");
    return el("button", {
      type: "button",
      class: "bg-task-row" + level,
      title: `${t.name} · 已运行 ${fmtBgElapsed(elapsed)}${detached ? " · 后台执行中" : (Number(t.timeoutMs) > 0 ? ` · 超时 ${fmtBgElapsed(Number(t.timeoutMs))}` : "")}\n点击看详情`,
      onclick: () => openBgTask(t.callId),
    },
      el("span", { class: "bg-task-line" },
        el("i", { class: "bg-status", "aria-hidden": "true" }),
        el("span", { class: "bg-name", title: t.name || "tool" }, t.name || "tool"),
      ),
      el("span", { class: "bg-task-meta" },
        el("span", { class: "bg-time", "data-bg-time": String(t.startedAt || "") }, fmtBgElapsed(elapsed)),
        el("span", { class: "bg-state" }, stateLabel),
      ),
      el("span", { class: "bg-meter", "aria-hidden": "true", style: `--bg-progress:${progress}%` }, el("i")),
    );
  }));
  box.replaceChildren(...rows);
}

/** 1s 刷新面板上的计时（不重建 DOM，避免打断点击）。 */
function tickBgTaskTimes() {
  const now = Date.now();
  for (const node of document.querySelectorAll("#bg-tasks [data-bg-time]")) {
    const started = Number(node.dataset.bgTime) || 0;
    if (started) node.textContent = fmtBgElapsed(now - started);
  }
  if (!$("bg-task-dlg").open) return;
  const live = (state.bgTasks || []).find((t) => t.callId === state.bgTaskOpen);
  const slot = $("bg-task-body").querySelector("[data-bg-live]") ;
  if (slot) slot.textContent = live ? fmtBgElapsed(Date.now() - (Number(live.startedAt) || Date.now())) : "已结束";
}

/** 详情：命令原文、开始时间、已运行、上限（来自工具参数或默认）。 */
function openBgTask(callId) {
  const task = (state.bgTasks || []).find((t) => t.callId === callId);
  if (!task) {
    toast("这个任务已经结束了");
    return;
  }
  state.bgTaskOpen = callId;
  $("bg-task-title").textContent = `${task.name || "tool"} · 后台任务`;
  const hardMs = Number(task.timeoutMs) > 0 ? Number(task.timeoutMs) : 30 * 60_000;
  const body = $("bg-task-body");
  body.replaceChildren(
    el("div", { class: "bg-kv" }, el("span", null, "已运行"), el("b", { "data-bg-live": "" }, fmtBgElapsed(Date.now() - (Number(task.startedAt) || Date.now())))),
    el("div", { class: "bg-kv" }, el("span", null, "开始于"), el("b", null, new Date(Number(task.startedAt) || Date.now()).toLocaleTimeString("zh-CN", { hour12: false }))),
    el("div", { class: "bg-kv" }, el("span", null, "超时上限"), el("b", null, Number(task.timeoutMs) > 0 ? `${fmtBgElapsed(Number(task.timeoutMs))}（来自工具参数 timeout）` : `${fmtBgElapsed(hardMs)}（默认；长命令建议自己带 timeout）`)),
     el("div", { class: "bg-note" }, task.background
       ? "工具已经脱离当前回合在后台执行；完成或失败后会自动回到当前对话，并触发 AI 继续处理结果。"
       : "超过 5 分钟会有一次「慢工具提醒」；到上限还没结束会自动中断本轮，并立刻把控制权交回 AI 让它重新决策。"),
    el("pre", { class: "bg-args" }, String(task.args || "（无参数）")),
  );
  $("bg-task-hint").textContent = `callId ${String(callId).slice(0, 18)}`;
  $("bg-task-dlg").showModal();
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
    // 同一个子代理并行派了多个任务时，坞里只有一个格子——用气泡把数量说出来
    const active = (state.sessionSubagents.runs || []).filter(
      (item) => item.agent === agent.name && !TERMINAL_RUN_STATUS.has(String(item.status || "")),
    ).length;
    return el(
      "button",
      {
        type: "button",
        class: "agent-cell " + (agent.status || "unknown"),
        title: agentTitle(agent.name) + "（" + agent.name + "） · " + status + (active > 1 ? ` · ${active} 个任务在跑` : ""),
        onclick: () => openAgentRuns(agent.name, run?.childSessionId || agent.sessionId || (conv && conv.sessionId)),
      },
      active > 1 ? el("b", { class: "agent-badge", title: `${active} 个任务` }, String(active)) : null,
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
    clearInlineThreads();
    renderAgentDock();
    renderUnviewedFlag();
    return;
  }
  const parentId = state.sessionId;
  if (state.subagentsLoading === parentId) return;
  state.subagentsLoading = parentId;
  try {
    const snapshot = await api(`/api/sessions/${encodeURIComponent(parentId)}/subagents`);
    if (state.sessionId !== parentId) return;
    state.sessionSubagents = snapshot || { agents: [], runs: [] };
    renderAgentDock();
    renderUnviewedFlag();
    mountInlineChildren();
  } catch {
    // 会话尚未建立时保持现有图标
  } finally {
    if (state.subagentsLoading === parentId) state.subagentsLoading = null;
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
  renderUnviewedFlag();
  mountInlineChildren();
}
/** 工具行（子代理对话用）：与主对话同款 details.tool 结构。 */
function agentToolDetail(event) {
  const running = event.phase === "start";
  const node = el("details", { class: "tool step agent-tool", "data-call": event.callId });
  node.classList.toggle("err", Boolean(event.isError));
  node.append(el("summary", {},
    el("span", { class: "name" }, event.name || "tool"),
    running ? " 运行中…" : event.isError ? " 失败" : " 完成",
  ));
  const body = running ? event.args : (event.output || (event.isError ? "（出错）" : "（无输出）"));
  if (body) node.append(el("pre", {}, String(body).slice(0, 4000)));
  if (!running && Array.isArray(event.images) && event.images.length) {
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
  return node;
}

/**
 * 子代理对话线程：与主对话同款渲染（思考折叠块 / 工具行 / markdown 气泡）。
 * 之前只渲染 user + assistant 文本，子代理跑工具时界面一片空白，分不清在跑还是卡死。
 * host 传线程容器时，工具的 end 事件会就地更新对应的「运行中…」行，而不是再追加一行。
 */
function threadNodes(events, host = null) {
  const nodes = [];
  // 同一批里 start/end 还没挂到 host 上，得先用局部表按 callId 合并，
  // 否则回放时每个工具会占两行（「运行中…」+「完成」）
  const local = new Map();
  for (const event of events || []) {
    if (event.type === "user" && event.text) {
      const userDiv = el("div", { class: "agent-msg user md" });
      renderMarkdown(userDiv, event.text);
      nodes.push(userDiv);
      continue;
    }
    if (event.type === "thinking" && event.text) {
      nodes.push(makeThinkBlock(event.text));
      continue;
    }
    if (event.type === "tool") {
      const callId = String(event.callId || "");
      const existing = (callId && (local.get(callId) || (host ? host.querySelector(`details[data-call="${CSS.escape(callId)}"]`) : null))) || null;
      if (event.phase !== "start" && existing) {
        const fresh = agentToolDetail(event);
        existing.replaceChildren(...fresh.childNodes);
        existing.classList.toggle("err", Boolean(event.isError));
        continue; // 就地更新，不再多出一行
      }
      const node = agentToolDetail(event);
      if (callId) local.set(callId, node);
      nodes.push(node);
      continue;
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
  return nodes;
}

// ── 子代理对话：按 childSessionId 缓存 DOM + 增量追加 + 轮询 ──────────
// 切换对话卡，是因为每次都重新拉 transcript 并从零建 DOM；这里把渲染结果按
// 子会话缓存下来，切回去只是 appendChild（增量拉新事件）。
const agentThreadCache = new Map(); // childId -> { el, events, count, loading, agent }
let agentThreadTimer = 0;
let agentThreadWatching = "";
// 内联挂在主对话派生点下面的子线程：childSessionId -> agent 名。
// 一个父对话能同时挂着 N 条，所以轮询是集合级的，不像模态那样一次只看一条。
const inlineThreads = new Map();
let inlineTimer = 0;

function pruneAgentThreadCache(keepId) {
  if (agentThreadCache.size <= 6) return;
  for (const [key, entry] of agentThreadCache) {
    // 内联中的 DOM 就长在父对话里，摘掉等于把那段子对话从主对话撕走
    if (key === keepId || inlineThreads.has(key)) continue;
    entry.el.remove();
    agentThreadCache.delete(key);
    if (agentThreadCache.size <= 6) break;
  }
}

function getAgentThread(childId, agentName) {
  const key = String(childId || "");
  let entry = key ? agentThreadCache.get(key) : null;
  if (entry) return entry;
  entry = { el: el("div", { class: "agent-thread" }), events: [], count: 0, loading: false, agent: agentName, key };
  if (key) {
    agentThreadCache.set(key, entry);
    pruneAgentThreadCache(key);
  }
  return entry;
}

/** 线程底部是否贴着底（用户上翻看历史时别打断）。 */
function agentThreadStick(thread) {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
}

function markAgentThreadWorking(entry, childId) {
  const run = (state.sessionSubagents.runs || []).find((item) => item.childSessionId === childId || item.id === childId);
  const working = run?.status === "working";
  let mark = entry.el.querySelector(".agent-working");
  if (working) {
    if (!mark) mark = el("div", { class: "agent-working" }, "子代理工作中…");
    entry.el.append(mark); // append 已有节点=挪到末尾，光标始终压在最新内容下面
  } else if (mark) {
    mark.remove();
  }
}

/** 线程占位/兜底：拉不到内容时必须说清楚，绝不留一个「加载对话…」转圈。 */
function clearAgentPlaceholder(entry) {
  entry.el.querySelector(".agent-placeholder")?.remove();
}
function setAgentPlaceholder(entry, nodes) {
  clearAgentPlaceholder(entry);
  entry.el.prepend(el("div", { class: "agent-placeholder" }, ...nodes));
}
function agentRunFor(entry) {
  return (state.sessionSubagents.runs || []).find((item) => item.childSessionId === entry.key || item.id === entry.key) || null;
}
function agentFallbackNodes(entry, error) {
  const run = agentRunFor(entry);
  const nodes = [];
  if (run?.task) nodes.push(...threadNodes([{ type: "user", text: String(run.task) }]));
  if (run?.result || run?.error) nodes.push(...threadNodes([{ type: "assistant-end", text: run.result || "", error: run.error || undefined }]));
  if (run?.failHint) nodes.push(el("p", { class: "dim" }, run.failHint));
  if (!nodes.length) {
    nodes.push(el("p", { class: "dim" }, error
      ? `拿不到这次对话的记录：${error.message}`
      : "这次对话没有留下可回放的记录（多半是刚派出去还没落盘）"));
  }
  return nodes;
}

/** 增量同步一条线程：只渲染比上次多的部分；事件变少则整个重建。 */
async function syncAgentThread(key, agentName, { force = false } = {}) {
  const entry = key ? agentThreadCache.get(key) : null;
  if (!entry || !state.sessionId) return;
  if (entry.loading && !force) return;
  entry.loading = true;
  let failed = null;
  try {
    const transcript = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/subagents/${encodeURIComponent(key)}/transcript`);
    const events = Array.isArray(transcript.events) ? transcript.events : [];
    entry.fails = 0;
    if (entry.events.length && events.length < entry.events.length) {
      entry.el.replaceChildren();
      entry.events = [];
      entry.count = 0;
    }
    const fresh = events.slice(entry.count);
    if (fresh.length) {
      const stick = agentThreadStick(entry.el);
      clearAgentPlaceholder(entry);
      entry.el.append(...threadNodes(fresh, entry.el));
      entry.events = events;
      entry.count = events.length;
      if (stick && state.selectedChildId === key) entry.el.scrollIntoView({ block: "end" });
    } else if (!entry.count) {
      setAgentPlaceholder(entry, agentFallbackNodes(entry, null));
    }
  } catch (error) {
    // 网络抖动/记录已清理：下一轮再试，但界面上要给出解释（不能停在「加载对话…」）
    failed = error;
    entry.fails = (entry.fails || 0) + 1;
    if (!entry.count) setAgentPlaceholder(entry, agentFallbackNodes(entry, error));
  }
  entry.loading = false;
  markAgentThreadWorking(entry, key);
  // 终态 run + 连续拉不到 → 停止空转轮询（对话框重开还会再试一次）
  const run = agentRunFor(entry);
  const terminal = Boolean(run && TERMINAL_RUN_STATUS.has(String(run.status || "")));
  if (failed && entry.fails >= 3 && terminal) stopAgentThreadWatch();
  // 内联的必须自己收敛：终态后多拉一轮把尾巴收干净就停，
  // 否则一段长对话里每派一个子代理就多一条永久 1.5s 轮询。
  if (terminal && inlineThreads.has(key)) {
    entry.terminalHits = failed ? 0 : (entry.terminalHits || 0) + 1;
    if (entry.terminalHits >= 2 || (failed && entry.fails >= 3)) dropInlineThread(key);
  } else if (!terminal) {
    entry.terminalHits = 0;
  }
}

/** 打开对话框期间每 1.5s 拉一次增量：能看到工具在跑，不是静止画面。 */
function watchAgentThread(key, agentName) {
  if (agentThreadWatching === key && agentThreadTimer) return;
  stopAgentThreadWatch();
  agentThreadWatching = key;
  if (!key) return;
  agentThreadTimer = setInterval(() => {
    if (!$("agent-run-dlg").open || state.selectedChildId !== key) return;
    void syncAgentThread(key, agentName);
  }, 1500);
}

function stopAgentThreadWatch() {
  if (agentThreadTimer) clearInterval(agentThreadTimer);
  agentThreadTimer = 0;
  agentThreadWatching = "";
}

// ── 子对话内联进主对话 ─────────────────────────────────────────────
// 锚点是父转录里那次 subagent 工具调用的 details.tool[data-call=callId]：
// 服务端快照每个 run 都带 callId，两边对得上就能把子对话就地挂在它被派出来
// 的位置，全文流式展开，不用点开模态只看一条摘要。

function dropInlineThread(key) {
  if (!inlineThreads.delete(key)) return;
  if (!inlineThreads.size && inlineTimer) {
    clearInterval(inlineTimer);
    inlineTimer = 0;
  }
}

function clearInlineThreads() {
  inlineThreads.clear();
  if (inlineTimer) {
    clearInterval(inlineTimer);
    inlineTimer = 0;
  }
}

/** 所有内联子线程共用一个 1.5s 轮询：N 条子对话同时往前流。 */
function watchInlineThreads() {
  if (inlineTimer || !inlineThreads.size) return;
  inlineTimer = setInterval(() => {
    for (const [key, agentName] of inlineThreads) void syncAgentThread(key, agentName);
  }, 1500);
}

function inlineSlotOf(anchor) {
  let slot = anchor.nextElementSibling;
  if (!slot || !slot.classList.contains("agent-inline")) {
    slot = el("div", { class: "agent-inline" });
    anchor.after(slot);
  }
  return slot;
}

const RUN_STATUS_LABEL = { working: "运行中", completed: "完成", failed: "失败", stopped: "已停止", queued: "排队", unknown: "未知" };

// failLabel 是后端按失败原因分好类的短标签（空返回 / 角色名不存在 / 超时）：
// 光写「失败」分不清是被锁了权限还是模型没出声。
function runStateLabel(run) {
  const base = RUN_STATUS_LABEL[run?.status] || String(run?.status || "");
  return run?.failLabel ? `${base}·${run.failLabel}` : base;
}

/**
 * 一个锚点下面挂 N 条子对话：一次 workflow 扇出只有一次 subagent 工具调用，
 * 却可能派出 36 个子代理，它们全挂在那一行下面。
 * 增量挂载——已经渲染过的块不重建，否则子代理陆续落盘时会反复整槽重画。
 */
function mountSlotChildren(slot, runs) {
  const wanted = new Set();
  for (const run of runs) {
    const status = String(run.status || "unknown");
    // 终态却没留下子会话 = 永远不会有对话可回放（角色名不存在、空返回、被判死的孤儿）。
    // 这类要以它自己的身份挂在主对话里、就地报错，不能缩成一句「N 个已结束但没有留下
    // 对话」——36 个失败和 1 个失败在那句话里长得一模一样。
    const key = String(run.childSessionId || (TERMINAL_RUN_STATUS.has(status) ? run.id : ""));
    if (!key) continue;
    wanted.add(key);
    let block = slot.querySelector(`.agent-child[data-child="${CSS.escape(key)}"]`);
    if (block) {
      const chip = block.querySelector(".agent-child-state");
      if (chip) chip.textContent = runStateLabel(run);
      block.classList.toggle("failed", status === "failed");
      // 没有子会话的块，占位文案就是终稿：再去拉转录只是每轮多三次必然 404
      if (!run.childSessionId) continue;
      if (TERMINAL_RUN_STATUS.has(status)) {
        // 已经收敛（终态后停轮询）：快照再变也只补拉一次，不挂回定时器
        void syncAgentThread(key, run.agent);
        continue;
      }
      inlineThreads.set(key, run.agent || "");
      continue;
    }
    const entry = getAgentThread(key, run.agent);
    // 缓存里的 DOM 可能还挂在别处（换了会话又换回来），先摘下来再挂进这个槽
    if (entry.el.parentNode) entry.el.remove();
    block = el("div", { class: "agent-child", "data-child": key },
      el("div", { class: "agent-child-head" },
        agentAvatarImg(run.agent, 18),
        el("span", { class: "nm" }, agentTitle(run.agent)),
        el("span", { class: "agent-child-state" }, runStateLabel(run))),
      entry.el);
    if (status === "failed") block.classList.add("failed");
    slot.append(block);
    if (run.childSessionId) {
      inlineThreads.set(key, run.agent || "");
      void syncAgentThread(key, run.agent, { force: true });
    } else {
      setAgentPlaceholder(entry, agentFallbackNodes(entry, null));
    }
  }
  // 快照里已经没有的块摘掉，别让上一轮的子对话赖在主对话里
  for (const block of [...slot.querySelectorAll(".agent-child")]) {
    if (wanted.has(block.dataset.child)) continue;
    dropInlineThread(block.dataset.child);
    block.remove();
  }
  // 还没落盘的子会话要说人话：不留空槽，也不让人以为根本没派出去。
  // 终态却没有子会话的那些已经各自成块了，留在这儿只会重复一遍。
  let waiting = 0;
  for (const run of runs) {
    if (run.childSessionId || TERMINAL_RUN_STATUS.has(String(run.status || ""))) continue;
    waiting++;
  }
  const text = waiting ? `已派出 ${waiting} 个子代理，等它们的对话落盘…` : "";
  const note = slot.querySelector(".agent-pending");
  if (text) {
    if (note) note.textContent = text;
    else slot.prepend(el("div", { class: "agent-placeholder agent-pending" }, text));
  } else if (note) {
    note.remove();
  }
}

function mountInlineChildren() {
  const host = transcriptHost();
  if (!host || !state.sessionId) return;
  const byCall = new Map();
  for (const run of state.sessionSubagents.runs || []) {
    const callId = String(run.callId || "");
    if (!callId) continue;
    const list = byCall.get(callId);
    if (list) list.push(run);
    else byCall.set(callId, [run]);
  }
  for (const [callId, runs] of byCall) {
    const anchor = host.querySelector(`details.tool[data-spawn="1"][data-call="${CSS.escape(callId)}"]`);
    if (!anchor) continue;
    mountSlotChildren(inlineSlotOf(anchor), runs);
  }
  watchInlineThreads();
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
  const entry = getAgentThread(sessionId, name);
  if (!entry.el.childNodes.length) setAgentPlaceholder(entry, [el("p", { class: "dim" }, "加载对话…")]);
  body.replaceChildren(...[queue, el("div", { id: "agent-run-summary", class: "agent-run-summary" }), entry.el].filter(Boolean));
  const working = selectedAgentRun(name, sessionId);
  $("agent-run-stop").disabled = !working;
  $("agent-run-stop").dataset.runId = working ? working.id : "";
  $("agent-run-dlg").showModal();
  updateAgentMetrics();
  if (!sessionId || !state.sessionId) {
    const fallbackRun = selectedAgentRun(name, sessionId);
    entry.el.replaceChildren(...(fallbackRun && (fallbackRun.task || fallbackRun.result)
      ? threadNodes([
        fallbackRun.task ? { type: "user", text: fallbackRun.task } : null,
        fallbackRun.result ? { type: "assistant-end", text: fallbackRun.result } : null,
      ].filter(Boolean))
      : [el("p", { class: "dim" }, "还没有对应的子代理对话")]));
    stopAgentThreadWatch();
    return;
  }
  await syncAgentThread(String(sessionId), name, { force: true });
  watchAgentThread(String(sessionId), name);
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
  // 帧图拉不到（pi-web 正在重启 / 素材缺失）时退回内置 SVG 头像：
  // 否则浏览器留一个破图 + alt 文字（“PI 编程助手”），得刷新页面才恢复
  const fallback = () => {
    avatarAnims.delete(entry);
    img.onerror = null;
    img.src = AVATAR_ASSISTANT;
  };
  img.onerror = fallback;
  img.src = `/avatars/${frames[0]}`;
  img._avatarOn = true; // 观察器回调前先播；离开视口后停，避免后台解码
  avatarView.observe(img);
  avatarAnims.add(entry);
  if (!avatarTicker) avatarTicker = setInterval(avatarTick, 220);
}
const avatarView = new IntersectionObserver((entries) => {
  for (const entry of entries) entry.target._avatarOn = entry.isIntersecting;
});
function avatarTick() {
  if (document.hidden) return;
  for (const entry of avatarAnims) {
    if (!entry.img.isConnected) {
      avatarView.unobserve(entry.img);
      avatarAnims.delete(entry);
      continue;
    }
    if (entry.img._avatarOn === false) continue;
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
  const fallback = kind === "user" ? AVATAR_USER : AVATAR_ASSISTANT;
  if (kind === "user") {
    img.src = AVATAR_USER;
  } else {
    const frames = assistantAvatarFrames(sessionId);
    if (frames) registerAvatarAnim(img, frames);
    else img.src = AVATAR_ASSISTANT;
  }
  // 任何加载失败都退回内置 SVG（头像装饰性，不该出现破图）
  img.onerror = () => { img.onerror = null; img.src = fallback; };
  img.width = size;
  img.height = size;
  img.className = "pixelated c-avatar";
  img.alt = kind === "user" ? "你" : "助手";
  return img;
}

function agentAvatarImg(name, size = 24) {
  const img = document.createElement("img");
  const frames = agentAvatarFrames(name);
  if (frames) registerAvatarAnim(img, frames);
  else img.src = AVATAR_ASSISTANT;
  img.onerror = () => { img.onerror = null; img.src = AVATAR_ASSISTANT; };
  img.width = size;
  img.height = size;
  img.className = "pixelated";
  img.alt = agentTitle(name);
  return img;
}

/** 右下角大图：当前会话的角色动图（对话内不再显示头像）；点击做反应。 */
function renderPet() {
  const box = $("pet");
  if (!box) return;
  box.replaceChildren();
  if (!state.sessionId) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.dataset.busy = "0";
  box.title = "点我一下";
  box.append(avatarImg("assistant", 132, state.sessionId), el("span", { class: "pet-say" }));
  box.onclick = () => petReact();
  // 连点/拖拽会选中图片（浏览器蓝底高亮）：按下即阻止默认选择行为
  box.onmousedown = (event) => event.preventDefault();
}

// 点击反应：现有素材上做（CSS 变形 + 台词气泡，再点一下恢复常态循环）
const PET_LINES = ["在的！", "干什么~", "别戳我…", "嗯？", "忙着呢", "戳我干嘛", "嘿嘿", "来了来了", "干嘛呀", "在忙在忙"];
const PET_ACTIONS = ["pet-bounce", "pet-flip", "pet-shake", "pet-zoom", "pet-spin"];
let petReactionTimer = 0;
let petSayTimer = 0;

function petSay(text) {
  const say = $("pet")?.querySelector(".pet-say");
  if (!say) return;
  say.textContent = text;
  say.classList.add("show");
  clearTimeout(petSayTimer);
  petSayTimer = setTimeout(() => say.classList.remove("show"), 1800);
}

function stopPetReaction() {
  clearTimeout(petReactionTimer);
  const box = $("pet");
  if (!box) return;
  box.dataset.busy = "0";
  for (const action of PET_ACTIONS) box.classList.remove(action);
}

function petReact() {
  const box = $("pet");
  if (!box || box.hidden) return;
  if (box.dataset.busy === "1") {
    stopPetReaction(); // 再点一下：收起动作，回到常态循环
    return;
  }
  box.dataset.busy = "1";
  const action = PET_ACTIONS[Math.floor(Math.random() * PET_ACTIONS.length)];
  for (const name of PET_ACTIONS) box.classList.remove(name);
  void box.offsetWidth; // 重启动画
  box.classList.add(action);
  petSay(PET_LINES[Math.floor(Math.random() * PET_LINES.length)]);
  petReactionTimer = setTimeout(stopPetReaction, 1000);
}

async function loadAvatars() {
  try {
    const m = await fetch("/avatars/manifest.json").then((r) => r.json());
    if (m && Array.isArray(m.main) && m.main.length) {
      state.avatars = m;
      renderSessions();     // 会话列表换头像
      renderAgentDock();    // 子代理坞换头像
      renderPet();          // 右下角大图
    }
  } catch { /* 没素材就用默认像素小人 */ }
}

// ── 基础设施 ───────────────────────────────────────────────────────

async function api(path, options) {
  const request = { ...(options || {}) };
  // 启动接口异常卡住时给用户明确错误，避免永久停在某个 boot 文案。
  // 调用方自己传 signal 时保留它的超时/取消策略。
  if (!request.signal && typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    request.signal = AbortSignal.timeout(20000);
  }
  const res = await fetch(path, request);
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
  // attrs 允许传 null（调用方想“只要子节点”时省事）：默认值只对 undefined 生效
  for (const [k, v] of Object.entries(attrs || {})) {
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
    // 只有「按钮会跟着离开原位」的滚动才关闭菜单：文档/窗口级滚动，或滚动容器
    // 恰好包含下拉按钮。否则像流式输出时聊天区自动滚动，会把刚打开的菜单顶掉。
    const target = e.target;
    const affectsButton = target === document || target === window
      || (target instanceof Node && target.contains(root));
    if (!affectsButton) return;
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

/** 时间戳 → HH:MM（本地时区）。事件自带 at 时一律用它，别用渲染时刻。 */
function fmtClock(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function clockNow() {
  return fmtClock(Date.now());
}

/** 流式期间的滚底：用户上翻后（stickBottom=false）不再打扰。 */
let scrollBottomRaf = 0;
let scrollAdjust = 0; // >0 时这次 scroll 是程序改的，不能当成用户上翻，也不能覆盖会话记忆
let scrollHold = 0; // 用户或「置底」接手后，未完成的位置恢复要停手
let scrollSaveTimer = 0;
function setScrollTop(node, value) {
  if (!node) return;
  scrollAdjust++;
  node.scrollTop = value;
  scrollAdjust--;
}
function scrollBottom() {
  if (!state.stickBottom || state.replaying) return; // 回放期间统一滚，避免逐条强制重排
  if (scrollBottomRaf) return;
  scrollBottomRaf = requestAnimationFrame(() => {
    scrollBottomRaf = 0;
    if (!state.stickBottom || state.replaying) return;
    const t = $("transcript");
    setScrollTop(t, t.scrollHeight);
  });
}

function scrollMap() {
  try {
    const data = JSON.parse(localStorage.getItem(SCROLL_KEY) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function savedScroll(id) {
  if (!id) return null;
  const row = scrollMap()[String(id)];
  return row && typeof row === "object" ? row : null;
}

/** 记下离开时离底部的距离。贴底记 atBottom，这样下次新消息仍落在最底。 */
function captureScroll(id) {
  const t = $("transcript");
  if (!t || !id || state.replaying) return;
  const dist = Math.max(0, Math.round(t.scrollHeight - t.scrollTop - t.clientHeight));
  const all = scrollMap();
  all[String(id)] = { atBottom: dist < 48, dist, at: Date.now() };
  const entries = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 150);
  try { localStorage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(entries))); } catch { /* 存不下就只在本次会话里有效 */ }
}

function scheduleScrollSave() {
  clearTimeout(scrollSaveTimer);
  const id = state.sessionId;
  if (!id) return;
  scrollSaveTimer = setTimeout(() => {
    if (state.sessionId !== id || state.replaying || state.openLoading) return;
    captureScroll(id);
  }, 180);
}

function jumpToBottom() {
  const t = $("transcript");
  if (!t || !state.stickBottom) return;
  setScrollTop(t, Math.max(0, t.scrollHeight - t.clientHeight));
}

/** 用户主动回到底部（发送消息 / 点置底）：恢复跟随，并在布局涨高后再补一次。 */
function forceScrollBottom() {
  scrollHold++;
  state.stickBottom = true;
  const btn = $("btn-jump-bottom");
  if (btn) btn.hidden = true;
  jumpToBottom();
  requestAnimationFrame(jumpToBottom);
  setTimeout(jumpToBottom, 60);
  setTimeout(jumpToBottom, 240);
  if (!state.replaying) captureScroll(state.sessionId);
}

/** 恢复上次离开这个会话时的阅读位置。没有记录、或当时就在底部，则真正贴底。 */
function restoreScroll(id) {
  const saved = savedScroll(id);
  const t = $("transcript");
  if (!t) return;
  if (!saved || saved.atBottom !== false || !Number.isFinite(saved.dist)) {
    forceScrollBottom();
    return;
  }
  const hold = scrollHold;
  state.stickBottom = false;
  let settled = false;
  const place = (final) => {
    if (hold !== scrollHold || settled) return;
    const max = Math.max(0, t.scrollHeight - t.clientHeight);
    // 记录比当前内容还远：多半是更早的消息还没画完。先别钉在一个错误高度上。
    if (!final && saved.dist > max + 8) return;
    settled = true;
    const want = Math.max(0, Math.min(max, max - saved.dist));
    if (Math.abs(t.scrollTop - want) > 1) setScrollTop(t, want);
    const btn = $("btn-jump-bottom");
    if (btn) btn.hidden = max - want < 48;
  };
  place(false);
  requestAnimationFrame(() => place(false));
  setTimeout(() => place(false), 60);
  setTimeout(() => place(true), 240);
  const btn = $("btn-jump-bottom");
  if (btn) btn.hidden = false;
}

/** 距底部超过阈值即视为「上翻」，显示置底按钮。 */
function bindScrollWatch() {
  const t = $("transcript");
  let watchRaf = 0;
  t.addEventListener("scroll", () => {
    // 回放/换会话时 DOM 替换会把 scrollTop 打到 0，这次不能写进记忆，否则把上次的位置盖掉
    if (scrollAdjust || state.replaying || state.openLoading) return;
    scrollHold++;
    if (watchRaf) return;
    watchRaf = requestAnimationFrame(() => {
      watchRaf = 0;
      if (state.replaying || state.openLoading) return;
      const dist = t.scrollHeight - t.scrollTop - t.clientHeight;
      state.stickBottom = dist < 48;
      const btn = $("btn-jump-bottom");
      if (btn) btn.hidden = state.stickBottom;
      if (!state.sessionId) return;
      scheduleScrollSave();
    });
  }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) captureScroll(state.sessionId);
  });
  window.addEventListener("pagehide", () => captureScroll(state.sessionId));
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
  if (state.replaying) return; // 历史回放结束后统一构建，避免每轮扫描和重排整棵树
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

// ── 任务旗帜：跨会话的进行中 / 刚完成未查看任务，点开直接跳 ──────────
// 子代理任务不在这里重复展示——右侧「子代理」坞已经按角色列出。

const DONE_TASKS_KEY = `${STORE}:done-tasks`; // 跑完但还没打开过、需要提醒的会话
let flagMenuOpen = false;
let flagMenuSig = "";

/** 「刚跑完但还没打开过」的会话：{ [sessionId]: { title, at } }，跨刷新保留。 */
function loadDoneTasks() {
  state.doneTasks = {};
  try {
    const saved = JSON.parse(localStorage.getItem(DONE_TASKS_KEY) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) state.doneTasks = saved;
  } catch {
    // 本地记录损坏：当作没有
  }
}
function saveDoneTasks() {
  try {
    localStorage.setItem(DONE_TASKS_KEY, JSON.stringify(state.doneTasks || {}));
  } catch {
    // localStorage 不可用时降级（仅本次会话内有效）
  }
}
function clearDoneTask(sessionId) {
  if (!sessionId || !state.doneTasks || !(sessionId in state.doneTasks)) return;
  delete state.doneTasks[sessionId];
  saveDoneTasks();
}
function sessionShort(id) {
  const s = (state.sessions || []).find((x) => String(x.id) === String(id));
  return (s && s.title) || String(id).slice(0, 8);
}

/**
 * 旗帜条目：跨会话进行中的任务 + 刚跑完还没打开的会话 + 本会话未查看的子任务。
 * 排序：进行中优先，其次按时间倒序。
 */
function flagEntries() {
  const out = [];
  const runningIds = new Set();
  for (const s of state.runningTasks || []) {
    runningIds.add(String(s.id));
    out.push({ kind: "session", id: String(s.id), title: s.title || sessionShort(s.id), running: true, at: s.updatedAt || 0 });
  }
  for (const [id, info] of Object.entries(state.doneTasks || {})) {
    if (runningIds.has(id)) continue;
    out.push({ kind: "session", id, title: (info && info.title) || sessionShort(id), running: false, at: (info && info.at) || 0 });
  }
  return out.sort((a, b) => (Number(b.running === true) - Number(a.running === true)) || ((b.at || 0) - (a.at || 0)));
}

/**
 * 轮询会话列表：跟踪「谁在跑 / 谁刚跑完」，驱动跨会话旗帜。
 * 只更新旗帜相关状态，不重绘会话列表（避免打断列表上的悬停/点击）。
 */
async function refreshRunningSessions() {
  try {
    // 轻量接口：只报 id/标题/是否在跑，不解析会话文件（轮询完整列表会周期性卡住服务端）
    const r = await api("/api/sessions/running");
    const sessions = (r.sessions || []).filter((s) => !isSubagentHistoryItem(s) && !isDispatchOnlySession(s));
    const running = sessions.filter((s) => s.running);
    const nowIds = new Set(sessions.map((s) => String(s.id)));
    for (const meta of state.runningTasks || []) {
      const id = String(meta.id);
      if (running.some((s) => String(s.id) === id) || id === String(state.sessionId)) continue;
      if (!nowIds.has(id)) continue;
      state.doneTasks[id] = { title: meta.title || sessionShort(id), at: Date.now() };
    }
    for (const id of Object.keys(state.doneTasks || {})) {
      if (!nowIds.has(id)) delete state.doneTasks[id]; // 会话已删除
    }
    state.runningTasks = running;
    for (const s of sessions) {
      const hit = (state.sessions || []).find((x) => String(x.id) === String(s.id));
      if (hit && s.title) hit.title = s.title; // 让旗帜里的标题保持最新
    }
    saveDoneTasks();
    renderUnviewedFlag();
  } catch {
    // 网络抖动忽略，下一轮再试
  }
}
function closeFlagMenu() {
  const menu = $("bm-flag-menu");
  if (menu) menu.hidden = true;
  flagMenuOpen = false;
  flagMenuSig = "";
}
/** 只更新按钮（供每秒计时调用，不碰已打开的菜单，避免点击被重绘打断）。 */
function updateUnviewedFlagBadge() {
  const btn = $("bm-flag");
  if (!btn) return;
  const count = flagEntries().length;
  btn.hidden = count === 0;
  if (btn.hidden) {
    closeFlagMenu();
    return;
  }
  btn.title = `${count} 个任务`;
  btn.replaceChildren(document.createTextNode("⚑"), el("b", {}, String(count)));
}
/** 菜单内容指纹：内容没变就不重建，避免轮询刷新时打断悬停/点击。 */
function flagSignature(entries) {
  return entries.map((e) => `${e.id}:${e.running ? "running" : "done"}`).join("|");
}
function flagSessionRow(entry) {
  return el("div", {
    class: "fm-row session " + (entry.running ? "working" : "completed"),
    title: entry.title,
    onclick: () => {
      closeFlagMenu();
      if (entry.id === state.sessionId) {
        forceScrollBottom();
        return;
      }
      clearDoneTask(entry.id);
      void openSession(entry.id);
    },
  },
    el("span", { class: "fm-ico" }, entry.running ? "▶" : "✓"),
    el("div", { class: "fm-main" },
      el("div", { class: "fm-name" }, entry.title),
      el("div", { class: "fm-meta" }, entry.running ? "任务进行中 · 点击查看" : "已完成 · 点击查看"),
    ),
  );
}
function renderFlagMenu(entries = flagEntries()) {
  const menu = $("bm-flag-menu");
  const btn = $("bm-flag");
  if (!menu || !btn || btn.hidden) return;
  if (!entries.length) {
    menu.replaceChildren(el("div", { class: "fm-empty" }, "没有进行中的任务"));
  } else {
    menu.replaceChildren(...entries.map(flagSessionRow));
  }
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(8, r.right + 6) + "px";
  menu.style.top = Math.max(8, Math.min(r.top, window.innerHeight - menu.offsetHeight - 8)) + "px";
  flagMenuOpen = true;
  flagMenuSig = flagSignature(entries);
}
function toggleFlagMenu() {
  if (flagMenuOpen) closeFlagMenu();
  else renderFlagMenu();
}
/** 会话/子任务状态变化时调用：刷新按钮；菜单开着且内容变了才重建。 */
function renderUnviewedFlag() {
  updateUnviewedFlagBadge();
  if (!flagMenuOpen) return;
  if ($("bm-flag").hidden) {
    closeFlagMenu();
    return;
  }
  const entries = flagEntries();
  if (flagSignature(entries) === flagMenuSig) return; // 无变化不重建，避免打断悬停/点击
  renderFlagMenu(entries);
}

// ── 消息富文本：Markdown / 图片 / 链接 / 可点击路径 ────────────────

const PATH_RE = /(?:[A-Za-z]:[\\/](?:[^\s"'`<>|*?:]+[\\/])*[^\s"'`<>|*?:]*)|(?:\/(?:[\w.@+-]+\/)+[\w.@+-]*)|(?:[\w.@-]+(?:[\\/][\w.@-]+)+)/g;
const TRAILING = /[.,;:)\]}'"]+$/;

function sessionCwd() {
  const s = state.sessions.find((x) => x.id === state.sessionId);
  return s ? s.cwd : null;
}

/** 把渲染后的 DOM 里的文本路径替换为可点击链接（存在性经服务端确认）。 */
function scheduleLinkify(scope) {
  const run = () => { void linkifyPaths(scope); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 200);
}

async function linkifyPaths(scope) {
  const candidates = new Map(); // raw → {path, kind}|null
  const nodes = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    // 已经是链接的文本不要再链接（否则回切重扫会把链接套成两层）
    if (node.parentElement && node.parentElement.closest(".path-link")) continue;
    PATH_RE.lastIndex = 0;
    if (PATH_RE.test(node.textContent)) nodes.push(node);
    PATH_RE.lastIndex = 0;
  }
  if (!nodes.length) return;
  const cwd = sessionCwd() || "";

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
  const uniq = Array.from(new Set(pending)).slice(0, 400);
  if (!uniq.length) return;
  // 一次批量探测（相对路径连同 cwd 拼接一起问），替代逐路径 GET
  const probe = [];
  for (const raw of uniq) {
    probe.push(raw);
    if (!/^[A-Za-z]:/.test(raw) && !raw.startsWith("/")) probe.push(cwd.replace(/[\\/]+$/, "") + "\\" + raw);
  }
  const resolved = new Map();
  try {
    const r = await api("/api/fs/exists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: probe.slice(0, 500) }),
    });
    for (const [p, v] of Object.entries(r.results || {})) resolved.set(p, v);
  } catch {
    return; // 探测失败：本回合不做链接化（不影响阅读）
  }
  for (const raw of uniq) {
    const abs = resolved.get(raw);
    let out = abs && (abs.file || abs.dir) ? { path: abs.path, kind: abs.dir ? "dir" : "file" } : null;
    if (!out && !/^[A-Za-z]:/.test(raw) && !raw.startsWith("/")) {
      const joined = cwd.replace(/[\\/]+$/, "") + "\\" + raw;
      const rel = resolved.get(joined);
      if (rel && (rel.file || rel.dir)) out = { path: rel.path, kind: rel.dir ? "dir" : "file" };
    }
    candidates.set(raw, out);
  }

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
    // 流式回复会反复重建 markdown 节点：不 lazy 的话，屏幕外的图也要下载+解码，
    // 图片多的会话（生图/像素画）会把内存和 CPU 顶爆
    img.loading = "lazy";
    img.decoding = "async";
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

let sessionsLoadedAt = 0;
/**
 * 刷新会话列表。
 * 注意：完整列表要服务端解析几十 MB 会话文件（冷扫 ~2s，会堵住 SSE）；
 * 所以默认 20s 节流——发消息/编辑这类热路径不能每次都触发它。
 * 显式动作（新建/删除/重命名/手动刷新）传 { force: true }。
 */
async function loadSessions({ force = false } = {}) {
  if (!force && Date.now() - sessionsLoadedAt < 55000) return;
  sessionsLoadedAt = Date.now();
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
  // 「打开文件夹」只在有工作区时出现，title 里带上路径（选错的目录一眼能看出来）
  const open = $("btn-open-workspace");
  if (open) {
    open.hidden = !state.workspace;
    if (state.workspace) open.title = `在资源管理器中打开：${state.workspace}`;
  }
}

/** 让服务端调系统文件管理器打开当前工作区（浏览器自己开不了本地目录）。 */
async function openWorkspaceFolder() {
  if (!state.workspace) {
    toast("先选择或添加工作区");
    return;
  }
  try {
    await api("/api/reveal", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: state.workspace }),
    });
    toast(`已在资源管理器打开：${state.workspace}`);
  } catch (e) {
    toast(`打开文件夹失败：${e.message}`);
  }
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

// ── 会话列表排序开关（工作区行右侧的滑动按钮） ────────────────────
// workspace：只看当前工作区（默认）；recent：所有工作区混排、按最近活动排序。

function loadSessionOrder() {
  try {
    return localStorage.getItem(ORDER_KEY) === "recent" ? "recent" : "workspace";
  } catch {
    return "workspace";
  }
}

function setSessionOrder(mode) {
  state.sessionOrder = mode === "recent" ? "recent" : "workspace";
  try {
    localStorage.setItem(ORDER_KEY, state.sessionOrder);
  } catch { /* 存不了就只影响下次打开 */ }
  renderOrderButton();
  renderSessions();
}

function renderOrderButton() {
  const btn = $("btn-order");
  if (!btn) return;
  const recent = state.sessionOrder === "recent";
  btn.classList.toggle("on", recent);
  btn.setAttribute("aria-pressed", recent ? "true" : "false");
  btn.title = recent
    ? "当前：全部工作区按最近排序（点击切回按工作区分组）"
    : "当前：按工作区分组（点击切换：全部工作区按最近排序）";
}

/** 会话所属工作区名的显示用（列表里没有注册就退回目录名）。 */
function wsNameOf(cwd) {
  const norm = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  const w = state.workspaces.find((x) => norm(x.path) === norm(cwd));
  if (w) return w.title || w.path;
  const parts = String(cwd || "").split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "未分组";
}

/** 点下去的同一帧先换高亮，不等整表重画、也不等历史回来。 */
function markSessionActive(id) {
  const ul = $("session-list");
  if (!ul) return;
  const want = id ? String(id) : "";
  for (const li of ul.querySelectorAll("li[data-sid]")) {
    li.classList.toggle("active", li.dataset.sid === want);
  }
}

/** 列表内容没变就别拆掉头像重建：每次重建都会重新解码一串帧图。 */
let sessionListSig = null;
function sessionListSignature(list, recent) {
  const rows = list.map((s) => [s.id, s.title || "", s.running ? 1 : 0, s.updatedAt || 0, recent ? s.cwd || "" : ""].join("\u0001")).join("\u0002");
  return (recent ? "recent" : "workspace") + "\u0002" + rows;
}

function renderSessions() {
  const ul = $("session-list");
  const norm = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  const ws = state.workspaces.find((w) => norm(w.path) === norm(state.workspace));
  const recent = state.sessionOrder === "recent";
  const list = recent
    ? [...state.sessions].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    : (ws ? state.sessions.filter((s) => norm(s.cwd) === norm(ws.path)) : []);
  const sig = sessionListSignature(list, recent);
  if (sig === sessionListSig && ul.childElementCount) {
    markSessionActive(state.sessionId);
    return;
  }
  sessionListSig = sig;
  ul.replaceChildren();
  if (!list.length) {
    ul.append(el("li", { class: "empty" }, recent ? "还没有会话" : ws ? "这个工作区还没有会话" : "还没有会话"));
    return;
  }
  for (const s of list) {
    const li = el("li", {
      class: s.id === state.sessionId ? "active" : "",
      "data-sid": s.id,
      onclick: () => openSession(s.id),
      title: s.title || s.id,
    });
    li.append(avatarImg("assistant", 26, s.id));
    const body = el("div", { class: "s-body" });
    body.append(el("div", { class: "s-title" }, s.title || s.id.slice(0, 8)));
    // 混排模式下带上工作区名，跨区找会话不会认错
    body.append(el("div", { class: "s-time" }, recent ? `${wsNameOf(s.cwd)} · ${timeOf(s.updatedAt)}` : timeOf(s.updatedAt)));
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
      body: JSON.stringify({
        ...(cwd ? { cwd } : {}),
        ...(state.model ? { provider: state.model.provider, modelId: state.model.modelId } : {}),
      }),
    });
    state.sessionId = id;
    $("transcript").replaceChildren();
    state.currentView = null; // 新会话：没有缓存视图
    state.currentTurn = null;
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
      await loadSessions({ force: true });
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
      forgetTranscriptView(id);
      $("transcript").replaceChildren();
      state.streamBubble = null;
      state.streamThink = null;
      clearStreamStatus();
      $("session-title").textContent = "选择或新建会话";
      $("btn-rename").hidden = true;
      $("input").disabled = true;
      $("btn-send").disabled = true;
    }
    await loadSessions({ force: true });
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
    await loadSessions({ force: true });
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

function chatRow(kind, at) {
  const row = el("div", { class: `chat-row ${kind}` });
  // 头像不再出现在对话里：改到 web 右下角显示大图（#pet）
  const col = el("div", { class: "bubble-col" });
  const meta = el("div", { class: "c-meta" },
    el("span", { class: "name" }, kind === "user" ? "我" : assistantName(state.sessionId)),
    el("span", { class: "c-time" }, fmtClock(at)),
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

function startTaskTimer(fromTs) {
  resetTaskTimer();
  const elx = $("task-timer");
  taskStartTs = Number.isFinite(fromTs) && fromTs > 0 ? fromTs : Date.now();
  elx.hidden = false;
  elx.classList.remove("done");
  const tick = () => {
    elx.textContent = `任务中 ${fmtElapsed((Date.now() - taskStartTs) / 1000)}`;
  };
  tick();
  taskTimerInt = setInterval(tick, 500);
}

/** 回放：直接按服务端落盘的时长显示历史任务耗时（不重跑计时）。 */
function showTaskDuration(ms) {
  if (taskTimerInt) {
    clearInterval(taskTimerInt);
    taskTimerInt = 0;
  }
  taskStartTs = 0;
  const elx = $("task-timer");
  elx.hidden = false;
  elx.classList.add("done");
  elx.textContent = `任务 ${fmtElapsed(ms / 1000)}`;
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
  const host = state.currentTurn ? state.currentTurn.body : transcriptHost();
  // 已在末尾就不动它：append 会移动节点，白白触发一次重排
  if (chip.el.parentElement !== host || chip.el.nextElementSibling) host.append(chip.el);
  scrollBottom();
}

function clearStreamStatus() {
  const chip = state.streamStatus;
  if (!chip) return;
  clearInterval(chip.timer);
  chip.el.remove();
  state.streamStatus = null;
}

// ── 流式增量合帧 ──────────────────────────────────────────────────
// 逐条 delta 直接落 DOM 时，浏览器每来一条都要重排整段文本：思考越长越慢
// （实测 35KB 的 <pre> 每条 10ms+），生成中整页直接卡死，思考块一弹出来就动不了。
// 这里把增量攒进缓冲，每 80ms 一批落一次 DOM，重排次数从「每条」降到「每批」。

const STREAM_FLUSH_MS = 80;
const THINK_LIVE_CAP = 24000; // 生成中思考块最多可见字符数（全文收口时补回）
const TEXT_LIVE_CAP = 40000; // 生成中正文同理

function scheduleStreamFlush() {
  if (state.streamFlushTimer) return;
  state.streamFlushTimer = setTimeout(() => {
    state.streamFlushTimer = 0;
    flushStreamDeltas();
  }, STREAM_FLUSH_MS);
}

/** 把缓冲的流式增量一次性写进 DOM（思考块 + 正文气泡）。 */
function flushStreamDeltas() {
  if (state.streamFlushTimer) {
    clearTimeout(state.streamFlushTimer);
    state.streamFlushTimer = 0;
  }
  const think = state.pendingThink;
  const text = state.pendingText;
  state.pendingThink = "";
  state.pendingText = "";
  if (!think && !text) return;
  if (think && state.streamThink) {    state.thinkFull += think;
    const pre = state.streamThink.querySelector("pre");
    if (pre) {
      pre.append(think);
      if (state.thinkFull.length > THINK_LIVE_CAP) pre.textContent = state.thinkFull.slice(-THINK_LIVE_CAP);
    }
  }
  if (text && state.streamBubble) {
    state.streamTextFull += text;
    const node = state.streamTextNode;
    if (node && node.isConnected) {
      // 没超长就往尾部追加。整段重写会让生成中的正文越来越卡。
      if (state.streamTextFull.length > TEXT_LIVE_CAP) node.data = state.streamTextFull.slice(-TEXT_LIVE_CAP);
      else node.appendData(text);
    } else {
      state.streamBubble.insertBefore(el("span", {}, text), state.streamBubble.querySelector(".cursor"));
    }
  }
  // 回放中的历史增量不挂状态条（否则回切旧会话会闪一个「生成中」）
  if (!state.replaying) setStreamStatus("生成中");
  tickStreamSpeed();
  scrollBottom();
}

/** 丢弃还没落 DOM 的增量（切会话 / 回放重建；内容由终态事件补全）。 */
function dropStreamDeltas() {
  if (state.streamFlushTimer) {
    clearTimeout(state.streamFlushTimer);
    state.streamFlushTimer = 0;
  }
  state.pendingThink = "";
  state.pendingText = "";
  state.streamTextFull = "";
  state.thinkFull = "";
  state.streamTextNode = null;
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
  const chain = state.errChain;
  // 连续同类错误合并计数（400×1 → 400×2）；中间出现过成功回复、或换成别的错误码（如 500）
  // 就另起一张新签——不再出现没有信息量的「（同上）」。
  if (code && chain && chain.code === code && chain.chip.isConnected) {
    const n = Number(chain.chip.dataset.count) + 1;
    chain.chip.dataset.count = String(n);
    chain.chip.querySelector("summary").textContent = `⚠ ${code}×${n}`;
    chain.chip.querySelector("pre").append(`\n────\n${errorText}`);
    return null; // 已并入上一张
  }
  const chip = el("details", { class: "err-chip", "data-code": code || "", "data-count": "1" },
    el("summary", {}, `⚠ ${code || "错误"}×1`),
    el("pre", {}, String(errorText)));
  state.errChain = code ? { chip, code } : null;
  return chip;
}

// ── 思考块（与正文分开展示的可折叠 <details>） ──────────────────────

/** 思考摘要：折起时在标题里显示开头一段，便于扫读。 */
function thinkPreview(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > 36 ? s.slice(0, 36) + "…" : s;
}

function makeThinkBlock(text) {
  const preview = thinkPreview(text);
  return el("details", { class: "think" },
    el("summary", {}, preview ? `思考 · ${preview}` : "思考"),
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
  const preview = thinkPreview(box.querySelector("pre")?.textContent || "");
  box.querySelector("summary").textContent = preview ? `思考 · ${preview}` : "思考";
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

/**
 * 用户消息里的图片：有小图数据就显示缩略图，否则显示「图片×N」标记
 * （大图 base64 不走事件流，只给张数，避免 SSE/内存被撑爆）。
 */
function userImageBlock(event) {
  const datas = Array.isArray(event.images) ? event.images : [];
  const mimes = Array.isArray(event.imageMimes) ? event.imageMimes : [];
  const n = Number(event.imageCount) || datas.length;
  if (!n) return null;
  const box = el("div", { class: "msg-imgs" });
  for (let i = 0; i < datas.length; i += 1) {
    const img = document.createElement("img");
    img.src = `data:${mimes[i] || "image/png"};base64,${datas[i]}`;
    img.loading = "lazy";
    img.decoding = "async";
    img.title = "点击放大";
    img.addEventListener("click", () => showLightbox(img.src, `消息图片 ${i + 1}/${n}`));
    box.append(img);
  }
  if (!datas.length) {
    box.append(el("span", {
      class: "msg-img-chip",
      title: "这条消息带图并已随消息发送给模型；大图不回显缩略图（省流量/内存）",
    }, `🖼 图片×${n}`));
  }
  return box;
}

function startEditUser(row, col, msg) {
  if (!msg || !msg.dataset.entry) {
    toast("这条消息还在落盘，请稍候再编辑");
    return;
  }
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
  const original = (msg.querySelector(".msg-text") || msg).textContent;
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
      const edited = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/edit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId: msg.dataset.entry, text }),
      });
      report({ event: "edit-ok", entryId: msg.dataset.entry });
      box.remove();
      if (edited && edited.sessionId && edited.sessionId !== state.sessionId) await openSession(edited.sessionId);
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
      const { row, col } = chatRow("user", event.at);
      const msg = el("div", { class: "msg" });
      // 正文单独放 .msg-text：图片块加进来后 textContent 会变，
      // 而「双击编辑 / user-id 回填」都靠正文文本匹配
      msg.append(el("span", { class: "msg-text" }, event.text));
      const pics = userImageBlock(event);
      if (pics) msg.append(pics);
      if (event.id) bindUserEdit(row, col, msg, event.id);
      // 元信息右侧的编辑按钮：与双击等效（双击仍保留），免去「找不到入口」
      const editBtn = el("button", {
        class: "msg-edit",
        type: "button",
        title: "编辑并重新发送",
        onclick: () => startEditUser(row, col, msg),
      }, "✎");
      const meta = col.querySelector(".c-meta");
      if (meta) meta.append(editBtn);
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
        const body = msg && (msg.querySelector(".msg-text") || msg);
        if (msg && !msg.dataset.entry && body.textContent === event.text) {
          bindUserEdit(row, row.querySelector(".bubble-col"), msg, event.id);
          break;
        }
      }
      return null;
    }
    case "transcript-reset": {
      // 事件缓冲里存的是「轻量版」reset（不带整份回放，只有实时线才带）：
      // 回放时它前面的帧已经是重建后的新分支，直接清空会把历史清没
      // （打开旧会话只剩最后几条就是这个原因）。
      const resetEvents = event.events || [];
      if (!resetEvents.length) {
        state.streamBubble = null;
        state.streamThink = null;
        clearStreamStatus();
        return null;
      }
      // 编辑重发后服务端按新分支重建视图
      dropStreamDeltas();
      state.streamBubble = null;
      state.streamThink = null;
      state.currentTurn = null;
      clearStreamStatus();
      const transcript = $("transcript");
      const host = transcriptHost();
      // 重置后帧序号不好对齐：丢弃缓存（当前元素继续用），下次打开整体重建
      state.transcriptViews.delete(String(state.sessionId));
      host.replaceChildren();
      state.replaying = true;
      for (const ev of resetEvents) appendEvent(ev);
      state.replaying = false;
      forceScrollBottom();
      rebuildBookmarks();
      void linkifyPaths(transcript);
      refreshDiff();
      refreshContext();
      return null;
    }
    case "assistant-start": {
      const { row, col } = chatRow("assistant", event.at);
      row.classList.add("step", "no-head"); // 轮内步骤：头像/名字/时间只在轮首引导行
      const bubble = el("div", { class: "msg" }, el("span", { class: "cursor" }));
      col.append(bubble);
      row.append(col);
      state.streamBubble = bubble;
      state.streamThink = null;
      state.streamTextNode = document.createTextNode(""); // 正文合帧的落点
      bubble.insertBefore(state.streamTextNode, bubble.firstChild);
      state.streamTextFull = "";
      state.thinkFull = "";
      state.pendingThink = "";
      state.pendingText = "";
      state.streamStart = performance.now();
      state.streamTokens = 0;
      state.streamSpeedAt = 0;
      return row;
    }
    case "thinking-delta": {
      const bubble = state.streamBubble;
      if (!bubble) return null;
      ensureThinkBlock(bubble);
      state.pendingThink += event.text; // 合帧：每 80ms 落一次 DOM
      scheduleStreamFlush();
      return null;
    }
    case "thinking-end": {
      flushStreamDeltas();
      if (state.streamThink) {
        // 生成中只写了尾部（控重排），收口前补回全文再折叠
        const pre = state.streamThink.querySelector("pre");
        if (pre && state.thinkFull && pre.textContent !== state.thinkFull) pre.textContent = state.thinkFull;
        collapseThink(state.streamThink);
      }
      return null;
    }
    case "assistant-delta": {
      const bubble = state.streamBubble;
      if (!bubble) return null;
      if (typeof event.tokens === "number") state.streamTokens = event.tokens;
      state.pendingText += event.text; // 合帧：不再每 token 一个 span
      scheduleStreamFlush();
      return null;
    }
    case "assistant-end": {
      flushStreamDeltas(); // 收口前把缓冲的增量落干净
      const bubble = state.streamBubble;
      state.streamBubble = null;
      state.streamTextNode = null;
      clearStreamStatus();
      // 轮次统计：累计本轮的输出 tok 与生成时长（轮末汇总行用）
      if (state.currentTurn && Number.isFinite(event.usage?.output) && event.usage.output > 0) {
        state.currentTurn.tokens += event.usage.output;
        if (Number.isFinite(event.tokPerSec) && event.tokPerSec > 0) {
          state.currentTurn.seconds += event.usage.output / event.tokPerSec;
        }
      }
      if (!bubble) {
        // 无增量（一次性返回 / 历史回放）：补一整条
        const { row, col } = chatRow("assistant", event.at);
        row.classList.add("step", "no-head");
        if (event.thinking) col.append(makeThinkBlock(event.thinking));
        if (event.error || (event.text || "").trim()) {
          // 没正文也没错误就别渲染空气泡（只有思考/工具调用的回合）
          const fresh = el("div", { class: "msg" });
          if (event.error) {
            fresh.classList.add("error");
            const chip = errChip(event.error);
            if (chip) fresh.append(chip);
          } else {
            state.errChain = null; // 成功回复：错误链断开，之后报错从 ×1 重新起
            renderMarkdown(fresh, event.text || "");
          }
          col.append(fresh);
        }
        row.append(col);
        settleSpeed(row, event);
        if (!state.replaying) refreshContext(); // 回放期几百条消息各发一次请求 → 切换会话必卡；结束后统一刷
        return row;
      }
      const text = event.text !== undefined ? event.text : (state.streamTextFull || bubble.textContent);
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
        const chip = errChip(event.error);
        if (chip) bubble.append(chip);
      } else {
        state.errChain = null; // 成功回复：错误链断开
        renderMarkdown(bubble, text || "");
        if (!bubble.hasChildNodes()) bubble.remove(); // 空回合不渲染空气泡
      }
      settleSpeed(row, event);
      refreshContext();
      scrollBottom();
      return null;
    }
    case "tool": {
      if (!state.replaying && event.phase === "end" && (event.name === "write" || event.name === "edit")) {
        refreshDiff(); // 回放期每个写操作都请求一次 diff 会拖垮切换，结束后统一刷
      }
      if (event.phase === "start") {
        const duplicate = [...transcriptHost().querySelectorAll('details.tool[data-call]')]
          .find((row) => row.dataset.call === String(event.callId));
        if (duplicate) return null; // 重连/回放的同一调用不再新建一行计时
        const d = el("details", { class: "tool step", "data-call": event.callId, "data-tool-state": "running" });
        if (event.name === "subagent") d.dataset.spawn = "1"; // 派生锚点：子对话就挂在这一行下面
        // 运行中的工具带秒级计时：长时间跑的命令一眼能看出是在跑还是卡了（回放不加）
        if (!state.replaying) d.dataset.startedAt = String(Number(event.at) || Date.now());
        d.append(el("summary", {},
          el("span", { class: "name" }, event.name),
          state.replaying ? null : el("span", { class: "tool-timer" }, "0s"),
          " 运行中…"));
        if (event.args) d.append(el("pre", {}, String(event.args).slice(0, 4000)));
        return d;
      }
      const matches = [...transcriptHost().querySelectorAll('details.tool[data-call]')]
        .filter((row) => row.dataset.call === String(event.callId));
      const existing = matches.at(-1);
      for (const duplicate of matches.slice(0, -1)) duplicate.remove();
      const node = existing || el("details", { class: "tool step", "data-call": event.callId });
      if (event.name === "subagent") node.dataset.spawn = "1"; // 回放时可能只有 end 帧，锚点照样要打上
      node.dataset.toolState = event.isError ? "failed" : "completed";
      node.classList.toggle("err", Boolean(event.isError));
      delete node.dataset.startedAt; // 结束：停表
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
      if (!state.replaying) startTaskTimer();
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
      flushStreamDeltas(); // 轮末：缓冲里的正文先落干净再统计
      // 重试导致的 turn-end 不算任务结束：否则重试等待期间「■ 停止」会消失、
      // 任务计时也会被清零（这正是"任务中看不到暂停按钮"的原因）
      if (!event.retry) {
        settlePendingToolRows();
        setStreaming(false);
        clearStreamStatus();
        finalizeTurn(event);
        if (Number.isFinite(event.durationMs) && event.durationMs > 0) showTaskDuration(event.durationMs);
        else if (!state.replaying) finalizeTaskTimer();
      }
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
    case "notice": {
      // 宿主提示（子代理回执等）：独立小条，不进轮首/轮末统计。
      // 同一条回执可能同时来自实时推送和历史回放（重启后重发也会堆同样的正文），
      // 正文一样就只留最早那条，避免板上一串一模一样的回执。
      const text = String(event.text || "");
      const norm = (s) => s.replace(/\s+/g, " ").trim();
      const seen = $("transcript").querySelectorAll(".host-notice");
      for (const n of seen) {
        if (norm(n.textContent || "") === norm(text)) return null;
      }
      const node = el("div", { class: "host-notice" + (event.asyncTool ? " async-tool-notice" : "") }, text);
      if (event.asyncTool && Array.isArray(event.images) && event.images.length) {
        const box = el("div", { class: "tool-images" });
        for (const im of event.images) {
          const img = document.createElement("img");
          img.src = `data:${im.mime || "image/png"};base64,${im.data}`;
          img.className = "tool-thumb pixelated";
          img.loading = "lazy";
          img.onclick = () => window.open(img.src, "_blank");
          box.append(img);
        }
        node.append(box);
      }
      return node;
    }
    case "status": {
      // 服务端的忙闲状态：兜底同步按钮态（stop 之后 abort 停稳才来 idle）。
      // retry 不动：重试等待期间要保持「■ 停止」可用。
      if (event.status === "idle") {
        settlePendingToolRows();
        flushStreamDeltas();
        if (state.streaming) setStreaming(false);
        clearStreamStatus();
      } else if (event.status === "working" && !state.streaming) {
        setStreaming(true);
      }
      return null;
    }
    case "stopping": {
      flushStreamDeltas(); // 停止前把已收到的内容落出来
      // 点击停止的即时回执：服务端已收到，abort 还在生效中
      setStreamStatus("停止中");
      setStreaming(true);
      const stopBtn = $("btn-stop");
      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.textContent = "停止中";
        stopBtn.title = "正在停止…";
      }
      return null;
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
    if (event.type === "goal") {
      renderGoal(event.goal);
      return;
    }
    if (event.type === "bg-tasks") {
      state.bgTasks = Array.isArray(event.tasks) ? event.tasks : [];
      renderBgTasks();
      return;
    }
  if (event.type === "subagents") {
    applySubagentSnapshot(event);
    return;
  }
  if (event.type === "subagents-config") {
    loadSubagents();
    return;
  }
  if (event.type === "prompt-queue") {
    // 缓冲里每条都是当时的快照。打开会话会先画最近 20 条、再补更早的一段，
    // 后补那段里的旧快照会把已经发出去的队列盖回来。当前队列以 history 的 promptQueue 和实时帧为准。
    if (state.replaying) return;
    state.serverQueue = event.items || [];
    renderQueue();
    return;
  }
  // 用户消息开启新一轮：后续助手步骤都收进这条时间轴，直到下一次用户输入
  if (event.type === "user") {
    if (state.currentTurn) finalizeTurn(null); // 上一轮若没收尾（如重试失败后直接发新消息）先补汇总
    const body = el("div", { class: "turn-body" });
    const turn = el("div", { class: "turn" }, body);
    state.currentTurn = { el: turn, body, lead: false, steps: 0, tokens: 0, seconds: 0, at: Number(event.at) || Date.now(), startedAt: Number(event.at) || Date.now() };
    const row = renderEvent(event);
    if (!row) {
      state.currentTurn = null;
      return;
    }
    turn.insertBefore(row, body);
    transcriptHost().append(turn);
    scrollBottom();
    return;
  }
  const node = renderEvent(event);
  if (!node) return;
  if (state.currentTurn && node.classList && node.classList.contains("step")) ensureTurnLead();
  (state.currentTurn ? state.currentTurn.body : transcriptHost()).append(node);
  // 锚点进 DOM 之后才可能挂上子对话（快照可能早就到了）
  if (node.dataset && node.dataset.spawn === "1") mountInlineChildren();
  scrollBottom();
}

/** 轮首引导行：身份 + 时间，每轮只出现一次（头像已移到右下角大图）。 */
function ensureTurnLead() {
  const turn = state.currentTurn;
  if (!turn || turn.lead) return;
  turn.lead = true;
  turn.body.append(el("div", { class: "turn-lead" },
    el("span", { class: "tn" }, assistantName(state.sessionId)),
    el("span", { class: "tt" }, fmtClock(turn.at)),
  ));
}

/** 轮末汇总：步数 · tok · 平均速度 · 时长 · 时间（回放用服务端落盘时长）。 */
function finalizeTurn(event = null) {
  const turn = state.currentTurn;
  if (!turn) return;
  state.currentTurn = null;
  const steps = turn.el.querySelectorAll(".tool, .think").length;
  // 耗时只用：服务端实测时长 → （仅实时轮）墙钟。不再用前端推算的「轮内事件跨度」——
  // 视图缓存/未收尾的轮次会让跨度串到别的时间上（曾出现 3845m、3600m 这种假耗时）。
  const durationMs = Number.isFinite(event && event.durationMs) && event.durationMs > 0
    ? event.durationMs
    : (!state.replaying && turn.startedAt ? Date.now() - turn.startedAt : 0);
  const parts = [];
  if (steps) parts.push(`${steps} 步`);
  if (turn.tokens > 0) parts.push(`${turn.tokens >= 1000 ? (turn.tokens / 1000).toFixed(1) + "k" : turn.tokens} tok`);
  if (turn.tokens > 0 && turn.seconds > 0.5) parts.push(`${fmtSpeed(turn.tokens / turn.seconds)} tok/s`);
  if (durationMs > 0) parts.push(fmtElapsed(durationMs / 1000));
  // 轮末时间用事件时间（回放时是落盘的真实时间；实时就是收尾那一刻）
  parts.push(fmtClock(Number.isFinite(event && event.at) ? event.at : turn.at));
  turn.body.append(el("div", { class: "turn-foot" }, parts.join(" · ")));
}

// 按用户/助手消息计数，向前对齐到用户轮次，工具和未完成回复不拆开。
function recentHistoryStart(events, limit) {
  let start = 0;
  let assistantOpen = false;
  const messages = [];
  for (let i = 0; i < events.length; i++) {
    const type = events[i].event.type;
    if (type === "user") { messages.push(i); assistantOpen = false; }
    else if (type === "assistant-start") { messages.push(i); assistantOpen = true; }
    else if (type === "assistant-end") {
      if (!assistantOpen) messages.push(i);
      assistantOpen = false;
    }
  }
  if (messages.length <= limit) return 0;
  start = messages[messages.length - limit];
  while (start > 0 && events[start].event.type !== "user") start--;
  return start;
}

async function openSession(id, { keepTranscript, messageLimit = 50, expandHistory = false, restorePosition = true } = {}) {
  if (id === state.sessionId && (state.openLoading || state.es) && keepTranscript === undefined) return;
  // 代际号：连续快速切换时，只有最后一次切换能写 DOM——
  // 否则先发起的会话 history 后返回，会把后点开的那条顶掉（串会话/发错消息的根因）
  const gen = (state.openSeq = (state.openSeq || 0) + 1);
  const stale = () => gen !== state.openSeq;
  state.historyController?.abort();
  const controller = new AbortController();
  state.historyController = controller;
  clearTimeout(scrollSaveTimer); // 别让上一个会话的防抖保存写到即将打开的这条上
  if (state.sessionId && state.sessionId !== id) captureScroll(state.sessionId);
  state.openLoading = true;
  closeStream();
  state.replaying = false;
  state.sessionId = id;
  state.pulledLevels = [];
  state.sessionSubagents = { agents: [], runs: [] };
  clearInlineThreads(); // 上一个会话的内联子对话轮询必须停干净，不能跟着切过去
  state.currentTurn = null;
  // 按下的同一帧：高亮、标题、输入锁定。重画列表和拉历史都放到下一帧。
  markSessionActive(id);
  const known = state.sessions.find((s) => s.id === id);
  if (known && known.title) $("session-title").textContent = known.title;
  const cached = keepTranscript ? null : state.transcriptViews.get(id);
  const transcript = $("transcript");
  if (cached && cached.el.childNodes.length) {
    transcript.replaceChildren(cached.el);
    state.currentView = cached;
    state.currentTurn = cached.turn || null;
    transcript.classList.remove("switching");
    transcript.classList.add("settled");
    $("input").disabled = false;
    $("btn-send").disabled = false;
  } else {
    // 切换期间禁止输入/发送：这期间界面内容可能还是上一个会话，误发就发错人
    $("input").disabled = true;
    $("btn-send").disabled = true;
    transcript.classList.add("switching");
    transcript.classList.remove("settled");
    if (!keepTranscript) transcript.replaceChildren();
  }
  try {
    // 先把按下的高亮画出来，再做列表重绘、头像和历史请求。
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (stale()) return;
    renderPet();
    clearDoneTask(id);
    $("agent-run-dlg").close();
    renderAgentDock();
    renderUnviewedFlag();
    dropStreamDeltas(); // 切会话：丢掉上一会话没落的增量
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
    // 合并一连串点击：只为最后一次选择读取历史。
    await new Promise((resolve) => setTimeout(resolve, 16));
    if (stale()) return;
    const { session, events, bootId } = await api(`/api/sessions/${encodeURIComponent(id)}/history`, { signal: controller.signal });
    if (stale()) return; // 期间又切了别的会话：这次的结果整个丢掉
    $("session-title").textContent = session.title || id.slice(0, 8);
    $("btn-rename").hidden = false;
    state.model = session.model;
    state.pulledLevels = loadPulledLevels(state.model); // 刷新后恢复该模型拉取过的级别
    state.thinking = session.thinkingLevel;
    state.thinkingExplicit = session.thinkingExplicit === true;
    renderModelPicker();
    renderThinkingPicker();
    // 关键：恢复流式状态。切走再切回（或刷新页面）后本地 flag 丢了，
    // 若该会话后台仍在跑任务，必须把按钮恢复成「■ 任务中」，否则
    // 显示「发送 ▸」，一点发送就会把正在跑的任务打断
    // 缓存命中时输入已经放开：历史返回前用户可能已经点了发送，不能被旧的 running=false 盖掉。
    setStreaming(session.running === true || sendInFlight || state.streaming);
    state.serverQueue = session.promptQueue || []; // 队列真身在服务端，切走再回来照样看得到
    renderQueue();
    if (!keepTranscript) {
      const transcript = $("transcript");
      const view = transcriptViewFor(id, events, bootId);
      const shown = transcript.contains(view.el) && view.el.childNodes.length > 0;
      const sameBoot = shown && view.bootId === bootId && view.lastSeq > 0;
      // 加载更早消息必须整段重画：那些帧的 seq 更小，不能当成「已经跟上」。
      const caughtUp = !expandHistory && view.painted && sameBoot
        && events.every((frame) => !Number.isFinite(frame.seq) || frame.seq <= view.lastSeq);
      if (caughtUp) {
        // 缓存已经画到最新：点下去时挂上的就是终稿，不要再清空重放。
        state.currentView = view;
        state.currentTurn = view.turn || null;
        transcript.classList.remove("switching");
        transcript.classList.add("settled");
        const remembered = restorePosition ? savedScroll(id) : null;
        // 运行中的长任务必须回到最新输出；恢复旧的阅读位置会把正在生成的末尾藏掉。
        if (session.running) forceScrollBottom();
        else if (!expandHistory && remembered && remembered.atBottom === false) restoreScroll(id);
        else forceScrollBottom();
      } else {
      if (!shown) {
        transcript.replaceChildren(view.el);
      }
      state.currentView = view;
      state.currentTurn = view.turn || null;
      state.avgTok = { tokens: 0, seconds: 0 }; // 平均速度随会话重置，回放时按消息重建
      updateAvgSpeed();
      stopCompactUi(); // 切会话清掉压缩计时
      const remembered = restorePosition ? savedScroll(id) : null;
      const resumeMid = !expandHistory && remembered && remembered.atBottom === false;
      state.stickBottom = !resumeMid;
      // 回放模式：跳过逐条 scrollBottom（几百次强制重排是切换卡顿的主因）
      // 和逐条路径链接化（几十上百个并发 fs 请求），结束后统一补一次
      state.replaying = true;
      const renderFrames = async (frames) => {
        let tick = performance.now();
        let shown = false;
        for (const frame of frames) {
          if (stale()) return false;
          appendEvent(frame.event);
          if (!shown) {
            shown = true;
            transcript.classList.remove("switching");
          }
          if (performance.now() - tick < 12) continue;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (stale()) return false;
          tick = performance.now();
        }
        return true;
      };
      // 先画最近 20 条让末尾出现，再只补更早的那一段。
      // 以前第二次是整段 replaceChildren 重画，20 条 markdown 白做一遍。
      const paintRecent = async (limit, { prependBefore = -1, pinBottom = true } = {}) => {
        const start = recentHistoryStart(events, limit);
        state.replaying = true;
        let ok = true;
        if (prependBefore < 0) {
          // 只有整段画完的缓存才按序号续画。画到一半就切走的视图仍整段重建，避免更早的消息被补两次。
          const resumeAt = !expandHistory && view.painted && sameBoot ? view.lastSeq : 0;
          const fresh = events.slice(start).filter((frame) => !resumeAt || !Number.isFinite(frame.seq) || frame.seq > resumeAt);
          if (!resumeAt) {
            dropStreamDeltas();
            clearStreamStatus();
            state.streamBubble = null;
            state.streamThink = null;
            state.currentTurn = null;
            state.errChain = null;
            view.el.replaceChildren();
            view.lastSeq = 0;
            view.painted = false;
          }
          ok = await renderFrames(fresh);
        } else if (start < prependBefore) {
          const saved = {
            turn: state.currentTurn,
            err: state.errChain,
            bubble: state.streamBubble,
            think: state.streamThink,
            text: state.streamTextFull,
            thinkFull: state.thinkFull,
            node: state.streamTextNode,
          };
          const box = document.createElement("div");
          const host = state.currentView;
          state.currentView = { el: box, lastSeq: 0 };
          state.currentTurn = null;
          state.errChain = null;
          state.streamBubble = null;
          state.streamThink = null;
          state.streamTextNode = null;
          state.streamTextFull = "";
          state.thinkFull = "";
          const prevHeight = transcript.scrollHeight;
          const prevTop = transcript.scrollTop;
          try {
            ok = await renderFrames(events.slice(start, prependBefore));
          } finally {
            // 让出主线程期间如果已经切到别的会话，currentView 不再是这块离屏容器，不能抢回来。
            if (state.currentView && state.currentView.el === box) {
              state.currentView = host;
              state.currentTurn = saved.turn;
              state.errChain = saved.err;
              state.streamBubble = saved.bubble;
              state.streamThink = saved.think;
              state.streamTextNode = saved.node;
              state.streamTextFull = saved.text;
              state.thinkFull = saved.thinkFull;
            }
          }
          if (ok && !stale()) {
            view.el.prepend(...box.childNodes);
            if (state.stickBottom) forceScrollBottom();
            else setScrollTop(transcript, prevTop + (transcript.scrollHeight - prevHeight));
          }
        }
        if (!ok || stale()) return start;
        flushStreamDeltas();
        state.replaying = false;
        view.lastSeq = events.reduce((n, f) => Math.max(n, f.seq || 0), 0);
        view.el.querySelector(":scope > .history-more")?.remove();
        if (start > 0) {
          const more = el("button", { class: "btn history-more", type: "button", onclick: () => {
            void openSession(id, { keepTranscript: false, messageLimit: limit + 50, expandHistory: true });
          } }, "加载更早消息");
          view.el.prepend(more);
        }
        rebuildBookmarks();
        if (pinBottom) forceScrollBottom();
        return start;
      };
      const firstLimit = expandHistory ? messageLimit : 20;
      const firstStart = await paintRecent(firstLimit, { pinBottom: !expandHistory && !resumeMid });
      if (stale()) return;
      transcript.classList.remove("switching");
      // 已经完整画过的视图只追加新帧；没画完的（先画了最近 20 条）仍补更早的一段。
      if (!expandHistory && !view.painted && recentHistoryStart(events, messageLimit) < firstStart) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (stale()) return;
        // 默认 pinBottom 会在补历史时跳到底，把这次要恢复的阅读位置冲掉
        await paintRecent(messageLimit, { prependBefore: firstStart, pinBottom: !resumeMid });
        if (stale()) return;
      }
      if (expandHistory) {
        setScrollTop(transcript, 0);
        state.stickBottom = false;
        captureScroll(id);
      } else if (session.running) {
        // 切回仍在生成的会话时，优先显示最新思考/工具状态。
        forceScrollBottom();
      } else if (resumeMid) {
        restoreScroll(id);
      } else {
        forceScrollBottom();
      }
      transcript.classList.add("settled");
      view.painted = true;
      // 这些操作会遍历整棵长对话、读取文件或计算上下文；延后到首屏稳定后，
      // 避免切回超长任务时出现几秒空白/卡顿。切换代际变化后结果自动作废。
      const postPaintGen = gen;
      setTimeout(() => {
        if (postPaintGen !== state.openSeq || state.sessionId !== id) return;
        scheduleLinkify(view.el);
        void refreshDiff();
        void refreshContext();
      }, session.running ? 350 : 80);
      }
    }
    $("transcript").classList.remove("switching");
    $("input").disabled = false;
    $("btn-send").disabled = false;
    setStreaming(session.running === true || sendInFlight); // 历史 turn-end 不能覆盖当前任务的真实状态
    // 运行中会话：用服务端的任务起点还原「任务中」计时（回放只给历史时长）
    if (session.running && session.turnStartedAt) startTaskTimer(session.turnStartedAt);
    // SSE 实时流（history 与 stream 之间的间隙事件会重复：以「boot:seq」去重，
    // 裸 seq 在服务器重启后会撞上旧进程的已见集合，把新事件整段丢弃）
    const seen = new Set(events.map((f) => f.id || f.seq));
    // history 已经回放到当前 seq；SSE 只补上订阅建立期间的新帧，避免
    // 每次切换都再次传输/解析整段进行中的任务记录。
    const lastSeq = events.reduce((max, frame) => Number.isFinite(frame.seq) ? Math.max(max, frame.seq) : max,
      state.currentView?.bootId === bootId ? state.currentView.lastSeq : 0);
    const streamQuery = lastSeq > 0
      ? `?since=${lastSeq}&boot=${encodeURIComponent(bootId || "")}`
      : "";
    const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream${streamQuery}`);
    state.es = es;
    es.onmessage = (ev) => {
      // 已被更新的切换取代 / 这条流已不是当前流：旧会话的事件绝不能写进新视图
      if (stale() || state.es !== es) return;
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.id && bootId && !String(frame.id).startsWith(`${bootId}:`)) {
        void openSession(id, { keepTranscript: false });
        return;
      }
      const key = frame.id || frame.seq;
      if (seen.has(key)) return;
      seen.add(key);
      // 缓存视图里已经渲染过这一帧（回切只补了新帧）→ 跳过，避免重复
      if (state.currentView && Number.isFinite(frame.seq) && frame.seq <= state.currentView.lastSeq) return;
      appendEvent(frame.event);
      if (state.currentView && Number.isFinite(frame.seq)) {
        state.currentView.lastSeq = Math.max(state.currentView.lastSeq, frame.seq);
      }
    };
    es.onerror = () => { if (stale() || state.es !== es) es.close(); };
    loadSessionSubagents();
    if (RUNTIME === "codex") void refreshGoal();
  } catch (e) {
    if (!stale()) {
      $("transcript").classList.remove("switching");
      toast(`打开会话失败：${e.message}`);
      // 失败也要把输入区放开，不然界面像卡死
      $("input").disabled = false;
      $("btn-send").disabled = false;
    }
  } finally {
    if (!stale()) {
      state.openLoading = false;
      state.replaying = false;
    }
  }
}

// ── 发送 / 停止 ────────────────────────────────────────────────────

function setStreaming(on) {
  state.streaming = on;
  // 任务中：主按钮变「排队」，停止收进独立的 ■ 按钮（不再抢占发送键）
  const btn = $("btn-send");
  btn.classList.toggle("streaming", on);
  btn.textContent = on ? "排队 ▸" : "发送 ▸";
  btn.title = on ? "任务进行中：加入队列（队列里可「立即发送」插队）" : "";
  const stopBtn = $("btn-stop");
  if (stopBtn) {
    stopBtn.hidden = !on;
    if (!on) {
      stopBtn.disabled = false;
      stopBtn.textContent = "■";
      stopBtn.title = "停止当前任务";
    }
  }
  if (!on) state.stopping = false;
}

/** 实际发一条消息；返回是否成功（调用方负责排队/插队策略）。 */
async function postPrompt(text, images) {
  if (!state.sessionId) return false;
  setStreaming(true);
  forceScrollBottom();
  setStreamStatus("请求中");
  try {
    const sent = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(images && images.length ? { images } : {}) }),
    });
    if (sent && sent.sessionId && sent.sessionId !== state.sessionId) await openSession(sent.sessionId);
    loadSessions();
    syncAgentStatus();
    return true;
  } catch (e) {
    // 409 = 服务端任务其实还在跑（本地 flag 过期）：转成服务端排队，别把消息弄丢
    if (/\b409\b|任务进行中/.test(e.message)) {
      setStreaming(true);
      clearStreamStatus();
      await enqueueMessage(text, images);
      return false;
    }
    toast(`发送失败：${e.message}`);
    clearStreamStatus();
    setStreaming(false);
    return false;
  }
}

let sendInFlight = false;
const DUPLICATE_SEND_WINDOW_MS = 2000;

const SLASH_COMMANDS = [
  { name: "compact", hint: "", title: "压缩上下文" },
  { name: "goal", hint: "描述", title: "设置目标，/goal clear 清除" },
  { name: "diff", hint: "", title: "查看本会话改动" },
  { name: "model", hint: "", title: "打开模型菜单" },
  { name: "stop", hint: "", title: "停止当前任务" },
  { name: "new", hint: "", title: "新建会话" },
  { name: "status", hint: "", title: "查看当前目标" },
];
let slashIndex = 0;

function slashMatches() {
  const text = $("input").value;
  if (!text.startsWith("/") || text.includes("\n")) return [];
  const name = text.slice(1).split(" ")[0].toLowerCase();
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(name));
}
function slashOpen() {
  const menu = $("slash-menu");
  return Boolean(menu && !menu.hidden);
}
function closeSlash() {
  const menu = $("slash-menu");
  if (menu) menu.hidden = true;
}
function slashSelection() {
  const menu = $("slash-menu");
  if (!menu || menu.hidden) return "";
  return menu.querySelector(".slash-item.on")?.dataset.cmd || "";
}
function moveSlash(delta) {
  const items = [...($("slash-menu")?.querySelectorAll(".slash-item") || [])];
  if (!items.length) return;
  slashIndex = (slashIndex + delta + items.length) % items.length;
  items.forEach((item, index) => item.classList.toggle("on", index === slashIndex));
}
function acceptSlash() {
  const name = slashSelection();
  if (!name) return;
  const input = $("input");
  input.value = `/${name}${name === "goal" ? " " : ""}`;
  closeSlash();
  autoGrow(input);
}
function renderSlash() {
  let menu = $("slash-menu");
  if (!menu) {
    menu = el("div", { id: "slash-menu", hidden: "" });
    $("composer").append(menu);
  }
  const matches = slashMatches();
  if (!matches.length) {
    menu.hidden = true;
    return;
  }
  if (slashIndex >= matches.length) slashIndex = 0;
  menu.hidden = false;
  menu.replaceChildren(...matches.map((cmd, index) => {
    const item = el("div", {
      class: "slash-item" + (index === slashIndex ? " on" : ""),
      "data-cmd": cmd.name,
    }, el("b", {}, `/${cmd.name}${cmd.hint ? " " + cmd.hint : ""}`), el("span", {}, cmd.title));
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      slashIndex = index;
      $("input").value = `/${cmd.name}${cmd.name === "goal" ? " " : ""}`;
      if (cmd.name === "goal") {
        closeSlash();
        $("input").focus();
      } else {
        void send();
      }
    });
    return item;
  }));
}

const GOAL_STATUS = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  usageLimited: "用量到顶",
  budgetLimited: "预算到顶",
  complete: "已完成",
};
function renderGoal(goal) {
  const bar = $("goal-bar");
  if (!bar) return;
  if (!goal || !goal.objective) {
    bar.hidden = true;
    bar.className = "goal-bar";
    return;
  }
  bar.hidden = false;
  bar.className = "goal-bar " + (goal.status || "");
  $("goal-text").textContent = goal.objective;
  const bits = [GOAL_STATUS[goal.status] || goal.status || ""];
  if (goal.tokenBudget) bits.push(`${goal.tokensUsed || 0}/${goal.tokenBudget} tok`);
  else if (goal.tokensUsed) bits.push(`${goal.tokensUsed} tok`);
  if (goal.timeUsedSeconds) bits.push(`${Math.round(goal.timeUsedSeconds)}s`);
  $("goal-meta").textContent = bits.filter(Boolean).join(" · ");
}
async function refreshGoal() {
  if (RUNTIME !== "codex" || !state.sessionId) return;
  const id = state.sessionId;
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(id)}/goal`);
    if (state.sessionId !== id) return;
    renderGoal(result.goal);
  } catch {
    // 目标读失败不挡聊天
  }
}
async function clearGoal() {
  if (!state.sessionId) return;
  await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/goal`, { method: "DELETE" });
  renderGoal(null);
}
async function runSlash(raw) {
  const body = raw.slice(1).trim();
  const space = body.indexOf(" ");
  const name = (space < 0 ? body : body.slice(0, space)).toLowerCase();
  const rest = space < 0 ? "" : body.slice(space + 1).trim();
  if (name === "new") return newSession();
  if (!state.sessionId) {
    toast("先打开或新建会话");
    return;
  }
  if (name === "compact") return doCompact();
  if (name === "diff") return openAllDiffDialog();
  if (name === "stop") return stop();
  if (name === "model") {
    document.querySelector("#model-picker button")?.click();
    return;
  }
  if (name === "status") {
    await refreshGoal();
    toast($("goal-bar").hidden ? "当前没有目标" : $("goal-text").textContent);
    return;
  }
  if (name === "goal") {
    if (!rest) {
      await refreshGoal();
      toast($("goal-bar").hidden ? "当前没有目标。用法：/goal 描述" : $("goal-text").textContent);
      return;
    }
    if (rest === "clear") {
      await clearGoal();
      toast("目标已清除");
      return;
    }
    const result = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: rest }),
    });
    renderGoal(result.goal);
    toast("目标已设置");
    return;
  }
  toast(`没有 /${name} 这条命令`);
}

async function send() {
  if (sendInFlight) return; // 同一次按键/点击引起的重复调用直接丢弃
  const input = $("input");
  const text = input.value.trim();
  const willSend = Boolean(state.sessionId) && (Boolean(text) || state.pendingAttach.length > 0)
    && !(RUNTIME === "codex" && text.startsWith("/"));
  if (willSend) {
    // 请求还在路上时，按钮先变成「发送中」，避免连点以为没点上。
    const btn = $("btn-send");
    btn.disabled = true;
    btn.textContent = "发送中";
  }
  if (RUNTIME === "codex" && text.startsWith("/")) {
    const picked = slashSelection();
    const command = picked && !text.slice(1).includes(" ") ? `/${picked}` : text;
    input.value = "";
    autoGrow(input);
    closeSlash();
    try { await runSlash(command); }
    catch (error) { toast(error.message); }
    return;
  }
  if (!text && state.pendingAttach.length === 0) {
    setStreaming(state.streaming);
    return;
  }
  if (!state.sessionId) {
    setStreaming(state.streaming);
    return;
  }
  // 附件并入消息：图片走 prompt images，文本文件以代码块拼进正文
  const images = [];
  let full = text;
  for (const a of state.pendingAttach) {
    if (a.kind === "image") images.push({ type: "image", data: a.data, mimeType: a.mime });
    else full += `\n\n---\n附件「${a.name}」：\n\`\`\`\n${a.text}\n\`\`\``;
  }
  // 两秒内同样的内容只发一次（输入法/连点/键盘抖动都会走到这里）
  const now = Date.now();
  if (state.lastSend && state.lastSend.text === full && now - state.lastSend.at < DUPLICATE_SEND_WINDOW_MS) {
    toast("刚发过同一条消息，已忽略重复");
    const btn = $("btn-send");
    if (btn) btn.disabled = Boolean($("input").disabled);
    setStreaming(state.streaming);
    return;
  }
  state.lastSend = { text: full, at: now };
  state.pendingAttach = [];
  renderAttachments();
  input.value = "";
  autoGrow(input);
  sendInFlight = true;
  try {
    // 任务进行中：不打断，进队列等任务结束自动发（可点「立即发送」插队）
    if (state.streaming) {
      enqueueMessage(full, images);
      return;
    }
    await postPrompt(full, images);
  } finally {
    sendInFlight = false;
    const btn = $("btn-send");
    if (btn) btn.disabled = Boolean($("input").disabled);
    setStreaming(state.streaming);
  }
}

// ── transcript 视图缓存：每个会话保留已渲染的 DOM，回切只补新帧 ──────
// 之前每次切换都重建几千个节点（170~480ms），这是"切换不够丝滑"的主因。

const TRANSCRIPT_VIEW_KEEP = 8; // 最多缓存几个会话的 DOM（切会话要重建整棵 DOM，缓存大一点回切才秒开）

function createTranscriptView(sessionId, bootId) {
  const view = { el: el("div", { class: "tview", "data-session": sessionId }), lastSeq: 0, bootId: bootId || "", turn: null, painted: false };
  state.transcriptViews.set(sessionId, view);
  while (state.transcriptViews.size > TRANSCRIPT_VIEW_KEEP) {
    state.transcriptViews.delete(state.transcriptViews.keys().next().value);
  }
  return view;
}

/** 取（或建）某会话的视图；服务端重启导致 seq 重置时丢弃缓存。 */
function transcriptViewFor(sessionId, frames, bootId = "") {
  const boot = bootId || (frames && frames.length ? String(frames[0].id || "").split(":")[0] : "");
  let view = state.transcriptViews.get(sessionId);
  if (view && boot && view.bootId && view.bootId !== boot) {
    state.transcriptViews.delete(sessionId);
    view = null;
  }
  if (!view) return createTranscriptView(sessionId, boot);
  state.transcriptViews.delete(sessionId); // LRU 触摸
  state.transcriptViews.set(sessionId, view);
  return view;
}

/** 新事件该挂到哪：当前视图（没有视图时退回 #transcript）。 */
function transcriptHost() {
  return state.currentView ? state.currentView.el : $("transcript");
}

function forgetTranscriptView(sessionId) {
  if (sessionId) state.transcriptViews.delete(sessionId);
  if (state.currentView && state.currentView.el.dataset.session === String(sessionId)) state.currentView = null;
}

// ── 消息队列（服务端持有）：任务中继续发消息 → 服务端排队，回合结束自动发出 ──
// 队列真身在 bridge（切走会话/关掉页面也照发）；这里只渲染服务端推来的队列视图。

function renderQueue() {
  const bar = $("queue-bar");
  if (!bar) return;
  const queue = state.serverQueue || [];
  bar.hidden = queue.length === 0;
  if (!queue.length) {
    bar.replaceChildren();
    return;
  }
  const countText = `${queue.length} 条待发送`;
  const hint = queue.length === 1 ? "当前任务结束后自动发送" : "按顺序发送 · 可随时插队";
  const rows = queue.map((item, index) => {
    const preview = String(item.text || "").replace(/\s+/g, " ").trim();
    const row = el("div", { class: "q-row" + (index === 0 ? " next" : "") + (item.pending ? " pending" : "") });
    const indexNode = el("span", { class: "q-idx", "aria-label": `第 ${index + 1} 条` }, String(index + 1));
    const copy = el("div", { class: "q-copy" },
      el("span", { class: "q-text", title: item.text }, preview.slice(0, 120) || "（图片消息）"),
      el("span", { class: "q-meta" }, item.pending ? "同步中" : (index === 0 ? "下一条" : "排队中")),
    );
    const tags = [];
    if (item.images) tags.push(el("span", { class: "q-tag" }, `图×${item.images}`));
    if (item.pending) tags.push(el("span", { class: "q-sync", title: "正在与服务端同步" }, "…"));
    const actions = el("span", { class: "q-actions" },
      el("button", {
        class: "q-btn jump", type: "button", title: "插队：打断当前任务，立刻发送这条",
        "aria-label": "立即发送这条排队消息", onclick: () => void sendQueuedNow(item.id),
      }, "立即发送"),
      el("button", {
        class: "q-btn del", type: "button", title: "从队列移除", "aria-label": "移除这条排队消息",
        onclick: () => void removeQueued(item.id),
      }, "✕"),
    );
    row.append(indexNode, copy, ...tags, actions);
    return row;
  });
  bar.replaceChildren(
    el("div", { class: "q-head", "aria-live": "polite" },
      el("span", { class: "q-head-icon", "aria-hidden": "true" }, "▤"),
      el("strong", { class: "q-title" }, "消息队列"),
      el("span", { class: "q-count" }, countText),
      el("span", { class: "q-hint" }, hint),
    ),
    el("div", { class: "q-list" }, ...rows),
  );
}

async function enqueueMessage(text, images) {
  if (!state.sessionId) return false;
  const id = state.sessionId;
  const preview = String(text || "").replace(/\s+/g, " ").slice(0, 80) || "（图片）";
  const optimistic = {
    id: `local-${Date.now()}`,
    text: preview,
    ...(images && images.length ? { images: images.length } : {}),
    pending: true,
  };
  state.serverQueue = [...(state.serverQueue || []), optimistic];
  renderQueue();
  try {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(images && images.length ? { images } : {}) }),
    });
    toast("已加入队列（本轮结束后自动发送，切走会话也会发）");
    return true;
  } catch (e) {
    if (state.sessionId === id) {
      state.serverQueue = (state.serverQueue || []).filter((item) => item !== optimistic);
      renderQueue();
    }
    toast(`入队失败：${e.message}`);
    return false;
  }
}

async function removeQueued(id) {
  if (!state.sessionId) return;
  const sid = state.sessionId;
  const prev = state.serverQueue || [];
  state.serverQueue = prev.filter((item) => item.id !== id);
  renderQueue();
  try {
    await api(`/api/sessions/${encodeURIComponent(sid)}/queue/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (e) {
    if (state.sessionId === sid) {
      state.serverQueue = prev;
      renderQueue();
    }
    toast(`移除失败：${e.message}`);
  }
}

async function sendQueuedNow(id) {
  if (!state.sessionId) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/queue/${encodeURIComponent(id)}/jump`, { method: "POST" });
    setStreaming(true);
    setStreamStatus("请求中");
  } catch (e) {
    toast(`插队失败：${e.message}`);
  }
}

// ── 附件（粘贴 / 拖入图片和文件） ──────────────────────────────────

// 单图 12M 字符（≈9MB 原图）；总量留出 JSON 开销，压在服务端 40MB 请求体上限以内
const ATTACH_LIMITS = { maxFiles: 8, maxImageChars: 12_000_000, maxTextChars: 400_000, maxTotalChars: 34_000_000 };

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
  const totalChars = () => state.pendingAttach.reduce((n, a) => n + (a.kind === "image" ? a.data.length : (a.text || "").length), 0);
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
        if (totalChars() + data.length > ATTACH_LIMITS.maxTotalChars) {
          toast(`附件总大小超限（约 ${Math.round(ATTACH_LIMITS.maxTotalChars / 3_000_000)}MB），请减少图片数量或压缩后再发`);
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
        if (totalChars() + text.length > ATTACH_LIMITS.maxTotalChars) {
          toast(`附件总大小超限，请减少附件后再发`);
          continue;
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
  // 立刻给反馈：变「停止中…」并禁用，不等服务端把 abort 等完
  setStreamStatus("停止中");
  state.stopping = true;
  const stopBtn = $("btn-stop");
  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.textContent = "停止中";
    stopBtn.title = "正在停止…";
  }
  try {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/stop`, { method: "POST" });
  } catch (e) {
    toast(`停止失败：${e.message}`);
    state.stopping = false;
    if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = "■"; stopBtn.title = "停止当前任务"; }
    clearStreamStatus();
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
  // 压缩模型接口与模型目录并行加载。模型目录后到时也要刷新一次，
  // 否则已保存的压缩模型会因为暂时没有匹配项而一直显示占位文案。
  if (state.dd.compactModel) state.dd.compactModel.refresh();
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
    const switched = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/model`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: provider, modelId: modelId }),
    });
    state.model = { provider: provider, modelId: modelId };
    if (switched && switched.sessionId && switched.sessionId !== state.sessionId) {
      await openSession(switched.sessionId);
    }
    state.pulledLevels = loadPulledLevels(state.model); // 换模型 → 换用该模型拉取过的级别
    renderThinkingPicker();
    toast("模型已切换");
  } catch (e) {
    toast(`切换模型失败：${e.message}`);
  }
  if (state.dd.model) state.dd.model.refresh();
}

/** 拉取到的思考级别按模型缓存到 localStorage（刷新后不丢）。 */
const PULLED_LEVELS_KEY = `${STORE}.pulledLevels`;

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
    const c = r.compactionModel;
    state.compactionModel = c && c.provider && (c.modelId || c.model)
      ? { provider: c.provider, modelId: c.modelId || c.model }
      : null;
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
    const c = r.compactionModel;
    state.compactionModel = c && c.provider && (c.modelId || c.model)
      ? { provider: c.provider, modelId: c.modelId || c.model }
      : null;
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
  if (state.replaying) return;
  if (!state.sessionId) {
    $("ctx-meter").hidden = true;
    return;
  }
  if (ctxLoading) {
    ctxPending = true;
    return;
  }
  const wantId = state.sessionId; // 晚到的响应不能画到下一条会话上
  ctxLoading = true;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(wantId)}/context`);
    if (wantId !== state.sessionId) return;
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

/** token 数展示：K/M/B/T（token 计数的行业习惯；G 留给字节）。 */
function fmtTok(n) {
  if (!Number.isFinite(n)) return "—";
  const v = Math.abs(n);
  if (v >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return v >= 1000 ? `${(n / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(n));
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
  );
  // 本对话累计：整条分支所有 assistant 的 usage 之和（这才是"这个会话一共花了多少"）
  const t = info.totals;
  if (t && t.calls > 0) {
    rows.push(
      el("div", { class: "row total" },
        el("span", {}, "本对话累计"),
        el("b", {}, `${fmtTok(t.total)} tok / ${t.calls} 次`)),
      el("div", { class: "row sub" },
        el("span", {}, "输入（含缓存）"),
        el("b", {}, `${fmtTok((t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0))} tok`)),
      el("div", { class: "row sub" },
        el("span", {}, "输出"),
        el("b", {}, `${fmtTok(t.output)} tok`)),
    );
  }
  rows.push(el("div", { class: "note" }, "分项为 chars/4 估算；总量、缓存以 provider 回报的 usage 为准"));
  pop.replaceChildren(...rows);
}

// ── 右栏：当前对话 DIFF ────────────────────────────────────────────

let diffLoading = false;
async function refreshDiff() {
  if (state.replaying || !state.sessionId || diffLoading) return;
  const wantId = state.sessionId; // 晚到的响应不能画到下一条会话上
  diffLoading = true;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(wantId)}/diff`);
    if (wantId !== state.sessionId) return;
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
  // 识图声明：勾选后即多模态——pi 会把图片作为原生输入发给该模型，不再丢弃
  const nonImageInputs = Array.isArray(m.input) && m.input.some((value) => value !== "image" && typeof value === "string" && value)
    ? m.input.filter((value) => value !== "image" && typeof value === "string" && value)
    : ["text"];
  let visionEnabled = Array.isArray(m.input) && m.input.includes("image");
  const visionBox = el("input", { type: "checkbox" });
  visionBox.checked = visionEnabled;
  visionBox.addEventListener("change", () => { visionEnabled = visionBox.checked; });
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
  const visionLine = el("div", { class: "model-line" },
    el("label", {
      class: "switch-line vision-toggle",
      title: "勾选后把该模型声明为多模态：图片会作为原生输入发送；文本模型不勾选（否则图片会被运行时丢弃）",
    }, visionBox, "支持识图（多模态）"),
  );
  row.append(line1, visionLine, line2, thinkingFetch, choices, thinkingNote);
  row._read = () => ({
    id: id.value,
    name: name.value,
    contextWindow: parseCapacity(ctx.value),
    maxTokens: parseCapacity(max.value),
    reasoning: Boolean(efforts.value.trim()) || reasoning,
    thinkingEfforts: efforts.value.trim() === "" ? (disabledThinking ? false : "") : efforts.value.trim(),
    input: visionEnabled ? [...new Set([...nonImageInputs, "image"])] : nonImageInputs,
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
  // 工作区行右侧：在系统文件管理器里打开当前工作区
  $("btn-open-workspace")?.addEventListener("click", openWorkspaceFolder);
  // 工作区行右侧：切换会话列表排序（按工作区分组 ↔ 全部按最近）
  $("btn-order")?.addEventListener("click", () => {
    setSessionOrder(state.sessionOrder === "recent" ? "workspace" : "recent");
  });
  $("btn-send").addEventListener("click", send);
  $("btn-stop")?.addEventListener("click", () => void stop()); // 容错：旧版 HTML 里没有这个按钮
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
  $("bm-flag").addEventListener("click", () => toggleFlagMenu());
  document.addEventListener("pointerdown", (e) => {
    if (!flagMenuOpen) return;
    if (e.target.closest("#bm-flag") || e.target.closest("#bm-flag-menu")) return;
    closeFlagMenu();
  });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFlagMenu(); });
  // 只有「按钮会跟着移位」的滚动才关旗帜菜单：聊天区自动滚动不受影响
  window.addEventListener("scroll", (e) => {
    if (!flagMenuOpen || !$("bm-flag")) return;
    const t = e.target;
    if (t === document || t === window || (t instanceof Node && t.contains($("bm-flag")))) closeFlagMenu();
  }, true);
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
  $("bg-task-close").addEventListener("click", () => $("bg-task-dlg").close());
  $("bg-task-stop").addEventListener("click", () => { $("bg-task-dlg").close(); void stop(); });
  $("agent-run-close").addEventListener("click", () => $("agent-run-dlg").close());
  // 关闭对话框就停掉增量轮询（缓存留着，下次打开秒开）
  $("agent-run-dlg").addEventListener("close", () => stopAgentThreadWatch());
  $("agent-run-stop").addEventListener("click", stopSelectedAgent);
  $("btn-add-preset").addEventListener("click", () => openPresetEditor(null));
  $("pd-close").addEventListener("click", () => $("preset-dlg").close());
  $("pd-add-rule").addEventListener("click", () => {
    state.editingPreset.rules.push({ content: "", enabled: true });
    renderPresetRules();
  });
    $("pd-save").addEventListener("click", savePresetEditor);
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
    // API 返回的是 modelId；这里用同一个字段生成选中值，否则保存成功后下拉框会回退到占位文案。
    getValue: () => (state.compactionModel
      ? `${state.compactionModel.provider}/${state.compactionModel.modelId || state.compactionModel.model}`
      : ""),
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
  if (RUNTIME === "codex") input.placeholder = "输入问题，或用 / 打开命令…（Enter 发送，Shift+Enter 换行）";
  $("goal-clear")?.addEventListener("click", () => { void clearGoal(); });
  input.addEventListener("keydown", (e) => {
    // 输入法组词中的回车是「上屏」，不是发送（中文输入最容易踩）
    if (e.isComposing || e.keyCode === 229) return;
    if (RUNTIME === "codex" && slashOpen()) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSlash(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlash();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        acceptSlash();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.repeat) return; // 长按连发只发一次
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => {
    autoGrow(input);
    if (RUNTIME === "codex") renderSlash();
  });
  bindAttachInput();
  input.disabled = true;
  $("btn-send").disabled = true;
  renderOrderButton(); // 会话排序开关：按上次选择初始化滑块位置
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
  setInterval(() => { if (!document.hidden) { updateAgentMetrics(); updateUnviewedFlagBadge(); tickToolTimers(); tickBgTaskTimes(); } }, 1000);
  loadDoneTasks();
  void refreshRunningSessions();
  setInterval(() => { if (!document.hidden) void refreshRunningSessions(); }, 3000);
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
    if (RUNTIME !== "pi") {
      for (const item of document.querySelectorAll("#settings-menu .sm-item")) {
        if (item.dataset.action !== "providers") item.remove();
      }
      await Promise.all([loadSessions(), loadModels()]);
    } else {
      await Promise.all([loadSessions(), loadModels(), loadPresets(), loadSubagents()]);
    }
    // 回到上次点击的会话（已被删除就不恢复）
    bootText("恢复上次会话…");
    if (last.sessionId && state.sessions.some((s) => s.id === last.sessionId)) {
      // 页面重载从最新消息开始，避免上次临时滚动到旧消息后再次“窜回”对话定位。
      await openSession(last.sessionId, { restorePosition: false });
    }
    closeBootOverlay();
    setInterval(() => {
      if (document.hidden || !state.sessionId) return;
      if (RUNTIME === "codex") void refreshGoal();
      else return loadSessionSubagents();
      loadSessionSubagents();
    }, 2500);
  } catch (e) {
    toast(`初始化失败：${e.message}`);
    closeBootOverlay(e.message);
  }
}

boot();
