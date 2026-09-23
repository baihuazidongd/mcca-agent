"use strict";

/**
 * @mcca/mobile-bridge — 手机端接入层（桌面侧）。
 *
 * 桌面 portal/pi-web 只监听 127.0.0.1；本进程把两边的能力聚合成一套
 * 「QQ 式」的精简协议，双通道提供：
 *   - 局域网：0.0.0.0:<port> 上的 WS（/ws）+ HTTP（/rpc、/events）
 *   - 公网中转：主动外连 relay（默认 ws://<server>/desktop），断线自愈
 *
 * 协议（JSON 文本帧）：
 *   App → 桥   {t:"req", id, m, p}
 *   桥 → App   {t:"res", id, ok, d} | {t:"res", id, ok:false, e}
 *   桥 → App   {t:"evt", m, d}        m: sessions|patch|notify|host|hello
 *
 * 鉴权：token（config/mobile.json 自动生成；query `?token=` 或
 * `x-mcca-token` 头）。relay 侧由 relay 校验，桥只带 token 出站。
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const { WebSocketServer } = require("ws");

const { PiSource } = require("./pi-source.cjs");
const { PortalSource } = require("./portal-source.cjs");
const { DshSource } = require("./dsh-source.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_FILE = process.env.MCCA_MOBILE_CONFIG || path.join(ROOT, "config", "mobile.json");
const VERSION = "0.1.0";

function log(line) {
  console.log(`[mobile-bridge] ${line}`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  let file = readJson(CONFIG_FILE, null);
  if (!file || typeof file !== "object") file = {};
  let dirty = false;
  if (!file.token) {
    file.token = process.env.MCCA_MOBILE_TOKEN || crypto.randomBytes(18).toString("base64url");
    dirty = true;
  }
  if (!file.port) {
    file.port = Number(process.env.MCCA_MOBILE_PORT) || 3471;
    dirty = true;
  }
  if (!file.name) {
    file.name = os.hostname() || "MCCA 桌面";
    dirty = true;
  }
  if (file.relayUrl === undefined) {
    file.relayUrl = process.env.MCCA_RELAY_URL || "";
    dirty = true;
  }
  if (dirty) {
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    } catch (error) {
      log(`配置写入失败：${error.message}`);
    }
  }
  return file;
}

const config = loadConfig();
const PORT = Number(process.env.MCCA_MOBILE_PORT) || Number(config.port) || 3471;
const TOKEN = process.env.MCCA_MOBILE_TOKEN || config.token;
const RELAY_URL = process.env.MCCA_RELAY_URL || config.relayUrl || "";
const PI_BASE = process.env.MCCA_PI_WEB_BASE || "http://127.0.0.1:3458";
const PORTAL_BASE = process.env.MCCA_PORTAL_BASE || "http://127.0.0.1:3470";
const DSH_BASE = process.env.MCCA_DSH_BASE || "http://127.0.0.1:3081";

// ── 客户端集合 ─────────────────────────────────────────────────────

/** @type {Set<{send:(obj:object)=>void, opened:Set<string>, meta:object}>} */
const clients = new Set();

function broadcast(topic, data, except) {
  const frame = JSON.stringify({ t: "evt", m: topic, d: data });
  for (const client of clients) {
    if (client === except) continue;
    try { client.send(frame); } catch { clients.delete(client); }
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) out.push(item.address);
    }
  }
  return out;
}

// ── 数据源接线 ─────────────────────────────────────────────────────

const pi = new PiSource({
  baseUrl: PI_BASE,
  log,
  onPatch: (sessionId, patches) => broadcast("patch", { sessionId, agent: "pi", patches }),
  onSessions: (sessions) => broadcast("sessions", { sessions, agent: "pi" }),
  onNotify: (item) => broadcast("notify", { item: { ...item, at: Date.now() } }),
});

const portal = new PortalSource({ baseUrl: PORTAL_BASE, log });

const dsh = new DshSource({
  baseUrl: DSH_BASE,
  log,
  onPatch: (sessionId, patches) => broadcast("patch", { sessionId, agent: "dsh", patches }),
  onSessions: (sessions) => broadcast("sessions", { sessions, agent: "dsh" }),
});

