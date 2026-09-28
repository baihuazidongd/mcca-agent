"use strict";

// Codex driver for the mini page: one resident `codex app-server` child, JSON-RPC 2.0
// over stdio (one object per line). Exposes the same method surface GrokBridge does so
// mini-web/server.cjs can serve either tool without branching.
//
// Verified against codex-cli 0.155.0-alpha.16:
//   initialize -> thread/start {cwd,model,modelProvider,approvalPolicy,sandbox}
//             -> turn/start {threadId,input:[{type:"text",text}]}
//   streaming: item/agentMessage/delta, item/reasoning/summaryTextDelta,
//              item/commandExecution/outputDelta, item/started, item/completed,
//              turn/started, turn/completed, thread/tokenUsage/updated
// The global `-m` flag is ignored by app-server threads: the model only sticks when it
// is passed in thread/start.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const piProviders = require("../pi-web/pi-providers.cjs");

const NOISE = new Set([
  "configWarning",
  "warning",
  "remoteControl/status/changed",
  "account/rateLimits/updated",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "thread/started",
  "thread/status/changed",
]);

function redact(text) {
  return String(text ?? "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…");
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* first run */ }
  return fallback;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function findCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const bundled = path.join(require("../runtime-core/paths.cjs").createPaths().runtimes, "codex-web/current/codex.exe");
  if (fs.existsSync(bundled)) return bundled;
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
  if (!fs.existsSync(base)) return "";
  let newest = "";
  let mtime = 0;
  for (const name of fs.readdirSync(base)) {
    const exe = path.join(base, name, process.platform === "win32" ? "codex.exe" : "codex");
    try {
      const stat = fs.statSync(exe);
      if (stat.mtimeMs > mtime) { mtime = stat.mtimeMs; newest = exe; }
    } catch { /* not a version dir */ }
  }
  return newest;
}

/** Provider section without the key: the key travels in the child env, never in argv. */
function providerArgs(provider) {
  const overlay = piProviders.codexOverlay(provider);
  const spec = overlay && overlay.model_providers && overlay.model_providers[provider];
  if (!spec) return null;
  const keyName = `MCCA_CODEX_${crypto.createHash("sha256").update(String(provider)).digest("hex").slice(0, 10).toUpperCase()}`;
  const token = spec.experimental_bearer_token || "";
  const args = [];
  const push = (key, value) => {
    args.push("-c", `${key}=${typeof value === "boolean" || typeof value === "number" ? value : JSON.stringify(String(value))}`);
  };
  const root = `model_providers.${/^[A-Za-z0-9_-]+$/.test(provider) ? provider : JSON.stringify(provider)}`;
  for (const [key, value] of Object.entries(spec)) {
    if (key === "experimental_bearer_token") continue;
    if (value && typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (innerValue == null || typeof innerValue === "object") continue;
        push(`${root}.${key}.${inner}`, innerValue);
      }
      continue;
    }
    if (value == null) continue;
    push(`${root}.${key}`, value);
  }
  push(`${root}.env_key`, keyName);
  return { args, env: token ? { [keyName]: token } : {} };
}

class CodexBridge {
  constructor({ stateFile } = {}) {
    this.bootId = `codex-${Date.now().toString(36)}`;
    this.stateFile = stateFile || path.join(__dirname, "..", "..", "config", ".mini-web", "codex-state.json");
    this.child = null;
    this._state = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.logs = new Map();
    this.turns = new Map();
    this.usage = new Map();
    this.seq = new Map();
    this.dead = "";
    this.starting = null;
    this.serverProvider = "";
  }

  state() {
    if (!this._state) this._state = readJson(this.stateFile, { titles: {}, workspaces: [] });
    return this._state;
  }

  save(patch) {
    const data = { ...this.state(), ...patch };
    this._state = data;
    writeJson(this.stateFile, data);
  }

  // ── process ──────────────────────────────────────────────────────

