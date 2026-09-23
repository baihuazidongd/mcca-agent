"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const piProviders = require("../pi-web/pi-providers.cjs");

const STATE_FILE = process.env.MCCA_GROK_STATE
  || path.join(__dirname, "..", "..", "config", ".grok-web", "state.json");

function grokHome() {
  return process.env.GROK_HOME || path.join(process.env.USERPROFILE || os.homedir(), ".grok");
}

function findGrokBin() {
  if (process.env.GROK_BIN && fs.existsSync(process.env.GROK_BIN)) return process.env.GROK_BIN;
  const exe = path.join(grokHome(), "bin", process.platform === "win32" ? "grok.exe" : "grok");
  return fs.existsSync(exe) ? exe : "grok";
}

function redact(text) {
  return String(text || "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…");
}

function readState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (data && typeof data === "object") return data;
  } catch { /* first run */ }
  return { models: {}, titles: {}, workspaces: [] };
}

function writeState(data) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, STATE_FILE);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

function asMs(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : Date.now();
}

/** Collapse a Grok updates.jsonl into pi-web events. `line` is stable across rereads. */
function mapUpdates(lines) {
  const events = [];
  let user = null;
  let assistantLine = 0;
  let thought = false;
  const flushUser = () => {
    if (!user) return;
    const text = user.text.replace(/\u0000/g, "").trim();
    if (text) events.push({ line: user.line, event: { type: "user", at: user.at, text, id: `u-${user.line}` } });
    user = null;
  };
  const closeAssistant = (at, line) => {
    if (!assistantLine) return;
    if (thought) {
      events.push({ line, event: { type: "thinking-end", at } });
      thought = false;
    }
    events.push({ line, event: { type: "assistant-end", at } });
    assistantLine = 0;
  };
  lines.forEach((line, index) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    const update = row && row.params && row.params.update;
    if (!update || !update.sessionUpdate) return;
    const at = asMs(row.timestamp);
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk") {
      closeAssistant(at, index);
      const text = contentText(update.content);
      if (!user) user = { line: index, at, text };
      else user.text += text;
      return;
    }
    if (kind === "agent_thought_chunk" || kind === "agent_message_chunk" || kind === "tool_call" || kind === "tool_call_update") {
      flushUser();
    }
    if ((kind === "agent_thought_chunk" || kind === "agent_message_chunk") && !assistantLine) {
      assistantLine = index;
      events.push({ line: index, event: { type: "turn-start", at } });
      events.push({ line: index, event: { type: "assistant-start", at } });
    }
    if (kind === "agent_thought_chunk") {
      thought = true;
      const text = contentText(update.content);
      if (text) events.push({ line: index, event: { type: "thinking-delta", at, text } });
      return;
    }
    if (kind === "agent_message_chunk") {
      if (thought) {
        events.push({ line: index, event: { type: "thinking-end", at } });
        thought = false;
      }
      const text = contentText(update.content);
      if (text) events.push({ line: index, event: { type: "assistant-delta", at, text } });
      return;
    }
    if (kind === "tool_call") {
      events.push({
        line: index,
        event: {
          type: "tool",
          phase: "start",
          at,
          name: update.title || update.kind || "tool",
          callId: update.toolCallId || `tool-${index}`,
          args: redact(typeof update.rawInput === "string" ? update.rawInput : JSON.stringify(update.rawInput || "")).slice(0, 4000),
        },
      });
      return;
    }
    if (kind === "tool_call_update") {
      const output = redact(contentText(update.content) || update.title || "");
      if (!output && !update.status) return;
      events.push({
        line: index,
        event: {
          type: "tool",
          phase: "end",
          at,
          name: update.title || update.kind || "tool",
          callId: update.toolCallId || `tool-${index}`,
          isError: /fail|error/i.test(String(update.status || "")),
          output: output.slice(0, 4000),
        },
      });
      return;
    }
    if (kind === "turn_completed") {
      flushUser();
      closeAssistant(at, index);
      events.push({ line: index, event: { type: "turn-end", at, stopReason: update.stop_reason || "" } });
    }
  });
  flushUser();
  return events;
}