/** 两个 agent 的数据源统一取用；默认 pi。 */
function sourceOf(agent) {
  return String(agent || "pi") === "dsh" ? dsh : pi;
}

let hostSnapshot = "";
let relays = { connected: false, url: RELAY_URL, since: 0, lastError: "" };

async function pollPortal() {
  if (clients.size === 0) return;
  try {
    const [agents, resources] = await Promise.all([portal.status(), portal.resources()]);
    const view = {
      online: true,
      agents: agents.map((a) => ({
        agent: a.agent,
        label: a.label,
        port: a.port,
        running: a.running,
        pid: a.pid,
        startedAt: a.startedAt,
        lastExit: a.lastExit || null,
      })),
      resources: {
        cpuApp: resources.cpuApp,
        cpuTotal: resources.cpuTotal,
        memApp: resources.memApp,
        memUsed: resources.memUsed,
        memTotal: resources.memTotal,
        procCount: resources.procCount,
        netConns: resources.netConns,
      },
    };
    const json = JSON.stringify(view);
    if (json !== hostSnapshot) {
      hostSnapshot = json;
      broadcast("host", view);
    }
  } catch {
    if (hostSnapshot !== JSON.stringify({ online: false })) {
      hostSnapshot = JSON.stringify({ online: false });
      broadcast("host", { online: false, error: portal.lastError });
    }
  }
}

let notifySeen = 0;
async function pollNotify() {
  if (clients.size === 0) return;
  try {
    const { items, latest } = await portal.notifications(notifySeen);
    if (items.length) {
      for (const item of items) broadcast("notify", { item: { ...item, source: "portal" } });
      notifySeen = Math.max(notifySeen, latest);
    } else if (latest > notifySeen) {
      notifySeen = latest;
    }
  } catch {
    // portal 未运行时静默重试
  }
}

setInterval(() => void pollPortal(), 6000).unref();
setInterval(() => void pollNotify(), 3000).unref();

// ── 方法表 ─────────────────────────────────────────────────────────

function helloPayload() {
  return {
    name: config.name || os.hostname(),
    version: VERSION,
    time: Date.now(),
    lan: { port: PORT, addresses: lanAddresses() },
    relay: { url: relays.url, connected: relays.connected },
    pi: { online: pi.online, error: pi.lastError },
    dsh: { online: dsh.online, error: dsh.lastError, base: DSH_BASE },
    portal: { online: portal.online },
    caps: ["sessions", "chat", "tasks", "notify", "host", "files", "images", "dsh"],
  };
}

