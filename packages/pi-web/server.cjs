"use strict";

/**
 * @mcca/pi-web — 原生 Web 服务（:3458）。
 *
 * 静态资源（public/）+ 简单 REST + SSE。所有会话/模型/服务商操作走 bridge。
 * 会话事件经 /api/sessions/:id/stream 的 SSE 推送（先回放已缓冲帧再接实时）。
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PI_WEB_PORT || process.env.PI_PORT || 3458);
const ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const BODY_LIMIT = 40 * 1024 * 1024; // 图片附件走 base64 JSON：前端单图上限 9M 字符，1MB 的旧上限会让「发图」直接断连（Failed to fetch）

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
  if (!res || res.headersSent) return; // 已经回过（如 413 超限）就别再写一次，避免二次写头抛错
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const wantsGzip = String((res.req && res.req.headers && res.req.headers["accept-encoding"]) || "").includes("gzip");
  // 大响应压缩：历史回放能有几 MB，gzip 后通常只剩 1/6，切换会话明显更快
  if (body.length > 64 * 1024 && wantsGzip) {
    zlib.gzip(body, (error, packed) => {
      if (error) {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-encoding": "gzip",
      });
      res.end(packed);
    });
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req, res) {
  return new Promise((resolve) => {
    let body = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      if (done) return;
      body += chunk;
      if (body.length > BODY_LIMIT) {
        // 超限不再 destroy（那样前端只会看到 Failed to fetch）：
        // 回 413 + 明确原因，并把剩余请求体丢掉
        if (res && !res.headersSent) {
          try {
            res.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, error: `请求体过大（超过 ${Math.round(BODY_LIMIT / 1048576)}MB）：附件太多或图片太大，请压缩后再发` }));
          } catch { /* 头已发就只丢弃 */ }
        }
        body = "";
        req.resume();
        finish({});
      }
    });
    req.on("end", () => {
      try {
        finish(JSON.parse(body || "{}"));
      } catch {
        finish({});
      }
    });
    req.on("error", () => finish({}));
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

/**
 * 在系统文件管理器里打开一个目录（工作区行的「打开文件夹」）。
 *
 * explorer 打开成功也会返回退出码 1，所以不看子进程结果；detached + unref
 * 是为了不把 portal 的进程树挂在 explorer 上。目录不存在/不是目录直接报错。
 */
