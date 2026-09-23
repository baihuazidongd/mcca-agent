"use strict";

/**
 * @mcca/mobile-bridge — pi-web 事件 → 手机端消息模型 的归约器。
 *
 * pi-web 的事件是给富前端用的细粒度流（delta/工具/回合/状态），手机端只需要
 * 「谁说了什么、任务跑到哪、要不要通知」。这里把历史回放与实时事件归约成同一
 * 种稳定结构，并输出紧凑补丁（patch），App 端只做加法。
 *
 * 与 pi-web 语义对齐的两点：
 *  - 一条 assistant 消息 = 一个气泡（一轮里可以有多条：文本/工具/文本…），
 *    所以模型是「按消息」，不是「按轮」；assistant-end 自带全文，回放里没有
 *    assistant-start/delta。
 *  - 工具调用挂在所属的 assistant 消息上；回放里 tool 帧跟在 assistant-end 后，
 *    所以没有流式消息时挂到本轮最后一条。
 *
 * 消息：
 *   { id, role:"user"|"agent"|"system", text, thinking, at, turn,
 *     status:"streaming"|"done"|"error", stopReason, error,
 *     durationMs, tokens, tokPerSec, tools:[{callId,name,args,output,isError,phase}] }
 *
 * 补丁：
 *   { t:"reset",  messages:[...] }
 *   { t:"msg",    msg:{...} }
 *   { t:"delta",  msgId, field:"text"|"thinking", text }
 *   { t:"session",session:{...} }
 */

const MESSAGE_CAP = 1500;
const TOOL_CAP = 60;

function nowMs() {
  return Date.now();
}

function createSessionState(id) {
  return {
    id: String(id),
    messages: [],
    byId: new Map(),
    streamMsgId: "",
    lastAssistantId: "",
    lastUserId: "",
    turnAgent: new Map(), // turn -> 本轮最后一条 agent 消息 id（工具挂载点）
    truncated: false,
    meta: {
      id: String(id),
      title: "",
      cwd: "",
      running: false,
      status: "idle",
      turn: 0,
      model: null,
      thinkingLevel: null,
      turnStartedAt: 0,
      queue: [],
      updatedAt: 0,
      online: false,
    },
  };
}

function capMessages(state) {
  if (state.messages.length <= MESSAGE_CAP) return;
  const removed = state.messages.splice(0, state.messages.length - MESSAGE_CAP);
  for (const msg of removed) state.byId.delete(msg.id);
  state.truncated = true;
}

function upsert(state, msg) {
  const existing = state.byId.get(msg.id);
  if (existing) {
    Object.assign(existing, msg);
    return existing;
  }
  state.messages.push(msg);
  state.byId.set(msg.id, msg);
  capMessages(state);
  return msg;
}

function createAgentMessage(state, at, streaming = true) {
  const msg = {
    id: `a${state.messages.length}_${at || nowMs()}`,
    role: "agent",
    text: "",
    thinking: "",
    at: at || nowMs(),
    turn: Number(state.meta.turn) || 0,
    status: streaming ? "streaming" : "done",
    tools: [],
  };
  if (streaming) state.streamMsgId = msg.id;
  state.lastAssistantId = msg.id;
  state.turnAgent.set(msg.turn, msg.id);
  return upsert(state, msg);
}

function streamingMessage(state) {
  if (state.streamMsgId && state.byId.has(state.streamMsgId)) return state.byId.get(state.streamMsgId);
  return createAgentMessage(state);
}

function lastAgentOfTurn(state) {
  const id = state.turnAgent.get(Number(state.meta.turn));
  if (id && state.byId.has(id)) return state.byId.get(id);
  if (state.lastAssistantId && state.byId.has(state.lastAssistantId)) return state.byId.get(state.lastAssistantId);
  return null;
}

function ensureUserMessage(state, text, at, id) {
  const msg = {
    id: id ? String(id) : `u${state.messages.length}_${at || nowMs()}`,
    role: "user",
    text: String(text ?? ""),
    at: at || nowMs(),
  };
  state.lastUserId = msg.id;
  return upsert(state, msg);
}

