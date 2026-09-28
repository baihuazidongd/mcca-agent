"use strict";

/**
 * @mcca/mobile-relay — 公网中转（跑在云服务器上）。
 *
 * 桌面端（mobile-bridge）主动外连 /desktop，App 连 /app；relay 只做透传：
 *   App 的 {t:"req"} → 桌面，桌面的 {t:"res"} 按 client 号回给对应 App；
 *   桌面的 {t:"evt"} 广播给所有 App。
 *
 * 鉴权：token（env RELAY_TOKEN / config.json / 首次启动自动生成到 config.json）。
 * 附带：/health 健康检查、/app.apk 下发安装包、/ 状态页。
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");

const CONFIG_FILE = process.env.RELAY_CONFIG || path.join(__dirname, "config.json");
const APK_FILE = process.env.RELAY_APK || path.join(__dirname, "app.apk");
/** 版本元数据：与 APK 同目录的 version.json（发布脚本生成），App 用它判断有没有新版本。 */
const VERSION_FILE = process.env.RELAY_VERSION || path.join(path.dirname(APK_FILE), "version.json");
const PORT = Number(process.env.RELAY_PORT) || 8099;
const HOST = process.env.RELAY_HOST || "0.0.0.0";
const DEBUG = process.env.RELAY_DEBUG === "1";

// 死链回收：手机被 ROM 冻结、换网或进程被杀时，TCP 常常不会自己关，relay 只等
// close 事件就会攒下永远读不到数据的幽灵连接（云上实测同时挂过 4 条、内核积压
// 100KB+，App 的请求被转发到幽灵链路上，表现就是「连着但收不到东西」）。
// 桌面和 App 都会对应用层 ping 回 pong，所以「最近收到过任何上行帧」就是可靠的
// 存活信号，不需要加新协议。
const IDLE_MS = Number(process.env.RELAY_IDLE_MS) || 90_000;
const SWEEP_MS = Number(process.env.RELAY_SWEEP_MS) || 25_000;
const MAX_BUFFER = Number(process.env.RELAY_MAX_BUFFER) || 4 * 1024 * 1024;

function log(line) {
  console.log(`[relay] ${new Date().toISOString()} ${line}`);
}

function loadConfig() {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    file = null;
  }
  if (!file || typeof file !== "object") file = {};
  let dirty = false;
  if (!file.token) {
    file.token = process.env.RELAY_TOKEN || crypto.randomBytes(18).toString("base64url");
    dirty = true;
  }
  if (dirty) {
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return file;
}

const config = loadConfig();
const TOKEN = process.env.RELAY_TOKEN || config.token;

// ── 状态 ──────────────────────────────────────────────────────────

let desktop = null; // { ws, since, info }
let seq = 0;
const apps = new Map(); // clientNo -> { ws, since, info }
/** 桌面侧请求 id（gN）→ 发起它的 App 与 App 侧原始 id，回包按此还原路由。 */
const pendingReq = new Map();

function authorized(req, url) {
  return url.searchParams.get("token") === TOKEN
    || String(req.headers["x-mcca-token"] || "") === TOKEN
    || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") === TOKEN;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function broadcastApps(list) {
  for (const { ws } of apps.values()) send(ws, { t: "apps", apps: list });
}

function sendToApps(obj) {
  for (const { ws } of apps.values()) send(ws, obj);
}

/** 桌面链路没了：把它身上在飞的转发请求当场判失败，别让 App 干等到自己的超时。 */
function failPending(reason) {
  for (const [gid, route] of pendingReq) {
    pendingReq.delete(gid);
    const target = apps.get(String(route.app));
    if (target) send(target.ws, { t: "res", id: route.id, ok: false, e: reason });
  }
}

