"use strict";

/**
 * @pi-dsh-bridge/pi-web — 原生 Web 服务（:3458）。
 *
 * 静态资源（public/）+ 简单 REST + SSE。所有会话/模型/服务商操作走 bridge。
 * 会话事件经 /api/sessions/:id/stream 的 SSE 推送（先回放已缓冲帧再接实时）。
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PI_WEB_PORT || process.env.PI_PORT || 3458);
const ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const BODY_LIMIT = 1024 * 1024;

const { PiWebBridge, THINKING_LEVELS } = require("./bridge.cjs");
const bridge = new PiWebBridge();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

process.on("uncaughtException", (error) => {
  console.error("[pi-web] uncaught (suppressed):", error && error.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[pi-web] unhandled rejection (suppressed):", reason instanceof Error ? reason.message : String(reason));
});

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        req.destroy();
        resolve(null);
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// ── 文件系统面：消息里的路径可点击（查看文件/进入目录） ───────────
const FILE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
};

function safeResolvePath(raw) {
  try {
    return path.resolve(String(raw ?? ""));
  } catch {
    return null;
  }
}

/** 仅允许本站来源读取任意工作区文件（阻断外网页面借 localhost 读盘）。 */
function sameOriginGuard(req, res) {
  const site = String(req.headers["sec-fetch-site"] ?? "none");
  if (site === "cross-site") {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("cross-site forbidden");
    return false;
  }
  return true;
}

function fsExists(rawPath) {
  const p = safeResolvePath(rawPath);
  if (!p || !fs.existsSync(p)) return { file: false, dir: false };
  const st = fs.statSync(p);
  return { file: st.isFile(), dir: st.isDirectory(), path: p };
}

