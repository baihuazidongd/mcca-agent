"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const piProviders = require("../pi-web/pi-providers.cjs");
const { OpenHandsBridge } = require("./bridge.cjs");

const PORT = Number(process.env.OH_WEB_PORT || process.env.OPENHANDS_PORT || 3460);
const PUBLIC_DIR = path.resolve(__dirname, "..", "pi-web", "public");
const bridge = new OpenHandsBridge();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function sendJson(res, status, value) {
  if (!res || res.headersSent) return;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function indexHtml() {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  return raw
    .replace("<title>PI 编程助手</title>", "<title>OpenHands · PI 编程助手</title>")
    .replace("</head>", '  <script>window.__MCCA_RUNTIME__="openhands";</script>\n</head>');
}

function safeResolvePath(rawPath) {
  try { return path.resolve(String(rawPath ?? "")); } catch { return null; }
}

function openInFileManager(rawPath) {
  const target = safeResolvePath(String(rawPath || "").trim());
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { ok: false, error: "目录不存在" };
  const [cmd, args] = process.platform === "win32" ? ["explorer", [target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); }
  catch (error) { return { ok: false, error: error.message }; }
  return { ok: true, path: target };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (parts[0] === "api") {
      if (parts[1] === "health" && req.method === "GET") return sendJson(res, 200, { ok: true, runtime: "openhands" });
      if (parts[1] === "sessions" && req.method === "GET" && !parts[2]) return sendJson(res, 200, { sessions: await bridge.list() });
      if (parts[1] === "sessions" && parts[2] === "running" && req.method === "GET") return sendJson(res, 200, { sessions: await bridge.runningSessions() });
      if (parts[1] === "sessions" && req.method === "POST" && !parts[2]) {
        const body = await readBody(req);
        const created = await bridge.create(body);
        return sendJson(res, created.ok === false ? 400 : 200, created);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "history" && req.method === "GET") {
        const history = await bridge.history(decodeURIComponent(parts[2]));
        return sendJson(res, 200, history);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "stream" && req.method === "GET") {
        const id = decodeURIComponent(parts[2]);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const seen = new Set();
        let wasRunning = false;
        const tick = async () => {
          if (res.writableEnded) return;
          try {
            const frames = await bridge.events(id);
            for (const frame of frames) {
              if (seen.has(frame.id)) continue;
              seen.add(frame.id);
              res.write(`data: ${JSON.stringify(frame)}\n\n`);
            }
            const info = await bridge.conversation(id);
            const status = String(info && info.execution_status || "");
            const running = status === "running" || status === "waiting_for_confirmation";
            if (wasRunning && !running) {
              res.write(`data: ${JSON.stringify({ id: `oh-turn:${Date.now()}`, event: { type: "turn-end" } })}\n\n`);
            }
            wasRunning = running;
            res.write(`data: ${JSON.stringify({ id: `oh-status:${Date.now()}`, event: { type: "status", status: running ? "working" : "idle" } })}\n\n`);
          } catch { /* 下一拍再试 */ }
        };
        await tick();
        const timer = setInterval(tick, 1000);
        req.on("close", () => clearInterval(timer));
        return;
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "prompt" && req.method === "POST") {
        const body = await readBody(req);
        const result = await bridge.prompt(decodeURIComponent(parts[2]), body.text);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "stop" && req.method === "POST") {
        return sendJson(res, 200, await bridge.stop(decodeURIComponent(parts[2])));
      }
      if (parts[1] === "sessions" && parts[2] && req.method === "DELETE" && !parts[3]) {
        return sendJson(res, 200, await bridge.remove(decodeURIComponent(parts[2])));
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "model" && req.method === "POST") {
        const body = await readBody(req);
        const result = await bridge.setModel(decodeURIComponent(parts[2]), body.provider, body.modelId);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "thinking" && req.method === "POST") {
        return sendJson(res, 200, { ok: true, level: "medium" });
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "context" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, contextWindow: null });
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "diff" && req.method === "GET") {
        return sendJson(res, 200, { files: [] });
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "subagents" && req.method === "GET") {
        return sendJson(res, 200, { agents: [], runs: [] });
      }
      if (parts[1] === "sessions" && parts[2] && req.method === "GET" && !parts[3]) {
        const history = await bridge.history(decodeURIComponent(parts[2]));
        return sendJson(res, 200, history.session);
      }
      if (parts[1] === "models" && req.method === "GET") return sendJson(res, 200, bridge.catalog());
      if (parts[1] === "subagents" && req.method === "GET") return sendJson(res, 200, { agents: [] });
      if (parts[1] === "presets" && req.method === "GET") return sendJson(res, 200, { presets: [], contextFiles: [] });
      if (parts[1] === "providers" && req.method === "GET" && !parts[2]) return sendJson(res, 200, { providers: piProviders.publicProviders() });
      if (parts[1] === "providers" && parts[2] === "discover" && parts[3] === "models" && req.method === "POST") {
        const body = await readBody(req);
        const found = await piProviders.discoverModels(body);
        return sendJson(res, found.error ? 400 : 200, found);
      }
      if (parts[1] === "providers" && parts[2] && req.method === "PUT" && !parts[3]) {
        const body = await readBody(req);
        const saved = piProviders.saveProvider(decodeURIComponent(parts[2]), body);
        return sendJson(res, saved.ok ? 200 : saved.status || 400, saved);
      }
      if (parts[1] === "providers" && parts[2] && req.method === "DELETE" && !parts[3]) {
        const removed = piProviders.deleteProvider(decodeURIComponent(parts[2]));
        return sendJson(res, removed.ok ? 200 : removed.status || 400, removed);
      }
      if (parts[1] === "compaction-model" && req.method === "GET") return sendJson(res, 200, { compactionModel: null });
      if (parts[1] === "workspaces" && req.method === "GET") return sendJson(res, 200, { workspaces: bridge.workspaces() });
      if (parts[1] === "workspaces" && req.method === "POST") {
        const body = await readBody(req);
        const result = bridge.addWorkspace(body.path, body.title);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }
      if (parts[1] === "workspaces" && req.method === "DELETE") {
        return sendJson(res, 200, bridge.removeWorkspace(url.searchParams.get("path") || ""));
      }
      if (parts[1] === "reveal" && req.method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 200, openInFileManager(body.path));
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "rename" && req.method === "POST") {
        const body = await readBody(req);
        const result = await bridge.rename(decodeURIComponent(parts[2]), body.title);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (parts[1] === "compaction-model" && req.method === "POST") return sendJson(res, 200, { ok: true, compactionModel: null });
      if (parts[1] === "client-error" && req.method === "POST") return sendJson(res, 200, { ok: true });
      if (parts[1] === "sessions" && parts[2] && parts[3] === "enqueue" && req.method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 200, await bridge.prompt(decodeURIComponent(parts[2]), body.text));
      }
      return sendJson(res, 404, { error: `no api route: ${req.method} ${url.pathname}` });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const body = Buffer.from(indexHtml(), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    const target = path.normalize(path.join(PUBLIC_DIR, url.pathname));
    if (!target.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const body = fs.readFileSync(target);
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
      "content-length": body.length,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

process.on("exit", () => bridge.stopAgent());
server.on("close", () => bridge.stopAgent());

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  console.log(`openhands-web → http://127.0.0.1:${addr.port}`);
  const started = Date.now();
  bridge.ready()
    .then(() => console.log(`[openhands-web] agent-server ready in ${Date.now() - started}ms`))
    .catch((error) => console.error(`[openhands-web] agent-server failed: ${error.message}`));
});
