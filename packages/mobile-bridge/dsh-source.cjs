"use strict";

/**
 * @mcca/mobile-bridge — dsh（DeepSeek Harness）数据源。
 *
 * 只走 dsh 自己的 HTTP/WS 接口，与 pi-web 数据源并列：
 *   POST /api/<method>   信封 {type:"client-request", rpcId, method, payload}
 *   WS   /api/events.mux  会话事件/投影/队列
 *   WS   /api/events.host 会话生命周期/运行状态
 *
 * 本机托管实例使用门户捕获的登录 cookie。默认 127.0.0.1:3081。
 */

const { createSessionState, applyEvent, reduceEntries } = require("./dsh-reducer.cjs");
// 用 ws 包的客户端而不是全局 WebSocket：terminate() 能立刻释放连接，
// 否则测试/重启流程会卡在 close 握手超时上（undici 的 30s 兜底）。
const WebSocket = require("ws");

const POLL_MS = 5000;

class DshSource {
  constructor({ baseUrl, onPatch, onSessions, log }) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:3081").replace(/\/+$/, "");
    this.wsBase = this.baseUrl.replace(/^http/, "ws");
    this.onPatch = onPatch || (() => {});
    this.onSessions = onSessions || (() => {});
    this.log = log || (() => {});
    this.online = false;
    this.lastError = "";
    this.index = new Map();
    this.states = new Map();
    this.sockets = [];
    this.reconnectTimer = null;
    this.backoff = 1000;
    this.timer = null;
    this.rpcSeq = 0;
    this.started = false;
    this.problemLogged = false;
    this.previewCache = new Map(); // id -> { role, text, status, at }
    this.previewPending = new Set();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connectSockets();
    const tick = async () => {
      try {
        await this.poll();
      } catch (error) {
        this.setOffline(error);
      }
    };
    this.timer = setInterval(() => void tick(), POLL_MS);
    void tick();
  }

  dispose() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const ws of this.sockets) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
    this.sockets = [];
  }

  setOffline(error) {
    const was = this.online;
    this.online = false;
    this.lastError = error instanceof Error ? error.message : String(error || "");
    if (was) {
      this.log(`dsh 离线：${this.lastError}`);
      this.onSessions(this.view());
    }
  }

  // ── RPC ─────────────────────────────────────────────────────────

  authHeaders() {
    const url = new URL(this.baseUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return {};
    return require("../runtime-core/dsh-auth.cjs").headers(Number(url.port || (url.protocol === "https:" ? 443 : 80)));
  }

  async rpc(method, payload, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...await this.authHeaders() },
        body: JSON.stringify({ type: "client-request", rpcId: `mcca-${++this.rpcSeq}-${Date.now()}`, method, payload: payload || {} }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`dsh ${method} → HTTP ${res.status}`);
      const json = await res.json();
      const result = json && json.result;
      if (!result) throw new Error(`dsh ${method} → 响应格式异常`);
      if (result.ok === false) {
        const err = result.error || {};
        const error = new Error(`${err.code || "error"}: ${err.message || ""}`);
        error.code = err.code || "error";
        throw error;
      }
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── WebSocket 事件流 ────────────────────────────────────────────

  connectSockets() {
    for (const path of ["/api/events.mux", "/api/events.host"]) this.openSocket(path);
  }

  async openSocket(path) {
    if (!this.started) return;
    let ws;
    try {
      const headers=await this.authHeaders();
      if(!this.started)return;
      ws = new WebSocket(`${this.wsBase}${path}`,{headers});
    } catch (error) {
      this.scheduleReconnect();
      return;
    }
    this.sockets.push(ws);
    ws.onopen = () => {
      this.backoff = 1000;
      this.log(`dsh ${path} 已连接`);
    };
    ws.onmessage = (event) => {
      let envelope = null;
      try { envelope = JSON.parse(String(event.data)); } catch { return; }
      const frame = envelope && envelope.payload ? envelope.payload : envelope;
      if (!frame || typeof frame !== "object") return;
      try {
        if (String(frame.type || "").startsWith("host/")) this.handleHostFrame(frame);
        else this.handleMuxFrame(frame);
      } catch (error) {
        this.log(`dsh 帧处理失败：${error.message}`);
      }
    };
    ws.onclose = () => {
      this.sockets = this.sockets.filter((s) => s !== ws);
      if (this.started) this.scheduleReconnect();
    };
    ws.onerror = () => { /* close 统一收尾 */ };
  }

  scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.sockets.length) this.connectSockets();
    }, this.backoff);
    this.backoff = Math.min(Math.round(this.backoff * 1.8), 20000);
  }

  handleMuxFrame(frame) {
    const sessionId = String(frame.sessionId || "");
    if (!sessionId) {
      if (frame.type === "stream/error") this.log(`dsh 事件流错误：${frame.error?.message || ""}`);
      return;
    }
    if (frame.type === "session/event") {
      const state = this.states.get(sessionId);
      if (!state) {
        // 没打开的会话也别丢：用事件更新列表预览（否则 App 里永远是空的）
        const ev = frame.event || {};
        const data = ev.data || {};
        let text = "";
        let role = "";
        if (ev.type === "user/message" && data.source?.kind === "user") {
          role = "user";
          text = contentText(data.content);
        } else if (ev.type === "assistant/message") {
          role = "agent";
          text = contentText((data.message || {}).content);
        } else if (ev.type === "session/title" && data.title) {
          const entry = this.index.get(sessionId);
          if (entry) entry.title = String(data.title);
        }
        text = String(text || "").trim();
        if (text) {
          this.previewCache.set(sessionId, { role, text: text.slice(0, 120), status: "", at: Date.now() });
          this.onSessions(this.view());
        }
        return;
      }
      const patches = applyEvent(state, frame.event);
      if (patches.length) this.onPatch(sessionId, patches);
      return;
    }
    if (frame.type === "session/projection") {
      const state = this.states.get(sessionId);
      if (!state) return;
      if (frame.key === "goal") {
        const goal = frame.value && frame.value.goal ? frame.value : null;
        state.meta.goal = goal
          ? {
              id: String(goal.goal.id || ""),
              revision: Number(goal.goal.revision) || 0,
              objective: String(goal.goal.objective || ""),
              phase: String(goal.goal.phase || ""),
              blockedReason: goal.goal.blockedReason?.message ? String(goal.goal.blockedReason.message) : "",
              roundsStarted: Number(goal.roundsStarted) || 0,
              createdAt: Number(goal.createdAt) || 0,
              updatedAt: Number(goal.updatedAt) || 0,
              maxGoalRounds: Number(goal.goal.maxGoalRounds) || 0,
            }
          : null;
        this.onPatch(sessionId, [{ t: "session", session: { ...state.meta } }]);
      }
      return;
    }
    if (frame.type === "session/queue") {
      const state = this.states.get(sessionId);
      if (!state) return;
      state.meta.queue = (frame.items || []).map((item) => item.id).filter(Boolean);
      this.onPatch(sessionId, [{ t: "session", session: { ...state.meta } }]);
      return;
    }
    if (frame.type === "approval/requested" || frame.type === "question/requested") {
      const state = this.states.get(sessionId);
      if (!state) return;
      const text =
        frame.type === "approval/requested"
          ? `等待确认：${frame.toolName || "操作"}${frame.reason ? `（${frame.reason}）` : ""}`
          : `agent 提问：${(frame.questions || []).map((q) => q.question || q.text || "").join(" / ").slice(0, 120)}`;
      const note = { id: `n${Date.now()}`, role: "system", text, at: Date.now() };
      state.messages.push(note);
      this.onPatch(sessionId, [{ t: "msg", msg: note }]);
      return;
    }
    if (frame.type === "stream/error") {
      this.log(`dsh mux 错误：${frame.error?.message || ""}`);
    }
  }

  handleHostFrame(frame) {
    const sessionId = String(frame.sessionId || "");
    if (!sessionId) return;
    if (frame.type === "host/session-status") {
      const state = this.states.get(sessionId);
      if (state) {
        state.meta.running = Boolean(frame.running);
        state.meta.status = frame.running ? "processing" : "idle";
        if (!frame.running) state.meta.turnStartedAt = 0;
        this.onPatch(sessionId, [{ t: "session", session: { ...state.meta } }]);
      }
      const entry = this.index.get(sessionId);
      if (entry && Boolean(entry.running) !== Boolean(frame.running)) {
        entry.running = Boolean(frame.running);
        this.onSessions(this.view());
      }
      return;
    }
    if (frame.type === "host/session-removed") {
      this.index.delete(sessionId);
      this.states.delete(sessionId);
      this.onSessions(this.view());
      return;
    }
    if (frame.type === "host/session-added") {
      void this.poll().catch(() => {});
      return;
    }
    if (frame.type === "host/agent-error") {
      const state = this.states.get(sessionId);
      if (state) {
        const msg = { id: `e${Date.now()}`, role: "system", text: `运行出错：${frame.message || ""}`, at: Date.now(), status: "error" };
        state.messages.push(msg);
        this.onPatch(sessionId, [{ t: "msg", msg }]);
      }
      return;
    }
    if (frame.type === "stream/error") this.log(`dsh host 流错误：${frame.error?.message || ""}`);
  }

  // ── 索引与视图 ──────────────────────────────────────────────────

  view() {
    const items = [...this.index.values()].map((s) => {
      const state = this.states.get(s.id);
      const preview = this.previewOf(s.id);
      return {
        agent: "dsh",
        id: s.id,
        title: (state && state.meta.title) || s.title || "未命名会话",
        cwd: s.cwd || "",
        updatedAt: s.updatedAt || 0,
        running: Boolean(state ? state.meta.running : s.running),
        status: state ? state.meta.status : s.running ? "processing" : "idle",
        turn: (state && state.meta.turn) || 0,
        model: (state && state.meta.model) || s.model || null,
        turnStartedAt: (state && state.meta.turnStartedAt) || 0,
        queue: state ? state.meta.queue.length : 0,
        goal: (state && state.meta.goal) || s.goal || null,
        lastRole: preview ? preview.role : "",
        lastText: preview ? preview.text : "",
        lastStatus: preview ? preview.status : "",
        online: this.online,
      };
    });
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return items;
  }

  /** 预览兜底：内存态 → 5 分钟内的缓存 → 后台补拉一次 history 尾巴。 */
  previewOf(id) {
    const st = this.states.get(id);
    if (st && st.messages.length) {
      const last = st.messages[st.messages.length - 1];
      const text = String(last.text || "").trim();
      if (text) return { role: last.role || "", text: text.slice(0, 120), status: last.status || "" };
    }
    const cached = this.previewCache.get(id);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
    if (!this.previewPending.has(id) && this.previewPending.size < 12) {
      this.previewPending.add(id);
      void this.fillPreview(id);
    }
    return cached || null;
  }

  async fillPreview(id) {
    try {
      const history = await this.rpc("session.history", { sessionId: String(id), maxMessages: 3 }, 12_000);
      const state = reduceEntries(id, history?.events || []);
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        const m = state.messages[i];
        const text = String(m.text || "").trim();
        if (!text) continue;
        this.previewCache.set(String(id), { role: m.role || "", text: text.slice(0, 120), status: m.status || "", at: Date.now() });
        this.onSessions(this.view());
        break;
      }
    } catch {
      // 预览失败不影响列表
    } finally {
      this.previewPending.delete(String(id));
    }
  }

  async poll() {
    const value = await this.rpc("session.list", {});
    const items = Array.isArray(value?.items) ? value.items : [];
    const next = new Map();
    let changed = !this.online;
    for (const s of items) {
      const id = String(s.sessionId || "");
      if (!id) continue;
      const before = this.index.get(id);
      const projections = s.projections?.values || {};
      const entry = {
        id,
        title: typeof projections.title === "string" ? projections.title : "",
        cwd: s.cwd || "",
        updatedAt: Number(s.updatedAt) || 0,
        running: Boolean(s.running),
        blank: Boolean(s.blank),
        model: projections.model || null,
        goal:
          projections.goal && projections.goal.goal
            ? {
                id: String(projections.goal.goal.id || ""),
                revision: Number(projections.goal.goal.revision) || 0,
                objective: String(projections.goal.goal.objective || ""),
                phase: String(projections.goal.goal.phase || ""),
                blockedReason: projections.goal.goal.blockedReason?.message ? String(projections.goal.goal.blockedReason.message) : "",
                roundsStarted: Number(projections.goal.roundsStarted) || 0,
                createdAt: Number(projections.goal.createdAt) || 0,
                updatedAt: Number(projections.goal.updatedAt) || 0,
                maxGoalRounds: Number(projections.goal.goal.maxGoalRounds) || 0,
              }
            : null,
      };
      next.set(id, entry);
      const state = this.states.get(id);
      if (state) {
        if (entry.title) state.meta.title = entry.title;
        state.meta.cwd = entry.cwd || state.meta.cwd;
        state.meta.updatedAt = entry.updatedAt || state.meta.updatedAt;
        state.meta.online = true;
        if (entry.goal) state.meta.goal = entry.goal;
        if (state.meta.running !== entry.running) {
          state.meta.running = entry.running;
          state.meta.status = entry.running ? "processing" : "idle";
          if (!entry.running) state.meta.turnStartedAt = 0;
          this.onPatch(id, [{ t: "session", session: { ...state.meta } }]);
        }
      }
      if (
        !before ||
        before.title !== entry.title ||
        before.updatedAt !== entry.updatedAt ||
        before.running !== entry.running ||
        Boolean(before.goal?.phase) !== Boolean(entry.goal?.phase)
      ) {
        changed = true;
      }
    }
    for (const id of this.index.keys()) if (!next.has(id)) changed = true;
    this.index = next;
    this.online = true;
    this.lastError = "";
    this.problemLogged = false;
    if (changed) this.onSessions(this.view());
  }

  // ── 会话操作 ────────────────────────────────────────────────────

  async list() {
    await this.poll();
    return this.view();
  }

  async open(id) {
    const sid = String(id);
    const history = await this.rpc("session.history", { sessionId: sid, maxMessages: 200 }, 30000);
    const state = reduceEntries(sid, history?.events || []);
    const entry = this.index.get(sid);
    const projections = history?.projections?.values || {};
    state.meta.title = (typeof projections.title === "string" && projections.title) || (entry && entry.title) || "";
    state.meta.cwd = (entry && entry.cwd) || "";
    state.meta.updatedAt = (entry && entry.updatedAt) || 0;
    state.meta.running = Boolean(entry && entry.running);
    state.meta.status = state.meta.running ? "processing" : "idle";
    state.meta.goal = (entry && entry.goal) || null;
    state.meta.online = true;
    state.meta.hasMore = Boolean(history?.hasMore);
    state.seq = Math.max(state.seq, ...(history?.events || []).map((e) => Number((e.event || e).seq) || 0), 0);
    this.states.set(sid, state);
    return { session: { ...state.meta }, messages: state.messages.slice(), truncated: Boolean(state.truncated), hasMore: Boolean(history?.hasMore) };
  }

  close(id) {
    // dsh 侧状态留着无妨（事件流是全量的，patch 只发给已打开会话）
    const sid = String(id);
    if (!this.index.has(sid)) this.states.delete(sid);
  }

  async send(id, text, images) {
    const content = [];
    const body = String(text ?? "").trim();
    if (body) content.push({ type: "text", text: body });
    for (const im of Array.isArray(images) ? images.slice(0, 8) : []) {
      const mediaType = String(im.mimeType || "image/png");
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) continue;
      content.push({ type: "image", mediaType, data: String(im.data || ""), ...(im.name ? { name: String(im.name) } : {}) });
    }
    if (!content.length) return { ok: false, error: "消息为空" };
    await this.rpc("session.prompt", { sessionId: String(id), mode: "queue", content }, 30000);
    const state = this.states.get(String(id));
    if (state) {
      state.meta.running = true;
      if (!state.meta.turnStartedAt) state.meta.turnStartedAt = Date.now();
      if (state.meta.status === "idle") state.meta.status = "requesting";
      this.onPatch(String(id), [{ t: "session", session: { ...state.meta } }]);
    }
    return { ok: true, mode: "queue" };
  }

  async stop(id) {
    if (id === undefined) { this.dispose(); return; }
    const value = await this.rpc("session.cancel", { sessionId: String(id) }, 20000);
    return { ok: value?.accepted !== false };
  }

  async create(cwd) {
    const value = await this.rpc("session.create", cwd ? { cwd: String(cwd) } : {}, 30000);
    const id = String(value?.sessionId || "");
    if (!id) return { ok: false, error: "session.create 未返回 sessionId" };
    await this.poll().catch(() => {});
    return { ok: true, id };
  }

  async rename(id, title) {
    await this.rpc("session.rename", { sessionId: String(id), title: String(title) }, 20000);
    const state = this.states.get(String(id));
    if (state) {
      state.meta.title = String(title);
      this.onPatch(String(id), [{ t: "session", session: { ...state.meta } }]);
    }
    return { ok: true };
  }

  async models(id) {
    const value = await this.rpc("session.models", { sessionId: String(id) }, 30000);
    const groups = (value?.groups || []).map((g) => ({
      provider: String(g.id || g.name || ""),
      label: String(g.name || g.id || ""),
      models: (g.models || []).map((m) => ({
        id: String(m.id || ""),
        name: String(m.name || m.id || ""),
        efforts: (m.reasoning?.efforts || []).map((e) => ({ id: String(e.id || ""), name: String(e.name || e.id || "") })),
      })),
    }));
    const current = value?.current || null;
    const state = this.states.get(String(id));
    if (state && current) {
      state.meta.model = { provider: String(current.provider || ""), modelId: String(current.model || "") };
      state.meta.thinkingLevel = current.reasoningEffort ? String(current.reasoningEffort) : "";
      this.onPatch(String(id), [{ t: "session", session: { ...state.meta } }]);
    }
    return { ok: true, groups, levels: [], current };
  }

  async setModel(id, provider, modelId, level) {
    const payload = { sessionId: String(id), provider: String(provider), model: String(modelId) };
    if (level) payload.reasoningEffort = String(level);
    await this.rpc("session.selectModel", payload, 30000);
    const state = this.states.get(String(id));
    if (state) {
      state.meta.model = { provider: String(provider), modelId: String(modelId) };
      if (level) state.meta.thinkingLevel = String(level);
      this.onPatch(String(id), [{ t: "session", session: { ...state.meta } }]);
    }
    return { ok: true };
  }

  /** 思考强度：用当前 provider/model + 新的 reasoningEffort 重新 selectModel。 */
  async setThinking(id, level) {
    const state = this.states.get(String(id));
    const model = state?.meta?.model;
    if (!model?.provider || !model?.modelId) return { ok: false, error: "当前会话模型未知，先选择一个模型" };
    return this.setModel(id, model.provider, model.modelId, level);
  }

  /**
   * 目标操作：create 用 objective；pause/resume/complete/clear 需要 goal ref，
   * 从当前会话状态里取（session/projection 的 goal 值带 id/revision）。
   */
  async goalAction(sessionId, action, { objective = "", maxRounds = 0 } = {}) {
    const sid = String(sessionId);
    const state = this.states.get(sid);
    const meta = state?.meta?.goal;
    const ref = meta && meta.id ? { id: meta.id, revision: meta.revision } : null;
    if (action === "create") {
      if (!String(objective).trim()) return { ok: false, error: "目标内容不能为空" };
      const payload = { sessionId: sid, objective: String(objective).trim() };
      if (maxRounds > 0) payload.maxGoalRounds = Number(maxRounds);
      const value = await this.rpc("goal.create", payload, 20000);
      return { ok: true, ref: value?.ref || null };
    }
    if (!["pause", "resume", "complete", "clear"].includes(action)) {
      return { ok: false, error: `未知操作 ${action}` };
    }
    if (!ref) return { ok: false, error: "当前没有可操作的目标" };
    const method = { pause: "goal.pause", resume: "goal.resume", complete: "goal.complete", clear: "goal.clear" }[action];
    const value = await this.rpc(method, { sessionId: sid, ref }, 20000);
    return { ok: true, ref: value?.ref || ref };
  }

  async attachment(id, attachmentId) {    const value = await this.rpc("session.attachment", { sessionId: String(id), attachmentId: String(attachmentId) }, 30000);
    const data = String(value?.data || "");
    if (!data) return null;
    return { mimeType: String(value?.attachment?.mediaType || "image/png"), data };
  }
}

module.exports = { DshSource };
