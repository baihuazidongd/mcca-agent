"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { writeJson } = require("./paths.cjs");
const { taskAdapter } = require("./task-adapters.cjs");

async function request(port, route, method = "GET", body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const chunks = []; let length = 0;
  for await (const chunk of res.body) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error("Runtime response too large");
    chunks.push(chunk);
  }
  if (!res.ok) { const error = new Error("Runtime HTTP " + res.status); error.status = res.status; throw error; }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!res.ok || data?.ok === false || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
function createTasks({ paths, runtime, fetchRuntime = request, onEvent = () => {} }) {
  const file = path.join(paths.state, "tasks.json");
  let rows = [];
  if (fs.existsSync(file)) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.tasks)) throw new Error("Unsupported tasks schema");
    rows = doc.tasks;
  }
  const inFlight = new Map(); let ticking = false;
  const acp = require("./acp-tasks.cjs").createAcpTasks({ paths, runtime });
  for (const row of rows) if (row.state === "dispatching") row.state = "dispatch-unknown";
  const save = () => writeJson(file, { schemaVersion: 1, tasks: rows });
  function change(row, state, detail = "") {
    if (row.state === state && row.detail === detail) return;
    row.state = state; row.detail = detail; row.updatedAt = Date.now(); save();
    onEvent({ task: row.id, state, detail, at: row.updatedAt });
  }
  function cfg(id) {
    const c = runtime(id);
    if (c?.taskProtocol === "openhands-acp-v1") return acp.adapter(id);
    return taskAdapter({ ...c, paths }, fetchRuntime);
  }
  function find(id) { const row = rows.find(r => r.id === id); if (!row) throw new Error("Task not found"); return row; }
  async function dispatch(args) {
    const c = cfg(args.runtime);
    if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 100000) throw new Error("Task text is required (max 100000)");
    if (rows.length >= 1000) throw new Error("任务记录已达 1000 条，请先归档旧记录");
    const duration = args.stopAfterMs == null ? null : Number(args.stopAfterMs);
    if (duration !== null && (!Number.isFinite(duration) || duration < 1000 || duration > 30 * 86400000)) throw new Error("stopAfterMs must be 1 second to 30 days");
    const row = { id: randomUUID(), key: args.key, fingerprint: fingerprint(args), runtime: args.runtime, title: String(args.title || args.text).slice(0, 120), text: args.text, state: "dispatching", createdAt: Date.now(), updatedAt: Date.now(), deadline: duration === null ? null : Date.now() + duration, session: args.session || null };
    rows.push(row); save();
    try {
      if (!row.session) {
        row.session = await c.create({ ...args, title: row.title });
        if (typeof row.session !== "string" || !row.session) throw new Error("Runtime did not return a session id"); save();
      }
      await c.prompt(row.session, args.text);
      change(row, "submitted", "已提交；等待运行状态，不自动重发");
    } catch (error) {
      // A transport timeout does not prove the prompt was rejected. Never retry
      // automatically: that could duplicate an external action.
      change(row, "dispatch-unknown", error.message);
    }
    return { ...row };
  }
  async function submit(args) {
    if (typeof args.key !== "string" || !/^[\w.-]{1,100}$/.test(args.key)) throw new Error("提供唯一 key，重试时使用同一个 key，避免重复发布任务");
    const existing = rows.find(row => row.key === args.key);
    if (existing && (existing.fingerprint ? existing.fingerprint !== fingerprint(args) : existing.runtime !== args.runtime || existing.text !== args.text)) throw new Error("该 key 已用于不同任务，请使用新的 key");
    if (inFlight.has(args.key)) return inFlight.get(args.key);
    if (existing) return { ...existing };
    const op = dispatch(args); inFlight.set(args.key, op);
    try { return await op; } finally { inFlight.delete(args.key); }
  }
  async function stop(id) {
    const row = find(id), c = cfg(row.runtime);
    if (!row.session) throw new Error("没有可停止的会话；请检查 IDE 的原生任务列表");
    await c.stop(row.session);
    change(row, "stopped", "已请求停止会话"); return { ...row };
  }
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const active = rows.filter(r => ["submitted", "running", "offline", "dispatch-unknown"].includes(r.state));
      const cache = new Map();
      for (const row of active) {
        if (!row.session) continue;
        try {
          if (row.deadline && Date.now() >= row.deadline) { await stop(row.id); continue; }
          const c = cfg(row.runtime);
          if (!cache.has(row.runtime)) cache.set(row.runtime, c.list().catch(error => ({ error })));
          const data = await cache.get(row.runtime); if (data.error) throw data.error;
          if (!Array.isArray(data.sessions)) throw new Error("Runtime returned invalid session status");
          const session = data.sessions.find(s => s.id === row.session);
          if (!session) throw new Error("会话不存在；需人工核对，未标记完成");
          if (session.offline && !session.finishedAt) throw new Error("任务宿主已断开，未标记完成");
          const permissions = session.permissions || [];
          if (JSON.stringify(row.permissions) !== JSON.stringify(permissions)) { row.permissions = permissions; save(); }
          if (session.running) { row.observedRunning = true; change(row, "running"); }
          else if (row.observedRunning || session.finishedAt) change(row, "idle", session.lastError || "会话已空闲；任务结果需查看记录确认");
          else if (row.state === "offline") change(row, "submitted", "连接已恢复；等待确认运行状态");
        } catch (error) { change(row, "offline", error.message); }
      }
    } finally { ticking = false; }
  }
  const timer = setInterval(() => void tick(), 15000); timer.unref();
  return { list: () => rows.map(r => ({ ...r, text: undefined })).reverse(), submit, stop, tick,
    async inspect(id) { const row = find(id); return { ...row, history: row.session ? await cfg(row.runtime).history(row.session) : null }; },
    permission(id, request, option) { const row = find(id); return acp.permission(row.session, request, option); },
    dispose() { clearInterval(timer); acp.dispose(); } };
}
function fingerprint(args) {
  return createHash("sha256").update(JSON.stringify([args.runtime, args.text, args.session || null, args.cwd || null, args.provider || null, args.modelId || null, args.stopAfterMs ?? null, args.title || null])).digest("hex");
}
module.exports = { createTasks, request };
