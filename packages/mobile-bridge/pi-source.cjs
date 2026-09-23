"use strict";

/**
 * @mcca/mobile-bridge — pi-web 数据源。
 *
 * 只依赖 pi-web 的 REST + SSE（无额外进程内引用），职责：
 *  - 会话索引轮询（运行中/标题/时间 → 变化时通知 App 刷新列表）
 *  - 按需订阅会话 SSE，把事件归约成手机补丁（reducer.cjs）并广播
 *  - 任务收尾时产出通知（完成/失败），供 App 发系统通知
 *  - 透传会话操作（发送/停止/新建/删除/改名/模型/思考强度/子代理）
 */

const { createSessionState, applyEvent, reduceFrames } = require("./reducer.cjs");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
/** pi-web 的静态资源目录：像素角色头像（manifest.json + <角色>/fN.png）在这里。 */
const PI_PUBLIC = process.env.MCCA_PI_WEB_PUBLIC || path.join(ROOT, "packages", "pi-web", "public");

/** 与 pi-web 前端完全一致的稳定 hash（同一会话取到同一个角色）。 */
function strHash(text) {
  let h = 5381;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

const POLL_MS = 4000;
const NOTIFY_COOLDOWN_MS = 5000;

class PiSource {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - pi-web 基址（默认 http://127.0.0.1:3458）
   * @param {(sessionId:string, patches:object[])=>void} opts.onPatch
   * @param {(sessions:object[])=>void} opts.onSessions
   * @param {(item:{title:string,body:string,kind:string,sessionId?:string})=>void} opts.onNotify
   * @param {(line:string)=>void} [opts.log]
   */
  constructor({ baseUrl, onPatch, onSessions, onNotify, log }) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:3458").replace(/\/+$/, "");
    this.onPatch = onPatch || (() => {});
    this.onSessions = onSessions || (() => {});
    this.onNotify = onNotify || (() => {});
    this.log = log || (() => {});

    this.online = false;
    this.index = new Map(); // id -> session summary
    this.states = new Map(); // id -> reducer state (cached messages)
    this.streams = new Map(); // id -> AbortController
    this.wanted = new Set(); // ids the app is watching + running sessions
    this.timer = null;
    this.lastError = "";
    this.notifyAt = new Map();
    this.pollPromise = null;
    this.avatarManifest = null;
    this.avatarManifestAt = 0;
    this.avatarCache = new Map(); // 相对路径 -> { mimeType, data }
    this.previewCache = new Map(); // id -> { role, text, status, at }
    this.previewPending = new Set();
  }

  start() {
    if (this.timer) return;
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

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ctrl of this.streams.values()) {
      try { ctrl.abort(); } catch { /* ignore */ }
    }
    this.streams.clear();
  }

  setOffline(error) {
    const was = this.online;
    this.online = false;
    this.lastError = error instanceof Error ? error.message : String(error || "");
    if (was) {
      this.log(`pi-web 离线：${this.lastError}`);
      this.onSessions(this.view());
      for (const ctrl of this.streams.values()) {
        try { ctrl.abort(); } catch { /* ignore */ }
      }
      this.streams.clear();
    }
  }

  async httpJson(method, pathname, body, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 会话预览（列表里的「最后一条消息」）：
   *  - 打开过的会话直接用内存态的最后一条；
   *  - 没打开过的读 5 分钟内的预览缓存，没有就排队补（后台拉一次 history 尾巴）。
   * 之前只认内存态，导致未打开的会话 lastText 全空，App 列表看起来「没同步」。
   */
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
      const { status, json } = await this.httpJson("GET", `/api/sessions/${encodeURIComponent(id)}/history?maxMessages=3`, undefined, 12_000);
      if (status === 200 && json && Array.isArray(json.events)) {
        const state = reduceFrames(id, json.events);
        for (let i = state.messages.length - 1; i >= 0; i -= 1) {
          const m = state.messages[i];
          const text = String(m.text || "").trim();
          if (!text) continue;
          this.previewCache.set(id, { role: m.role || "", text: text.slice(0, 120), status: m.status || "", at: Date.now() });
          this.onSessions(this.view());
          break;
        }
      }
    } catch {
      // 预览只是列表装饰，失败就当没有
    } finally {
      this.previewPending.delete(id);
    }
  }

  /** 会话列表视图（给 App 的精简结构）。 */
  view() {
    const items = [...this.index.values()].map((s) => {
      const state = this.states.get(s.id);
      const preview = this.previewOf(s.id);
      return {
        agent: "pi",
        id: s.id,
        title: s.title || "新会话",
        cwd: s.cwd || "",
        updatedAt: s.updatedAt || 0,
        running: Boolean(s.running),
        status: (state && state.meta.status) || (s.running ? "processing" : "idle"),
        turn: s.turn || (state ? state.meta.turn : 0) || s.messageCount || 0,
        model: (state && state.meta.model) || null,
        turnStartedAt: (state && state.meta.turnStartedAt) || 0,
        queue: (state && state.meta.queue ? state.meta.queue.length : 0) || 0,
        lastRole: preview ? preview.role : "",
        lastText: preview ? preview.text : "",
        lastStatus: preview ? preview.status : "",
        online: this.online,
      };
    });
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return items;
  }

  async poll() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.pollOnce().finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  async pollOnce() {
    const { status, json } = await this.httpJson("GET", "/api/sessions");
    if (status !== 200 || !json || !Array.isArray(json.sessions)) {
      throw new Error(`pi-web /api/sessions → ${status}`);
    }
    const firstOnline = !this.online;
    this.online = true;
    this.lastError = "";
    const next = new Map();
    let changed = firstOnline;
    for (const s of json.sessions) {
      const id = String(s.id);
      const before = this.index.get(id);
      next.set(id, s);
      const state = this.states.get(id);
      if (state) {
        state.meta.title = s.title || state.meta.title;
        state.meta.cwd = s.cwd || state.meta.cwd;
        state.meta.updatedAt = s.updatedAt || state.meta.updatedAt;
        state.meta.turn = s.turn || state.meta.turn;
        state.meta.online = true;
        if (state.meta.running !== Boolean(s.running)) {
          state.meta.running = Boolean(s.running);
          state.meta.status = s.running ? "processing" : "idle";
          if (!s.running) state.meta.turnStartedAt = 0;
          this.onPatch(id, [{ t: "session", session: { ...state.meta } }]);
        }
      }
      if (!before || before.title !== s.title || before.updatedAt !== s.updatedAt || Boolean(before.running) !== Boolean(s.running)) {
        changed = true;
      }
      if (s.running && !this.streams.has(id)) this.watch(id);
      if (!s.running && this.streams.has(id) && !this.wanted.has(id)) this.unwatch(id);
      if (!s.running && before && before.running) this.announceSettled(id);
    }
    for (const id of this.index.keys()) {
      if (!next.has(id)) changed = true;
    }
    this.index = next;
    if (changed) this.onSessions(this.view());
  }

  /** 任务收尾通知（完成/失败），带冷却，避免轮询抖动重复播报。 */
  announceSettled(id) {
    const now = Date.now();
    if (now - (this.notifyAt.get(id) || 0) < NOTIFY_COOLDOWN_MS) return;
    this.notifyAt.set(id, now);
    const state = this.states.get(id);
    const summary = this.index.get(id);
    const title = (summary && summary.title) || (state && state.meta.title) || "pi 会话";
    const last = state && state.messages.length ? state.messages[state.messages.length - 1] : null;
    if (last && last.role === "agent" && last.status === "error") {
      this.onNotify({
        kind: "error",
        sessionId: id,
        title: "pi 任务失败 ✗",
        body: `${title}：${String(last.error || "运行出错").slice(0, 120)}`,
      });
      return;
    }
    const text = last && last.role === "agent" && last.text ? last.text.replace(/\s+/g, " ").slice(0, 80) : "";
    this.onNotify({
      kind: "done",
      sessionId: id,
      title: "pi 任务完成 ✓",
      body: text ? `${title}：${text}` : title,
    });
  }

  /** 打开会话：回放历史 + 开始实时订阅。 */
  async open(id) {
    this.wanted.add(String(id));
    const { status, json } = await this.httpJson("GET", `/api/sessions/${encodeURIComponent(id)}/history`);
    if (status !== 200 || !json || !Array.isArray(json.events)) {
      throw new Error(`history ${id} → ${status}`);
    }
    const state = reduceFrames(id, json.events);
    state.meta.id = String(id);
    state.meta.agent = "pi";
    // SSE 订阅会重放一遍缓冲帧：记下回放水位，避免同一事件被归约两次（消息翻倍）
    state.seq = (json.events || []).reduce((max, frame) => Math.max(max, Number(frame && frame.seq) || 0), 0);
    const summary = this.index.get(String(id));
    state.meta.title = (json.session && json.session.title) || (summary && summary.title) || "";
    state.meta.cwd = (json.session && json.session.cwd) || (summary && summary.cwd) || "";
    state.meta.running = Boolean(json.session && json.session.running);
    state.meta.status = state.meta.running ? "processing" : "idle";
    state.meta.turnStartedAt = (json.session && json.session.turnStartedAt) || 0;
    state.meta.turn = (json.session && json.session.turn) || state.meta.turn;
    state.meta.model = (json.session && json.session.model) || null;
    state.meta.thinkingLevel = (json.session && json.session.thinkingLevel) || null;
    state.meta.queue = (json.session && json.session.promptQueue) || [];
    state.meta.updatedAt = (summary && summary.updatedAt) || 0;
    state.meta.online = this.online;
    this.states.set(String(id), state);
    this.watch(id);
    return { session: { ...state.meta }, messages: state.messages.slice(), truncated: Boolean(state.truncated) };
  }

  close(id) {
    this.wanted.delete(String(id));
    if (this.timer && !this.streams.has(String(id))) return;
    const stillRunning = this.index.get(String(id))?.running;
    if (!stillRunning) this.unwatch(id);
  }

  /** 订阅会话 SSE；先回放（丢弃，open 已拿全量）再接实时补丁。 */
  watch(id) {
    const sid = String(id);
    if (this.streams.has(sid)) return;
    const ctrl = new AbortController();
    this.streams.set(sid, ctrl);
    const run = async () => {
      const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sid)}/stream`, {
        headers: { accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${sid} → ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of raw.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            let frame = null;
            try { frame = JSON.parse(line.slice(6)); } catch { continue; }
            this.handleFrame(sid, frame);
          }
        }
      }
    };
    run()
      .catch((error) => {
        if (!ctrl.signal.aborted) this.log(`stream ${sid} 中断：${error.message}`);
      })
      .finally(() => {
        this.streams.delete(sid);
      });
  }

  unwatch(id) {
    const sid = String(id);
    const ctrl = this.streams.get(sid);
    if (ctrl) {
      try { ctrl.abort(); } catch { /* ignore */ }
      this.streams.delete(sid);
    }
  }

  handleFrame(id, frame) {
    const ev = frame && frame.event ? frame.event : frame;
    if (!ev) return;
    let state = this.states.get(id);
    if (!state) {
      state = createSessionState(id);
      this.states.set(id, state);
      const summary = this.index.get(id);
      state.meta.title = (summary && summary.title) || "";
      state.meta.cwd = (summary && summary.cwd) || "";
      state.meta.running = true;
      state.meta.online = true;
      state.seq = 0;
    }
    const seq = Number(frame && frame.seq) || 0;
    if (seq && seq <= (state.seq || 0)) return; // 已回放过的事件不重复归约
    if (seq) state.seq = seq;
    const patches = applyEvent(state, ev, Date.now());
    if (patches.length) this.onPatch(id, patches);
  }

  // ── 操作透传 ─────────────────────────────────────────────────────

  async list() {
    await this.poll();
    return this.view();
  }

  /** 发送：空闲→prompt；任务中→enqueue（服务端排队，App 不必等）。images: [{mimeType,data}] */
  async send(id, text, images) {
    const body = String(text ?? "").trim();
    const pics = Array.isArray(images)
      ? images
          .filter((im) => im && typeof im.data === "string" && typeof im.mimeType === "string" && im.mimeType.startsWith("image/"))
          .slice(0, 8)
          .map((im) => ({ type: "image", data: String(im.data), mimeType: String(im.mimeType) }))
      : [];
    if (!body && !pics.length) return { ok: false, error: "消息为空" };
    const payload = { text: body, ...(pics.length ? { images: pics } : {}) };
    const first = await this.httpJson("POST", `/api/sessions/${encodeURIComponent(id)}/prompt`, payload, 30000);
    if ((first.status === 200 || first.status === 201) && first.json && first.json.ok !== false) {
      const state = this.states.get(String(id));
      if (state) {
        state.meta.running = true;
        state.meta.turnStartedAt = state.meta.turnStartedAt || Date.now();
        if (state.meta.status === "idle") state.meta.status = "requesting";
        this.onPatch(String(id), [{ t: "session", session: { ...state.meta } }]);
      }
      this.watch(id);
      return { ok: true, mode: "prompt" };
    }
    if (first.status === 409 || (first.json && first.json.status === 409)) {
      const second = await this.httpJson("POST", `/api/sessions/${encodeURIComponent(id)}/enqueue`, payload, 30000);
      if (second.json && second.json.ok !== false) return { ok: true, mode: "queued" };
      return { ok: false, error: (second.json && second.json.error) || `enqueue → ${second.status}` };
    }
    return { ok: false, error: (first.json && first.json.error) || `prompt → ${first.status}` };
  }

  async stop(id) {
    const { status, json } = await this.httpJson("POST", `/api/sessions/${encodeURIComponent(id)}/stop`, {}, 15000);
    return { ok: status === 200, error: status === 200 ? undefined : (json && json.error) || `stop → ${status}` };
  }

  async create(cwd) {
    const { status, json } = await this.httpJson("POST", "/api/sessions", cwd ? { cwd } : {}, 30000);
    if (status !== 200 || !json || !json.id) {
      return { ok: false, error: (json && json.error) || `create → ${status}` };
    }
    await this.poll();
    return { ok: true, id: String(json.id) };
  }

  async remove(id) {
    const { status, json } = await this.httpJson("DELETE", `/api/sessions/${encodeURIComponent(id)}`, undefined, 15000);
    this.states.delete(String(id));
    this.index.delete(String(id));
    this.unwatch(id);
    if (status === 200) {
      this.onSessions(this.view());
      return { ok: true };
    }
    return { ok: false, error: (json && json.error) || `delete → ${status}` };
  }

  async rename(id, title) {
    const { status, json } = await this.httpJson("POST", `/api/sessions/${encodeURIComponent(id)}/rename`, { title }, 15000);
    if (status === 200) {
      await this.poll();
      return { ok: true };
    }
    return { ok: false, error: (json && json.error) || `rename → ${status}` };
  }

  async setModel(id, provider, modelId) {
    const { status, json } = await this.httpJson("POST", `/api/sessions/${encodeURIComponent(id)}/model`, { provider, modelId }, 20000);
    if (status === 200) return { ok: true };
    return { ok: false, error: (json && json.error) || `model → ${status}` };
  }

  async setThinking(id, level) {
    const { status, json } = await this.httpJson("POST", `/api/sessions/${encodeURIComponent(id)}/thinking`, { level }, 20000);
    if (status === 200) return { ok: true };
    return { ok: false, error: (json && json.error) || `thinking → ${status}` };
  }

  async models() {
    const { status, json } = await this.httpJson("GET", "/api/models", undefined, 20000);
    if (status !== 200) return { ok: false, error: `models → ${status}` };
    return { ok: true, groups: json.groups || [], levels: json.levels || [] };
  }

  async workspaces() {
    const { status, json } = await this.httpJson("GET", "/api/workspaces", undefined, 10000);
    if (status !== 200) return { ok: false, error: `workspaces → ${status}` };
    return { ok: true, workspaces: json.workspaces || [] };
  }

  async subagents(id) {
    const { status, json } = await this.httpJson("GET", `/api/sessions/${encodeURIComponent(id)}/subagents`, undefined, 10000);
    if (status !== 200) return { ok: false, error: `subagents → ${status}` };
    return { ok: true, data: json };
  }

  async stopSubagent(id, runId) {
    const { status, json } = await this.httpJson(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/subagents/${encodeURIComponent(runId)}/stop`,
      {},
      15000,
    );
    if (status === 200) return { ok: true };
    return { ok: false, error: (json && json.error) || `stop subagent → ${status}` };
  }

  /** 子代理的对话转录：pi-web 会把子会话（或异步 run 的 transcript）回放成同一套事件。 */
  async transcript(parentId, runId) {
    const { status, json } = await this.httpJson(
      "GET",
      `/api/sessions/${encodeURIComponent(parentId)}/subagents/${encodeURIComponent(runId)}/transcript`,
      undefined,
      30000,
    );
    if (status !== 200 || !json || !Array.isArray(json.events)) return null;
    const childId = String(json.sessionId || runId);
    const state = reduceFrames(childId, json.events);
    return {
      agent: "pi",
      name: String(json.agent || json.name || ""),
      sessionId: childId,
      messages: state.messages.slice(0, 500),
    };
  }

  /**
   * 会话的角色头像（像素画）：
   *  - 普通会话按 sessionId 在 manifest.main 里取（与 pi-web 前端同算法）
   *  - 子代理/角色名先在 manifest.roles 里查固定角色，再退回 agents 池
   * 返回 { mimeType, data(base64), path }；素材缺失就返回 null，手机端回落字母头像。
   */
  async avatar(id, role) {
    const manifest = this.loadAvatarManifest();
    if (!manifest) return null;
    let frames = null;
    if (role) {
      const fixed = manifest.roles && manifest.roles[role];
      if (Array.isArray(fixed) && fixed.length) frames = fixed;
      else if (Array.isArray(manifest.agents) && manifest.agents.length) {
        frames = manifest.agents[strHash(role) % manifest.agents.length];
      }
    } else if (Array.isArray(manifest.main) && manifest.main.length) {
      frames = manifest.main[strHash(id || "pi") % manifest.main.length];
    }
    if (!Array.isArray(frames) || !frames.length) return null;
    const rel = String(frames[0]);
    if (this.avatarCache.has(rel)) return this.avatarCache.get(rel);
    try {
      const res = await fetch(`${this.baseUrl}/avatars/${rel}`);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const out = { mimeType: "image/png", data: buf.toString("base64"), path: rel };
      if (this.avatarCache.size > 96) this.avatarCache.clear();
      this.avatarCache.set(rel, out);
      return out;
    } catch {
      return null;
    }
  }

  loadAvatarManifest() {
    try {
      const file = path.join(PI_PUBLIC, "avatars", "manifest.json");
      const stat = fs.statSync(file);
      if (this.avatarManifest && this.avatarManifestAt === stat.mtimeMs) return this.avatarManifest;
      this.avatarManifest = JSON.parse(fs.readFileSync(file, "utf8"));
      this.avatarManifestAt = stat.mtimeMs;
      return this.avatarManifest;
    } catch {
      return null;
    }
  }

  /**
   * 读取工作区文件（图片）：pi-web /api/file 只允许同站来源，桥是回环直连所以自带资格。
   * 相对路径按会话 cwd 解析（agent 输出里常见 ![img](artwork/x.png) 这种写法）。
   */
  async file(sessionId, rawPath) {
    const state = this.states.get(String(sessionId));
    const summary = this.index.get(String(sessionId));
    const cwd = (state && state.meta.cwd) || (summary && summary.cwd) || "";
    let target = String(rawPath || "").trim();
    if (!target) return { ok: false, error: "路径为空" };
    target = target.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, "");
    if (!/^[a-zA-Z]:[\\/]|^\//.test(target)) {
      if (!cwd) return { ok: false, error: "会话工作区未知" };
      target = `${cwd.replace(/[\\/]+$/, "")}/${target.replace(/^\.\//, "")}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${this.baseUrl}/api/file?path=${encodeURIComponent(target)}`, { signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: `文件不可读（HTTP ${res.status}）` };
      const type = String(res.headers.get("content-type") || "");
      if (!type.startsWith("image/")) return { ok: false, error: `不是图片：${type || "未知类型"}` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 6 * 1024 * 1024) return { ok: false, error: "图片超过 6MB，手机端不加载" };
      return { ok: true, mimeType: type.split(";")[0], data: buf.toString("base64"), path: target, bytes: buf.length };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { PiSource };