async function dispatch(method, params, client) {
  const p = params && typeof params === "object" ? params : {};
  switch (method) {
    case "hello":
      return { ok: true, d: helloPayload() };
    case "sessions.list": {
      const [piSessions, dshSessions] = await Promise.all([
        pi.list().catch(() => []),
        dsh.list().catch(() => []),
      ]);
      const sessions = [...piSessions, ...dshSessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return {
        ok: true,
        d: {
          sessions,
          piOnline: pi.online,
          dshOnline: dsh.online,
          error: pi.lastError || dsh.lastError || "",
        },
      };
    }
    case "sessions.open": {
      const agent = String(p.agent || "pi");
      const data = await sourceOf(agent).open(p.id);
      client.opened.add(`${agent}:${p.id}`);
      return { ok: true, d: { ...data, agent } };
    }
    case "sessions.close": {
      const agent = String(p.agent || "pi");
      client.opened.delete(`${agent}:${p.id}`);
      const stillOpen = [...clients].some((c) => c.opened.has(`${agent}:${p.id}`));
      if (!stillOpen) sourceOf(agent).close(p.id);
      return { ok: true, d: { ok: true } };
    }
    case "sessions.send":
      return { ok: true, d: await sourceOf(p.agent).send(p.id, p.text, p.images) };
    case "sessions.stop":
      return { ok: true, d: await sourceOf(p.agent).stop(p.id) };
    case "sessions.create":
      return { ok: true, d: await sourceOf(p.agent).create(p.cwd) };
    case "sessions.delete": {
      if (String(p.agent || "pi") === "dsh") {
        return { ok: true, d: { ok: false, error: "dsh 暂不支持删除会话，可在桌面端归档" } };
      }
      return { ok: true, d: await pi.remove(p.id) };
    }
    case "sessions.rename":
      return { ok: true, d: await sourceOf(p.agent).rename(p.id, p.title) };
    case "sessions.setModel":
      return { ok: true, d: await sourceOf(p.agent).setModel(p.id, p.provider, p.modelId, p.level) };
    case "sessions.setThinking":
      return { ok: true, d: await sourceOf(p.agent).setThinking(p.id, p.level) };
    case "sessions.models":
      return { ok: true, d: await sourceOf(p.agent).models(p.id) };
    case "sessions.workspaces":
      return { ok: true, d: await pi.workspaces() };
    case "goal.action": {
      if (String(p.agent || "dsh") !== "dsh") return { ok: false, e: "只有 dsh 支持目标（goal）" };
      const r = await dsh.goalAction(p.id, String(p.action || ""), {
        objective: String(p.objective || ""),
        maxRounds: Number(p.maxRounds) || 0,
      });
      setTimeout(() => void dsh.poll().catch(() => {}), 800);
      return { ok: true, d: r };
    }
    case "avatar.get": {
      // pi 的像素角色头像：id=会话 id（每会话固定角色），role=子代理/角色名（固定角色）
      const agent = String(p.agent || "pi");
      if (agent !== "pi") return { ok: false, e: "该 agent 没有角色头像" };
      const data = await pi.avatar(p.id, p.role);
      if (!data) return { ok: false, e: "没有可用头像" };
      return { ok: true, d: data };
    }
    case "file.get": {      // 图片读取：pi 走工作区文件（path，相对会话 cwd），dsh 走会话附件（attachmentId）
      const agent = String(p.agent || "pi");
      if (p.attachmentId) {
        if (agent !== "dsh") return { ok: false, e: "仅 dsh 支持 attachmentId" };
        const att = await dsh.attachment(p.sessionId, p.attachmentId);
        if (!att) return { ok: false, e: "附件不存在或已过期" };
        return { ok: true, d: att };
      }
      if (agent === "dsh") return { ok: false, e: "dsh 图片请用 attachmentId" };
      return { ok: true, d: await pi.file(p.sessionId, p.path) };
    }
    case "tasks.list": {
      const sessions = pi.view();
      const running = sessions.filter((s) => s.running);
      const tasks = running.map((s) => ({
        kind: "session",
        id: `s:${s.id}`,
        sessionId: s.id,
        agent: "pi",
        title: s.title,
        status: "working",
        statusText: s.status === "requesting" ? "等待模型响应" : "处理中",
        startedAt: s.turnStartedAt || s.updatedAt,
        updatedAt: s.updatedAt,
        turn: s.turn,
        queue: s.queue,
        agent: "pi",
      }));
      // dsh：运行中的会话 + 未结束的目标（goal）
      for (const s of dsh.view()) {
        if (s.running) {
          tasks.push({
            kind: "session",
            id: `dsh:${s.id}`,
            sessionId: s.id,
            agent: "dsh",
            title: s.title,
            status: "working",
            statusText: s.status === "requesting" ? "等待模型响应" : "处理中",
            startedAt: s.turnStartedAt || s.updatedAt,
            updatedAt: s.updatedAt,
            turn: s.turn,
            queue: s.queue,
          });
        }
        if (s.goal && s.goal.objective && !["completed", "blocked", "cleared"].includes(String(s.goal.phase))) {
          tasks.push({
            kind: "goal",
            id: `goal:${s.id}`,
            sessionId: s.id,
            agent: "dsh",
            title: s.goal.objective,
            detail: `第 ${s.goal.roundsStarted}${s.goal.maxGoalRounds ? "/" + s.goal.maxGoalRounds : ""} 轮`,
            status: s.goal.phase === "paused" ? "paused" : "working",
            statusText: s.goal.phase === "paused" ? "已暂停" : "推进中",
            startedAt: s.goal.createdAt || 0,
            updatedAt: s.goal.updatedAt || s.updatedAt,
            parentTitle: s.title,
          });
        }
      }
      // 子代理只在 pi 侧；取「运行中的会话 + 最近 12 个」，避免漏掉排在后面的活会话
      const subagentScope = sessions.filter((s, i) => s.running || i < 12);
      for (const s of subagentScope.slice(0, 20)) {
        try {
          const { ok, data } = await pi.subagents(s.id);
          if (!ok || !data || !Array.isArray(data.runs)) continue;
          for (const run of data.runs) {
            if (run.status === "working" || (run.endedAt && Date.now() - run.endedAt < 3600e3)) {
              tasks.push({
                kind: "subagent",
                id: `r:${s.id}:${run.id}`,
                sessionId: s.id,
                runId: run.id,
                title: run.agent || "子代理",
                detail: run.task || "",
                status: run.status,
                startedAt: run.startedAt || 0,
                endedAt: run.endedAt || 0,
                result: String(run.result || "").slice(0, 2000),
                error: String(run.error || "").slice(0, 2000),
                background: Boolean(run.background),
                parentTitle: s.title,
                model: run.model || "",
                thinking: run.thinking || "",
                childSessionId: run.childSessionId || "",
              });
            }
          }
        } catch {
          // 单个会话的子代理快照失败不影响整体任务列表
        }
      }
      tasks.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      return { ok: true, d: { tasks, sessions: sessions.filter((s) => s.running).length } };
    }
    case "tasks.stopSubagent":
      return { ok: true, d: await pi.stopSubagent(p.sessionId, p.runId) };
    case "tasks.transcript": {
      const data = await pi.transcript(p.sessionId, p.runId);
      if (!data) return { ok: false, e: "子代理转录不存在（可能已清理）" };
      // 附带 run 的元信息（状态/模型/思考强度/结果），聊天页里点进来的子代理也能显示完整头部
      try {
        const snap = await pi.subagents(p.sessionId);
        const run = (snap.data?.runs || []).find((r) => r.id === p.runId || String(r.runId) === String(p.runId) || r.childSessionId === data.sessionId);
        if (run) {
          data.run = {
            id: run.id,
            agent: run.agent || data.name,
            status: run.status || "",
            model: run.model || "",
            thinking: run.thinking || "",
            task: run.task || "",
            result: String(run.result || "").slice(0, 4000),
            error: String(run.error || "").slice(0, 4000),
            startedAt: run.startedAt || 0,
            endedAt: run.endedAt || 0,
            background: Boolean(run.background),
          };
        }
      } catch {
        // 元信息拿不到不影响转录
      }
      return { ok: true, d: data };
    }
    case "notify.list": {
      const { items, latest } = await portal.notifications(Number(p.since) || 0);
      return { ok: true, d: { items, latest } };
    }
    case "notify.delete": {
      const id = Number(p && p.id);
      if (!Number.isFinite(id)) return { ok: false, e: "bad id" };
      const result = await portal.deleteNotification(id);
      return { ok: result.ok !== false, d: result, e: result.error };
    }
    case "host.status": {
      const agents = await portal.status();
      const resources = await portal.resources();
      return { ok: true, d: { online: true, agents, resources } };
    }
    case "host.action": {
      const result = await portal.action(p.agent, p.action);
      setTimeout(() => void pollPortal(), 1500).unref();
      return { ok: true, d: result };
    }
    case "host.logs": {
      const agents = await portal.status();
      const found = agents.find((a) => a.agent === p.agent);
      return { ok: true, d: { agent: p.agent, log: found ? found.log : [] } };
    }
    default:
      return { ok: false, e: `未知方法 ${method}` };
  }
}

async function handleRequest(msg, client) {
  const id = msg.id;
  try {
    const result = await dispatch(String(msg.m || ""), msg.p, client);
    client.send(JSON.stringify({ t: "res", id, ok: result.ok !== false, d: result.d, e: result.e || result.error }));
  } catch (error) {
    client.send(JSON.stringify({ t: "res", id, ok: false, e: error instanceof Error ? error.message : String(error) }));
  }
}

function attachClient(send, meta) {
  const client = { send, meta: meta || {}, opened: new Set() };
  clients.add(client);
  client.send(JSON.stringify({ t: "evt", m: "hello", d: helloPayload() }));
  const snapshot = [...pi.view(), ...dsh.view()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (snapshot.length) client.send(JSON.stringify({ t: "evt", m: "sessions", d: { sessions: snapshot } }));
  pi.start();
  dsh.start();
  return client;
}

/**
 * relay 连接本身也是一个广播出口：不注册它，走中转的 App 就收不到
 * sessions/patch/notify/host 这些实时事件（历史只能靠 RPC 拉）。
 * 它以伪客户端身份进 clients，事件 fan-out 时照发；请求仍按 per-app 处理。
 */
function attachRelaySink(ws) {
  const sink = { send: (frame) => { if (ws.readyState === ws.OPEN) ws.send(frame); }, meta: { relay: true }, opened: new Set() };
  clients.add(sink);
  pi.start();
  dsh.start();
  return sink;
}

function detachClient(client) {
  clients.delete(client);
}

// ── HTTP（局域网） ────────────────────────────────────────────────

function authorized(req, url) {
  const header = String(req.headers["x-mcca-token"] || "");
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return header === TOKEN || bearer === TOKEN || url.searchParams.get("token") === TOKEN;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      name: config.name,
      version: VERSION,
      pi: pi.online,
      portal: portal.online,
      relay: relays,
      clients: clients.size,
    });
  }
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      `mcca mobile bridge ${VERSION}\n`
      + `设备：${config.name}\n`
      + `局域网地址：${lanAddresses().map((ip) => `http://${ip}:${PORT}`).join("  ") || "(无)"}\n`
      + `pi-web：${pi.online ? "在线" : "离线"}  portal：${portal.online ? "在线" : "离线"}\n`
      + `中转：${relays.connected ? "已连接" : "未连接"} ${relays.url || "(未配置)"}\n`
      + `App 端在「设置」里填：地址 + token（token 见 config/mobile.json）\n`,
    );
    return;
  }
  if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: "unauthorized" });

  if (url.pathname === "/rpc" && req.method === "POST") {
    const body = await readBody(req);
    const client = { send: () => {}, meta: { http: true }, opened: new Set() };
    try {
      const result = await dispatch(String(body.m || ""), body.p, client);
      return sendJson(res, 200, { t: "res", id: body.id, ok: result.ok !== false, d: result.d, e: result.e || result.error });
    } catch (error) {
      return sendJson(res, 500, { t: "res", id: body.id, ok: false, e: error instanceof Error ? error.message : String(error) });
    }
  }
  if (url.pathname === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const client = attachClient((frame) => res.write(`data: ${frame}\n\n`), { http: true });
    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* ignore */ }
    }, 20000);
    req.on("close", () => {
      clearInterval(ping);
      detachClient(client);
    });
    return;
  }
  sendJson(res, 404, { ok: false, error: "not found" });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://x");
  if (!authorized(req, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = attachClient((frame) => {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }, { ws: true });
    ws.on("message", (data) => {
      let msg = null;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || msg.t !== "req") return;
      void handleRequest(msg, client);
    });
    ws.on("close", () => detachClient(client));
    ws.on("error", () => detachClient(client));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`局域网入口 → http://0.0.0.0:${PORT}（${lanAddresses().join(", ") || "无网卡"}）`);
  log(`配对 token：${TOKEN}`);
  log(`pi-web ${PI_BASE} · portal ${PORTAL_BASE}`);
});

