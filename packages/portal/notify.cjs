#!/usr/bin/env node
/**
 * 事件板推送小工具（UTF-8 安全）。
 *
 * 为什么需要它：Windows 上用 curl/PowerShell 直接拼中文时，命令行参数会按系统
 * ANSI 代码页（zh-CN 是 GBK/cp936）编码，portal 按 UTF-8 解析就整条变乱码
 * （存进队列的已是 U+FFFD，不可逆）。这个脚本由 Node 读参数并按 UTF-8 发
 * HTTP，中文不再经过 shell 的代码页。
 *
 * 用法：
 *   node notify.cjs "标题" "正文"
 *   node notify.cjs --title 标题 --body 正文 [--port 3470]
 *   node notify.cjs --file payload.json          # UTF-8 的 JSON 文件 {title,body,session?,agent?,cwd?}
 *   node notify.cjs --b64 <base64(UTF-8 JSON)>   # 全 ASCII，最抗代码页
 *   echo {"title":"..","body":".."} | node notify.cjs --stdin
 *
 * 来源会自动带上：当前工作目录（哪个工作区），以及 pi 注入的 PI_SESSION_ID /
 * PI_SESSION_FILE（哪段对话）。显式字段优先于自动检测。
 */
const http = require("http");
const fs = require("fs");

const USAGE = `用法:
  node notify.cjs "标题" "正文"
  node notify.cjs --title <标题> --body <正文> [--session <会话名>] [--agent pi|dsh] [--cwd <工作区>] [--port 3470]
  node notify.cjs --file <payload.json>          # UTF-8 JSON: {title,body,session?,agent?,cwd?}
  node notify.cjs --b64 <base64(UTF-8 JSON)>
  ... | node notify.cjs --stdin
工作区默认是当前目录；在 pi 会话里跑还会自动带上会话 id 和标题。`;

function parseArgs(argv) {
  const out = {
    title: "", body: "", port: Number(process.env.PORTAL_PORT) || 3470,
    b64: "", file: "", stdin: false, session: "", agent: "", cwd: "", sessionId: "",
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--title") out.title = argv[++i] || "";
    else if (a === "--body") out.body = argv[++i] || "";
    else if (a === "--session") out.session = argv[++i] || "";
    else if (a === "--agent") out.agent = argv[++i] || "";
    else if (a === "--cwd") out.cwd = argv[++i] || "";
    else if (a === "--session-id") out.sessionId = argv[++i] || "";
    else if (a === "--port") out.port = Number(argv[++i]) || out.port;
    else if (a === "--b64") out.b64 = argv[++i] || "";
    else if (a === "--file") out.file = argv[++i] || "";
    else if (a === "--stdin") out.stdin = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else rest.push(a);
  }
  if (!out.title && rest.length) out.title = rest.shift();
  if (!out.body && rest.length) out.body = rest.join(" ");
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function clipLine(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 从 pi 会话文件开头抽出标题：优先会话名，否则用第一条用户消息。 */
function titleFromSessionChunk(text) {
  const lines = String(text || "").split(/\r?\n/);
  let named = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    if (!named) named = clipLine(row.name || row.sessionName || "", 80);
    const msg = row.message && typeof row.message === "object" ? row.message : row;
    const role = msg.role || row.role || "";
    if (role !== "user" && row.type !== "user") continue;
    const content = msg.content ?? row.content ?? row.text;
    let textPart = "";
    if (typeof content === "string") textPart = content;
    else if (Array.isArray(content)) {
      const block = content.find((c) => c && c.type === "text" && c.text);
      textPart = block ? block.text : "";
    }
    const title = clipLine(textPart, 80);
    if (named) return named;
    if (title) return title;
  }
  return named;
}

function readSessionTitle(file) {
  if (!file) return "";
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return titleFromSessionChunk(buf.slice(0, n).toString("utf8"));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已经失败就放弃 */ } }
  }
}

function detectSource() {
  const sessionId = String(process.env.PI_SESSION_ID || process.env.MCCA_SESSION_ID || process.env.DSH_SESSION_ID || "").slice(0, 80);
  const sessionFile = String(process.env.PI_SESSION_FILE || "");
  let agent = String(process.env.MCCA_AGENT || "").toLowerCase();
  if (agent === "pi-web" || agent === "ds") agent = agent === "ds" ? "dsh" : "pi";
  if (agent !== "pi" && agent !== "dsh") agent = "";
  if (!agent && (process.env.PI_SESSION_ID || process.env.PI_SESSION_FILE)) agent = "pi";
  else if (!agent && process.env.DSH_SESSION_ID) agent = "dsh";
  return {
    cwd: process.cwd(),
    agent,
    sessionId,
    session: String(process.env.MCCA_SESSION_TITLE || "") || readSessionTitle(sessionFile),
  };
}

function payloadFrom(text) {
  try {
    const j = JSON.parse(text);
    return {
      title: String(j.title || ""),
      body: String(j.body || ""),
      session: String(j.session || j.sessionTitle || ""),
      agent: String(j.agent || ""),
      cwd: String(j.cwd || j.workspace || ""),
      sessionId: String(j.sessionId || ""),
    };
  } catch {
    throw new Error("JSON 解析失败（应为 UTF-8 的 {title, body}）");
  }
}

function mergeSource(explicit, detected) {
  const pick = (a, b) => (String(a || "").trim() ? String(a).trim() : String(b || "").trim());
  return {
    cwd: pick(explicit.cwd, detected.cwd).slice(0, 400),
    agent: pick(explicit.agent, detected.agent).slice(0, 16),
    session: clipLine(pick(explicit.session, detected.session), 80),
    sessionId: pick(explicit.sessionId, detected.sessionId).replace(/\s+/g, "").slice(0, 80),
  };
}

function post(payload, port) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({
      title: payload.title,
      body: payload.body,
      kind: "manual",
      source: payload.source || undefined,
    }), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/notify",
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "content-length": data.length },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 保持原始文本 */ }
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed?.ok) resolve(parsed);
          else reject(new Error(`portal 返回 ${res.statusCode} ${text.slice(0, 200)}`));
        });
      },
    );
    req.on("error", (e) => reject(new Error(`连不上 portal（127.0.0.1:${port}）：${e.message}`)));
    req.write(data);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return; }

  let payload;
  if (args.b64) payload = payloadFrom(Buffer.from(args.b64.trim(), "base64").toString("utf8"));
  else if (args.file) payload = payloadFrom(fs.readFileSync(args.file, "utf8"));
  else if (args.stdin) payload = payloadFrom(await readStdin());
  else {
    payload = {
      title: args.title,
      body: args.body,
      session: args.session,
      agent: args.agent,
      cwd: args.cwd,
      sessionId: args.sessionId,
    };
  }

  payload.title = payload.title.slice(0, 120);
  payload.body = payload.body.slice(0, 500);
  payload.source = mergeSource(payload, detectSource());
  if (!payload.title && !payload.body) {
    console.error(`标题和正文不能都为空。\n${USAGE}`);
    process.exit(2);
  }

  const res = await post(payload, args.port);
  const src = payload.source || {};
  const where = src.cwd ? src.cwd.split(/[\\/]/).filter(Boolean).pop() : "";
  console.log(`已推送到事件板：id=${res.id} title=${payload.title || "(无)"}${where ? ` workspace=${where}` : ""}${src.session ? ` session=${src.session}` : ""}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`推送失败：${e.message}`); process.exit(1); });
} else {
  module.exports = { titleFromSessionChunk, mergeSource, detectSource };
}
