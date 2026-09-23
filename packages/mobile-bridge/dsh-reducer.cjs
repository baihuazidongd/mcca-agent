"use strict";

/**
 * @mcca/mobile-bridge — dsh 事件 → 手机端消息模型 的归约器。
 *
 * dsh（Cordis）的会话事件比 pi 更结构化：一条 assistant/message = 一个 step 的
 * 完整消息（含 reasoning / text / tool-call 块），实时增量走 assistant/chunk，
 * 工具调用/结果分开成 tool/call、tool/result。这里把它们归约成与 pi 侧同构的
 * 消息（reducer.cjs 的 Msg 形状），App 端不需要区分 agent。
 *
 * 过滤规则：user/message 里只有 source.kind === "user" 才是人发的；
 * plugin（系统提示/技能快照）与 tool（工具结果，另有 tool/result 事件）都不进对话。
 *
 * 补丁与 pi 侧同一套：{t:"reset"|"msg"|"delta"|"session"}
 */

const MESSAGE_CAP = 1500;
const TOOL_CAP = 60;

function nowMs() {
  return Date.now();
}

function createSessionState(id) {
  return {
    id: String(id),
    agent: "dsh",
    messages: [],
    byId: new Map(),
    streamKey: "", // `${turn}:${step}` → 正在流式的 agent 消息 id
    lastAssistantId: "",
    tools: new Map(), // callId -> { msgId, index }
    truncated: false,
    seq: 0,
    meta: {
      id: String(id),
      agent: "dsh",
      title: "",
      cwd: "",
      running: false,
      status: "idle",
      turn: 0,
      model: null,
      thinkingLevel: null,
      turnStartedAt: 0,
      queue: [],
      goal: null,
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

function keyOf(turn, step) {
  return `${Number(turn) || 0}:${Number(step) || 0}`;
}

function agentMessage(state, turn, step, at) {
  const key = keyOf(turn, step);
  const id = `a${turn || 0}_${step || 0}`;
  const existing = state.byId.get(id);
  if (existing) {
    state.streamKey = key;
    return existing;
  }
  const msg = {
    id,
    role: "agent",
    text: "",
    thinking: "",
    images: [],
    tools: [],
    at: at || nowMs(),
    turn: Number(turn) || 0,
    status: "streaming",
    step: Number(step) || 0,
  };
  state.streamKey = key;
  state.lastAssistantId = id;
  return upsert(state, msg);
}

function streamingAgentMessage(state) {
  const [turn, step] = String(state.streamKey || "").split(":");
  return agentMessage(state, Number(turn) || state.meta.turn, Number(step) || 0);
}

function contentText(content, type = "text") {
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === type).map((c) => String(c.text ?? "")).join("");
}

function contentImages(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c && c.type === "image")
    .map((c) => {
      const att = c.attachment || {};
      return {
        attachmentId: String(att.attachmentId || ""),
        mimeType: String(att.mediaType || "image/png"),
        name: String(att.name || ""),
        bytes: Number(att.bytes) || 0,
      };
    })
    .filter((im) => im.attachmentId);
}

function userMessage(state, data, at, pending) {
  const msg = {
    id: String(data.id || `u${state.messages.length}_${at || nowMs()}`),
    role: "user",
    text: contentText(data.content),
    images: contentImages(data.content),
    at: at || nowMs(),
    pending: Boolean(pending),
  };
  return upsert(state, msg);
}

function note(state, text, at) {
  return upsert(state, {
    id: `s${state.messages.length}_${at || nowMs()}`,
    role: "system",
    text: String(text ?? ""),
    at: at || nowMs(),
  });
}

function toolFromArguments(name, args) {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return String(args);
  }
}

/**
 * 把一条 dsh 会话事件归约进 state，返回要发给 App 的补丁。
 * @param {object} state - createSessionState() 产物
 * @param {object} ev - SessionEvent（{type, seq, time, data}）
 */