// ── UDP 局域网发现（App 广播 MCCA_DISCOVER，桥回当前地址）────────────
//
// 家里/公司网络换网段、DHCP 换 IP 后，App 手里记的地址就过期了；只靠 hello 里
// 广播的地址要"先连上中转"才能学到。这里给一条不依赖中转的发现通道。
const DISCOVERY_PORT = Number(process.env.MCCA_DISCOVERY_PORT) || 3472;

try {
  const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  udp.on("message", (msg, rinfo) => {
    if (String(msg).trim() !== "MCCA_DISCOVER") return;
    const payload = Buffer.from(
      JSON.stringify({
        t: "mcca-desktop",
        name: config.name || os.hostname(),
        version: VERSION,
        port: PORT,
        addresses: lanAddresses(),
      }),
      "utf8",
    );
    udp.send(payload, rinfo.port, rinfo.address, () => {});
  });
  udp.on("error", (error) => log(`发现服务不可用：${error.message}`));
  udp.bind(DISCOVERY_PORT, "0.0.0.0", () => {
    try { udp.setBroadcast(true); } catch { /* ignore */ }
    log(`局域网发现 → udp/${DISCOVERY_PORT}（设备广播 MCCA_DISCOVER 即回地址）`);
  });
} catch (error) {
  log(`发现服务启动失败：${error.message}`);
}

