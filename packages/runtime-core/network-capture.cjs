"use strict";
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), https = require("node:https"), net = require("node:net");
const { randomUUID } = require("node:crypto");
const { writeJson } = require("./paths.cjs");
const BODY_LIMIT = 256 * 1024, DISK_LIMIT = 64 * 1024 * 1024;
function createNetworkCapture({ paths, android }) {
  const root = path.join(paths.state, "captures"), ledger = path.join(root, "sessions.json");
  const rows = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf8")).sessions : [], live = new Map(), starting = new Set();
  for (const r of rows) if (["running", "starting"].includes(r.state)) r.state = "needs_restore";
  let startQueue = Promise.resolve(); const stopping = new Map();
  const save = () => writeJson(ledger, { schemaVersion: 1, sessions: rows });
  const shell = (serial, args) => android.call({ action: "shell", serial, args });
  const proxy = serial => shell(serial, ["settings", "get", "global", "http_proxy"]).then(s => String(s).trim());
  function persist(row, event) {
    const text = JSON.stringify(event) + "\n", bytes = Buffer.byteLength(text);
    if (row.bytes + bytes > DISK_LIMIT || row.count >= 1000) { row.truncated = true; return; }
    fs.appendFileSync(row.file, text); row.bytes += bytes; row.count++; save();
  }
  async function restore(row) {
    if (!row.serial || !row.proxy) return;
    const current = await proxy(row.serial);
    if (current === row.proxy) await shell(row.serial, row.previousProxy === "null" ? ["settings", "delete", "global", "http_proxy"] : ["settings", "put", "global", "http_proxy", row.previousProxy]);
    if (row.reverseOwned) { await android.call({ action: "reverse", serial: row.serial, localPort: row.port, remotePort: row.port, remove: true }); row.reverseOwned = false; }
  }
  async function stopNow(id) {
    const row = rows.find(r => r.id === id); if (!row) throw new Error("抓包会话不存在");
    const active = live.get(id);
    if (active) { clearTimeout(active.timer); for (const socket of active.sockets) socket.destroy(); await new Promise(r => active.server.close(r)); live.delete(id); }
    try { await restore(row); row.state = "stopped"; row.error = null; }
    catch (error) { row.state = "needs_restore"; row.error = "设备代理待恢复：" + error.message; }
    row.endedAt = Date.now(); save(); return { ...row };
  }
  function stop(id) {
    if (stopping.has(id)) return stopping.get(id);
    const operation = stopNow(id).finally(() => stopping.delete(id)); stopping.set(id, operation); return operation;
  }
  const ready = Promise.allSettled(rows.filter(r => r.state === "needs_restore").map(r => stop(r.id)));
  async function start(a) {
    if (live.size >= 4 || rows.length >= 200) throw new Error("抓包会话上限已到达");
    if (a.serial && (starting.has(a.serial) || rows.some(r => r.serial === a.serial && ["running", "needs_restore"].includes(r.state)))) throw new Error("设备已有抓包或待恢复代理，请先停止/恢复");
    const minutes = a.minutes ?? 30; if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("时长需要 1–1440 分钟");
    if (a.serial) starting.add(a.serial);
    let row, server; const sockets = new Set();
    try {
      const previousProxy = a.serial ? await proxy(a.serial) : null;
      fs.mkdirSync(root, { recursive: true });
      row = { id: randomUUID(), state: "starting", serial: a.serial || null, previousProxy, at: Date.now(), count: 0, bytes: 0, truncated: false, reverseOwned: false, mode: "http-connect" };
      row.file = path.join(root, row.id + ".jsonl"); fs.writeFileSync(row.file, ""); rows.push(row); save();
      server = http.createServer((req, res) => {
        let url; try { url = new URL(req.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { res.writeHead(400); res.end("Absolute HTTP URL required"); return; }
        if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && Number(url.port) === row.port) { res.writeHead(400); res.end("Proxy loop"); return; }
        const event = { id: randomUUID(), at: Date.now(), method: req.method, url: url.href, requestHeaders: req.headers, kind: "http" };
        const requestBody = [], responseBody = []; let requestBytes = 0, responseBytes = 0, recorded = false;
        const finish = () => { if (recorded) return; recorded = true; event.durationMs = Date.now() - event.at; event.requestBody = Buffer.concat(requestBody).toString("base64"); event.responseBody = Buffer.concat(responseBody).toString("base64"); event.requestBytes = requestBytes; event.responseBytes = responseBytes; event.bodyTruncated = requestBytes > BODY_LIMIT || responseBytes > BODY_LIMIT; persist(row, event); };
        const headers = { ...req.headers, host: url.host }; delete headers["proxy-connection"]; delete headers["proxy-authorization"];
        const upstream = (url.protocol === "https:" ? https : http).request(url, { method: req.method, headers, timeout: 30000 }, response => {
          event.status = response.statusCode; event.responseHeaders = response.headers; res.writeHead(response.statusCode, response.headers);
          response.on("data", chunk => { if (responseBytes < BODY_LIMIT) responseBody.push(chunk.subarray(0, BODY_LIMIT - responseBytes)); responseBytes += chunk.length; });
          response.on("end", finish); response.on("error", error => { event.error = error.message; finish(); res.destroy(); }); response.pipe(res);
        });
        req.on("data", chunk => { if (requestBytes < BODY_LIMIT) requestBody.push(chunk.subarray(0, BODY_LIMIT - requestBytes)); requestBytes += chunk.length; });
        req.on("aborted", () => upstream.destroy());
        res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
        upstream.on("timeout", () => upstream.destroy(new Error("Upstream timeout")));
        upstream.on("error", error => { event.error = error.message; finish(); if (!res.headersSent) res.writeHead(502); res.end(); });
        upstream.on("socket", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); }); req.pipe(upstream);
      });
      server.on("connect", (req, socket, head) => {
        let url; try { url = new URL("https://" + req.url); if (!url.hostname || url.username || url.password || (Number(url.port) === row.port && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error(); } catch { socket.destroy(); return; }
        const event = { id: randomUUID(), at: Date.now(), method: "CONNECT", url: req.url, kind: "tls-tunnel", note: "加密隧道，不解密 HTTPS 正文", uploadBytes: head.length, downloadBytes: 0 };
        const upstream = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 443 }); sockets.add(upstream);
        upstream.setTimeout(30000); upstream.on("timeout", () => upstream.destroy());
        upstream.once("connect", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
        socket.on("data", b => { event.uploadBytes += b.length; }); upstream.on("data", b => { event.downloadBytes += b.length; });
        socket.on("close", () => upstream.destroy()); upstream.on("error", error => { event.error = error.message; socket.destroy(); });
        upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); event.durationMs = Date.now() - event.at; persist(row, event); });
      });
      server.on("connection", socket => { if (sockets.size >= 128) { socket.destroy(); return; } sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
      server.on("clientError", (_, socket) => socket.destroy());
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      row.port = server.address().port; row.proxy = "127.0.0.1:" + row.port; save();
      if (a.serial) { await android.call({ action: "reverse", serial: a.serial, localPort: row.port, remotePort: row.port }); row.reverseOwned = true; save(); await shell(a.serial, ["settings", "put", "global", "http_proxy", row.proxy]); }
      row.state = "running"; const timer = setTimeout(() => void stop(row.id).catch(() => {}), minutes * 60000); timer.unref();
      live.set(row.id, { server, sockets, timer }); save(); return { ...row };
    } catch (error) {
      if (server) { for (const socket of sockets) socket.destroy(); server.close(); }
      if (row) { try { await restore(row); row.state = "failed"; } catch { row.state = "needs_restore"; } row.error = error.message; save(); }
      throw error;
    } finally { if (a.serial) starting.delete(a.serial); }
  }
  async function call(a) {
    await ready;
    if (a.action === "list") return rows.map(r => ({ ...r })).reverse();
    if (a.action === "start") { const next = startQueue.catch(() => {}).then(() => start(a)); startQueue = next; return next; }
    if (["stop", "restore"].includes(a.action)) return stop(a.id);
    const row = rows.find(r => r.id === a.id); if (!row) throw new Error("抓包会话不存在");
    const records = fs.readFileSync(row.file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    if (a.action === "flows") return { count: records.length, truncated: row.truncated, flows: records.slice(-100).map(({ requestBody, responseBody, requestHeaders, responseHeaders, ...r }) => r) };
    if (a.action === "detail") { const flow = records.find(r => r.id === a.flow); if (!flow) throw new Error("请求不存在"); return flow; }
    if (a.action === "export") return { file: row.file, format: "JSONL", count: records.length, https: "CONNECT metadata only; bodies remain encrypted" };
    throw new Error("未知抓包操作");
  }
  return { call, async dispose() { await ready; await startQueue.catch(() => {}); await Promise.allSettled([...live.keys()].map(stop)); } };
}
module.exports = { createNetworkCapture };
