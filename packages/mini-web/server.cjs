"use strict";

// One tiny HTTP server, one page, two drivers: `node server.cjs --tool=codex|grok`.
// The page talks REST + SSE; the driver is either CodexBridge (codex app-server over
// stdio) or GrokBridge (grok agent stdio over ACP).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const piProviders = require("../pi-web/pi-providers.cjs");
const { createCliProviders } = require("../portal/cli-provider.cjs");
const { GrokBridge } = require("../grok-web/bridge.cjs");
const { CodexBridge, findCodexBin } = require("./bridge-codex.cjs");

const TOOL = (process.argv.find((arg) => arg.startsWith("--tool=")) || "--tool=grok").split("=")[1];
const LABEL = { codex: "Codex", grok: "Grok Build" }[TOOL] || TOOL;
const PORT = Number(process.env.MCCA_MINI_PORT
  || (TOOL === "codex" ? process.env.CODEX_WEB_PORT || 3463 : process.env.GROK_WEB_PORT || process.env.GROK_PORT || 3461));
const paths = require("../runtime-core/paths.cjs").createPaths();
const ROOT = paths.app;
const PUBLIC_DIR = path.join(__dirname, "public");
const cli = createCliProviders({ root: ROOT });
const bridge = TOOL === "codex"
  ? new CodexBridge({ stateFile: path.join(paths.data, ".mini-web", "codex-state.json") })
  : new GrokBridge();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function redact(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…");
}

function sameOriginGuard(req, res) {
  if (String(req.headers["sec-fetch-site"] ?? "none") === "cross-site") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("cross-site forbidden");
    return false;
  }
  return true;
}

function safeResolvePath(rawPath) {
  try { return path.resolve(String(rawPath ?? "")); } catch { return null; }
}

function dirExists(rawPath) {
  const target = safeResolvePath(rawPath);
  if (!target) return null;
  try { return fs.statSync(target).isDirectory() ? target : null; } catch { return null; }
}

function fsList(rawPath) {
  const target = dirExists(rawPath);
  if (!target) return null;
  const entries = [];
  for (const name of fs.readdirSync(target)) {
    if (name.startsWith(".")) continue;
    let dir = false;
    try { dir = fs.statSync(path.join(target, name)).isDirectory(); } catch { continue; }
    if (dir) entries.push({ name, dir: true });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { cwd: target, parent: parent === target ? "" : parent, entries: entries.slice(0, 800) };
}

/** Provider/model the page should use when it doesn't name one: the shared cli selection. */
function selected() {
  const hit = (cli.readSelection() || {})[TOOL];
  if (hit) return hit;
  return { provider: "", modelId: "" };
}

function modelGroups() {
  return piProviders.publicProviders().map((row) => ({
    id: row.id,
    name: row.id,
    models: (row.entry.models || []).filter((model) => model && model.id).map((model) => ({
      id: model.id,
      name: model.name || model.id,
    })),
  }));
}

async function stream(req, res, id) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  // 游标是事件数组的下标，不是帧里的 seq：同一行更新可以映射出多帧（assistant-end
  // 和 turn-end 就来的一对），按 seq 过滤会把后面那帧吞掉，页面就永远停在「正在回答」。
  let cursor = Number(req.headers["last-event-id"] || url(req).searchParams.get("since")) || 0;
  const tick = async () => {
    if (res.writableEnded) return;
    let frames = [];
    try { frames = await bridge.events(id, 0); } catch { return; }
    if (frames.length < cursor) cursor = 0; // 服务端重启过，日志重排了
    for (let i = cursor; i < frames.length; i += 1) {
      res.write(`id: ${i + 1}\ndata: ${JSON.stringify(frames[i].event)}\n\n`);
    }
    cursor = Math.max(cursor, frames.length);
  };
  await tick();
  const timer = setInterval(tick, 300);
  req.on("close", () => clearInterval(timer));
}

function url(req) {
  return new URL(req.url ?? "/", "http://x");
}