// ── relay 出站连接 ────────────────────────────────────────────────

let relayWs = null;
let relayBackoff = 2000;
let relayTimer = null;

function relayLog(line) {
  log(`relay: ${line}`);
}

function connectRelay() {
  if (!RELAY_URL) return;
  const url = `${RELAY_URL}${RELAY_URL.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (error) {
    relayLog(`创建连接失败：${error.message}`);
    scheduleRelayReconnect();
    return;
  }
  relayWs = ws;
  let relaySink = null;
  ws.onopen = () => {
    relays = { connected: true, url: RELAY_URL, since: Date.now(), lastError: "" };
    relayBackoff = 2000;
    relayLog("已连接");
    relaySink = attachRelaySink(ws);
    broadcast("relay", { connected: true, url: RELAY_URL });
    ws.send(JSON.stringify({ t: "hello", d: helloPayload() }));
  };
  ws.onmessage = (event) => {
    let msg = null;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (!msg) return;
    if (msg.t === "req") {
      const clientId = msg.c || "";
      const client = {
        meta: { relay: true, clientId },
        opened: relayOpened.get(clientId) || (relayOpened.set(clientId, new Set()), relayOpened.get(clientId)),
        send: (frame) => {
          const parsed = JSON.parse(frame);
          if (parsed.t === "res") parsed.c = clientId;
          else if (parsed.t === "evt" && parsed.m === "hello") { /* keep broadcast */ }
          try { ws.send(JSON.stringify(parsed)); } catch { /* ignore */ }
        },
      };
      void handleRequest(msg, client);
      return;
    }
    if (msg.t === "apps") {
      // relay 侧 App 上下线广播，用于清理 opened 集合
      for (const id of Object.keys(relayOpened)) {
        if (!(msg.apps || []).includes(id)) relayOpened.delete(id);
      }
      return;
    }
    if (msg.t === "ping") {
      try { ws.send(JSON.stringify({ t: "pong" })); } catch { /* ignore */ }
    }
  };
  ws.onclose = () => {
    const wasConnected = relays.connected;
    relays = { connected: false, url: RELAY_URL, since: relays.since, lastError: "连接关闭" };
    relayWs = null;
    if (relaySink) {
      clients.delete(relaySink);
      relaySink = null;
    }
    if (wasConnected) relayLog("已断开，等待重连");
    broadcast("relay", { connected: false, url: RELAY_URL });
    scheduleRelayReconnect();
  };
  ws.onerror = () => {
    relays.lastError = "连接错误";
  };
}

/** relay 侧每个 App 单独维护 opened 集合。 */
const relayOpened = new Map();

function scheduleRelayReconnect() {
  if (!RELAY_URL) return;
  if (relayTimer) clearTimeout(relayTimer);
  relayTimer = setTimeout(() => {
    relayTimer = null;
    connectRelay();
  }, relayBackoff);
  relayBackoff = Math.min(Math.round(relayBackoff * 1.8), 30000);
}

if (RELAY_URL) {
  log(`中转地址：${RELAY_URL}`);
  connectRelay();
} else {
  log("未配置中转地址（config/mobile.json 的 relayUrl 或 MCCA_RELAY_URL）；仅局域网可用");
}

process.on("uncaughtException", (error) => log(`uncaught: ${error && error.message}`));
process.on("unhandledRejection", (reason) => log(`rejection: ${reason instanceof Error ? reason.message : String(reason)}`));