  buildArgs(provider) {
    const found = provider ? providerArgs(provider) : null;
    const args = found ? ["-c", `model_provider=${JSON.stringify(provider)}`, ...found.args] : [];
    const mcp = require("../runtime-core/mcp-config.cjs").workbenchMcp();
    const toml = value => JSON.stringify(String(value));
    args.push("-c", `mcp_servers.mcca-workbench.command=${toml(mcp.command)}`);
    args.push("-c", `mcp_servers.mcca-workbench.args=[${mcp.args.map(toml).join(",")}]`);
    for (const [key, value] of Object.entries(mcp.env)) args.push("-c", `mcp_servers.mcca-workbench.env.${key}=${toml(value)}`);
    args.push("app-server");
    return { args, env: (found && found.env) || {} };
  }

  /** Start (or restart for another provider) the resident app-server. Resolves once initialized. */
  ensureServer(provider) {
    const want = String(provider || "");
    if (this.child && this.serverProvider === want) return this.ready();
    if (this.starting) return this.starting;
    this.starting = this.restart(want).finally(() => { this.starting = null; });
    return this.starting;
  }

  async restart(provider) {
    this.killChild();
    const bin = findCodexBin();
    if (!bin) throw new Error("找不到 codex 可执行文件");
    const spec = this.buildArgs(provider);
    const child = spawn(bin, spec.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.serverProvider = provider;
    this.buf = "";
    this.dead = "";
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const text = redact(chunk).trim();
      if (text) this.dead = (this.dead + " " + text).slice(-2000);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.serverProvider = "";
      for (const [, waiter] of this.pending) waiter.reject(new Error(redact(this.dead || `codex app-server 已退出 (${code})`)));
      this.pending.clear();
    });
    await this.request("initialize", { clientInfo: { name: "mcca-mini", title: "mcca mini web", version: "0.1.0" } }, 20000);
    this.save({ provider });
    return true;
  }

  ready() {
    return this.child ? Promise.resolve(true) : this.ensureServer(this.serverProvider);
  }

  killChild() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }

  onStdout(chunk) {
    this.buf += chunk.toString("utf8");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(redact(msg.error.message || "codex 请求失败")));
        else waiter.resolve(msg.result || {});
        continue;
      }
      if (msg.id != null && msg.method) { this.answer(msg); continue; }
      if (msg.method) this.onNotify(msg);
    }
  }

  /** With approvalPolicy=never these should not arrive; declining keeps a turn from hanging. */
  answer(msg) {
    const method = msg.method;
    if (/requestApproval|applyPatchApproval|execCommandApproval$/.test(method)) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: { decision: "accept" } });
      return;
    }
    if (method === "currentTime/read") {
      this.send({ jsonrpc: "2.0", id: msg.id, result: { currentTime: Math.floor(Date.now() / 1000) } });
      return;
    }
    this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
  }

  send(msg) {
    if (!this.child) return;
    try { this.child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* pipe closed */ }
  }

  request(method, params, timeoutMs = 30000) {
    if (!this.child) return Promise.reject(new Error("codex app-server 未启动"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs) : null;
      this.pending.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  // ── event log ────────────────────────────────────────────────────

  push(threadId, event) {
    if (!threadId) return;
    const rows = this.logs.get(threadId) || [];
    const nextSeq = (this.seq.get(threadId) || 0) + 1;
    this.seq.set(threadId, nextSeq);
    rows.push({ seq: nextSeq, id: `${this.bootId}:${threadId}:${nextSeq}`, event });
    if (rows.length > 4000) rows.splice(0, rows.length - 4000);
    this.logs.set(threadId, rows);
  }

  frames(threadId) {
    return this.logs.get(threadId) || [];
  }

  async events(threadId) {
    return this.frames(threadId);
  }

  onNotify(msg) {
    const method = msg.method;
    if (NOISE.has(method)) return;
    const params = msg.params || {};
    const threadId = params.threadId || (params.thread && params.thread.id) || "";
    const item = params.item || {};
    const at = Date.now();
    if (method === "turn/started") {
      this.turns.set(threadId, params.turn && params.turn.id ? params.turn.id : "");
      this.push(threadId, { type: "turn-start", at });
      this.push(threadId, { type: "assistant-start", at });
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn || {};
      this.turns.delete(threadId);
      if (turn.status === "failed" && turn.error) {
        this.push(threadId, { type: "assistant-end", at, text: "", error: redact(turn.error.message || JSON.stringify(turn.error)).slice(0, 600) });
      } else {
        this.push(threadId, { type: "assistant-end", at });
      }
      this.push(threadId, { type: "turn-end", at, stopReason: turn.status || "completed", usage: turn.durationMs ? { durationMs: turn.durationMs } : null });
      return;
    }
    if (method === "error") {
      const message = redact((params.error && params.error.message) || params.message || "").slice(0, 600);
      this.push(threadId, { type: "status", at, text: message, level: params.willRetry ? "retry" : "error" });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage || {};
      this.usage.set(threadId, {
        totalTokens: (usage.total && usage.total.totalTokens) || 0,
        contextWindow: usage.modelContextWindow || null,
      });
      this.push(threadId, { type: "usage", at, ...this.usage.get(threadId) });
      return;
    }
    if (method === "item/agentMessage/delta") {
      this.push(threadId, { type: "assistant-delta", at, text: String(params.delta || "") });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      this.push(threadId, { type: "thinking-delta", at, text: String(params.delta || "") });
      return;
    }
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
      this.push(threadId, { type: "tool", phase: "output", at, callId: params.itemId, name: "output", output: redact(params.delta).slice(0, 4000) });
      return;
    }
    if (method === "item/started") {
      this.pushItem(threadId, item, at, "start");
      return;
    }
    if (method === "item/completed") {
      this.pushItem(threadId, item, at, "end");
      return;
    }
  }

  pushItem(threadId, item, at, phase) {
    const type = String(item.type || "");
    if (type === "userMessage") {
      if (phase !== "end") return;
      const text = (item.content || []).map((row) => row.text || "").join("").trim();
      if (text) this.push(threadId, { type: "user", at, text, id: `u-${item.id || at}` });
      return;
    }
    if (type === "agentMessage") {
      // Deltas already streamed the text; only an error path needs the final copy.
      if (phase === "end" && item.text && !(this.frames(threadId).some((row) => row.event.type === "assistant-delta"))) {
        this.push(threadId, { type: "assistant-delta", at, text: String(item.text) });
      }
      return;
    }
    if (type === "reasoning") {
      if (phase === "end") this.push(threadId, { type: "thinking-end", at });
      return;
    }
    const name = type === "commandExecution" ? "shell"
      : type === "fileChange" ? "edit"
      : type === "mcpToolCall" ? String(item.tool || "mcp")
      : type === "webSearch" ? "search"
      : type === "plan" ? "plan"
      : type === "todoList" ? "todo"
      : type || "tool";
    const args = type === "commandExecution" ? redact(item.command || "")
      : type === "fileChange" ? (item.changes || []).map((row) => row.path || "").join(" ")
      : type === "mcpToolCall" ? redact(JSON.stringify(item.args || {}))
      : redact(typeof item.text === "string" ? item.text : JSON.stringify(item)).slice(0, 400);
    const output = type === "commandExecution" ? redact(item.aggregatedOutput || item.output || "") : "";
    this.push(threadId, {
      type: "tool",
      phase,
      at,
      name,
      callId: item.id,
      args: String(args).slice(0, 4000),
      output: String(output).slice(0, 4000),
      isError: /fail|declined|denied/i.test(String(item.status || "")) || Boolean(item.error),
    });
  }

  // ── page API (mirrors GrokBridge) ────────────────────────────────

  async runningSessions() {
    return (await this.list()).filter((row) => row.running);
  }

  titleOf(thread) {
    const saved = this.state().titles || {};
    if (saved[thread.id]) return saved[thread.id];
    const preview = String(thread.preview || thread.name || "").trim();
    if (preview) return preview.slice(0, 60);
    return "新会话";
  }

  async list() {
    await this.ensureServer(this.currentProvider());
    const result = await this.request("thread/list", { limit: 60 }).catch((error) => {
      console.error(`[mini-web] thread/list 失败: ${redact(error.message)}`);
      return {};
    });
    const rows = result.threads || result.data || result.items || result.threadsPage || [];
    const data = this.state();
    const titles = data.titles || {};
    const out = rows.filter((row) => row && row.id).map((row) => ({
      id: row.id,
      title: titles[row.id] || String(row.preview || "").trim().slice(0, 60) || "新会话",
      cwd: (row.environments && row.environments[0] && row.environments[0].cwd) || row.cwd || "",
      running: this.turns.has(row.id),
      updatedAt: (Number(row.recencyAt || row.updatedAt) || 0) * 1000 || Date.now(),
      model: { provider: row.modelProvider || this.currentProvider(), modelId: row.model || "" },
      thinkingLevel: row.reasoningEffort || null,
    }));
    // A thread with no turn yet never shows up in codex's own list, so the session the
    // page just created has to come from our state or the sidebar looks broken.
    const seen = new Set(out.map((row) => row.id));
    const cwds = data.cwds || {};
    const models = data.models || {};
    const stamps = data.stamps || {};
    for (const id of Object.keys(cwds)) {
      if (seen.has(id)) continue;
      const model = models[id] || {};
      out.push({
        id,
        title: titles[id] || "新会话",
        cwd: cwds[id] || "",
        running: this.turns.has(id),
        updatedAt: stamps[id] || Date.now(),
        model: { provider: model.provider || this.currentProvider(), modelId: model.modelId || "" },
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  currentProvider() {
    const data = this.state();
    return String(data.provider || "");
  }

  async create({ cwd, provider, modelId, title } = {}) {
    const want = String(provider || this.currentProvider() || "");
    if (!want) throw new Error("先选一个服务商");
    await this.ensureServer(want);
    const dir = path.resolve(String(cwd || process.cwd()));
    const created = await this.request("thread/start", {
      cwd: dir,
      model: String(modelId || ""),
      modelProvider: want,
      approvalPolicy: "never",
      sandbox: process.env.MCCA_CODEX_SANDBOX || "workspace-write",
    }, 60000);
    const thread = created.thread || {};
    if (!thread.id) throw new Error("codex 没有返回会话 id");
    this.logs.set(thread.id, []);
    this.seq.set(thread.id, 0);
    this.rememberMeta(thread.id, dir, want, String(modelId || ""));
    if (title) this.rename(thread.id, title);
    return { ok: true, id: thread.id };
  }

  async prompt(id, text) {
    const body = String(text || "").trim();
    if (!body) return { ok: false, status: 400, error: "空消息" };
    await this.ensureServer(this.currentProvider());
    if (this.turns.has(id)) return { ok: false, status: 409, error: "任务进行中" };
    const model = this.state().models && this.state().models[id];
    const data = this.state();
    this.save({ stamps: { ...(data.stamps || {}), [id]: Date.now() } });
    this.turns.set(id, "pending");
    this.request("turn/start", {
      threadId: id,
      input: [{ type: "text", text: body }],
      ...(model && model.model ? { model: model.model } : {}),
    }, 0).catch((error) => {
      this.turns.delete(id);
      this.push(id, { type: "assistant-end", at: Date.now(), text: "", error: redact(error.message).slice(0, 600) });
      this.push(id, { type: "turn-end", at: Date.now(), stopReason: "failed" });
    });
    return { ok: true, sessionId: id };
  }

  async stop(id) {
    const turnId = this.turns.get(id);
    if (!turnId || turnId === "pending") {
      this.turns.delete(id);
      return { ok: true, stopped: false };
    }
    try {
      await this.request("turn/interrupt", { threadId: id, turnId }, 10000);
      this.turns.delete(id);
      return { ok: true, stopped: true };
    } catch (error) {
      return { ok: false, error: redact(error.message) };
    }
  }

  async resume(id) {
    await this.ensureServer(this.currentProvider());
    const result = await this.request("thread/resume", { threadId: id }, 60000).catch(() => null);
    return result;
  }

  /** Rebuild the transcript from codex's own stored turns (server restarted). */
  async loadHistory(id) {
    const result = await this.resume(id);
    if (!result) return [];
    const turns = result.turns || (result.thread && result.thread.turns) || [];
    const at = Date.now();
    this.logs.set(id, []);
    this.seq.set(id, 0);
    for (const turn of turns) {
      for (const item of turn.items || []) this.pushItem(id, item, at, "end");
    }
    return this.frames(id);
  }

  async history(id) {
    if (this.frames(id).length) return { session: await this.rowFor(id), events: this.frames(id) };
    const events = await this.loadHistory(id).catch(() => []);
    return { session: await this.rowFor(id), events };
  }

  async rowFor(id) {
    const titles = this.state().titles || {};
    const model = (this.state().models || {})[id] || {};
    return {
      id,
      title: titles[id] || "会话",
      cwd: (this.state().cwds || {})[id] || "",
      running: this.turns.has(id),
      updatedAt: Date.now(),
      model: { provider: model.provider || this.currentProvider(), modelId: model.modelId || "" },
    };
  }

  rememberMeta(id, cwd, provider, modelId) {
    const data = this.state();
    this.save({
      cwds: { ...(data.cwds || {}), [id]: String(cwd || "") },
      models: { ...(data.models || {}), [id]: { provider, modelId, model: modelId } },
      stamps: { ...(data.stamps || {}), [id]: Date.now() },
    });
  }

  rename(id, title) {
    const name = String(title || "").trim().slice(0, 80);
    this.save({ titles: { ...(this.state().titles || {}), [id]: name || "新会话" } });
    return { ok: true, title: name || "新会话" };
  }

  async remove(id) {
    await this.ensureServer(this.currentProvider());
    const done = await this.request("thread/archive", { threadId: id }, 15000).catch(() => null);
    this.logs.delete(id);
    this.turns.delete(id);
    const data = this.state();
    const titles = { ...(data.titles || {}) };
    const models = { ...(data.models || {}) };
    const cwds = { ...(data.cwds || {}) };
    delete titles[id];
    delete models[id];
    delete cwds[id];
    this.save({ titles, models, cwds });
    return { ok: Boolean(done) };
  }

  async setModel(id, provider, modelId) {
    const data = this.state();
    this.save({
      models: { ...(data.models || {}), [id]: { provider, modelId, model: modelId } },
      provider,
    });
    return { ok: true, provider, modelId };
  }

  workspaces() {
    const saved = this.state().workspaces || [];
    const rows = [];
    const seen = new Set();
    for (const row of saved) {
      const target = path.resolve(String(row.path || ""));
      const key = target.toLowerCase();
      if (!target || seen.has(key)) continue;
      seen.add(key);
      rows.push({ path: target, title: row.title || path.basename(target), default: rows.length === 0 });
    }
    return rows;
  }

  addWorkspace(dir, title) {
    const target = path.resolve(String(dir || ""));
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { ok: false, status: 400, error: "目录不存在" };
    const rows = Array.isArray(this.state().workspaces) ? this.state().workspaces : [];
    if (!rows.some((row) => String(row.path).toLowerCase() === target.toLowerCase())) {
      this.save({ workspaces: [...rows, { path: target, title: title || path.basename(target) }] });
    }
    return { ok: true };
  }

  removeWorkspace(dir) {
    const key = String(dir || "").toLowerCase();
    this.save({ workspaces: (this.state().workspaces || []).filter((row) => String(row.path).toLowerCase() !== key) });
    return { ok: true };
  }

  stopAll() {
    this.killChild();
  }
}

module.exports = { CodexBridge, findCodexBin, providerArgs };