/** 结束一条桌面链路。close 对半死连接可能永远等不到对端回应，所以补一刀 terminate。 */
function retireDesktop(record, reason) {
  if (!record) return;
  try { record.ws.close(4000, reason); } catch { /* ignore */ }
  try { record.ws.terminate(); } catch { /* ignore */ }
  if (desktop === record) {
    desktop = null;
    sendToApps({ t: "evt", m: "desktop", d: { online: false } });
  }
  failPending("桌面端已断开");
  log(`desktop retired: ${reason}`);
}

// ── HTTP 面 ───────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    const now = Date.now();
    const body = JSON.stringify({
      ok: true,
      desktop: desktop
        ? { online: true, since: desktop.since, idleSec: Math.round((now - desktop.lastSeen) / 1000), info: desktop.info || null }
        : { online: false },
      apps: apps.size,
      // 每条 App 链路多久没上行 + 发送积压：一眼分辨「在线」还是「幽灵连接」
      appIdle: [...apps.entries()].map(([id, record]) => ({
        id,
        idleSec: Math.round((now - record.lastSeen) / 1000),
        buffered: record.ws.bufferedAmount || 0,
      })),
      time: now,
    });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  if (url.pathname === "/app.apk") {
    if (!fs.existsSync(APK_FILE)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("app.apk not uploaded\n");
      return;
    }
    const stat = fs.statSync(APK_FILE);
    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": stat.size,
      "content-disposition": 'attachment; filename="mcca-mobile.apk"',
      "cache-control": "no-store",
    });
    fs.createReadStream(APK_FILE).pipe(res);
    return;
  }
  if (url.pathname === "/version.json") {
    // App 的「检查更新」入口：没有元数据时回落成“让 App 下载后再自比对”
    let payload = { ok: false, error: "version.json 未发布", apk: "/app.apk" };
    try {
      const parsed = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
      payload = { ok: true, ...parsed, apk: "/app.apk" };
    } catch {
      // 保持默认：App 会走“先下载再读包内版本号”的兜底
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === "/") {
    const html = `<!doctype html><meta charset="utf-8"><title>mcca relay</title>
<style>body{font-family:system-ui;background:#101014;color:#e8e8ef;padding:32px;line-height:1.7}
b{color:#8be9a8}.off{color:#ff8888}.on{color:#8be9a8}code{background:#1c1c24;padding:2px 6px;border-radius:6px}</style>
<h2>mcca relay</h2>
<p>桌面端：<span class="${desktop ? "on" : "off"}">${desktop ? `在线（${desktop.info && desktop.info.name ? desktop.info.name : "mcca"}）` : "离线"}</span>
 · 手机端连接数：${apps.size}</p>
<p>App 下载：<a href="/app.apk">/app.apk</a>（在手机浏览器打开本页同域链接）</p>
<p>App 端填中转地址：<code>${(req.headers.host || "").replace(/:\d+$/, "")}${PORT === 80 ? "" : ":" + PORT}</code>，token 与桌面 <code>config/mobile.json</code> 一致。</p>
`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
});

// ── WebSocket 面 ──────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://x");
  const kind = url.pathname === "/desktop" ? "desktop" : url.pathname === "/app" ? "app" : "";
  if (!kind || !authorized(req, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (kind === "desktop") attachDesktop(ws);
    else attachApp(ws);
  });
});

let clientNo = 0;

function attachDesktop(ws) {
  const record = { ws, since: Date.now(), info: null, lastSeen: Date.now() };
  const previous = desktop;
  desktop = record;
  if (previous) retireDesktop(previous, "被新的桌面连接替换");
  log("desktop connected");
  sendToApps({ t: "evt", m: "desktop", d: { online: true } });
  broadcastApps([...apps.keys()]);

  ws.on("message", (data) => {
    record.lastSeen = Date.now();
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      record.info = msg.d || null;
      log(`desktop hello: ${JSON.stringify(msg.d || {})}`);
      return;
    }
    if (msg.t === "res") {
      const gid = String(msg.id || "");
      const route = pendingReq.get(gid);
      pendingReq.delete(gid);
      const target = route ? apps.get(String(route.app)) : null;
      if (DEBUG) log(`res ${gid} -> app#${route ? route.app : "?"} ${target ? "ok" : "MISSING"} ok=${msg.ok}`);
      if (target) send(target.ws, { t: "res", id: route.id, ok: msg.ok, d: msg.d, e: msg.e });
      return;
    }
    if (msg.t === "evt") {
      sendToApps(msg);
      return;
    }
    if (msg.t === "ping") {
      send(ws, { t: "pong" });
    }
  });
  ws.on("close", () => {
    if (desktop && desktop.ws === ws) {
      desktop = null;
      log("desktop disconnected");
      sendToApps({ t: "evt", m: "desktop", d: { online: false } });
      failPending("桌面端已断开");
    }
  });
  ws.on("error", () => { /* close 统一收尾 */ });
}