function modelSlug(provider, modelId) {
  const tag = crypto.createHash("sha256").update(String(provider)).digest("hex").slice(0, 8);
  const raw = `${modelId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `mcca-${tag}-${raw || "model"}`;
}

function envName(provider) {
  return `MCCA_PI_${crypto.createHash("sha256").update(String(provider)).digest("hex").slice(0, 12)}`;
}

function readPiStore() {
  const file = process.env.MCCA_PI_MODELS
    || path.join(process.env.USERPROFILE || os.homedir(), ".pi", "agent", "models.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (parsed && parsed.providers) return parsed.providers;
  } catch { /* no pi models */ }
  return {};
}

/** Register one pi model in grok config by env var name. The key stays in the child env, not in the file. */
function ensurePiModel(provider, modelId) {
  const providers = readPiStore();
  const env = {};
  for (const [name, entry] of Object.entries(providers)) {
    if (entry && typeof entry.apiKey === "string" && entry.apiKey) env[envName(name)] = entry.apiKey;
  }
  if (!provider || provider === "grok") return env;
  const entry = providers[provider];
  if (!entry || !entry.baseUrl) return env;
  const model = (entry.models || []).find((item) => item && item.id === modelId) || { id: modelId };
  const slug = modelSlug(provider, model.id || modelId);
  const configPath = path.join(grokHome(), "config.toml");
  let text = "";
  try { text = fs.readFileSync(configPath, "utf8"); } catch { text = ""; }
  if (text.includes(`[model."${slug}"]`)) return env;
  const backend = entry.api === "openai-completions" ? "chat_completions" : "responses";
  const window = Number(model.contextWindow) > 0 ? Number(model.contextWindow) : 0;
  const lines = [
    "",
    `[model."${slug}"]`,
    `model = ${JSON.stringify(String(model.id || modelId))}`,
    `base_url = ${JSON.stringify(String(entry.baseUrl).replace(/\/+$/, ""))}`,
    `name = ${JSON.stringify(`${provider} / ${model.name || model.id || modelId}`)}`,
    `env_key = ${JSON.stringify(envName(provider))}`,
    `api_backend = ${JSON.stringify(backend)}`,
  ];
  if (window) lines.push(`context_window = ${window}`);
  fs.appendFileSync(configPath, `${lines.join("\n")}\n`);
  return env;
}

function configuredDefault() {
  try {
    const text = fs.readFileSync(path.join(grokHome(), "config.toml"), "utf8");
    const match = text.match(/^\s*default\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  } catch { /* use the built-in coding model */ }
  return "grok-build";
}

function alwaysApprove() {
  try {
    const text = fs.readFileSync(path.join(grokHome(), "config.toml"), "utf8");
    return /permission_mode\s*=\s*"always-approve"/.test(text) || /\byolo\s*=\s*true/.test(text);
  } catch {
    return false;
  }
}

class GrokBridge {
  constructor() {
    this.bootId = `grok-${Date.now().toString(36)}`;
    this.procs = new Map();
    this.queue = new Map();
    this.queueRev = new Map();
  }

  cliModel(provider, modelId) {
    if (!provider || provider === "grok") return modelId || "grok-build";
    return modelSlug(provider, modelId);
  }

  remembered(id) {
    const row = readState().models[id];
    if (row && row.provider && row.modelId) return { provider: row.provider, modelId: row.modelId };
    return null;
  }

  remember(id, provider, modelId) {
    if (!provider || !modelId) return;
    const data = readState();
    data.models[id] = { provider, modelId };
    writeState(data);
  }

  walkSessions() {
    const root = path.join(grokHome(), "sessions");
    const rows = [];
    const visit = (dir) => {
      let names;
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isDirectory()) continue;
        const summaryPath = path.join(full, "summary.json");
        if (!fs.existsSync(summaryPath)) {
          visit(full);
          continue;
        }
        try {
          const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
          const info = summary.info || {};
          if (!info.id) continue;
          rows.push({ dir: full, summary, updatedAt: asMs(summary.updated_at || summary.created_at) });
        } catch { /* skip a bad summary */ }
      }
    };
    visit(root);
    return rows;
  }

  sessionDir(id) {
    const hit = this.walkSessions().find((row) => row.summary.info.id === id);
    return hit ? hit.dir : "";
  }

  readUpdateLines(id) {
    const dir = this.sessionDir(id);
    if (!dir) return [];
    try {
      return fs.readFileSync(path.join(dir, "updates.jsonl"), "utf8").split(/\n/).filter(Boolean);
    } catch {
      return [];
    }
  }

  titleOf(row) {
    const id = row.summary.info.id;
    const saved = readState().titles[id];
    if (saved) return saved;
    if (row.summary.session_summary) return String(row.summary.session_summary).slice(0, 80);
    const lines = (() => {
      try { return fs.readFileSync(path.join(row.dir, "updates.jsonl"), "utf8").split(/\n/).filter(Boolean).slice(0, 40); }
      catch { return []; }
    })();
    for (const mapped of mapUpdates(lines)) {
      if (mapped.event.type === "user" && mapped.event.text) return mapped.event.text.replace(/\s+/g, " ").trim().slice(0, 80);
    }
    return "新会话";
  }

  summaryOf(row) {
    const id = row.summary.info.id;
    const proc = this.procs.get(id);
    const model = this.remembered(id) || {
      provider: "grok",
      modelId: row.summary.current_model_id || "grok-build",
    };
    return {
      id,
      title: this.titleOf(row),
      cwd: row.summary.info.cwd || "",
      running: Boolean(proc && proc.running),
      updatedAt: row.updatedAt,
      model,
      thinkingLevel: null,
    };
  }

  async list() {
    return this.walkSessions()
      .map((row) => this.summaryOf(row))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async runningSessions() {
    return (await this.list()).filter((row) => row.running);
  }

  frames(id) {
    const mapped = mapUpdates(this.readUpdateLines(id));
    return mapped.map((item) => ({
      seq: item.line + 1,
      id: `${this.bootId}:${id}:${item.line}`,
      event: item.event,
    }));
  }

  queueView(id) {
    return (this.queue.get(id) || []).map((item) => ({ id: item.id, text: item.text }));
  }

  pushQueue(proc, id) {
    if (!proc) return;
    proc.extra.push({
      id: `${this.bootId}:${id}:queue:${this.queueRev.get(id) || 0}`,
      event: { type: "prompt-queue", items: this.queueView(id) },
    });
  }

  spawn(model, cwd, extraEnv) {
    const bin = findGrokBin();
    const child = spawn(bin, ["agent", "-m", model, "stdio"], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const proc = {
      child,
      buf: "",
      pending: new Map(),
      nextId: 1,
      running: false,
      extra: [],
      stderr: "",
      model,
      cwd,
    };
    child.stdout.on("data", (chunk) => this.onStdout(proc, chunk));
    child.stderr.on("data", (chunk) => {
      proc.stderr = (proc.stderr + redact(chunk.toString("utf8"))).slice(-4000);
    });
    child.on("exit", (code) => {
      proc.running = false;
      const tail = proc.stderr.trim().split(/\n/).slice(-4).join(" ").trim();
      const why = redact(tail || `grok 已退出 (${code ?? "null"})`);
      for (const [, waiter] of proc.pending) waiter.reject(new Error(why));
      proc.pending.clear();
    });
    return proc;
  }

  onStdout(proc, chunk) {
    proc.buf += chunk.toString("utf8");
    let nl;
    while ((nl = proc.buf.indexOf("\n")) >= 0) {
      const line = proc.buf.slice(0, nl);
      proc.buf = proc.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method && msg.id != null && msg.result === undefined && !msg.error) {
        this.answer(proc, msg);
        continue;
      }
      if (msg.id != null && proc.pending.has(msg.id)) {
        const waiter = proc.pending.get(msg.id);
        proc.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(redact(msg.error.message || "grok 请求失败")));
        else waiter.resolve(msg.result || {});
      }
    }
  }

  answer(proc, msg) {
    if (msg.method === "session/request_permission" && alwaysApprove()) {
      const options = (msg.params && msg.params.options) || [];
      const allow = options.find((option) => /allow/i.test(`${option.kind || ""} ${option.optionId || ""}`)) || options[0];
      this.send(proc, {
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: allow ? allow.optionId : "allow" } },
      });
      return;
    }
    if (msg.method === "session/request_permission") {
      const options = (msg.params && msg.params.options) || [];
      const deny = options.find((option) => /reject|deny|cancel/i.test(`${option.kind || ""} ${option.optionId || ""}`));
      this.send(proc, {
        jsonrpc: "2.0",
        id: msg.id,
        result: deny
          ? { outcome: { outcome: "selected", optionId: deny.optionId } }
          : { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    this.send(proc, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } });
  }

  send(proc, msg) {
    proc.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(proc, method, params, timeoutMs = 30000) {
    const id = proc.nextId;
    proc.nextId += 1;
    const result = new Promise((resolve, reject) => {
      proc.pending.set(id, { resolve, reject });
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (!proc.pending.has(id)) return;
          proc.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }, timeoutMs);
      }
    });
    this.send(proc, { jsonrpc: "2.0", id, method, params });
    return result;
  }

  async openNew(cwd, provider, modelId) {
    const env = ensurePiModel(provider, modelId);
    const model = this.cliModel(provider, modelId);
    const proc = this.spawn(model, cwd, env);
    await this.request(proc, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await this.request(proc, "session/new", { cwd, mcpServers: [] });
    const id = created.sessionId;
    if (!id) {
      this.kill(proc);
      throw new Error("grok 没有返回会话 id");
    }
    this.procs.set(id, proc);
    this.remember(id, provider || "grok", modelId || "grok-build");
    return id;
  }

  async ensureLoaded(id) {
    const existing = this.procs.get(id);
    if (existing && existing.child.exitCode == null) return existing;
    const row = this.walkSessions().find((item) => item.summary.info.id === id);
    if (!row) throw new Error("找不到会话");
    const model = this.remembered(id) || { provider: "grok", modelId: row.summary.current_model_id || "grok-build" };
    const cwd = row.summary.info.cwd || process.cwd();
    const env = ensurePiModel(model.provider, model.modelId);
    const proc = this.spawn(this.cliModel(model.provider, model.modelId), cwd, env);
    this.procs.set(id, proc);
    await this.request(proc, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    await this.request(proc, "session/load", { sessionId: id, cwd, mcpServers: [] });
    return proc;
  }

  async create(body = {}) {
    const cwd = path.resolve(typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd());
    let provider = typeof body.provider === "string" ? body.provider : "";
    let modelId = typeof body.modelId === "string" ? body.modelId : "";
    if (!provider || !modelId) {
      provider = "grok";
      modelId = configuredDefault();
    }
    const id = await this.openNew(cwd, provider, modelId);
    return { ok: true, id };
  }

  async prompt(id, text) {
    const proc = await this.ensureLoaded(id);
    if (proc.running) return { ok: false, status: 409, error: "任务进行中" };
    const body = String(text || "").trim();
    if (!body) return { ok: false, status: 400, error: "空消息" };
    proc.running = true;
    this.request(proc, "session/prompt", {
      sessionId: id,
      prompt: [{ type: "text", text: body }],
    }, 0).then(() => {
      proc.running = false;
      this.drain(id);
    }).catch((error) => {
      proc.running = false;
      proc.extra.push({
        id: `${this.bootId}:${id}:err:${Date.now()}`,
        event: { type: "assistant-end", at: Date.now(), text: "", error: redact(error.message) },
      });
      proc.extra.push({ id: `${this.bootId}:${id}:end:${Date.now()}`, event: { type: "turn-end", at: Date.now() } });
    });
    return { ok: true, sessionId: id };
  }

  drain(id) {
    const queued = this.queue.get(id) || [];
    if (!queued.length) return;
    const next = queued.shift();
    this.queueRev.set(id, (this.queueRev.get(id) || 0) + 1);
    this.pushQueue(this.procs.get(id), id);
    void this.prompt(id, next.text);
  }

  enqueue(id, text) {
    const body = String(text || "").trim();
    if (!body) return { ok: false, status: 400, error: "空消息" };
    const queued = this.queue.get(id) || [];
    queued.push({ id: crypto.randomBytes(8).toString("hex"), text: body });
    this.queue.set(id, queued);
    this.queueRev.set(id, (this.queueRev.get(id) || 0) + 1);
    this.pushQueue(this.procs.get(id), id);
    return { ok: true };
  }

  removeQueued(id, queuedId) {
    const queued = (this.queue.get(id) || []).filter((item) => item.id !== queuedId);
    this.queue.set(id, queued);
    this.queueRev.set(id, (this.queueRev.get(id) || 0) + 1);
    this.pushQueue(this.procs.get(id), id);
    return { ok: true };
  }

  async jumpQueued(id, queuedId) {
    const queued = this.queue.get(id) || [];
    const hit = queued.find((item) => item.id === queuedId);
    if (!hit) return { ok: false, status: 404, error: "队列里没有这条" };
    this.queue.set(id, queued.filter((item) => item.id !== queuedId));
    await this.stop(id);
    return this.prompt(id, hit.text);
  }

  async stop(id) {
    const proc = this.procs.get(id);
    if (!proc || proc.child.exitCode != null) return { ok: true };
    try { await this.request(proc, "session/cancel", { sessionId: id }); } catch { /* already idle */ }
    proc.running = false;
    return { ok: true };
  }

  kill(proc) {
    const pid = proc && proc.child && proc.child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { proc.child.kill(); } catch { /* gone */ }
    }
  }

  async remove(id) {
    const proc = this.procs.get(id);
    if (proc) {
      this.kill(proc);
      this.procs.delete(id);
    }
    await new Promise((resolve) => {
      const child = spawn(findGrokBin(), ["sessions", "delete", id], { windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 8000);
      child.on("close", () => { clearTimeout(timer); resolve(); });
      child.on("error", () => { clearTimeout(timer); resolve(); });
    });
    const data = readState();
    delete data.models[id];
    delete data.titles[id];
    writeState(data);
    return { ok: true };
  }

  async setModel(id, provider, modelId) {
    if (!provider || !modelId) return { ok: false, status: 400, error: "缺少模型" };
    this.remember(id, provider, modelId);
    const proc = this.procs.get(id);
    if (proc && !proc.running) {
      this.kill(proc);
      this.procs.delete(id);
    }
    return { ok: true, sessionId: id };
  }

  rename(id, title) {
    const next = String(title || "").trim();
    if (!next) return { ok: false, error: "标题不能为空" };
    const data = readState();
    data.titles[id] = next.slice(0, 80);
    writeState(data);
    return { ok: true };
  }

  async history(id) {
    const row = this.walkSessions().find((item) => item.summary.info.id === id);
    if (!row) return { ok: false, status: 404, error: "找不到会话" };
    const proc = this.procs.get(id);
    return {
      session: {
        ...this.summaryOf(row),
        thinkingExplicit: false,
        promptQueue: this.queueView(id),
        turnStartedAt: proc && proc.running ? Date.now() : 0,
      },
      events: this.frames(id).concat((proc && proc.extra) || []),
      bootId: this.bootId,
    };
  }

  async events(id, since) {
    const proc = this.procs.get(id);
    const frames = this.frames(id).filter((frame) => frame.seq > since);
    const extra = ((proc && proc.extra) || []).filter((frame) => !frame.seq || frame.seq > since);
    const running = Boolean(proc && proc.running);
    extra.push({
      id: `${this.bootId}:${id}:status:${running ? "work" : "idle"}`,
      event: { type: "status", status: running ? "working" : "idle" },
    });
    return frames.concat(extra);
  }

  workspaces() {
    const saved = readState().workspaces || [];
    const seen = new Set();
    const rows = [];
    const push = (dir, title, isDefault) => {
      const target = path.resolve(String(dir || ""));
      const key = target.replace(/[\\/]+$/, "").toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      rows.push({ path: target, title: title || path.basename(target), default: Boolean(isDefault), count: 0 });
    };
    if (saved.length) saved.forEach((row, index) => push(row.path, row.title, index === 0));
    else push(process.cwd(), path.basename(process.cwd()), true);
    for (const row of this.walkSessions()) push(row.summary.info.cwd, "", false);
    if (!rows.some((row) => row.default) && rows[0]) rows[0].default = true;
    return rows;
  }

  addWorkspace(dir, title) {
    const target = path.resolve(String(dir || ""));
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { ok: false, status: 400, error: "目录不存在" };
    const data = readState();
    const rows = Array.isArray(data.workspaces) ? data.workspaces : [];
    const key = target.replace(/[\\/]+$/, "").toLowerCase();
    if (!rows.some((row) => String(row.path || "").replace(/[\\/]+$/, "").toLowerCase() === key)) {
      rows.push({ path: target, title: title || path.basename(target) });
    }
    data.workspaces = rows;
    writeState(data);
    return { ok: true };
  }

  removeWorkspace(dir) {
    const key = String(dir || "").replace(/[\\/]+$/, "").toLowerCase();
    const data = readState();
    data.workspaces = (data.workspaces || []).filter((row) => String(row.path || "").replace(/[\\/]+$/, "").toLowerCase() !== key);
    writeState(data);
    return { ok: true };
  }

  catalog() {
    return {
      groups: [
        {
          id: "grok",
          name: "grok",
          models: [
            { id: "grok-build", name: "Grok Build", reasoning: true, efforts: ["low", "medium", "high"] },
            { id: "grok-4.6", name: "Grok 4.6", reasoning: true, efforts: ["low", "medium", "high"] },
            { id: "grok-4.5", name: "Grok 4.5", reasoning: true, efforts: ["low", "medium", "high"] },
          ],
        },
        ...piProviders.catalogGroups(),
      ],
      levels: [["off", "关"], ["low", "低"], ["medium", "中"], ["high", "高"]],
    };
  }

  stopAll() {
    for (const proc of this.procs.values()) this.kill(proc);
    this.procs.clear();
  }
}

module.exports = { GrokBridge, mapUpdates, findGrokBin, modelSlug, ensurePiModel };
