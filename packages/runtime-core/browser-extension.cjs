"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { WebSocketServer } = require("ws");
const { writeJson } = require("./paths.cjs");
const digest = value => createHash("sha256").update(value).digest("hex");
function createExtensionBridge({ paths, port }) {
  const file = path.join(paths.state, "browser-extensions.json");
  let credentials = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).credentials : [];
  if (!Array.isArray(credentials)) throw new Error("Invalid browser extension credentials");
  const clients = new Map(), pending = new Map(); let pairing;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  function pair() {
    pairing = { code: randomBytes(24).toString("hex"), expires: Date.now() + 120000 };
    return { ...pairing, port, directory: path.join(paths.app, "packages/browser-extension"), instructions: "在 Edge/Chrome 扩展页打开开发者模式，加载此目录。点击扩展输入端口与配对码，再在目标网页点击允许当前标签页。" };
  }
  function list() { return credentials.map(c => ({ id: c.id, origin: c.origin, connected: clients.has(c.id), pages: clients.get(c.id)?.pages || [] })); }
  wss.on("connection", (ws, req) => {
    let client;
    const authTimer = setTimeout(() => ws.close(1008, "Authentication timeout"), 5000);
    ws.on("error", () => {});
    ws.on("message", raw => {
      try {
        const data = JSON.parse(String(raw));
        if (!client) {
          let credential;
          if (typeof data.code === "string" && pairing && pairing.expires > Date.now() && digest(data.code) === digest(pairing.code)) {
            if (credentials.length >= 16) throw new Error("Too many paired browsers");
            const token = randomBytes(32).toString("hex");
            credential = { id: randomUUID(), hash: digest(token), origin: req.headers.origin };
            credentials.push(credential); writeJson(file, { schemaVersion: 1, credentials }); pairing = null;
            ws.send(JSON.stringify({ type: "paired", token, id: credential.id }));
          } else if (typeof data.token === "string") credential = credentials.find(c => c.hash === digest(data.token) && c.origin === req.headers.origin);
          if (!credential) throw new Error("Unauthorized extension");
          const previous = clients.get(credential.id); if (previous) previous.ws.close(1008, "Reconnected");
          client = { id: credential.id, ws, pages: [], queue: Promise.resolve() }; clients.set(client.id, client);
          clearTimeout(authTimer); ws.send(JSON.stringify({ type: "ready", id: client.id })); return;
        }
        if (data.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
        if (data.type === "pages") {
          if (!Array.isArray(data.pages) || data.pages.length > 50) throw new Error("Invalid tabs");
          client.pages = data.pages.filter(p => Number.isInteger(p.id) && /^https?:\/\//.test(p.url || "")).map(p => ({ id: String(p.id), title: String(p.title || "").slice(0, 300), url: p.url.slice(0, 4000) })); return;
        }
        const waiting = pending.get(data.id);
        if (!waiting || waiting.client !== client) return;
        clearTimeout(waiting.timer); pending.delete(data.id);
        if (data.error) waiting.reject(new Error(String(data.error))); else waiting.resolve(data.result);
      } catch { ws.close(1008, "Invalid or unauthorized message"); }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (client && clients.get(client.id) === client) clients.delete(client.id);
      for (const [id, waiting] of pending) if (waiting.client === client) { clearTimeout(waiting.timer); pending.delete(id); waiting.reject(new Error("浏览器已断开；操作结果未知，请先检查页面，不要自动重试")); }
    });
  });
  function attach(server) {
    server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/api/workbench/browser-extension") return;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host) || !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || "") || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
    });
  }
  async function call(a) {
    if (a.action === "list") return list();
    if (a.action === "revoke") {
      credentials = credentials.filter(c => c.id !== a.browser); writeJson(file, { schemaVersion: 1, credentials });
      clients.get(a.browser)?.ws.close(1000, "Revoked"); return { revoked: a.browser };
    }
    const client = clients.get(a.browser); if (!client) throw new Error("浏览器扩展尚未连接");
    const operation = client.queue.catch(() => {}).then(() => {
      if (client.ws.readyState !== 1 || clients.get(client.id) !== client) throw new Error("浏览器连接已失效");
      if (!client.pages.some(p => p.id === a.page)) throw new Error("请选择用户已允许的标签页");
      if (pending.size >= 32) throw new Error("浏览器操作队列已满");
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { pending.delete(id); client.ws.close(1008, "Command timeout"); reject(new Error("浏览器操作超时；结果未知，请检查页面后再决定下一步")); }, 20000);
        pending.set(id, { client, resolve, reject, timer });
        client.ws.send(JSON.stringify({ type: "command", id, args: a }));
      });
    });
    client.queue = operation; return operation;
  }
  return { pair, list, attach, call, dispose() { for (const ws of wss.clients) ws.terminate(); wss.close(); } };
}
module.exports = { createExtensionBridge };