function attachApp(ws) {
  clientNo += 1;
  const id = String(clientNo);
  const record = { ws, since: Date.now(), info: null, lastSeen: Date.now() };
  apps.set(id, record);
  log(`app #${id} connected（${apps.size} 在线）`);
  send(ws, { t: "evt", m: "desktop", d: { online: Boolean(desktop) } });
  broadcastApps([...apps.keys()]);

  ws.on("message", (data) => {
    record.lastSeen = Date.now();
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      const current = apps.get(id);
      if (current) current.info = msg.d || null;
      send(ws, {
        t: "res",
        id: "relay-hello",
        ok: true,
        d: { relay: true, desktopOnline: Boolean(desktop), desktop: desktop ? desktop.info : null },
      });
      return;
    }
    if (msg.t === "req") {
      if (!desktop) {
        send(ws, { t: "res", id: msg.id, ok: false, e: "桌面端未连接" });
        return;
      }
      seq += 1;
      const gid = `g${seq}`;
      pendingReq.set(gid, { app: id, id: msg.id, at: Date.now() });
      if (DEBUG) log(`req ${msg.m} app#${id} -> desktop as ${gid}`);
      send(desktop.ws, { t: "req", id: gid, m: msg.m, p: msg.p });
      return;
    }
    if (msg.t === "ping") send(ws, { t: "pong" });
  });
  ws.on("close", () => {
    apps.delete(id);
    for (const [gid, route] of pendingReq) {
      if (String(route.app) === id) pendingReq.delete(gid);
    }
    log(`app #${id} disconnected（${apps.size} 在线）`);
    broadcastApps([...apps.keys()]);
  });
  ws.on("error", () => { /* close 统一收尾 */ });
}

// 双向心跳 + 死链回收：ws 库自动回 pong，但应用层也保活（云上常有闲置断开）；
// 收到过上行帧就算活着，超过 IDLE_MS 没动静（或发送积压到上限）直接掐掉。
setInterval(() => {
  const now = Date.now();
  if (desktop) {
    if (now - desktop.lastSeen > IDLE_MS) retireDesktop(desktop, `${Math.round((now - desktop.lastSeen) / 1000)}s 无上行`);
    else send(desktop.ws, { t: "ping", time: now });
  }
  for (const [id, record] of apps) {
    const idle = now - record.lastSeen > IDLE_MS;
    const backedUp = (record.ws.bufferedAmount || 0) > MAX_BUFFER;
    if (idle || backedUp) {
      log(`app #${id} 死链回收（${idle ? `${Math.round((now - record.lastSeen) / 1000)}s 无上行` : "发送积压"}）`);
      try { record.ws.close(4001, "inactive"); } catch { /* ignore */ }
      try { record.ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    send(record.ws, { t: "ping", time: now });
  }
}, SWEEP_MS).unref();

// 超时未回包的转发请求清掉，避免桌面端卡死时 pendingReq 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [gid, route] of pendingReq) {
    if (now - route.at > 10 * 60_000) pendingReq.delete(gid);
  }
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`token: ${TOKEN}`);
  log(`desktop ws: ws://<host>:${PORT}/desktop?token=...  app ws: /app?token=...`);
});
