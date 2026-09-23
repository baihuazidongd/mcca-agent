"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const piProviders = require("../pi-web/pi-providers.cjs");

const AGENT_PORT = Number(process.env.OH_AGENT_PORT || 8012);
const AGENT_URL = process.env.OH_AGENT_URL || `http://127.0.0.1:${AGENT_PORT}`;
const SETTINGS = process.env.MCCA_OH_SETTINGS || path.join(__dirname, "..", "..", "config", ".openhands-web", "settings.json");
const READY_MS = Number(process.env.OH_READY_MS || 480000);

function findUv() {
  if (process.env.OH_UV && fs.existsSync(process.env.OH_UV)) return process.env.OH_UV;
  const home = process.env.USERPROFILE || os.homedir();
  const exe = path.join(home, ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
  return fs.existsSync(exe) ? exe : "uv";
}

function readSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    if (data && typeof data === "object") return data;
  } catch { /* first run */ }
  return { workspaces: [], models: {} };
}

function writeSettings(data) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, `${JSON.stringify(data, null, 2)}\n`);
}

function redact(text) {
  return String(text || "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…");
}

function llmOf(provider, modelId) {
  const overlay = piProviders.codexOverlay(provider);
  const spec = overlay && overlay.model_providers && overlay.model_providers[provider];
  if (!spec) throw new Error(`pi 里没有服务商「${provider}」`);
  const pub = piProviders.publicProviders().find((row) => row.id === provider);
  const api = (pub && pub.entry && pub.entry.api) || "";
  let prefix = "openai";
  let apiMode = spec.wire_api === "chat" ? "chat" : "responses";
  if (api === "anthropic-messages") {
    prefix = "anthropic";
    apiMode = "chat";
  } else if (api === "google-generative-ai") {
    prefix = "gemini";
    apiMode = "chat";
  } else if (api === "openai-completions") {
    prefix = "openai";
    apiMode = "chat";
  } else if (api === "openai-responses") {
    prefix = "openai";
    apiMode = "responses";
  }
  const llm = {
    model: `${prefix}/${modelId}`,
    api_key: spec.experimental_bearer_token || null,
    base_url: spec.base_url,
    usage_id: "mcca-openhands",
    api_mode: apiMode,
  };
  if (spec.http_headers && typeof spec.http_headers === "object") llm.extra_headers = spec.http_headers;
  return llm;
}

function defaultModel() {
  const groups = piProviders.catalogGroups();
  const group = groups.find((row) => row.models && row.models.length);
  if (!group) return null;
  return { provider: group.id, modelId: group.models[0].id };
}

function textOf(node, out = []) {
  if (!node || typeof node === "string" || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, out);
    return out;
  }
  if (typeof node.text === "string" && node.text.trim()) out.push(node.text);
  if (typeof node.command === "string" && node.command.trim()) out.push(node.command);
  for (const key of ["content", "llm_message", "action", "observation", "message"]) textOf(node[key], out);
  return out;
}

function asMs(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : Date.now();
}

class OpenHandsBridge {
  constructor() {
    this.agent = null;
    this.spawned = false;
    this.readyDone = null;
    this.models = new Map(Object.entries(readSettings().models || {}));
    this.bootId = `oh-${Date.now().toString(36)}`;
  }

  async ready() {
    if (!this.readyDone) this.readyDone = this.openAgent();
    await this.readyDone;
  }

  async openAgent() {
    if (await this.ping()) return;
    const uv = findUv();
    const child = spawn(uv, [
      "tool", "run",
      "--python", "3.12",
      "--from", "openhands-agent-server==1.49.3",
      "--with", "openhands-tools==1.49.3",
      "--with", "openhands-sdk==1.49.3",
      "agent-server",
      "--host", "127.0.0.1",
      "--port", String(AGENT_PORT),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.agent = child;
    this.spawned = true;
    const log = (chunk, write) => {
      const line = String(chunk).trim().split(/\n/).pop();
      if (!line || /sk-[A-Za-z0-9_-]{8,}/.test(line)) return;
      write(`[openhands] ${line.slice(0, 300)}`);
    };
    child.stdout.on("data", (chunk) => log(chunk, console.log));
    child.stderr.on("data", (chunk) => log(chunk, console.error));
    const deadline = Date.now() + READY_MS;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`agent-server 退出 ${child.exitCode}`);
      if (await this.ping()) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("agent-server 没有在时限内起来");
  }

  stopAgent() {
    const child = this.agent;
    this.agent = null;
    this.readyDone = null;
    if (!this.spawned || !child || !child.pid) return;
    this.spawned = false;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { child.kill(); } catch { /* already gone */ }
    }
  }