function applyEvent(state, ev) {
  const patches = [];
  if (!ev || typeof ev !== "object" || !ev.type) return patches;
  const at = Number(ev.time) || nowMs();
  if (Number.isFinite(ev.seq) && ev.seq <= state.seq) return patches; // 事件流去重（seq 单调）
  if (Number.isFinite(ev.seq)) state.seq = ev.seq;
  const data = ev.data || {};

  switch (ev.type) {
    case "user/message": {
      if (data.source && data.source.kind !== "user") break; // 系统提示/工具结果不进对话
      const msg = userMessage(state, data, at, false);
      patches.push({ t: "msg", msg });
      break;
    }
    case "assistant/chunk": {
      const chunk = data.chunk || {};
      if (chunk.type === "text-delta") {
        const msg = agentMessage(state, data.turn, data.step, at);
        msg.status = "streaming";
        const text = String(chunk.text ?? "");
        msg.text += text;
        patches.push({ t: "delta", msgId: msg.id, field: "text", text });
      } else if (chunk.type === "reasoning-delta") {
        const msg = agentMessage(state, data.turn, data.step, at);
        const text = String(chunk.text ?? "");
        msg.thinking = (msg.thinking || "") + text;
        patches.push({ t: "delta", msgId: msg.id, field: "thinking", text });
      } else if (chunk.type === "finish" && chunk.reason && chunk.reason.kind === "error") {
        const msg = agentMessage(state, data.turn, data.step, at);
        msg.error = String(chunk.reason.failure?.message || chunk.reason.error?.message || "运行出错");
        patches.push({ t: "msg", msg });
      }
      break;
    }
    case "assistant/message": {
      const message = data.message || {};
      const msg = agentMessage(state, data.turn, data.step, at);
      const text = contentText(message.content);
      const thinking = contentText(message.content, "reasoning");
      if (text) msg.text = text;
      if (thinking) msg.thinking = thinking;
      const images = contentImages(message.content);
      if (images.length) msg.images = images;
      const tools = (Array.isArray(message.content) ? message.content : [])
        .filter((c) => c && c.type === "tool-call")
        .map((c) => ({ callId: String(c.id || ""), name: String(c.name || "tool"), args: toolFromArguments(c.name, c.arguments), phase: "start" }));
      for (const tool of tools) {
        const existing = msg.tools.find((t) => t.callId && t.callId === tool.callId);
        if (existing) Object.assign(existing, tool);
        else msg.tools.push(tool);
        if (msg.tools.length > TOOL_CAP) msg.tools.splice(0, msg.tools.length - TOOL_CAP);
        if (tool.callId) state.tools.set(tool.callId, { msgId: msg.id, name: tool.name });
      }
      msg.status = msg.error ? "error" : "done";
      msg.tokens = Number(data.usage?.outputTokens || data.usage?.output_tokens || 0) || msg.tokens || 0;
      state.streamKey = "";
      patches.push({ t: "msg", msg });
      break;
    }
    case "tool/call": {
      const msg = agentMessage(state, data.turn, data.step, at);
      const callId = String(data.callId || "");
      if (!callId) break;
      let tool = msg.tools.find((t) => t.callId === callId);
      if (!tool) {
        tool = { callId, name: String(data.name || "tool"), args: toolFromArguments(data.name, data.arguments), phase: "start" };
        msg.tools.push(tool);
        if (msg.tools.length > TOOL_CAP) msg.tools.splice(0, msg.tools.length - TOOL_CAP);
      } else {
        Object.assign(tool, { name: String(data.name || tool.name), args: toolFromArguments(data.name, data.arguments) });
      }
      state.tools.set(callId, { msgId: msg.id, name: tool.name });
      patches.push({ t: "msg", msg });
      break;
    }
    case "tool/result": {
      const message = data.message || {};
      const callId = String(message.source?.callId || "");
      const results = (Array.isArray(message.content) ? message.content : []).filter((c) => c && c.type === "tool-result");
      const outText = results
        .map((r) => {
          const inner = Array.isArray(r.content) ? r.content : [];
          return contentText(inner) || (typeof r.text === "string" ? r.text : "");
        })
        .join("\n")
        .trim();
      const outImages = results.flatMap((r) => contentImages(r.content));
      const isError = Boolean(message.content?.some((c) => c && c.type === "tool-result" && c.isError)) || Boolean(data.error);
      const known = state.tools.get(callId);
      const msg = (known && state.byId.get(known.msgId)) || agentMessage(state, data.turn, data.step, at);
      let tool = msg.tools.find((t) => t.callId === callId);
      if (!tool) {
        tool = { callId, name: known?.name || "tool", args: "", phase: "end" };
        msg.tools.push(tool);
      }
      tool.phase = "end";
      tool.output = outText.slice(0, 4000);
      tool.isError = isError;
      if (outImages.length) tool.images = outImages.slice(0, 4);
      patches.push({ t: "msg", msg });
      break;
    }
    case "turn/start": {
      state.meta.turn = Number(data.turn) || state.meta.turn + 1;
      state.meta.running = true;
      state.meta.status = "requesting";
      if (!state.meta.turnStartedAt) state.meta.turnStartedAt = at;
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "turn/end": {
      const reason = data.reason || {};
      const msg = state.lastAssistantId ? state.byId.get(state.lastAssistantId) : null;
      if (msg) {
        if (msg.status === "streaming") msg.status = "done";
        if (reason.kind === "error") {
          msg.status = "error";
          msg.error = String(reason.error?.message || reason.message || "运行出错");
        } else if (reason.kind === "aborted" || reason.kind === "interrupted") {
          msg.status = "stopped";
        }
        patches.push({ t: "msg", msg });
      }
      state.meta.running = false;
      state.meta.turnStartedAt = 0;
      state.meta.status = "idle";
      state.streamKey = "";
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "session/title": {
      const title = String(data.title || "");
      if (title) {
        state.meta.title = title;
        patches.push({ t: "session", session: { ...state.meta } });
      }
      break;
    }
    case "goal/change": {
      const goal = data.goal || null;
      state.meta.goal = goal && goal.objective
        ? {
            objective: String(goal.objective),
            phase: String(goal.phase || ""),
            blockedReason: goal.blockedReason?.message ? String(goal.blockedReason.message) : "",
            roundsStarted: Number(data.roundsStarted) || 0,
            maxGoalRounds: Number(goal.maxGoalRounds) || 0,
          }
        : null;
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "llm/retry": {
      const noteMsg = note(state, `请求失败，自动重试${data.retry ? `（第 ${data.retry} 次）` : ""}`, at);
      patches.push({ t: "msg", msg: noteMsg });
      break;
    }
    case "session/queue": {
      const items = Array.isArray(data.items) ? data.items : [];
      state.meta.queue = items.map((it) => it.id).filter(Boolean);
      for (const item of items) {
        const message = item.message;
        if (message && message.source?.kind === "user") {
          const msg = userMessage(state, message, at, item.placement === "queued");
          patches.push({ t: "msg", msg });
        }
      }
      patches.push({ t: "session", session: { ...state.meta } });
      break;
    }
    case "approval/asked":
    case "question/asked": {
      const noteMsg = note(state, `等待确认：${String(data.title || data.reason || ev.type)}`, at);
      patches.push({ t: "msg", msg: noteMsg });
      break;
    }
    case "todo/write":
    case "step/start":
    case "step/end":
    case "agent/inbox/spliced":
    case "request/header":
    case "request/context":
    case "session/title-llm-request":
    case "session/end-seed":
    case "permission/preset":
    case "sandbox/mode":
    case "approval/policy":
    case "llm/retry-started":
      break;
    default:
      break;
  }
  return patches;
}

/** 用 history 回放（HistoryEntry[] 或 SessionEvent[]）重建 reducer 状态。 */
function reduceEntries(id, entries) {
  const state = createSessionState(id);
  for (const entry of entries || []) {
    applyEvent(state, entry && entry.event ? entry.event : entry);
  }
  state.streamKey = "";
  for (const msg of state.messages) {
    if (msg.status === "streaming") msg.status = "done";
    if (msg.pending) msg.pending = false;
  }
  return state;
}

module.exports = { createSessionState, applyEvent, reduceEntries, MESSAGE_CAP };