function fsList(rawPath) {
  const p = safeResolvePath(rawPath);
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return null;
  const entries = [];
  for (const name of fs.readdirSync(p)) {
    if (name.startsWith(".")) continue;
    let dir = false;
    let size = 0;
    try {
      const st = fs.statSync(path.join(p, name));
      dir = st.isDirectory();
      size = st.size;
    } catch {
      // 无权限的条目照样列出
    }
    entries.push({ name, dir, size });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { cwd: p, entries };
}

function serveFile(rawPath, res) {
  const p = safeResolvePath(rawPath);
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("file not found");
    return;
  }
  // html/svg 一律按纯文本下发：工作区文件不可信，避免在本站执行
  const ext = path.extname(p).toLowerCase();
  const type = ext === ".html" || ext === ".htm" || ext === ".svg"
    ? "text/plain; charset=utf-8"
    : FILE_MIME[ext] || (/\.(txt|md|json|js|mjs|cjs|css|ts|jsx|tsx|py|yml|yaml|toml|ini|log|c|cpp|h|go|rs|java|sh|bat|cmd|ps1|xml|csv)$/.test(ext) ? "text/plain; charset=utf-8" : "application/octet-stream");
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    // ── API ───────────────────────────────────────────────────────
    if (parts[0] === "api") {
      if (parts[1] === "sessions" && req.method === "GET" && !parts[2]) {
        return sendJson(res, 200, { sessions: await bridge.list() });
      }
      if (parts[1] === "sessions" && req.method === "POST" && !parts[2]) {
        const body = await readBody(req);
        const r = await bridge.create({ cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : undefined });
        return sendJson(res, r.ok === false ? r.status || 400 : 200, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "history" && req.method === "GET") {
        const h = await bridge.history(parts[2]);
        if (!h) return sendJson(res, 404, { error: "session not found" });
        return sendJson(res, 200, h);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "stream" && req.method === "GET") {
        return void bridge.subscribe(parts[2], res);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "prompt" && req.method === "POST") {
        const body = await readBody(req);
        // 图片附件：base64 data + mimeType，最多 8 张、单张 data ≤ 12M 字符
        let images;
        if (Array.isArray(body.images)) {
          images = body.images
            .filter((im) => im && typeof im.data === "string" && typeof im.mimeType === "string" && im.mimeType.startsWith("image/"))
            .slice(0, 8)
            .map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }));
          if (images.some((im) => im.data.length > 12_000_000)) {
            return sendJson(res, 413, { ok: false, error: "图片过大（单张 base64 上限 12MB）" });
          }
          if (!images.length) images = undefined;
        }
        const r = await bridge.prompt(parts[2], body.text, images);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (parts[1] === "compaction-model" && req.method === "GET") {
        return sendJson(res, 200, { compactionModel: bridge.getCompactionModel() });
      }
      if (parts[1] === "compaction-model" && req.method === "POST") {
        const body = await readBody(req);
        const r = await bridge.setCompactionModel(body);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "client-error" && req.method === "POST") {
        const body = await readBody(req);
        console.log(`[pi-web] client: ${JSON.stringify(body)}`);
        return sendJson(res, 200, { ok: true });
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "edit" && req.method === "POST") {
        const body = await readBody(req);
        console.log(`[pi-web] edit request: session=${parts[2]} entry=${body.entryId} text=${String(body.text ?? "").slice(0, 30)}`);
        const r = await bridge.editPrompt(parts[2], body.entryId, body.text);
        console.log(`[pi-web] edit result: ${JSON.stringify(r)}`);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "stop" && req.method === "POST") {
        return sendJson(res, 200, await bridge.stop(parts[2]));
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "compact" && req.method === "POST") {
        const r = await bridge.compact(parts[2]);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "rename" && req.method === "POST") {
        const body = await readBody(req);
        const r = await bridge.rename(parts[2], body.title);
        return sendJson(res, r.ok ? 200 : 404, r);
      }
      if (parts[1] === "sessions" && parts[2] && req.method === "DELETE" && !parts[3]) {
        const r = await bridge.remove(parts[2]);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "model" && req.method === "POST") {
        const body = await readBody(req);
        const r = await bridge.setModel(parts[2], body.provider, body.modelId ?? body.model);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "thinking" && req.method === "POST") {
        const body = await readBody(req);
        const r = await bridge.setThinking(parts[2], body.level);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "thinking" && parts[4] === "levels" && req.method === "GET") {
        const r = await bridge.thinkingInfo(parts[2]);
        return sendJson(res, r.ok ? 200 : r.status || 404, r);
      }
      if (parts[1] === "models" && req.method === "GET") {
        return sendJson(res, 200, { groups: await bridge.catalog(), levels: THINKING_LEVELS });
      }
      if (parts[1] === "subagents" && req.method === "GET") return sendJson(res, 200, { agents: await bridge.listSubagents(url.searchParams.get("cwd") || undefined) });
      if (parts[1] === "subagents" && req.method === "PUT") {
        const body = await readBody(req);
        const action = body.action;
        if (!["create", "update", "enable", "disable", "reset"].includes(action)) return sendJson(res, 400, { ok: false, error: "Unknown action: " + (action || "") });
        const r = await bridge.manageSubagent(action, body, body.cwd || undefined);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "subagents" && req.method === "GET" && !parts[4]) {
        const r = await bridge.subagentStatus(parts[2]);
        return sendJson(res, r ? 200 : 404, r || { error: "session not found" });
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "subagents" && parts[4] && parts[5] === "stop" && req.method === "POST") {
        const r = await bridge.stopSubagent(parts[2], decodeURIComponent(parts[4]));
        return sendJson(res, r.ok ? 200 : (r.status || 400), r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "subagents" && parts[4] && parts[5] === "transcript" && req.method === "GET") {
        const r = await bridge.subagentTranscript(parts[2], decodeURIComponent(parts[4]));
        return sendJson(res, r ? 200 : 404, r || { error: "subagent conversation not found" });
      }
      if (parts[1] === "providers" && req.method === "GET" && !parts[2]) {
        return sendJson(res, 200, { providers: await bridge.providers() });
      }
      if (parts[1] === "providers" && parts[2] === "discover" && parts[3] === "models" && req.method === "POST") {
        const body = await readBody(req);
        const r = await bridge.discoverModels(body);
        return sendJson(res, r.error ? 400 : 200, r);
      }
      if (parts[1] === "providers" && parts[2] && req.method === "PUT" && !parts[3]) {
        const body = await readBody(req);
        const r = await bridge.saveProvider(decodeURIComponent(parts[2]), body);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "providers" && parts[2] && req.method === "DELETE" && !parts[3]) {
        const r = await bridge.deleteProvider(decodeURIComponent(parts[2]));
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "workspaces" && req.method === "GET" && !parts[2]) {
        return sendJson(res, 200, { workspaces: await bridge.workspaces() });
      }
      if (parts[1] === "workspaces" && req.method === "POST" && !parts[2]) {
        const body = await readBody(req);
        const r = bridge.addWorkspace(body.path, body.title);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "workspaces" && req.method === "DELETE" && !parts[2]) {
        const r = bridge.removeWorkspace(url.searchParams.get("path") ?? "");
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "context" && req.method === "GET") {
        const r = await bridge.contextInfo(parts[2]);
        return sendJson(res, r.ok ? 200 : r.status || 404, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "diff" && req.method === "GET") {
        const r = await bridge.sessionDiff(parts[2]);
        return sendJson(res, r ? 200 : 404, r || { error: "session not found" });
      }
      if (parts[1] === "env" && req.method === "GET") {
        return sendJson(res, 200, await bridge.envInfo());
      }
      if (parts[1] === "presets" && req.method === "GET" && !parts[2]) {
        return sendJson(res, 200, await bridge.presetsView());
      }
      if (parts[1] === "presets" && parts[2] === "save" && req.method === "POST") {
        const body = await readBody(req);
        const r = await bridge.savePresets(body);
        return sendJson(res, 200, r);
      }
      if (parts[1] === "fs" && parts[2] === "write" && req.method === "POST") {
        const body = await readBody(req);
        const r = bridge.writeContextFile(body.file, body.content);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "fs" && parts[2] === "exists" && req.method === "GET") {
        return sendJson(res, 200, fsExists(url.searchParams.get("path")));
      }
      if (parts[1] === "fs" && parts[2] === "list" && req.method === "GET") {
        const r = fsList(url.searchParams.get("path"));
        return sendJson(res, r ? 200 : 404, r || { error: "目录不存在" });
      }
      if (parts[1] === "file" && req.method === "GET") {
        if (!sameOriginGuard(req, res)) return;
        return serveFile(url.searchParams.get("path"), res);
      }
      if (parts[1] === "preview" && req.method === "GET") {
        // HTML 预览：按 text/html 下发，但 CSP sandbox 隔离（不透明源 + 只开脚本/表单），
        // 工作区文件不可信，绝不能拿到本站会话凭据
        if (!sameOriginGuard(req, res)) return;
        const p = safeResolvePath(url.searchParams.get("path"));
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("file not found");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "sandbox allow-scripts allow-modals allow-forms",
          "cache-control": "no-store",
        });
        return fs.createReadStream(p).pipe(res);
      }
      if (parts[1] === "health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, sessions: bridge.sessions.size });
      }
      return sendJson(res, 404, { error: `no api route: ${req.method} ${url.pathname}` });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }

    // ── 静态资源 ──────────────────────────────────────────────────
    let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const target = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (target.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : fs.readFileSync(target));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  console.log(`pi-web → http://127.0.0.1:${addr.port}`);
  // 进程预热：后台建一个丢弃会话，把 SDK 导入、插件/MCP 装载提前完成。
  const t0 = Date.now();
  bridge
    .create({ warmup: true })
    .then(() => console.log(`[pi-web] warmup complete in ${Date.now() - t0}ms`))
    .catch((error) => console.error("[pi-web] warmup failed:", error instanceof Error ? error.message : String(error)));
});