const server = http.createServer(async (req, res) => {
  const parsed = url(req);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (!sameOriginGuard(req, res)) return;
  try {
    if (parts[0] === "api") {
      const method = req.method;
      if (parts[1] === "health") return sendJson(res, 200, { ok: true, tool: TOOL, label: LABEL, bin: TOOL === "codex" ? findCodexBin() : "grok" });
      if (parts[1] === "models") {
        const choice = selected();
        return sendJson(res, 200, { groups: modelGroups(), selection: choice, cli: TOOL === "codex" ? Boolean(findCodexBin()) : true });
      }
      if (parts[1] === "provider" && method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 200, cli.select(TOOL, body.provider, body.modelId));
      }
      if (parts[1] === "sessions" && !parts[2] && method === "GET") return sendJson(res, 200, { sessions: await bridge.list() });
      // 门户的事件板问这一条；没有它会被记成「这个服务连不上」。
      if (parts[1] === "sessions" && parts[2] === "running" && !parts[3] && method === "GET") {
        return sendJson(res, 200, { sessions: await bridge.runningSessions() });
      }
      if (parts[1] === "sessions" && !parts[2] && method === "POST") {
        const body = await readBody(req);
        const choice = selected();
        const provider = String(body.provider || choice.provider || "");
        const modelId = String(body.modelId || choice.modelId || "");
        if (!provider || !modelId) return sendJson(res, 400, { error: "先在上方选服务商和模型" });
        const cwd = dirExists(body.cwd) || dirExists(process.cwd());
        if (TOOL === "codex") {
          const created = await bridge.create({ cwd, provider, modelId, title: body.title });
          bridge.rememberMeta(created.id, cwd, provider, modelId);
          return sendJson(res, 200, created);
        }
        const created = await bridge.create({ cwd, provider, modelId });
        if (body.title) bridge.rename(created.id, body.title);
        return sendJson(res, 200, created);
      }
      const id = parts[2] ? decodeURIComponent(parts[2]) : "";
      if (parts[1] === "sessions" && id && !parts[3] && method === "GET") {
        const history = await bridge.history(id);
        return sendJson(res, history.ok === false ? history.status || 404 : 200, history.session || history);
      }
      if (parts[1] === "sessions" && id && parts[3] === "history" && method === "GET") {
        const history = await bridge.history(id);
        if (history.ok === false) return sendJson(res, history.status || 404, history);
        return sendJson(res, 200, history);
      }
      if (parts[1] === "sessions" && id && parts[3] === "stream" && method === "GET") return stream(req, res, id);
      if (parts[1] === "sessions" && id && parts[3] === "prompt" && method === "POST") {
        const body = await readBody(req);
        const result = await bridge.prompt(id, body.text);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }
      if (parts[1] === "sessions" && id && parts[3] === "stop" && method === "POST") {
        return sendJson(res, 200, await bridge.stop(id));
      }
      if (parts[1] === "sessions" && id && parts[3] === "rename" && method === "POST") {
        const body = await readBody(req);
        return sendJson(res, 200, bridge.rename(id, body.title));
      }
      if (parts[1] === "sessions" && id && parts[3] === "model" && method === "POST") {
        const body = await readBody(req);
        const result = await bridge.setModel(id, body.provider, body.modelId);
        if (result.ok) cli.select(TOOL, body.provider, body.modelId);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }
      if (parts[1] === "sessions" && id && method === "DELETE") {
        return sendJson(res, 200, await bridge.remove(id));
      }
      if (parts[1] === "workspaces" && method === "GET") return sendJson(res, 200, { workspaces: bridge.workspaces() });
      if (parts[1] === "workspaces" && method === "POST") {
        const body = await readBody(req);
        const result = bridge.addWorkspace(body.path, body.title);
        return sendJson(res, result.ok ? 200 : result.status || 400, result);
      }
      if (parts[1] === "workspaces" && method === "DELETE") {
        return sendJson(res, 200, bridge.removeWorkspace(parsed.searchParams.get("path") || ""));
      }
      if (parts[1] === "fs" && parts[2] === "list" && method === "GET") {
        const listed = fsList(parsed.searchParams.get("path") || process.cwd());
        return sendJson(res, listed ? 200 : 404, listed || { error: "目录不存在" });
      }
      if (parts[1] === "client-error") return sendJson(res, 200, { ok: true });
      return sendJson(res, 404, { error: `no api route: ${method} ${parsed.pathname}` });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const target = path.normalize(path.join(PUBLIC_DIR, parsed.pathname === "/" ? "index.html" : parsed.pathname));
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
    sendJson(res, 500, { error: redact(error) });
  }
});

process.on("exit", () => bridge.stopAll());
server.on("close", () => bridge.stopAll());

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  console.log(`mini-web[${TOOL}] → http://127.0.0.1:${addr.port}`);
});