function systemNote(state, text, at) {
  return upsert(state, {
    id: `s${state.messages.length}_${at || nowMs()}`,
    role: "system",
    text: String(text ?? ""),
    at: at || nowMs(),
  });
}

const UUID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

/** 从 subagent 工具的入参/输出里抠出 async runId（聊天页据此打开子代理转录）。 */
function extractRunId(args, output) {
  const argMatch = String(args || "").match(/"id"\s*:\s*"([0-9a-fA-F-]{16,})"/);
  if (argMatch) return argMatch[1];
  const outMatch = String(output || "").match(/(?:Async workflow|Run:|run ")\s*\[?([0-9a-fA-F-]{16,})\]?/);
  if (outMatch) return outMatch[1].replace(/["\]]/g, "");
  const generic = String(output || "").match(UUID_RE);
  return generic ? generic[1] : "";
}

function toolPatch(state, ev, at) {
  const msg = (state.streamMsgId && state.byId.get(state.streamMsgId))
    || lastAgentOfTurn(state)
    || createAgentMessage(state, at, false);
  const list = msg.tools || (msg.tools = []);
  let tool = list.find((t) => t.callId && t.callId === ev.callId);
  if (!tool) {
    tool = { callId: ev.callId || `c${list.length}`, name: ev.name || "tool", at: at || nowMs() };
    list.push(tool);
  }
  if (ev.phase === "start") {
    tool.phase = "start";
    tool.name = ev.name || tool.name;
    if (typeof ev.args === "string" && ev.args) tool.args = ev.args;
    tool.at = at || tool.at || nowMs();
  } else {
    tool.phase = "end";
    if (ev.name) tool.name = ev.name;
    if (typeof ev.output === "string" && ev.output) tool.output = ev.output;
    tool.isError = Boolean(ev.isError);
    // pi-web 在工具结果里内联图片缩略图（{mime, data}），透传给手机渲染
    if (Array.isArray(ev.images) && ev.images.length) {
      tool.images = ev.images
        .slice(0, 4)
        .filter((im) => im && typeof im.data === "string" && im.data)
        .map((im) => ({ mimeType: String(im.mime || im.mimeType || "image/png"), data: String(im.data) }));
    }
  }
  if (/subagent/i.test(tool.name || "")) {
    const runId = extractRunId(tool.args, tool.output);
    if (runId && tool.runId !== runId) tool.runId = runId;
  }
  if (list.length > TOOL_CAP) list.splice(0, list.length - TOOL_CAP);
  return { t: "msg", msg };
}

/**
 * 把一条 pi-web 事件归约进 state，返回要发给 App 的补丁。
 * @param {object} state - createSessionState() 产物
 * @param {object} ev - pi-web 事件对象（frame.event）
 * @param {number} [at] - 事件时间（毫秒），缺省 Date.now()
 */
function applyEvent(state, ev, at) {
  const patches = [];
  if (!ev || typeof ev !== "object") return patches;
  const ts = Number.isFinite(at) && at > 0 ? at : nowMs();
  switch (ev.type) {
    case "user": {
      patches.push({ t: "msg", msg: ensureUserMessage(state, ev.text, ts, ev.id) });
      break;
    }
    case "user-id":
      // pi-web 用这个帧把回放的用户消息挂上条目 id（供前端「编辑重发」用）。
      // 手机端不需要编辑重发，改名反而会让 App 端多出一条气泡，直接忽略。
      break;
    case "turn-start": {
      state.meta.turn = Number(ev.turn) || state.meta.turn + 1;
      state.meta.running = true;
      state.meta.status = "requesting";
      if (!state.meta.turnStartedAt) state.meta.turnStartedAt = ts;
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "assistant-start": {
      const msg = createAgentMessage(state, ts);
      patches.push({ t: "msg", msg });
      break;
    }
    case "assistant-delta": {
      const msg = streamingMessage(state);
      msg.status = "streaming";
      if (Number.isFinite(ev.tokens)) msg.tokens = ev.tokens;
      const text = String(ev.text ?? "");
      msg.text += text; // 桥侧同步累积：会话列表预览/通知摘要要用
      patches.push({ t: "delta", msgId: msg.id, field: "text", text });
      break;
    }
    case "thinking-delta": {
      const msg = streamingMessage(state);
      const text = String(ev.text ?? "");
      msg.thinking = (msg.thinking || "") + text;
      patches.push({ t: "delta", msgId: msg.id, field: "thinking", text });
      break;
    }
    case "thinking-end":
      break;
    case "assistant-end": {
      const msg = state.streamMsgId && state.byId.has(state.streamMsgId)
        ? state.byId.get(state.streamMsgId)
        : createAgentMessage(state, ts, false);
      if (typeof ev.text === "string" && ev.text) msg.text = ev.text;
      if (typeof ev.thinking === "string" && ev.thinking) msg.thinking = ev.thinking;
      const failed = ev.stopReason === "error" || Boolean(ev.error);
      msg.status = failed ? "error" : "done";
      msg.stopReason = ev.stopReason || "stop";
      if (ev.error) msg.error = String(ev.error);
      if (ev.usage?.output) msg.tokens = ev.usage.output;
      if (ev.tokPerSec) msg.tokPerSec = Math.round(ev.tokPerSec * 10) / 10;
      state.streamMsgId = "";
      patches.push({ t: "msg", msg });
      break;
    }
    case "tool":
      patches.push(toolPatch(state, ev, ts));
      break;
    case "turn-end": {
      const msg = lastAgentOfTurn(state);
      if (msg) {
        if (msg.status === "streaming") msg.status = "done";
        if (ev.durationMs) msg.durationMs = ev.durationMs;
        patches.push({ t: "msg", msg });
      }
      state.meta.running = false;
      state.meta.turnStartedAt = 0;
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "status": {
      state.meta.status = String(ev.status || "idle");
      state.meta.running = state.meta.status !== "idle";
      if (!state.meta.running) state.meta.turnStartedAt = 0;
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "title": {
      if (ev.title) {
        state.meta.title = String(ev.title);
        patches.push({ t: "session", session: { ...state.meta } });
      }
      break;
    }
    case "model": {
      state.meta.model = { provider: ev.provider, modelId: ev.modelId };
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "prompt-queue": {
      state.meta.queue = Array.isArray(ev.items) ? ev.items : [];
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "compact": {
      const note = systemNote(
        state,
        ev.phase === "start"
          ? "正在压缩上下文…"
          : ev.failed
            ? `上下文压缩失败${ev.error ? "：" + ev.error : ""}`
            : "上下文已压缩",
        ts,
      );
      patches.push({ t: "msg", msg: note });
      break;
    }
    case "retry": {
      if (ev.phase === "start") {
        const note = systemNote(state, `请求失败，自动重试（第 ${ev.attempt}/${ev.maxAttempts} 次）${ev.error ? "：" + ev.error : ""}`, ts);
        patches.push({ t: "msg", msg: note });
      }
      break;
    }
    case "subagents-config":
      break;
    case "transcript-reset": {
      const replay = Array.isArray(ev.events) ? ev.events : [];
      const fresh = createSessionState(state.id);
      fresh.meta = state.meta;
      for (const item of replay) applyEvent(fresh, item, ts);
      state.messages = fresh.messages;
      state.byId = fresh.byId;
      state.streamMsgId = "";
      state.lastAssistantId = fresh.lastAssistantId;
      state.lastUserId = fresh.lastUserId;
      state.turnAgent = fresh.turnAgent;
      patches.push({ t: "reset", messages: state.messages.slice() });
      break;
    }
    default:
      break;
  }
  return patches;
}

/** 用 frame 列表（history 回放）整段重建 reducer 状态。 */
function reduceFrames(id, frames) {
  const state = createSessionState(id);
  for (const frame of frames || []) {
    const ev = frame && frame.event ? frame.event : frame;
    applyEvent(state, ev, 0);
  }
  state.streamMsgId = "";
  return state;
}

module.exports = { createSessionState, applyEvent, reduceFrames, MESSAGE_CAP };