  ping() {
    return this.request("GET", "/health", null, 1500).then(() => true).catch(() => false);
  }

  request(method, pathname, body, timeoutMs = 120000) {
    const url = new URL(pathname, AGENT_URL);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    if (process.env.SESSION_API_KEY) headers["x-session-api-key"] = process.env.SESSION_API_KEY;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = {};
          if (raw) {
            try { data = JSON.parse(raw); }
            catch { data = { error: raw.slice(0, 400) }; }
          }
          if (res.statusCode >= 400) {
            const detail = data.detail || data.error || raw.slice(0, 400);
            reject(new Error(redact(typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400))));
            return;
          }
          resolve(data);
        });
      });
      req.on("error", (error) => reject(error));
      req.on("timeout", () => { req.destroy(new Error("agent-server 超时")); });
      if (payload) req.end(payload);
      else req.end();
    });
  }

  remember(id, provider, modelId) {
    if (!provider || !modelId) return;
    this.models.set(id, { provider, modelId });
    const data = readSettings();
    data.models = data.models && typeof data.models === "object" ? data.models : {};
    data.models[id] = { provider, modelId };
    writeSettings(data);
  }

  remembered(id) {
    return this.models.get(id) || null;
  }

  summary(row) {
    const id = String(row.id);
    const status = String(row.execution_status || "");
    const workspace = row.workspace || {};
    return {
      id,
      title: row.title || id.slice(0, 8),
      cwd: workspace.working_dir || "",
      running: status === "running" || status === "waiting_for_confirmation",
      updatedAt: asMs(row.updated_at || row.created_at),
      model: this.remembered(id),
      thinkingLevel: null,
    };
  }

  async list() {
    await this.ready();
    const page = await this.request("GET", "/api/conversations/search?limit=80");
    const items = Array.isArray(page.items) ? page.items : [];
    return items.map((row) => this.summary(row));
  }

  async runningSessions() {
    const rows = await this.list();
    return rows.filter((row) => row.running);
  }

  agentBody(provider, modelId, cwd) {
    return {
      agent: {
        kind: "Agent",
        llm: llmOf(provider, modelId),
        tools: [
          { name: "terminal" },
          { name: "file_editor" },
          { name: "task_tracker" },
        ],
      },
      workspace: { kind: "LocalWorkspace", working_dir: cwd },
    };
  }

  async create(body = {}) {
    await this.ready();
    const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd();
    let provider = typeof body.provider === "string" ? body.provider : "";
    let modelId = typeof body.modelId === "string" ? body.modelId : "";
    if (!provider || !modelId) {
      const fallback = defaultModel();
      if (!fallback) throw new Error("pi 里没有可用模型");
      provider = fallback.provider;
      modelId = fallback.modelId;
    }
    const info = await this.request("POST", "/api/conversations", this.agentBody(provider, modelId, cwd));
    const id = String(info.id);
    this.remember(id, provider, modelId);
    return { ok: true, id };
  }

  async remove(id) {
    await this.ready();
    await this.request("DELETE", `/api/conversations/${encodeURIComponent(id)}`);
    this.models.delete(id);
    const data = readSettings();
    if (data.models) delete data.models[id];
    writeSettings(data);
    return { ok: true };
  }

  async prompt(id, text) {
    await this.ready();
    await this.request("POST", `/api/conversations/${encodeURIComponent(id)}/events`, {
      role: "user",
      content: [{ type: "text", text: String(text || "") }],
      run: true,
    });
    return { ok: true, sessionId: id };
  }

  async stop(id) {
    await this.ready();
    try { await this.request("POST", `/api/conversations/${encodeURIComponent(id)}/interrupt`); }
    catch { await this.request("POST", `/api/conversations/${encodeURIComponent(id)}/pause`); }
    return { ok: true };
  }

  async setModel(id, provider, modelId) {
    await this.ready();
    await this.request("POST", `/api/conversations/${encodeURIComponent(id)}/switch_llm`, { llm: llmOf(provider, modelId) });
    this.remember(id, provider, modelId);
    return { ok: true, sessionId: id };
  }

  async rename(id, title) {
    await this.ready();
    const next = String(title || "").trim();
    if (!next) return { ok: false, error: "标题不能为空" };
    await this.request("PATCH", `/api/conversations/${encodeURIComponent(id)}`, { title: next.slice(0, 200) });
    return { ok: true };
  }

  async conversation(id) {
    await this.ready();
    return this.request("GET", `/api/conversations/${encodeURIComponent(id)}`);
  }

  mapEvent(event) {
    const at = asMs(event.timestamp);
    const kind = String(event.kind || "");
    const text = textOf(event).join("\n").trim();
    if (kind === "MessageEvent" && event.source === "user") return { type: "user", at, text, id: event.id };
    if (kind === "MessageEvent") return text ? { type: "assistant-end", at, text } : null;
    if (kind === "ActionEvent") {
      return {
        type: "tool",
        phase: "start",
        at,
        name: event.tool_name || "tool",
        callId: event.tool_call_id || event.id,
        args: text,
      };
    }
    if (kind === "ObservationEvent" || kind === "AgentErrorEvent") {
      return {
        type: "tool",
        phase: "end",
        at,
        name: event.tool_name || "tool",
        callId: event.tool_call_id || event.action_id || event.id,
        ok: kind !== "AgentErrorEvent",
        isError: kind === "AgentErrorEvent",
        output: text || event.detail || "",
      };
    }
    if (kind === "ConversationErrorEvent") {
      return { type: "assistant-end", at, text: "", error: redact(event.detail || event.code || "agent error") };
    }
    return null;
  }

  async events(id) {
    await this.ready();
    const items = [];
    let pageId = "";
    for (let page = 0; page < 8; page += 1) {
      const query = `/api/conversations/${encodeURIComponent(id)}/events/search?limit=100${pageId ? `&page_id=${encodeURIComponent(pageId)}` : ""}`;
      const data = await this.request("GET", query);
      const batch = Array.isArray(data.items) ? data.items : [];
      items.push(...batch);
      if (!data.next_page_id) break;
      pageId = data.next_page_id;
    }
    items.sort((a, b) => asMs(a.timestamp) - asMs(b.timestamp));
    const frames = [];
    let seq = 0;
    for (const item of items) {
      const event = this.mapEvent(item);
      if (!event) continue;
      seq += 1;
      frames.push({ seq, id: `${this.bootId}:${id}:${item.id || seq}`, event });
    }
    return frames;
  }

  async history(id) {
    const frames = await this.events(id);
    const info = await this.conversation(id).catch(() => null);
    const summary = info ? this.summary(info) : { id, title: id.slice(0, 8), running: false, model: this.remembered(id) };
    if (!summary.model) summary.model = this.remembered(id);
    return {
      session: {
        ...summary,
        thinkingLevel: null,
        thinkingExplicit: false,
        promptQueue: [],
        turnStartedAt: 0,
      },
      events: frames,
      bootId: this.bootId,
    };
  }

  workspaces() {
    const saved = readSettings().workspaces || [];
    const rows = saved.length ? saved : [{ path: process.cwd(), title: path.basename(process.cwd()), default: true }];
    return rows.map((row) => ({ path: row.path, title: row.title || path.basename(row.path), default: Boolean(row.default), count: 0 }));
  }

  addWorkspace(dir, title) {
    const target = path.resolve(String(dir || ""));
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { ok: false, status: 400, error: "目录不存在" };
    const data = readSettings();
    const rows = Array.isArray(data.workspaces) ? data.workspaces : [];
    const key = target.replace(/[\\/]+$/, "").toLowerCase();
    if (!rows.some((row) => String(row.path || "").replace(/[\\/]+$/, "").toLowerCase() === key)) {
      rows.push({ path: target, title: title || path.basename(target) });
    }
    data.workspaces = rows;
    writeSettings(data);
    return { ok: true };
  }

  removeWorkspace(dir) {
    const key = String(dir || "").replace(/[\\/]+$/, "").toLowerCase();
    const data = readSettings();
    data.workspaces = (data.workspaces || []).filter((row) => String(row.path || "").replace(/[\\/]+$/, "").toLowerCase() !== key);
    writeSettings(data);
    return { ok: true };
  }

  catalog() {
    return { groups: piProviders.catalogGroups(), levels: [["off", "关"], ["low", "低"], ["medium", "中"], ["high", "高"]] };
  }
}

module.exports = { OpenHandsBridge, AGENT_PORT, llmOf };