function openInFileManager(rawPath) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) return { ok: false, error: "路径为空" };
  const p = safeResolvePath(raw);
  if (!p) return { ok: false, error: "路径无效" };
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return { ok: false, error: "目录不存在" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const [cmd, args] = process.platform === "win32"
    ? ["explorer", [p]]
    : process.platform === "darwin"
      ? ["open", [p]]
      : ["xdg-open", [p]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, path: p };
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

function serveFile(rawPath, res, req) {
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
  // 对话里的图片走这里：流式回复每来一个 delta 都会重建 markdown 节点，
  // no-store 会逼浏览器把每张图重下一遍（整文件读盘 + 重新解码），图片多的
  // 会话直接卡死页面。改成 no-cache + ETag：重复请求变 304，几字节就完事。
  let etag = "";
  try {
    const stat = fs.statSync(p);
    etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    if (req && req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": "no-cache" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache", etag, "last-modified": stat.mtime.toUTCString() });
  } catch {
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  }
  // 读取失败（文件被占用 / 中途删掉）要让浏览器知道：直接断掉连接，别把
  // 截断的响应当成功下发，否则图片会变成偶尔的破图、CSS 会变裸样式
  const stream = fs.createReadStream(p);
  stream.on("error", (error) => {
    console.error(`[pi-web] 文件读取失败 ${p}: ${error.message}`);
    res.destroy();
  });
  stream.pipe(res);
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
      // 轻量运行状态（前端 3s 轮询旗帜用）：不解析会话文件，避免周期性堵事件循环
      if (parts[1] === "sessions" && parts[2] === "running" && req.method === "GET") {
        return sendJson(res, 200, { sessions: await bridge.runningSessions() });
      }
      if (parts[1] === "sessions" && req.method === "POST" && !parts[2]) {
        const body = await readBody(req, res);
        const r = await bridge.create({ cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : undefined });
        return sendJson(res, r.ok === false ? r.status || 400 : 200, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "history" && req.method === "GET") {
        const h = await bridge.history(parts[2], {
          since: Number(url.searchParams.get("since")) || 0,
          boot: url.searchParams.get("boot") || "",
        });
        if (!h) return sendJson(res, 404, { error: "session not found" });
        return sendJson(res, 200, h);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "stream" && req.method === "GET") {
        return void bridge.subscribe(parts[2], res, {
          since: Number(url.searchParams.get("since")) || 0,
          boot: url.searchParams.get("boot") || "",
        });
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "prompt" && req.method === "POST") {
        const body = await readBody(req, res);
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
      // 排队发送：任务中继续发消息 → 服务端排队，回合结束自动发出（前端关掉也照发）
      if (parts[1] === "sessions" && parts[2] && parts[3] === "enqueue" && req.method === "POST") {
        const body = await readBody(req, res);
        let images;
        if (Array.isArray(body.images)) {
          images = body.images
            .filter((im) => im && typeof im.data === "string" && typeof im.mimeType === "string" && im.mimeType.startsWith("image/"))
            .slice(0, 8)
            .map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }));
          if (!images.length) images = undefined;
        }
        const r = await bridge.enqueuePrompt(parts[2], body.text, images);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "queue" && parts[4] && parts[5] === "jump" && req.method === "POST") {
        const r = await bridge.jumpQueuedPrompt(parts[2], decodeURIComponent(parts[4]));
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "queue" && parts[4] && req.method === "DELETE") {
        const r = await bridge.removeQueuedPrompt(parts[2], decodeURIComponent(parts[4]));
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "compaction-model" && req.method === "GET") {
        return sendJson(res, 200, { compactionModel: bridge.getCompactionModel() });
      }
      if (parts[1] === "compaction-model" && req.method === "POST") {
        const body = await readBody(req, res);
        const r = await bridge.setCompactionModel(body);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "client-error" && req.method === "POST") {
        const body = await readBody(req, res);
        console.log(`[pi-web] client: ${JSON.stringify(body)}`);
        return sendJson(res, 200, { ok: true });
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "edit" && req.method === "POST") {
        const body = await readBody(req, res);
        console.log(`[pi-web] edit request: session=${parts[2]} entry=${body.entryId} text=${String(body.text ?? "").slice(0, 30)}`);
        const r = await bridge.editPrompt(parts[2], body.entryId, body.text);
        console.log(`[pi-web] edit result: ${JSON.stringify(r)}`);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "stop" && req.method === "POST") {
        return sendJson(res, 200, await bridge.stop(parts[2]));
      }
      // 卡住的忙态（进程早没了但 promptPending 残留）：手动解除
      if (parts[1] === "sessions" && parts[2] && parts[3] === "unstick" && req.method === "POST") {
        const r = await bridge.unstick(parts[2]);
        return sendJson(res, r.ok ? 200 : 404, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "compact" && req.method === "POST") {
        const r = await bridge.compact(parts[2]);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "rename" && req.method === "POST") {
        const body = await readBody(req, res);
        const r = await bridge.rename(parts[2], body.title);
        return sendJson(res, r.ok ? 200 : 404, r);
      }
      if (parts[1] === "sessions" && parts[2] && req.method === "DELETE" && !parts[3]) {
        const r = await bridge.remove(parts[2]);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "model" && req.method === "POST") {
        const body = await readBody(req, res);
        const r = await bridge.setModel(parts[2], body.provider, body.modelId ?? body.model);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "sessions" && parts[2] && parts[3] === "thinking" && req.method === "POST") {
        const body = await readBody(req, res);
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
      // 用量报表（按 服务商/模型 汇总 token；portal 的「消耗」面板用）
      if (parts[1] === "usage" && req.method === "GET") {
        return sendJson(res, 200, await bridge.usageReport());
      }
      if (parts[1] === "subagents" && req.method === "GET") return sendJson(res, 200, { agents: await bridge.listSubagents(url.searchParams.get("cwd") || undefined) });
      if (parts[1] === "subagents" && req.method === "PUT") {
        const body = await readBody(req, res);
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
        const body = await readBody(req, res);
        const r = await bridge.discoverModels(body);
        return sendJson(res, r.error ? 400 : 200, r);
      }
      if (parts[1] === "providers" && parts[2] && req.method === "PUT" && !parts[3]) {
        const body = await readBody(req, res);
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
        const body = await readBody(req, res);
        const r = bridge.addWorkspace(body.path, body.title);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "workspaces" && req.method === "DELETE" && !parts[2]) {
        const r = bridge.removeWorkspace(url.searchParams.get("path") ?? "");
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      // 在系统文件管理器里打开一个目录（左侧工作区那一行的「打开文件夹」按钮）
      if (parts[1] === "reveal" && req.method === "POST" && !parts[2]) {
        if (!sameOriginGuard(req, res)) return;
        const body = await readBody(req, res);
        const r = openInFileManager(body.path);
        return sendJson(res, r.ok ? 200 : 400, r);
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
        const body = await readBody(req, res);
        const r = await bridge.savePresets(body);
        return sendJson(res, 200, r);
      }
      if (parts[1] === "fs" && parts[2] === "write" && req.method === "POST") {
        const body = await readBody(req, res);
        const r = bridge.writeContextFile(body.file, body.content);
        return sendJson(res, r.ok ? 200 : r.status || 400, r);
      }
      if (parts[1] === "fs" && parts[2] === "exists" && req.method === "GET") {
        return sendJson(res, 200, fsExists(url.searchParams.get("path")));
      }
      // 批量存在性探测：切换会话时整棵 transcript 的路径一次性问完，
      // 避免逐路径请求把切换拖成上千个 HTTP（曾到 1900+ 请求/次）。
      if (parts[1] === "fs" && parts[2] === "exists" && req.method === "POST") {
        const body = await readBody(req, res);
        const list = Array.isArray(body && body.paths) ? body.paths.slice(0, 500) : [];
        const results = {};
        for (const p of list) {
          if (typeof p !== "string" || !p) continue;
          results[p] = fsExists(p);
        }
        return sendJson(res, 200, { results });
      }
      if (parts[1] === "fs" && parts[2] === "list" && req.method === "GET") {
        const r = fsList(url.searchParams.get("path"));
        return sendJson(res, r ? 200 : 404, r || { error: "目录不存在" });
      }
      if (parts[1] === "file" && req.method === "GET") {
        if (!sameOriginGuard(req, res)) return;
        return serveFile(url.searchParams.get("path"), res, req);
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
      // no-cache + ETag：内容没变走 304（省流量），变了立刻拿新的。
      // 之前不带任何缓存头，浏览器会缓存 app.js/index.html，新旧混用直接白屏。
      const stat = fs.statSync(target);
      const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": "no-cache" });
        res.end();
        return;
      }
      // 先把文件读出来再写头：读失败（编辑器在写 / 文件被占用）时还能返回一个像样的
      // 错误。反过来先 writeHead(200) 再 readFileSync 抛错的话，catch 里的 writeHead
      // 会因头部已发送而抛错，浏览器拿到「200 + 空 body」的样式表 → 页面裸奔，
      // 只有刷新才恢复（这就是“有时候丢样式”的来源）。
      let body;
      try {
        body = fs.readFileSync(target);
      } catch (error) {
        console.error(`[pi-web] 静态文件读取失败 ${pathname}: ${error.message}`);
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "1" });
        res.end("asset temporarily unavailable");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-cache",
        "content-length": body.length,
        etag,
        "last-modified": stat.mtime.toUTCString(),
      });
      res.end(req.method === "HEAD" ? undefined : body);
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
  // 延迟预热：不要在页面刚打开时抢占事件循环。MCP/插件装载可能很慢，
  // 先让 /api/workspaces 和静态页面响应，空闲后再预热首个会话。
  setTimeout(() => {
    const t0 = Date.now();
    bridge
      .create({ warmup: true })
      .then(() => console.log(`[pi-web] warmup complete in ${Date.now() - t0}ms`))
      .catch((error) => console.error("[pi-web] warmup failed:", error instanceof Error ? error.message : String(error)));
  }, 8000).unref?.();
});
