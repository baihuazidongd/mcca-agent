"use strict";

/**
 * @mcca/portal — the desktop-app core.
 *
 * A Node process that:
 *  - spawns / stops / supervises the dsh and pi child processes,
 *  - serves a three-tab React frontend (dsh iframe / pi iframe / manage),
 *  - exposes a small JSON management API (plugins, MCP, skills, processes).
 *
 * This is the process the Tauri shell (desktop/) wraps in a native window.
 * Keeping dsh, pi and portal as three separate processes means one crashing
 * does not take the others down.
 */

const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, fork } = require("node:child_process");
const { readMcpServers } = require("@mcca/pi-mcp");
const os = require("node:os");
const { SERVICE_KINDS, asArray, commandHint, describeAppProcess, buildProcessRow } = require("./process-detail.cjs");
const { readInstalled, writeInstalled, readResident, writeResident, defaultInstalled } = require("./instances.cjs");
const { createPtyHost } = require("./pty-host.cjs");
const { createDesk } = require("./desk.cjs");
const { createHermes } = require("./hermes.cjs");
const { createCliProviders } = require("./cli-provider.cjs");
const { listCliHistory, deleteCliHistory } = require("./cli-history.cjs");
const { readDiary, writeDiary, createEntry, DIARY_MAX } = require("./diary.cjs");

// This file lives at packages/portal/server.cjs, so the repo root is two levels up.
const ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORTAL_PORT) || 3470;

const PLUGINS_DIR = process.env.MCCA_PLUGINS_DIR || path.join(ROOT, "plugins");
const IDE_PLUGINS_DIR = path.join(ROOT, "packages", "agent-ide", "plugins");
const IDE_SKILLS_DIR = path.join(ROOT, "packages", "agent-ide", "skills");
const PLUGINS_CONFIG = process.env.MCCA_PLUGINS_CONFIG || path.join(ROOT, "config", "plugins.json");
const MCP_CONFIG = process.env.MCCA_MCP_CONFIG || path.join(ROOT, "config", "mcp.json");
const SKILLS_DIR = process.env.MCCA_SKILLS_DIR || path.join(ROOT, "skills");
// Missing file means every instance stays installed, so an existing setup does not change.
const INSTANCES_FILE = process.env.MCCA_INSTANCES_CONFIG || path.join(ROOT, "config", "portal-instances.json");
const DIARY_FILE = process.env.MCCA_DIARY_FILE || path.join(ROOT, "config", "portal-diary.json");

// The dsh patch overlays generated/committed in the shared config dir. dsh is
// launched from its own repo (`pnpm dsh web`) with these as extra layers, so
// dsh sources stay untouched.
const DSH_PATCH = process.env.MCCA_DSH_PATCH || path.join(ROOT, "config", "dsh.patch.yml");
const DSH_MCP_PATCH = process.env.MCCA_DSH_MCP_PATCH || path.join(ROOT, "config", "dsh-mcp.patch.yml");

let memoryStorePromise;
function loadMemoryStore() {
  if (!memoryStorePromise) memoryStorePromise = import("../agent-ide/memory-store.mjs");
  return memoryStorePromise;
}

async function memorySnapshot() {
  const memory = await loadMemoryStore();
  const cwd = ROOT;
  if (!memory.memoryEnabled()) {
    return { enabled: false, feature: [], project: [], cwd, at: Date.now() };
  }
  const root = memory.memoryRoot();
  return {
    enabled: true,
    feature: memory.listMemories(root, "feature"),
    project: memory.listMemories(root, "project", cwd),
    cwd,
    maxItems: memory.MAX_ITEMS,
    at: Date.now(),
  };
}

// Regenerate the dsh MCP rows from the shared registry. Done lazily (the
// generator is an ESM module and this file is CJS).
async function regenerateDshMcpPatch() {
  try {
    const generatorPath = path.join(ROOT, "scripts", "gen-dsh-mcp-patch.mjs");
    const { generateMcpPatch } = await import(
      // Windows absolute paths must be file:// URLs for dynamic import.
      require("node:url").pathToFileURL(generatorPath).href
    );
    const rows = generateMcpPatch(MCP_CONFIG, DSH_MCP_PATCH);
    return rows.length;
  } catch (error) {
    console.error("[portal] failed to regenerate dsh mcp patch:", error.message);
    return 0;
  }
}

// ── Agent process definitions ────────────────────────────────────

// The app's dsh boots against its own copy of the user's dsh home (sessions,
// workspaces, settings, MCP scripts), so the live ~/.dsh instance is never
// touched. Overridable; set to the literal home to share it instead.
const DSH_HOME = process.env.MCCA_DSH_HOME || path.join(ROOT, "config", "dsh-home");

const AGENTS = {
  dsh: {
    label: "dsh",
    port: Number(process.env.DSH_PORT) || 3081,
    cmd: process.env.DSH_CMD || "pnpm",
    args: process.env.DSH_ARGS
      ? process.env.DSH_ARGS.split(" ")
      : [
          "dsh",
          "--profile",
          "web",
          "--patch",
          dshPatchArg(),
          "--patch",
          dshMcpPatchArg(),
          "--port",
          String(process.env.DSH_PORT || 3081),
        ],
    // dsh runs from the vendored copy inside this workspace (vendor/dsh) so
    // the app has zero references to the original D:/DeepSeek Harness repo.
    cwd: process.env.DSH_CWD || path.join(ROOT, "vendor", "dsh"),
    env: { DSH_HOME },
    // `pnpm` is a .cmd shim on Windows — spawn through the shell.
    shell: process.platform === "win32",
  },
  "pi-web": {
    // pi 侧原生 Web UI（2026-09 重写版）：REST + SSE 直连 pi，不再套 dsh 壳。
    // 旧 pi-dsh-web 兼容层已归档（archive/pi-dsh-web-*-20260906.tar.gz）。
    label: "pi",
    port: Number(process.env.PI_PORT) || 3458,
    cmd: process.env.PI_WEB_CMD || process.execPath,
    args: process.env.PI_WEB_ARGS
      ? process.env.PI_WEB_ARGS.split(" ")
      : [path.join("packages", "pi-web", "server.cjs")],
    cwd: ROOT,
    env: { PI_MODEL: process.env.PI_MODEL || "" },
  },
  "codex-cli": {
    // 命令行，不启网页。打开本页终端里的 Codex。
    label: "codex",
    cli: true,
    port: null,
    cmd: "",
    args: [],
    cwd: ROOT,
    env: {},
  },
  "openhands-web": {
    // 网页会话（:3460）套 pi-web 页面。terminal 表示管理页仍可另开命令行。
    label: "openhands",
    terminal: true,
    port: Number(process.env.OH_WEB_PORT || process.env.OPENHANDS_PORT) || 3460,
    cmd: process.env.OH_WEB_CMD || process.execPath,
    args: process.env.OH_WEB_ARGS
      ? process.env.OH_WEB_ARGS.split(" ")
      : [path.join("packages", "openhands-web", "server.cjs")],
    cwd: ROOT,
    env: {},
  },
  "grok-web": {
    // 网页会话（:3461）套 pi-web 页面。terminal 表示管理页仍可另开命令行。
    label: "grok",
    terminal: true,
    port: Number(process.env.GROK_WEB_PORT || process.env.GROK_PORT) || 3461,
    cmd: process.env.GROK_WEB_CMD || process.execPath,
    args: process.env.GROK_WEB_ARGS
      ? process.env.GROK_WEB_ARGS.split(" ")
      : [path.join("packages", "grok-web", "server.cjs")],
    cwd: ROOT,
    env: {},
  },
  "hermes-web": {
    // 命令行，不启网页。打开本页终端里的Hermes Agent `hermes`。
    label: "hermes",
    cli: true,
    port: null,
    cmd: "",
    args: [],
    cwd: ROOT,
    env: {},
  },
  canvas: {
    // 画布：本机 ComfyUI 生图服务（portal 画布页签 iframe 的后端，dsh/pi 经
    // comfy MCP 出生图工具）。启动解释器必须是 ComfyUI 自带 venv 的 python：
    // 无 stdlib 的魔改解释器会在启动时报 `No module named 'encodings'`，
    // --directml 路径已实机验证可起。
    label: "canvas",
    port: Number(process.env.CANVAS_PORT) || 8188,
    cmd: process.env.CANVAS_CMD || "D:\\ComfyUI\\venv\\Scripts\\python.exe",
    args: process.env.CANVAS_ARGS
      ? process.env.CANVAS_ARGS.split(" ")
      : ["main.py", "--directml", "--listen", "0.0.0.0", "--port", String(process.env.CANVAS_PORT || 8188)],
    cwd: process.env.CANVAS_CWD || "D:\\ComfyUI",
    env: {},
  },
  mobile: {
    // 手机接入层：把 pi-web/portal 聚合成移动协议，局域网 0.0.0.0 直连 +
    // 公网 relay 出站（config/mobile.json 的 relayUrl）。portal 启动时随起，
    // 手机 App 的「管理」页也能启停/重启它。
    label: "mobile",
    port: Number(process.env.MCCA_MOBILE_PORT) || 3471,
    cmd: process.env.MCCA_MOBILE_CMD || process.execPath,
    args: process.env.MCCA_MOBILE_ARGS
      ? process.env.MCCA_MOBILE_ARGS.split(" ")
      : [path.join("packages", "mobile-bridge", "server.cjs")],
    cwd: ROOT,
    env: {},
  },
};

function dshPatchArg() {
  return DSH_PATCH.replaceAll("\\", "/");
}
function dshMcpPatchArg() {
  return DSH_MCP_PATCH.replaceAll("\\", "/");
}

function loadInstalledSet() {
  try {
    return new Set(readInstalled(INSTANCES_FILE));
  } catch (error) {
    console.error(`[portal] instances config unreadable, keeping defaults: ${error.message}`);
    return new Set(defaultInstalled());
  }
}

let installedIds = loadInstalledSet();

function isInstalled(agent) {
  return installedIds.has(agent);
}

// ── 常驻（resident）：跟着门户活 ───────────────────────────────────
//
// 桥/画布这类服务原来只在有人点「启动」时才起来：门户一重启就没人管了，
// 手机在公网中转上看到的永远是 desktop.online=false，收不到任何东西。
// 开了常驻之后：门户启动时端口上没人听就拉起来；跑着的过程死了由巡检重新
// 拉起；用户在管理页点「停止」则本轮不再跟用户作对（下次门户启动恢复常驻）。
function loadResidentSet() {
  try {
    return new Set(readResident(INSTANCES_FILE));
  } catch (error) {
    console.error(`[portal] resident config unreadable, keeping defaults: ${error.message}`);
    return new Set();
  }
}

let residentIds = loadResidentSet();
/** 本轮被手动停掉的常驻服务：巡检跳过它们，直到用户再启动或门户重启。 */
const residentPaused = new Set();

function isResident(agent) {
  return residentIds.has(agent);
}

function persistResident(next) {
  try {
    residentIds = new Set(writeResident(INSTANCES_FILE, [...next]));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function setResident(agent, on) {
  const cfg = AGENTS[agent];
  if (!cfg) return { ok: false, error: `unknown agent: ${agent}` };
  if (cfg.cli || cfg.terminal) return { ok: false, error: "命令行服务没有常驻后端" };
  const next = new Set(residentIds);
  if (on) next.add(agent);
  else next.delete(agent);
  const saved = persistResident(next);
  if (!saved.ok) return saved;
  residentPaused.delete(agent);
  writeJournal(agent, on ? "设为常驻：门户启动会自动拉起，异常退出会自动重启" : "取消常驻");
  if (on) void ensureResidentAgents();
  return { ok: true, resident: Boolean(on) };
}

/** 进程表里的记录可能是接管来的假子进程：它死了不会发 exit 事件，只能自己查。 */
function isRunning(agent) {
  const rec = children.get(agent);
  return Boolean(rec?.child && rec.child.exitCode === null);
}

async function ensureResidentAgents() {
  for (const agent of webAgents()) {
    if (!isResident(agent) || !isInstalled(agent) || residentPaused.has(agent)) continue;
    if (children.has(agent) && isRunning(agent)) continue;
    if (children.has(agent)) children.delete(agent); // 接管来的进程已经没了，腾出槽位
    const result = await startAgent(agent);
    if (result.ok) console.log(`[portal] resident ${agent} started (pid ${result.pid})`);
    else console.error(`[portal] resident ${agent} failed: ${result.error}`);
  }
}

let residentTickRunning = false;
function startResidentWatch() {
  setInterval(() => {
    if (residentTickRunning || residentIds.size === 0) return;
    residentTickRunning = true;
    ensureResidentAgents().finally(() => { residentTickRunning = false; });
  }, 20_000).unref();
}

function loadDiary() {
  try {
    return readDiary(DIARY_FILE);
  } catch (error) {
    console.error(`[portal] diary unreadable, starting empty: ${error.message}`);
    return [];
  }
}

let diaryEntries = loadDiary();

function listDiary() {
  return diaryEntries.slice().sort((a, b) => b.at - a.at);
}

function addDiary(body) {
  const made = createEntry(body && body.text, body && body.at);
  if (!made.ok) return made;
  const existing = diaryEntries.find((item) => item.at === made.entry.at && item.text === made.entry.text);
  if (existing) return { ok: true, entry: existing };
  diaryEntries = writeDiary(DIARY_FILE, [made.entry, ...diaryEntries].slice(0, DIARY_MAX));
  return { ok: true, entry: diaryEntries.find((item) => item.id === made.entry.id) || made.entry };
}

function deleteDiary(id) {
  if (!/^[\w-]{6,80}$/.test(String(id || ""))) return { ok: false, error: "没有这条" };
  const next = diaryEntries.filter((item) => item.id !== id);
  if (next.length === diaryEntries.length) return { ok: false, error: "没有这条" };
  diaryEntries = writeDiary(DIARY_FILE, next);
  return { ok: true };
}

const children = new Map(); // agent -> { child, startedAt, log }
const startInFlight = new Set(); // agents with a startAgent() currently awaiting
/** 崩溃退出留档：agent → { code, signal, at, logTail }；成功 start 时清除。 */
const lastExit = new Map();

/**
 * 通知/事件队列：宿主 POST /api/notify 入队，前端 GET /api/notifications 取走。
 *
 * 落盘归档（config/portal-events.jsonl，JSONL 追加）：事件板要的是「存档」，
 * 只放内存的话 portal 一重启（升级、崩溃自愈、手动 restart）历史就没了。
 * 归档保留全部 kind（含 auto 的系统播报），事件板只显示 manual，见前端过滤。
 */
const NOTIFY_QUEUE_MAX = 1000; // 内存里保留的历史条数（给事件板回放用）
const NOTIFY_STORE_MAX = 2000; // 磁盘归档上限，超过就压实成最近这些条
const NOTIFY_STORE = process.env.MCCA_NOTIFY_STORE || path.join(ROOT, "config", "portal-events.jsonl");
const notifyQueue = [];
let notifySeq = 0;
let notifyStored = 0; // 归档里当前条数（估算，用于压实判断）

/** 推送来源：哪个工作区、哪边 agent、哪段对话。缺了就省略，旧档没有这个字段。 */
function normalizeSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cwd = String(raw.cwd || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 400);
  let agent = String(raw.agent || "").toLowerCase();
  if (agent === "pi-web") agent = "pi";
  if (agent === "codex-cli" || agent === "codex-web") agent = "codex";
  if (agent === "openhands-web") agent = "openhands";
  if (agent === "grok-web") agent = "grok";
  if (agent === "hermes-web") agent = "hermes";
  if (agent === "ds") agent = "dsh";
  if (agent !== "pi" && agent !== "dsh" && agent !== "codex" && agent !== "openhands" && agent !== "grok" && agent !== "hermes") agent = "";
  const session = String(raw.session || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const sessionId = String(raw.sessionId || "").replace(/[\s\u0000-\u001f]/g, "").slice(0, 80);
  if (!cwd && !agent && !session && !sessionId) return null;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return { agent, cwd, workspace: parts.length ? parts[parts.length - 1] : "", session, sessionId };
}

function normNotifyPath(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
}

function httpGetJson(port, pathname, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * 推送没写明会话时，用「正在跑、且工作区相同」的 pi 会话补上。
 * 对不上就保持原样，绝不因为查询失败让这条推送丢了。
 */
async function enrichNotifySource(source) {
  if (!source || !source.cwd || (source.session && source.agent)) return source;
  const want = normNotifyPath(source.cwd);
  const targets = [];
  if (!source.agent || source.agent === "pi") targets.push({ agent: "pi", port: AGENTS["pi-web"].port });
  const hits = [];
  await Promise.all(targets.map(async (target) => {
    const data = await httpGetJson(target.port, "/api/sessions/running", 800);
    const sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
    for (const row of sessions) {
      if (!row || !row.running || normNotifyPath(row.cwd) !== want) continue;
      hits.push({
        agent: target.agent,
        id: String(row.id || "").slice(0, 80),
        title: String(row.title || "").replace(/\s+/g, " ").trim().slice(0, 80),
        updatedAt: Number(row.updatedAt) || 0,
      });
    }
  }));
  if (!hits.length) return source;
  hits.sort((a, b) => b.updatedAt - a.updatedAt);
  const best = hits[0];
  return {
    ...source,
    agent: source.agent || best.agent,
    session: source.session || best.title,
    sessionId: source.sessionId || best.id,
  };
}

const desk = createDesk();

function deskSides() {
  return ["pi-web", "openhands-web", "grok-web"]
    .filter((id) => AGENTS[id] && AGENTS[id].port)
    .map((id) => ({ agent: AGENTS[id].label, port: AGENTS[id].port }));
}

async function deskSnapshot() {
  return desk.snapshot({
    sides: deskSides(),
    getJson: httpGetJson,
    terminals: ptyHost.list(),
  });
}

const AGENDA_FILE = process.env.MCCA_AGENDA_FILE || path.join(ROOT, "config", "portal-agenda.json");
const AGENDA_MAX = 80;

function readAgenda() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENDA_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((row) => row && row.id && row.title) : [];
  } catch (error) {
    if (error && error.code !== "ENOENT") console.error(`[portal] agenda unreadable: ${error.message}`);
    return [];
  }
}

function writeAgenda(items) {
  fs.mkdirSync(path.dirname(AGENDA_FILE), { recursive: true });
  const tmp = `${AGENDA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items.slice(0, AGENDA_MAX), null, 2) + "\n");
  try {
    fs.renameSync(tmp, AGENDA_FILE);
  } catch {
    fs.rmSync(AGENDA_FILE, { force: true });
    fs.renameSync(tmp, AGENDA_FILE);
  }
}

let agendaItems = readAgenda();

function listAgenda() {
  return agendaItems.slice().sort((a, b) => Number(a.done) - Number(b.done) || (a.at || 9e15) - (b.at || 9e15));
}

function httpPostJson(port, pathname, payload, timeoutMs) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      timeout: timeoutMs,
      headers: { "content-type": "application/json", "content-length": body.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = null; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on("error", (error) => resolve({ status: 0, error: error.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.end(body);
  });
}

function openAgenda() {
  return listAgenda().filter((row) => !row.done);
}

/** Hermes Agent的工作区里放一份完整清单。它每次开工都会读到当前还没做完的安排。 */
function publishAgendaForHermes() {
  const dir = hermes.ensureWorkspace();
  const open = openAgenda();
  const lines = [
    "# 事件安排",
    "",
    "这是事件板上还没做完的安排。用户一点提交，这份清单就会更新。",
    "按顺序处理。做完一条就说明结果；做不了就写明卡在哪里。",
    `更新时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
  ];
  if (!open.length) lines.push("现在没有未完成的安排。");
  open.forEach((row, index) => {
    const when = row.at ? new Date(row.at).toLocaleString("zh-CN", { hour12: false }) : "不限时";
    lines.push(`${index + 1}. ${row.title}（${when}）`);
  });
  lines.push("");
  fs.writeFileSync(path.join(dir, "AGENDA.md"), lines.join("\n"), "utf8");
  return { dir, count: open.length };
}

function agendaBrief() {
  const open = openAgenda();
  const lines = [
    "事件板刚提交了一份安排。下面是现在还没做完的全部任务，请按顺序处理。",
    "清单也写在当前工作区的 AGENDA.md，以那份文件为准。",
    "",
  ];
  if (!open.length) lines.push("现在没有未完成的安排。");
  open.forEach((row, index) => {
    const when = row.at ? new Date(row.at).toLocaleString("zh-CN", { hour12: false }) : "不限时";
    lines.push(`${index + 1}. ${row.title}（${when}）`);
  });
  lines.push("", "做完一条用一两句话说明结果。做不了就说明卡在哪里。");
  return lines.join("\n");
}

/** 把当前全部未完成安排交给Hermes Agent。终端没开就先打开，再写入整份清单。 */
function handAgendaToHermes() {
  const published = publishAgendaForHermes();
  let live = ptyHost.list("hermes-web").find((row) => row.exited == null);
  if (!live) {
    const opened = openCli("hermes-web");
    if (!opened.ok) return { ok: false, error: opened.error || "Hermes Agent没有打开" };
    live = ptyHost.list("hermes-web").find((row) => row.exited == null);
  }
  if (!live) return { ok: false, error: "Hermes Agent没有打开" };
  const written = ptyHost.write(live.id, agendaBrief().replace(/\r?\n/g, "\r") + "\r");
  if (!written.ok) return written;
  const note = `已交给Hermes Agent，共 ${published.count} 件`;
  for (const row of openAgenda()) {
    row.status = "handed";
    row.note = note;
    row.ref = live.id;
  }
  writeAgenda(agendaItems);
  return { ok: true, ref: live.id, count: published.count, note };
}

function addAgenda(body) {
  const title = String(body && body.title || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200);
  if (!title) return { ok: false, error: "先写要安排的事" };
  const at = Number(body && body.at) || 0;
  const item = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    at: Number.isFinite(at) && at > 0 ? at : 0,
    handler: "hermes",
    done: false,
    status: "queued",
    note: "",
    createdAt: Date.now(),
  };
  agendaItems = [item, ...agendaItems].slice(0, AGENDA_MAX);
  writeAgenda(agendaItems);
  publishAgendaForHermes();
  return { ok: true, item };
}

function patchAgenda(id, body) {
  const item = agendaItems.find((row) => row.id === id);
  if (!item) return { ok: false, error: "没有这条安排" };
  if (body && typeof body.done === "boolean") item.done = body.done;
  writeAgenda(agendaItems);
  publishAgendaForHermes();
  return { ok: true, item };
}

function deleteAgenda(id) {
  const next = agendaItems.filter((row) => row.id !== id);
  if (next.length === agendaItems.length) return { ok: false, error: "没有这条安排" };
  agendaItems = next;
  writeAgenda(agendaItems);
  publishAgendaForHermes();
  return { ok: true };
}

/** 一条通知 → 归档行（只留展示需要的字段，避免把整包请求写进盘）。 */
function notifyRecord(item) {
  const row = { id: item.id, title: item.title, body: item.body, kind: item.kind, at: item.at };
  if (item.source) row.source = item.source;
  return JSON.stringify(row);
}

/** 启动时把归档读回内存（尾部若干条），序号接着最大的 id。 */
function loadNotifyArchive() {
  try {
    if (!fs.existsSync(NOTIFY_STORE)) return;
    const lines = fs.readFileSync(NOTIFY_STORE, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const items = [];
    for (const line of lines.slice(-NOTIFY_STORE_MAX)) {
      try {
        const it = JSON.parse(line);
        if (!it || typeof it.id !== "number" || (!it.title && !it.body)) continue;
        const loaded = {
          id: it.id,
          title: String(it.title || "").slice(0, 160),
          body: String(it.body || "").slice(0, 4000),
          kind: it.kind === "auto" ? "auto" : "manual",
          at: Number(it.at) || Date.now(),
        };
        const source = normalizeSource(it.source);
        if (source) loaded.source = source;
        items.push(loaded);
      } catch {
        // 坏行（半截写入 / 手工编辑）跳过，不当成致命错误
      }
    }
    items.sort((a, b) => a.id - b.id);
    notifyQueue.push(...items.slice(-NOTIFY_QUEUE_MAX));
    notifySeq = items.length ? items[items.length - 1].id : 0;
    notifyStored = lines.length;
  } catch (error) {
    console.error(`[portal] 事件存档读取失败（按空档处理）: ${error.message}`);
  }
}

/** 追加归档；超过上限时压实成最近 NOTIFY_STORE_MAX 条。任何失败都只记日志。 */
function appendNotifyArchive(item) {
  try {
    fs.mkdirSync(path.dirname(NOTIFY_STORE), { recursive: true });
    fs.appendFileSync(NOTIFY_STORE, `${notifyRecord(item)}\n`, "utf8");
    notifyStored += 1;
    if (notifyStored > NOTIFY_STORE_MAX * 1.5) {
      const keep = notifyQueue.slice(-NOTIFY_STORE_MAX).map(notifyRecord).join("\n");
      fs.writeFileSync(NOTIFY_STORE, keep ? `${keep}\n` : "", "utf8");
      notifyStored = Math.min(notifyQueue.length, NOTIFY_STORE_MAX);
    }
  } catch (error) {
    console.error(`[portal] 事件存档写入失败: ${error.message}`);
  }
}

/** 标题和正文里的字已经变成问号，原文不可恢复，留着只会占一排。 */
function garbledNotify(item) {
  const text = `${item && item.title || ""}\n${item && item.body || ""}`;
  const marks = (text.match(/\?|？|\uFFFD/g) || []).length;
  const letters = (text.match(/[A-Za-z0-9\u4e00-\u9fff]/g) || []).length;
  return marks >= 4 && marks > letters;
}

/** 删掉一条推送：内存队列和落盘归档一起去掉，刷新不会再回来。 */
function deleteNotify(id) {
  const wanted = Number(id);
  if (!Number.isFinite(wanted)) return false;
  let removed = false;
  for (let i = notifyQueue.length - 1; i >= 0; i -= 1) {
    if (notifyQueue[i].id === wanted) {
      notifyQueue.splice(i, 1);
      removed = true;
    }
  }
  try {
    if (!fs.existsSync(NOTIFY_STORE)) return removed;
    const lines = fs.readFileSync(NOTIFY_STORE, "utf8").split(/\r?\n/).filter((line) => line.trim());
    const kept = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && row.id === wanted) {
          removed = true;
          continue;
        }
      } catch {
        // 坏行留着，避免一次删除把存档清光
      }
      kept.push(line);
    }
    fs.writeFileSync(NOTIFY_STORE, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    notifyStored = kept.length;
  } catch (error) {
    console.error(`[portal] 事件删除失败: ${error.message}`);
  }
  return removed;
}
loadNotifyArchive();

// ── 用量报表（「消耗」面板）─────────────────────────────────────────
// pi：扫会话文件里 assistant 消息的 usage（按 服务商/模型 汇总，60s 缓存）。
// dsh：读它自己的 token 热力图 .dsh/storages/tok-heatmap.json（byModel 已按模型聚合）。
const PI_SESSIONS_DIR = path.join(ROOT, "config", ".pi-web", "sessions");
// dsh 的真实数据在用户主目录的 .dsh（portal 自带的 config/dsh-home 只是个几乎没跑过的副本），
// 所以按候选顺序找：env 覆盖 → 用户主目录 → portal 的 DSH_HOME。
const DSH_HOMES = [
  process.env.MCCA_DSH_USAGE_HOME,
  path.join(os.homedir(), ".dsh"),
  path.join(DSH_HOME, ".dsh"),
].filter(Boolean);
const DSH_SESSIONS_DIR = DSH_HOMES.map((h) => path.join(h, "sessions")).find((d) => fs.existsSync(d)) || path.join(DSH_HOMES[0] || ".", "sessions");
const DSH_HEATMAP = DSH_HOMES.map((h) => path.join(h, "storages", "tok-heatmap.json")).find((f) => fs.existsSync(f)) || path.join(DSH_HOMES[0] || ".", "storages", "tok-heatmap.json");
let usageCache = null;
let usageJob = null;

function startUsageJob() {
  if (usageJob) return;
  const child = fork(__filename, ["--usage-scan"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, MCCA_USAGE_SCAN: "1" },
  });
  usageJob = child;
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* already gone */ }
  }, 120000);
  child.on("message", (data) => {
    if (data && data.ok) usageCache = { at: data.at, data };
  });
  child.on("exit", () => {
    clearTimeout(timer);
    if (usageJob === child) usageJob = null;
  });
}

function emptyUsageTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0, cost: 0 };
}

function addUsage(row, u) {
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  const cacheRead = Number(u.cacheRead) || 0;
  const cacheWrite = Number(u.cacheWrite) || 0;
  row.input += input;
  row.output += output;
  row.cacheRead += cacheRead;
  row.cacheWrite += cacheWrite;
  row.total += input + output + cacheRead + cacheWrite; // 统一口径：provider 的 totalTokens 不可靠
  row.calls += 1;
}

function piUsage() {
  const out = { sessions: 0, lastAt: 0, totals: emptyUsageTotals(), models: [] };
  const byModel = new Map();
  try {
    const files = fs.existsSync(PI_SESSIONS_DIR) ? fs.readdirSync(PI_SESSIONS_DIR).filter((n) => n.endsWith(".jsonl")) : [];
    for (const name of files) {
      const file = path.join(PI_SESSIONS_DIR, name);
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      out.sessions += 1;
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
      for (const line of text.split(/\r?\n/)) {
        if (!line || line.indexOf('"usage"') < 0 || line.indexOf('"role":"assistant"') < 0) continue;
        try {
          const row = JSON.parse(line);
          const m = row && row.message;
          if (!m || m.role !== "assistant" || !m.usage) continue;
          const provider = m.provider || "未知";
          const modelId = m.model || m.modelId || "未知";
          const key = provider + "/" + modelId;
          let hit = byModel.get(key);
          if (!hit) { hit = { provider, modelId, ...emptyUsageTotals(), lastAt: 0 }; byModel.set(key, hit); }
          addUsage(hit, m.usage);
          const at = Date.parse(row.timestamp || "") || mtime;
          if (at > hit.lastAt) hit.lastAt = at;
          if (at > out.lastAt) out.lastAt = at;
        } catch { /* 半截行 */ }
      }
    }
  } catch { /* 目录读不到就当空 */ }
  out.models = [...byModel.values()].sort((a, b) => b.total - a.total);
  for (const row of out.models) {
    out.totals.input += row.input;
    out.totals.output += row.output;
    out.totals.cacheRead += row.cacheRead;
    out.totals.cacheWrite += row.cacheWrite;
    out.totals.total += row.total;
    out.totals.calls += row.calls;
  }
  return out;
}

function dshUsage() {
  const out = { sessions: 0, updatedAt: 0, totals: emptyUsageTotals(), models: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(DSH_HEATMAP, "utf8"));
    const byModel = raw && raw.byModel && typeof raw.byModel === "object" ? raw.byModel : {};
    for (const [modelId, v] of Object.entries(byModel)) {
      if (!v || typeof v !== "object") continue;
      const row = {
        provider: "dsh",
        modelId,
        // dsh 热力图的 input = inputMiss + cacheRead（已含缓存），映射成和 pi 同口径（input 不含缓存）
        input: Number(v.inputMiss) || Math.max(0, (Number(v.input) || 0) - (Number(v.cacheRead) || 0)),
        output: Number(v.output) || 0,
        cacheRead: Number(v.cacheRead) || 0,
        cacheWrite: Number(v.cacheWrite) || 0,
        total: Number(v.total) || 0,
        calls: Number(v.calls) || 0,
        cost: Number(v.cost) || 0,
        lastAt: Number(raw.updatedAt) || 0,
      };
      out.models.push(row);
    }
    out.models.sort((a, b) => b.total - a.total);
    out.updatedAt = Number(raw.updatedAt) || 0;
    for (const row of out.models) {
      out.totals.input += row.input;
      out.totals.output += row.output;
      out.totals.cacheRead += row.cacheRead;
      out.totals.cacheWrite += row.cacheWrite;
      out.totals.total += row.total;
      out.totals.calls += row.calls;
      out.totals.cost += row.cost;
    }
  } catch { /* 没有 dsh 数据 */ }
  try {
    const sessions = fs.existsSync(DSH_SESSIONS_DIR) ? fs.readdirSync(DSH_SESSIONS_DIR) : [];
    out.sessions = sessions.length;
  } catch { out.sessions = 0; }
  return out;
}

function usageReport() {
  const now = Date.now();
  if (usageCache && now - usageCache.at < 60_000) return usageCache.data;
  startUsageJob();
  if (usageCache) return { ...usageCache.data, refreshing: true };
  return { ok: true, pending: true, at: now, pi: null, dsh: null };
}

if (process.argv[2] === "--usage-scan") {
  try {
    const data = { ok: true, at: Date.now(), pi: piUsage(), dsh: dshUsage() };
    if (typeof process.send === "function") process.send(data);
  } catch (error) {
    console.error(`[portal] usage scan failed: ${error.message}`);
  }
  process.exit(0);
}

const JOURNAL_DIR = process.env.MCCA_JOURNAL_DIR || path.join(ROOT, "config", "journals");
const JOURNAL_MAX = 400;

function journalFile(agent) {
  const name = String(agent || "").replace(/[^a-z0-9-]/gi, "");
  return name ? path.join(JOURNAL_DIR, `${name}.log`) : "";
}

function journalStamp(at) {
  const date = new Date(at || Date.now());
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function readJournal(agent) {
  const file = journalFile(agent);
  if (!file) return [];
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-JOURNAL_MAX);
  } catch {
    return [];
  }
}

function writeJournal(agent, text) {
  const file = journalFile(agent);
  if (!file) return;
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.trim()) rows.push(`${journalStamp()}  ${line}`);
  }
  if (!rows.length) return;
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  fs.appendFileSync(file, `${rows.join("\n")}\n`);
  const kept = readJournal(agent);
  if (kept.length >= JOURNAL_MAX) fs.writeFileSync(file, `${kept.slice(-JOURNAL_MAX).join("\n")}\n`);
}

function logLine(agent, text) {
  const rec = children.get(agent);
  if (!rec) return;
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim()) rows.push(line);
  }
  if (!rows.length) return;
  rec.log.push(...rows);
  if (rec.log.length > 200) rec.log.splice(0, rec.log.length - 200);
  writeJournal(agent, rows.join("\n"));
}

// ── 端口回收：启动前若端口被本服务的孤儿实例占用，先结束它 ────────
//
// 典型场景：实例被绕过 portal 手动启动（缺 DSH_HOME 等环境），
// portal 再启动就 EADDRINUSE 闪退。回收只认精确的命令行特征，不碰无关进程：
//   dsh    → 命令行含 "apps/cli/src/bin.ts" 且含本端口号（3080 的 `bin.ts web`
//            不含端口号，永不误伤）
//   pi     → 命令行含 "pi-web"（仓库路径本身足够唯一，免端口校验）
//   canvas → 命令行含 "main.py" 且含本端口号（ComfyUI 的启动行；其它端口的
//            python main.py 一律不动）
const RECLAIM_SIGNATURES = {
  dsh: "apps/cli/src/bin.ts",
  // 允许从 pi-web 工作目录直接执行 `node server.cjs`，这时命令行里没有
  // “pi-web” 路径；端口校验保证只接管 3458 上的该服务。
  "pi-web": "server.cjs",
  "openhands-web": "openhands-web",
  "grok-web": "grok-web",
  "hermes-web": "hermes",
  canvas: "main.py",
  mobile: "mobile-bridge",
};

// 端口号是否必须出现在命令行里才算“同一个服务”。
//   dsh / canvas：签名不唯一（3080 的 `bin.ts web`、别的 `python main.py`
//     都长得一样），必须靠端口号区分，否则误伤无关实例；
//   pi：端口是 server.cjs 的代码默认值，命令行不出现——同旧 pi-dsh-web 的
//     结论，免端口校验。
const RECLAIM_REQUIRE_PORT = {
  dsh: true,
  "pi-web": false,
  "openhands-web": false,
  "grok-web": false,
  "hermes-web": false,
  canvas: true,
  mobile: false,
};

function listeningPid(port) {
  const { execSync } = require("node:child_process");
  const out = execSync(
    `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`,
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  ).trim();
  const pid = Number(out);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function processCommandLine(pid) {
  const { execSync } = require("node:child_process");
  return execSync(
    `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  ).trim();
}

/** 端口上的进程是不是这个服务自己。对得上就返回 pid，无关进程返回 0。 */
function matchingListener(agent, cfg) {
  const signature = RECLAIM_SIGNATURES[agent];
  if (!signature || !cfg || !cfg.port) return 0;
  let pid = 0;
  try { pid = listeningPid(cfg.port); } catch { return 0; }
  if (!pid || pid === process.pid) return 0;
  let commandLine = "";
  try { commandLine = processCommandLine(pid); } catch { return 0; }
  const portOk = RECLAIM_REQUIRE_PORT[agent] === false || commandLine.includes(String(cfg.port));
  if (!commandLine.includes(signature) || !portOk) return 0;
  return pid;
}

function watchedChild(pid, startedAt) {
  return {
    pid,
    signalCode: null,
    get exitCode() {
      try { process.kill(pid, 0); return null; } catch { return 0; }
    },
  };
}

/** 网页服务。标了 cli 的仍可能在自己的端口上跑网页，启动时一并接上。 */
function webAgents() {
  return Object.keys(AGENTS).filter((agent) => AGENTS[agent] && AGENTS[agent].port);
}

/** 门户重启、应用关掉之后，原来的服务还在端口上听：认领它，不重新拉起。 */
function adoptListener(agent) {
  if (children.has(agent)) return false;
  const cfg = AGENTS[agent];
  const pid = matchingListener(agent, cfg);
  if (!pid) return false;
  children.set(agent, {
    child: watchedChild(pid),
    startedAt: Date.now(),
    adopted: true,
    log: ["[portal] 服务还在跑，已重新接上，没有重启"],
  });
  console.log(`[portal] ${agent}: adopted pid ${pid} on port ${cfg.port}`);
  return true;
}

function reclaimStaleInstance(agent, cfg) {
  const signature = RECLAIM_SIGNATURES[agent];
  if (!signature) return null;
  try {
    const pid = listeningPid(cfg.port);
    if (!pid) return null;
    const commandLine = processCommandLine(pid);
    const portOk = RECLAIM_REQUIRE_PORT[agent] === false || commandLine.includes(String(cfg.port));
    if (!commandLine.includes(signature) || !portOk) {
      console.error(`[portal] port ${cfg.port} held by unrelated process (pid ${pid}); not touching it`);
      return null;
    }
    try { process.kill(pid); } catch { return null; }
    return { pid, commandLine };
  } catch {
    return null;
  }
}

/** 等端口可绑定（孤儿进程退出、监听 socket 释放）。 */
function waitPortFree(port, timeoutMs) {
  const net = require("node:net");
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const probe = net.createServer();
      probe.once("error", () => {
        if (Date.now() < deadline) setTimeout(attempt, 300);
        else resolve(false);
      });
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    };
    attempt();
  });
}

const hermes = createHermes({ root: ROOT });
const cliProviders = createCliProviders({ root: ROOT });
let hermesJob = null;

function hermesEnv() {
  const bin = path.join(hermes.home, "bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "Path";
  const current = process.env[pathKey] || "";
  const parts = current.split(";").filter((part) => part && part.toLowerCase() !== bin.toLowerCase());
  return { HERMES_HOME: hermes.home, [pathKey]: `${bin};${parts.join(";")}` };
}

function findCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
  if (!fs.existsSync(base)) return "";
  const hits = [];
  for (const name of fs.readdirSync(base)) {
    const exe = path.join(base, name, process.platform === "win32" ? "codex.exe" : "codex");
    if (!fs.existsSync(exe)) continue;
    hits.push({ exe, mtime: fs.statSync(exe).mtimeMs });
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0] ? hits[0].exe : "";
}

function cliCommand(agent, resume) {
  const id = resume && String(resume).trim();
  const tuned = (tool) => {
    if (id) return { args: [], env: {} };
    try { return cliProviders.launch(tool); }
    catch (error) { return { args: [], env: {}, error: error.message }; }
  };
  if (agent === "codex-cli") {
    const exe = findCodexBin();
    const use = tuned("codex");
    return { title: "Codex", file: exe, args: [...use.args, ...(id ? ["resume", id] : [])], env: use.env, error: use.error };
  }
  if (agent === "grok-web") {
    const exe = path.join(ROOT, "vendor", "cli", "grok", "grok.exe");
    const use = tuned("grok");
    return { title: "Grok Build", file: fs.existsSync(exe) ? exe : "", args: [...use.args, ...(id ? ["--resume", id] : [])], env: use.env, error: use.error };
  }
  if (agent === "openhands-web") {
    const exe = path.join(ROOT, "vendor", "cli", "openhands", ".venv", "Scripts", "openhands.exe");
    const use = tuned("openhands");
    return {
      title: "OpenHands",
      file: fs.existsSync(exe) ? exe : "",
      args: [...use.args, ...(id ? ["--resume", id.replace(/-/g, "")] : [])],
      env: { OPENHANDS_SUPPRESS_BANNER: "1", ...use.env },
      error: use.error,
    };
  }
  if (agent === "hermes-web") {
    const found = hermes.launcher();
    const use = tuned("hermes");
    if (!found) return { title: "Hermes Agent", file: "", args: [], error: use.error };
    return {
      title: "Hermes Agent",
      file: found.file,
      args: [...found.args, ...use.args, ...(id ? ["--resume", id] : [])],
      env: { ...hermesEnv(), ...use.env },
      error: use.error,
    };
  }
  return null;
}

const ptyHost = createPtyHost({ cwd: ROOT, commandOf: cliCommand });

function resolveWorkspace(input) {
  const raw = String(input || "").trim();
  if (!raw) return { path: ROOT };
  if (raw.includes("\0") || raw.length > 400) return { error: "工作区路径不对" };
  const dir = path.resolve(raw);
  let st;
  try { st = fs.statSync(dir); } catch { return { error: "找不到这个工作区" }; }
  if (!st.isDirectory()) return { error: "工作区必须是文件夹" };
  return { path: dir };
}

function openCli(agent, workspace, resume) {
  const dir = agent === "hermes-web" ? { path: hermes.ensureWorkspace() } : resolveWorkspace(workspace);
  if (dir.error) return { ok: false, error: dir.error };
  const id = resume && String(resume).trim();
  if (id && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(id)) return { ok: false, error: "会话编号不对" };
  return ptyHost.open(agent, dir.path, id || "");
}

let pickInFlight = null;
function pickDirectory() {
  if (pickInFlight) return pickInFlight;
  pickInFlight = new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -Name NativeWin -Namespace Mcca -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'",
      "[Mcca.NativeWin]::ShowWindow([Mcca.NativeWin]::GetConsoleWindow(), 0) | Out-Null",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$owner.ShowInTaskbar = $false",
      "$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow",
      "$owner.StartPosition = 'CenterScreen'",
      "$owner.Size = New-Object System.Drawing.Size(1,1)",
      "$owner.Show()",
      "[Mcca.NativeWin]::SetForegroundWindow($owner.Handle) | Out-Null",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择工作区'",
      "$dialog.ShowNewFolderButton = $true",
      "$result = $dialog.ShowDialog($owner)",
      "$owner.Close()",
      "if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }",
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
      "[Console]::Out.Write($dialog.SelectedPath)",
    ].join("; ");
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false });
    const chunks = [];
    const errors = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ok: false, error: "文件夹窗口超时" });
    }, 120000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      const utf16 = (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) || (buf.length >= 4 && buf[1] === 0 && buf[3] === 0);
      const text = (utf16 ? buf.toString("utf16le") : buf.toString("utf8")).replace(/^\uFEFF/, "").trim();
      if (!text) {
        const errBuf = Buffer.concat(errors);
        const errText = (errBuf.length >= 4 && errBuf[1] === 0 ? errBuf.toString("utf16le") : errBuf.toString("utf8")).trim();
        if (code && errText) resolve({ ok: false, error: "文件夹窗口没有打开" });
        else resolve({ ok: false, cancelled: true });
        return;
      }
      const dir = resolveWorkspace(text);
      if (dir.error) { resolve({ ok: false, error: dir.error }); return; }
      resolve({ ok: true, path: dir.path });
    });
  }).finally(() => { pickInFlight = null; });
  return pickInFlight;
}

async function startAgent(agent, options = {}) {
  const cfg = AGENTS[agent];
  if (!cfg) return { ok: false, error: `unknown agent: ${agent}` };
  if (!isInstalled(agent)) return { ok: false, error: `${agent} is not installed` };
  if (cfg.cli || (cfg.terminal && options.terminal)) return openCli(agent, options.cwd, options.resume);
  // children 里可能残留已退出子进程的旧记录（例如门户重启后，服务本体
  // 还占着端口）。只有记录存在且进程确实还活着才算 already running；
  // 失效记录要先清掉，后面的端口回收逻辑才能接管并重新启动。
  if (children.has(agent) && isRunning(agent)) return { ok: false, error: `${agent} is already running` };
  if (children.has(agent)) children.delete(agent);
  // startAgent awaits (reclaim), so two concurrent starts could both pass the
  // children.has check above; serialize per agent.
  if (startInFlight.has(agent)) return { ok: false, error: `${agent} start already in progress` };
  startInFlight.add(agent);
  try {
    // 孤儿实例回收：portal 视角未运行但端口被同服务旧实例占着——结束它再启动。
    const reclaimed = reclaimStaleInstance(agent, cfg);
    if (reclaimed) {
      const freed = await waitPortFree(cfg.port, 15000);
      const note = `[portal] port ${cfg.port} was held by a stale instance (pid ${reclaimed.pid}); `
        + (freed ? "reclaimed, starting fresh" : "reclaim sent but port still busy");
      console.log(`[portal] ${agent}: ${note}`);
      if (!freed) return { ok: false, error: `port ${cfg.port} still busy after reclaiming pid ${reclaimed.pid}` };
    } else {
      // 没有回收（端口被**无关**进程占用，或恰好空闲）。占用时必须当场报错：
      // 否则 spawn 出的子进程 EADDRINUSE 秒退，portal 状态显示“已停止”，而端口
      // 仍被外部实例应答——用户看到的正是“开关失灵/作妖”。
      const holder = listeningPid(cfg.port);
      if (holder) {
        return {
          ok: false,
          error: `port ${cfg.port} is held by an unrelated process (pid ${holder}); stop it manually or change the port`,
        };
      }
    }
    // 刚停掉的实例：监听 socket 已消失，但连接可能还在 TIME_WAIT。Node 在
    // Windows 上以 SO_EXCLUSIVEADDRUSE 绑定，TIME_WAIT 足以让新进程 EADDRINUSE
    // 静默退出——表现为“停了再开就起不来”。故启动前统一等端口真正可绑定。
    if (!(await waitPortFree(cfg.port, 12000))) {
      return { ok: false, error: `port ${cfg.port} is not bindable yet; retry in a moment` };
    }

    const rec = { child: null, startedAt: Date.now(), log: [] };
    // Reserve the slot synchronously so a fast-exiting child's exit event cannot
    // be mistaken for a newer instance's (and double-start is impossible).
    children.set(agent, rec);

    let child;
    try {
      child = spawn(cfg.cmd, cfg.args, {
        cwd: cfg.cwd,
        env: { ...process.env, ...(cfg.env || {}), MCCA_PORT: String(cfg.port) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: cfg.shell === true,
        // 脱离门户进程组：门户崩了、桌面窗口关了，服务自己继续听端口。
        detached: true,
      });
    } catch (error) {
      // Spawn can fail synchronously (missing binary, bad args): release the
      // reserved slot, otherwise the agent shows a phantom "running, pid null".
      children.delete(agent);
      return { ok: false, error: `spawn failed: ${error.message}` };
    }
    rec.child = child;
    if (typeof child.unref === "function") child.unref();
    lastExit.delete(agent); // 重新起来就清掉上次的崩溃留档，避免状态页误导
    residentPaused.delete(agent); // 手动/巡检拉起都算“用户要它跑”，恢复常驻资格

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => logLine(agent, chunk));
    child.stderr.on("data", (chunk) => logLine(agent, chunk));
    child.on("error", (error) => logLine(agent, `spawn error: ${error.message}`));
    child.on("exit", (code, signal) => {
      // Only report if this record is still the current record (stopAgent
      // deletes it, a manual kill does not).
      if (children.get(agent) === rec) {
        logLine(agent, `[portal] process exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
        children.delete(agent);
        // 非主动停止的退出=崩溃。日志随记录一起删掉的话，状态页只剩“已停止”
        // 三个字，什么也诊断不出来；这里留一份尾巴供 agentStatus 展示。
        if (!rec.stopping) {
          lastExit.set(agent, {
            code: code ?? null,
            signal: signal ?? null,
            at: Date.now(),
            logTail: rec.log.slice(-60), // 崩溃时头几行（V8/WASM fatal 的“原因行”）比尾巴更值钱
          });
        }
      }
      if (code !== 0 && code !== null) {
        // Crash (not a clean stop): surface it in the portal's own log too.
        console.error(`[portal] ${agent} exited with code ${code}`);
      }
    });

    return { ok: true, pid: child.pid, port: cfg.port };
  } finally {
    startInFlight.delete(agent);
  }
}

function stopAgent(agent) {
  if (AGENTS[agent] && AGENTS[agent].cli) {
    const open = ptyHost.list(agent).filter((row) => row.exited == null);
    ptyHost.closeAgent(agent);
    writeJournal(agent, open.length ? `停止了 ${open.length} 个终端` : "没有正在运行的终端");
    return { ok: true };
  }
  const rec = children.get(agent);
  if (!rec) return { ok: false, error: `${agent} is not running` };
  const pid = rec.child?.pid;
  if (process.platform === "win32") {
    // /T kills the whole process tree (dsh/pi may spawn children).
    if (pid) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error) console.error(`[portal] taskkill ${pid} failed: ${error.message}`);
      });
    }
  } else if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        rec.child.kill();
      } catch {
        // ignore
      }
    }
  }
  children.delete(agent);
  if (isResident(agent)) {
    residentPaused.add(agent);
    writeJournal(agent, `已停止${pid ? ` pid ${pid}` : ""}（常驻已暂停，下次门户启动或点启动会恢复）`);
  } else {
    writeJournal(agent, `已停止${pid ? ` pid ${pid}` : ""}`);
  }
  return { ok: true };
}

function persistInstalled(next) {
  installedIds = new Set(writeInstalled(INSTANCES_FILE, [...next]));
}

function installInstance(agent) {
  if (!AGENTS[agent]) return { ok: false, error: `unknown agent: ${agent}` };
  const next = new Set(installedIds);
  next.add(agent);
  persistInstalled(next);
  return { ok: true, installed: true };
}

function captureCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: process.env });
    } catch {
      resolve("");
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve(out.trim());
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
  });
}

function httpsRedirectTarget(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "user-agent": "mcca-portal", accept: "text/html" }, timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(new URL(res.headers.location, url).href);
        return;
      }
      resolve("");
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

function httpsGet(url, timeoutMs, accept, hops = 0) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "user-agent": "mcca-portal", accept }, timeout: timeoutMs }, (res) => {
      if (hops < 2 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        resolve(httpsGet(next, timeoutMs, accept, hops + 1));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, finalUrl: url, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function httpsGetJson(url, timeoutMs) {
  return httpsGet(url, timeoutMs, "application/json").then((res) => {
    if (!res) return null;
    try { return JSON.parse(res.body); }
    catch { return null; }
  });
}

function versionTriple(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function versionIsNewer(latest, current) {
  if (!latest || !current) return null;
  for (let i = 0; i < 3; i += 1) {
    if (latest[i] !== current[i]) return latest[i] > current[i];
  }
  return false;
}

async function hermesLatestTag() {
  const viaCurl = hermesTagFrom(await captureCommand("curl.exe", [
    "-sL", "--ssl-no-revoke", "--max-time", "20", "-A", "mcca-portal",
    "-o", "NUL", "-w", "%{url_effective}", hermes.RELEASE_URL,
  ], 25000));
  if (viaCurl) return viaCurl;
  return hermesTagFrom(await httpsRedirectTarget(hermes.RELEASE_URL, 8000));
}

function hermesTagFrom(url) {
  const tag = decodeURIComponent(String(url || "").split("/").pop() || "");
  return /^v?\d{4}\.\d{1,2}\.\d{1,2}$/.test(tag) ? tag.replace(/^v/, "") : "";
}

function hermesVersionTriple(text) {
  const match = String(text || "").match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function hermesLine(current, latest) {
  if (!current) return { name: "Hermes Agent", id: "hermes", line: "Hermes Agent还没装进应用" };
  const newer = versionIsNewer(hermesVersionTriple(latest), hermesVersionTriple(current));
  if (newer) return { name: "Hermes Agent", id: "hermes", current, latest, canUpdate: true, line: `Hermes Agent ${current} → ${latest}` };
  if (newer === null) return { name: "Hermes Agent", id: "hermes", current, line: `Hermes Agent ${current}` };
  return { name: "Hermes Agent", id: "hermes", current, latest, line: `Hermes Agent ${current} 已是最新` };
}

function tailText(chunks, limit) {
  return Buffer.concat(chunks).toString("utf8").trim().slice(-limit);
}

function runHermesInstall(tag) {
  if (hermesJob) return Promise.resolve({ ok: false, error: "Hermes Agent正在安装" });
  const child = hermes.spawnInstaller(tag);
  hermesJob = { child, startedAt: Date.now(), log: "" };
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  const done = new Promise((resolve) => {
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("exit", (code) => {
      const note = tailText(err.length ? err : out, 500);
      if (code === 0 && hermes.installed()) {
        if (tag) hermes.writeVersion(tag);
        resolve({ ok: true, version: hermes.readVersion() });
        return;
      }
      resolve({ ok: false, error: note || `安装退出码 ${code ?? "null"}` });
    });
  });
  done.finally(() => {
    if (hermesJob && hermesJob.child === child) hermesJob = null;
  });
  return done;
}

function updateLine(name, current, latest, id) {
  const newer = versionIsNewer(versionTriple(latest), versionTriple(current));
  if (!current) return { id, name, line: `${name} 没读到本地版本` };
  if (newer === null) return { id, name, current, line: `${name} ${current}` };
  if (newer) return { id, name, current, latest, canUpdate: true, line: `${name} ${current} → ${latest}` };
  return { id, name, current, latest, line: `${name} ${current} 已是最新` };
}

async function checkUpdates() {
  const codexBin = findCodexBin();
  const [codexOut, openhandsRemote, hermesLatest, head, behind] = await Promise.all([
    captureCommand(codexBin, ["--version"], 12000),
    httpsGetJson("https://pypi.org/pypi/openhands-agent-server/json", 8000),
    hermesLatestTag(),
    captureCommand("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], 8000),
    captureCommand("git", ["-C", ROOT, "rev-list", "--count", "HEAD..origin/main"], 8000),
  ]);
  let pinned = "";
  try {
    const source = fs.readFileSync(path.join(ROOT, "packages", "openhands-web", "bridge.cjs"), "utf8");
    const match = source.match(/openhands-agent-server==(\d+\.\d+\.\d+)/);
    pinned = match ? match[1] : "";
  } catch { /* 没装这包就不比 */ }
  const codexLatestUrl = await httpsRedirectTarget("https://github.com/openai/codex/releases/latest", 8000);
  const codexLatestTag = codexLatestUrl ? decodeURIComponent(codexLatestUrl.split("/").pop() || "") : "";
  const items = [
    updateLine("Codex", (codexOut.match(/\d+\.\d+\.\d+/) || [""])[0], codexLatestTag, "codex"),
    updateLine("OpenHands", pinned, openhandsRemote && openhandsRemote.info && openhandsRemote.info.version, "openhands"),
    hermesLine(hermes.readVersion(), hermesLatest),
  ];
  const behindText = String(behind).trim();
  const behindCount = /^\d+$/.test(behindText) ? Number(behindText) : null;
  if (head) {
    items.push({
      name: "本仓库",
      current: head,
      line: behindCount === null
        ? `本仓库 ${head}，没比到 origin/main`
        : behindCount > 0
          ? `本仓库 ${head}，比已抓取的 origin/main 落后 ${behindCount} 个提交`
          : `本仓库 ${head}，相对已抓取的 origin/main 没有新提交`,
    });
  }
  return { ok: true, items };
}

function deleteInstance(agent) {
  if (!AGENTS[agent]) return { ok: false, error: `unknown agent: ${agent}` };
  const next = new Set(installedIds);
  next.delete(agent);
  persistInstalled(next);
  if (AGENTS[agent].cli) ptyHost.closeAgent(agent);
  if (children.has(agent)) stopAgent(agent);
  if (residentIds.delete(agent)) persistResident(residentIds);
  residentPaused.delete(agent);
  return { ok: true, installed: false };
}

/**
 * 重启一个实例：停止 → 等进程树真正退出 → 复用 startAgent 拉起新实例。
 * startAgent 内部自带端口回收与可绑定等待，所以这里只需保证旧进程已死，
 * 避免 taskkill 还没杀完就 spawn 出新旧并存或 EADDRINUSE 闪退。
 */
async function restartAgent(agent) {
  const cfg = AGENTS[agent];
  if (!cfg) return { ok: false, error: `unknown agent: ${agent}` };
  if (cfg.cli) {
    writeJournal(agent, "重启终端");
    ptyHost.closeAgent(agent);
    return openCli(agent);
  }
  writeJournal(agent, "开始重启");
  const rec = children.get(agent);
  if (rec) {
    stopAgent(agent);
    const exited = await new Promise((resolve) => {
      const deadline = Date.now() + 20000;
      const tick = () => {
        const child = rec.child;
        if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode !== null) {
          return resolve(true);
        }
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
    if (!exited) return { ok: false, error: `${agent} did not exit within 20s; restart aborted` };
  }
  return startAgent(agent);
}

function agentStatus(agent) {
  const cfg = AGENTS[agent];
  const rec = children.get(agent);
  return {
    agent,
    label: cfg.label,
    port: cfg.cli ? null : cfg.port,
    cli: Boolean(cfg.cli || cfg.terminal),
    running: Boolean(rec?.child && rec.child.exitCode === null),
    pid: rec?.child?.pid ?? null,
    startedAt: rec?.startedAt ?? null,
    log: cfg.cli ? [...readJournal(agent), ...ptyHost.diary(agent)] : readJournal(agent),
    // 上一次崩溃退出（主动停止不记）：状态页据此区分“我停的”与“它自己死的”。
    lastExit: lastExit.get(agent) ?? null,
    installed: isInstalled(agent),
    resident: isResident(agent),
    residentPaused: residentPaused.has(agent),
  };
}

// Process-level safety net for the portal itself: it supervises both agents,
// so an unhandled error must never take the supervisor down.
process.on("exit", () => ptyHost.closeAll());
process.on("uncaughtException", (error) => {
  console.error("[portal] uncaughtException:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[portal] unhandledRejection:", reason);
});

// ── Shared-config readers (plugins / mcp / skills) ───────────────

let pluginHost = null;
async function getPluginHost() {
  if (!pluginHost) pluginHost = await import("@mcca/plugin-host");
  return pluginHost;
}

async function listPlugins() {
  const { discoverPlugins, readEnableConfig, isEnabled } = await getPluginHost();
  const config = readEnableConfig(PLUGINS_CONFIG);
  const shared = [...discoverPlugins(PLUGINS_DIR), ...discoverPlugins(IDE_PLUGINS_DIR)].map((d) => ({
    name: d.manifest.name,
    version: d.manifest.version,
    kind: d.manifest.kind,
    surface: "shared",
    description: d.manifest.description || "",
    targets: d.manifest.targets && d.manifest.targets.length ? d.manifest.targets : ["ds", "pi"],
    enabled: {
      ds: isEnabled(d.manifest, "ds", config),
      pi: isEnabled(d.manifest, "pi", config),
    },
  }));
  return [...shared, ...listClientPlugins(), ...listHostPlugins()];
}

/** 客户端 bundle 扫描根：共享包目录（dsh profile 与客户端行共用）。 */
const CLIENT_PLUGIN_DIRS = [
  path.join(ROOT, "packages", "client-plugins"),
];
const CLIENT_PLUGINS_CONFIG = path.join(ROOT, "config", "client-plugins.json");
const HOST_MANIFEST = path.join(ROOT, "config", "hot-plugins.json");
const HOST_DISABLED = path.join(ROOT, "config", "hot-plugins.disabled.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return fallback;
  }
}

/**
 * 客户端 bundle（真正渲染界面组件的那一类）。`kind:"ui"` 的共享插件是死通道，
 * 界面能力实际由此承载：pi 经 boot 图，dsh 经 profile 的客户端行。
 */
function listClientPlugins() {
  const config = readJson(CLIENT_PLUGINS_CONFIG, {});
  const seen = new Set();
  const out = [];
  for (const dir of CLIENT_PLUGIN_DIRS) {
    let rows = [];
    try {
      rows = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of rows.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!dirent.isDirectory() || !dirent.name.startsWith("mcca-")) continue;
      // 键与宿主 boot 行一致：优先 package.json 的 name（dsh 一直用包名），
      // 否则回落目录名。
      const dirName = dirent.name;
      const pkg = readJson(path.join(dir, dirName, "package.json"), {}) || {};
      const id = typeof pkg.name === "string" && pkg.name ? pkg.name : dirName;
      if (seen.has(id)) continue;
      const clientFile = path.join(dir, dirName, "client.js");
      if (!fs.existsSync(clientFile)) continue;
      seen.add(id);
      out.push({
        name: id,
        version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
        kind: "ui",
        surface: "client",
        description: pkg.description || "",
        targets: ["ds", "pi"],
        enabled: {
          // 兼容历史键：任一命名键为 false 即视为停用。
          ds: config?.ds?.[id] !== false && config?.ds?.[dirName] !== false,
          pi: config?.pi?.[id] !== false && config?.pi?.[dirName] !== false,
        },
      });
    }
  }
  return out;
}

/** 宿主插件的中文说明（按 id 索引；未收录的回落到文件路径）。 */
const HOST_DESCRIPTIONS = {
  "mcca-dsh-adapter": "共享插件库的 dsh 侧适配器：把 plugins/ 里的工具、命令挂进 dsh",
  "mcca-session-delete": "会话删除：挂 POST /mcca/sessions/delete，补齐 dsh 缺失的删除会话能力",
  "mcca-client-flags": "客户端插件开关：挂 GET /mcca/client-flags，让界面插件禁用即刻生效、免重启",
  "mcca-task-notify": "任务通知：目标完成/失败时推给 portal 发系统通知，兜底 agent 运行期报错",
  "mcca-hot-mount": "热挂载监管器：按 config/hot-plugins.json 清单装载/卸载宿主插件，免重启",
};

/**
 * 宿主侧热挂载插件（config/hot-plugins.json 清单，监管器 700ms 对账）。 */
function listHostPlugins() {
  const manifest = Array.isArray(readJson(HOST_MANIFEST, [])) ? readJson(HOST_MANIFEST, []) : [];
  const parked = Array.isArray(readJson(HOST_DISABLED, [])) ? readJson(HOST_DISABLED, []) : [];
  const rows = [
    ...manifest.map((entry) => ({ entry, enabled: true })),
    ...parked.map((entry) => ({ entry, enabled: false })),
  ];
  return rows.map(({ entry, enabled }) => ({
    name: entry.id,
    version: "0.0.0",
    kind: "host",
    surface: "host",
    description:
      HOST_DESCRIPTIONS[entry.id] ||
      `宿主插件（热挂载）：${path.basename(path.dirname(entry.file || ""))}/${path.basename(entry.file || "")}`,
    // 只挂 dsh。
    targets: ["ds"],
    enabled: { ds: enabled, pi: false },
  }));
}

async function setPluginEnabled(name, agent, enabled, surface = "shared") {
  if (surface === "client") return setClientPluginEnabled(name, agent, enabled);
  if (surface === "host") return setHostPluginEnabled(name, enabled);
  if (agent !== "ds" && agent !== "pi") return { ok: false, error: `agent must be ds or pi, got ${agent}` };
  const configPath = path.resolve(PLUGINS_CONFIG);
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  config[agent] = config[agent] || {};
  config[agent][name] = Boolean(enabled);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { ok: true };
}

/**
 * 写客户端 bundle 开关。两侧都即时生效：pi 的 boot 图每次响应现算（禁用即从图
 * 里消失）；dsh 的 boot 行删不掉（client-modules 不回收已删行），所以 bundle
 * 自己服从 GET /mcca/client-flags，禁用即不产生任何效果。
 */
function setClientPluginEnabled(name, agent, enabled) {
  if (agent !== "ds" && agent !== "pi") return { ok: false, error: `agent must be ds or pi, got ${agent}` };
  const config = readJson(CLIENT_PLUGINS_CONFIG, {}) || {};
  config[agent] = config[agent] && typeof config[agent] === "object" ? config[agent] : {};
  config[agent][name] = Boolean(enabled);
  fs.mkdirSync(path.dirname(CLIENT_PLUGINS_CONFIG), { recursive: true });
  fs.writeFileSync(CLIENT_PLUGINS_CONFIG, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { ok: true };
}

/**
 * 写宿主插件开关：在清单与 parked 文件之间搬条目。监管器每轮对账读清单，
 * 摘除即 dispose fiber、加入即重导重挂——全程不重启宿主。
 */
function setHostPluginEnabled(name, enabled) {
  const manifest = Array.isArray(readJson(HOST_MANIFEST, [])) ? readJson(HOST_MANIFEST, []) : [];
  const parked = Array.isArray(readJson(HOST_DISABLED, [])) ? readJson(HOST_DISABLED, []) : [];
  if (enabled) {
    const move = parked.filter((row) => row?.id === name);
    if (!move.length) return { ok: false, error: `not a disabled host plugin: ${name}` };
    const keep = manifest.filter((row) => row?.id !== name);
    fs.writeFileSync(HOST_MANIFEST, `${JSON.stringify([...keep, ...move], null, 2)}\n`, "utf8");
    fs.writeFileSync(HOST_DISABLED, `${JSON.stringify(parked.filter((row) => row?.id !== name), null, 2)}\n`, "utf8");
    return { ok: true };
  }
  const move = manifest.filter((row) => row?.id === name);
  if (!move.length) return { ok: false, error: `not a mounted host plugin: ${name}` };
  fs.writeFileSync(HOST_MANIFEST, `${JSON.stringify(manifest.filter((row) => row?.id !== name), null, 2)}\n`, "utf8");
  const rest = parked.filter((row) => row?.id !== name);
  fs.writeFileSync(HOST_DISABLED, `${JSON.stringify([...rest, ...move], null, 2)}\n`, "utf8");
  return { ok: true };
}

/**
 * Runtime change notification is not needed: the dsh side picks changes up
 * through its own fs.watch.
 */

async function listMcp() {
  return readMcpServers(MCP_CONFIG);
}

/** Toggle one MCP server for an agent by rewriting config/mcp.json. */
async function setMcpEnabled(serverName, agent, enabled) {
  const servers = readMcpServers(MCP_CONFIG);
  const target = servers.find((s) => s.serverName === serverName);
  if (!target) return { ok: false, error: `unknown server: ${serverName}` };
  const key = agent === "ds" ? "disabledDs" : "disabledPi";
  if (enabled) delete target[key];
  else target[key] = true;
  fs.mkdirSync(path.dirname(path.resolve(MCP_CONFIG)), { recursive: true });
  fs.writeFileSync(path.resolve(MCP_CONFIG), `${JSON.stringify(servers, null, 2)}\n`, "utf8");
  return { ok: true };
}

/** Remove one MCP server from the shared registry. */
async function deleteMcpServer(serverName) {
  const servers = readMcpServers(MCP_CONFIG);
  const next = servers.filter((s) => s.serverName !== serverName);
  if (next.length === servers.length) return { ok: false, error: `unknown server: ${serverName}` };
  fs.writeFileSync(path.resolve(MCP_CONFIG), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { ok: true };
}

/** Register or replace an MCP server (PUT /api/mcp). */
async function upsertMcpServer(body) {
  const serverName = String(body.serverName || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    return { ok: false, error: "serverName must match [A-Za-z0-9_-]{1,32}" };
  }
  const transport = body.transport === "sse" ? "sse" : "stdio";
  const entry = { serverName, transport };
  if (transport === "stdio") {
    if (!body.command) return { ok: false, error: "stdio transport requires command" };
    entry.command = String(body.command);
    if (Array.isArray(body.args) && body.args.length) entry.args = body.args.map(String);
    if (body.env && typeof body.env === "object") entry.env = body.env;
  } else {
    if (!body.url) return { ok: false, error: "sse transport requires url" };
    entry.url = String(body.url);
  }
  if (body.dsh === false) entry.dsh = false;
  const servers = readMcpServers(MCP_CONFIG);
  const idx = servers.findIndex((s) => s.serverName === serverName);
  if (idx >= 0) servers[idx] = entry;
  else servers.push(entry);
  fs.mkdirSync(path.dirname(path.resolve(MCP_CONFIG)), { recursive: true });
  fs.writeFileSync(path.resolve(MCP_CONFIG), `${JSON.stringify(servers, null, 2)}\n`, "utf8");
  return { ok: true, server: entry };
}

function listSkills() {
  const out = [];
  const seen = new Set();
  for (const root of [SKILLS_DIR, IDE_SKILLS_DIR]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      const skillFile = path.join(root, entry.name, "SKILL.md");
      let description = "";
      if (fs.existsSync(skillFile)) {
        const text = fs.readFileSync(skillFile, "utf8");
        const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
        if (fm) {
          const desc = /^description:\s*(.+)$/m.exec(fm[1]);
          if (desc) description = desc[1].trim();
        }
      }
      out.push({ name: entry.name, description, dir: path.join(root, entry.name) });
    }
  }
  return out;
}

/** Remove one skill bundle from the shared library. Builtin IDE skills stay. */
async function deleteSkill(name) {
  const dir = path.resolve(path.join(SKILLS_DIR, path.basename(String(name || ""))));
  if (!dir.startsWith(path.resolve(SKILLS_DIR)) || dir === path.resolve(SKILLS_DIR)) {
    return { ok: false, error: "invalid skill name" };
  }
  if (!fs.existsSync(dir)) return { ok: false, error: `unknown skill: ${name}` };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

// ── HTTP server ──────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const VENDOR = {
  "/vendor/react.js": { package: "react", file: "umd/react.production.min.js" },
  "/vendor/react-dom.js": { package: "react-dom", file: "umd/react-dom.production.min.js" },
  "/vendor/xterm.js": { package: "@xterm/xterm", file: "lib/xterm.mjs" },
  "/vendor/xterm.css": { package: "@xterm/xterm", file: "css/xterm.css" },
  "/vendor/addon-fit.js": { package: "@xterm/addon-fit", file: "lib/addon-fit.mjs" },
};

function resolveVendor(entry) {
  try {
    const packageDir = path.dirname(require.resolve(`${entry.package}/package.json`));
    return path.join(packageDir, entry.file);
  } catch {
    return null;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/**
 * 按 UTF-8 解 body；出现替换符（非法字节）时按系统 ANSI 编码重解一次。
 *
 * Windows 上 curl / PowerShell 把中文按 GBK(cp936) 发出时，UTF-8 解码会把每个
 * 汉字变成若干 U+FFFD（不可逆），事件板就成了乱码。这里保留原始字节做兜底：
 * gb18030 能覆盖 GBK/GB2312，多试几个常见 ANSI 编码，全都解不出干净的才放弃。
 */
function decodeBodyUtf8(buf) {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  for (const enc of ["gb18030", "gbk", "big5", "shift_jis"]) {
    try {
      const alt = new TextDecoder(enc).decode(buf);
      if (alt && !alt.includes("\uFFFD")) return alt;
    } catch {
      // 运行时没带该编码表：跳过
    }
  }
  return utf8;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = chunks.length ? decodeBodyUtf8(Buffer.concat(chunks)) : "";
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendFile(res, filePath, mime) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// ── Resource monitor: feeds the manage-view side panel ────────────
const RES_POLL_MS = 2000;
const RES_TREE_TTL_MS = 8000;
let resCache = null;
let resInFlight = null;
let treePids = new Set();
let treeProcesses = new Map();
let treeAt = 0;
let treeRefresh = null;
let prevCpuTimes = null;
let prevProcCpu = new Map();
let prevNic = null;
let prevProbeAt = 0;

const RES_FAST_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$items = New-Object System.Collections.Generic.List[object]
foreach ($g in @(Get-Process)) {
  $cpu = 0.0
  if ($g.CPU) { $cpu = [double]$g.CPU }
  $started = ""
  try { $started = $g.StartTime.ToUniversalTime().Ticks.ToString() } catch {}
  $items.Add(@{ id = $g.Id; name = $g.ProcessName; started = $started; ws = [long]$g.WorkingSet64; private = [long]$g.PrivateMemorySize64; cpu = $cpu })
}
$est = @{}
foreach ($l in (netstat -ano -p tcp)) {
  if ($l -match 'ESTABLISHED\s+(\d+)\s*$') { $est[$Matches[1]] = 1 }
}
$rx = [long]0; $tx = [long]0
foreach ($i in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
  if ($i.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up -and $i.NetworkInterfaceType -ne [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) {
    $s = $i.GetIPStatistics()
    $rx += [long]$s.BytesReceived
    $tx += [long]$s.BytesSent
  }
}
@{ procs = $items; connPids = @($est.Keys); connTotal = $est.Count; nicRx = $rx; nicTx = $tx } | ConvertTo-Json -Compress -Depth 3
`;

const RES_TREE_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$portalPid = __PORTALPID__
$managedPids = @(__MANAGEDPIDS__)
$byId = @{}
$children = @{}
foreach ($p in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine)) {
  $k = [string]$p.ProcessId
  $byId[$k] = $p
  $pk = [string]$p.ParentProcessId
  if (-not $children.ContainsKey($pk)) { $children[$pk] = New-Object System.Collections.Generic.List[string] }
  $children[$pk].Add($k)
}
$inTree = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $byId.Values) {
  if ($p.Name -ieq 'mcca-desktop.exe' -or $p.ProcessId -eq $portalPid -or $managedPids -contains $p.ProcessId) { [void]$inTree.Add([string]$p.ProcessId) }
}
$queue = New-Object System.Collections.Generic.Queue[string]
foreach ($k in @($inTree)) { $queue.Enqueue($k) }
while ($queue.Count -gt 0) {
  $cur = $queue.Dequeue()
  if (-not $children.ContainsKey($cur)) { continue }
  foreach ($c in $children[$cur]) {
    if ($inTree.Contains($c)) { continue }
    $pp = $byId[$c]
    if (-not $pp) { continue }
    if ($pp.Name -ieq 'powershell.exe' -and $pp.ParentProcessId -eq $portalPid) { continue }
    [void]$inTree.Add($c)
    $queue.Enqueue($c)
  }
}
$details = foreach ($k in $inTree) {
  $p = $byId[$k]
  $command = [string]$p.CommandLine
  if ($command.Length -gt 1500) { $command = $command.Substring(0, 1500) }
  @{ id = $p.ProcessId; parent = $p.ParentProcessId; name = $p.Name; command = $command }
}
@{ pids = @(@($inTree)); details = @($details) } | ConvertTo-Json -Compress -Depth 4
`;

function runPs(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
    let out = ""; let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error("probe timeout")); }, timeoutMs || 10000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) { reject(new Error((err || "probe failed").slice(-160))); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function refreshTree() {
  return runPs(RES_TREE_PS.replace("__PORTALPID__", String(process.pid)).replace("__MANAGEDPIDS__", [...children.values()].map(r => Number(r.child?.pid)).filter(Number.isSafeInteger).join(",")), 15000)
    .then((raw) => {
      treePids = new Set(asArray(raw.pids).map(String));
      treeProcesses = new Map(asArray(raw.details).map((p) => [String(p.id), {
        id: p.id,
        parent: p.parent,
        name: p.name,
        hint: commandHint(p.command),
      }]));
      treeAt = Date.now();
    })
    .catch(() => {});
}

function ensureTree() {
  if (Date.now() - treeAt > RES_TREE_TTL_MS && !treeRefresh) {
    treeRefresh = refreshTree().finally(() => { treeRefresh = null; });
  }
}

function cpuTotalPct() {
  const now = os.cpus();
  if (!prevCpuTimes) { prevCpuTimes = now.map((c) => c.times); return 0; }
  let busy = 0, total = 0;
  for (let i = 0; i < now.length; i++) {
    const p = prevCpuTimes[i] || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const n = now[i].times;
    total += (n.user - p.user) + (n.nice - p.nice) + (n.sys - p.sys) + (n.idle - p.idle) + (n.irq - p.irq);
    busy += (n.user - p.user) + (n.nice - p.nice) + (n.sys - p.sys) + (n.irq - p.irq);
  }
  prevCpuTimes = now.map((c) => c.times);
  return total > 0 ? Math.min(100, Math.max(0, Math.round((busy / total) * 1000) / 10)) : 0;
}

function refreshResources() {
  ensureTree();
  return runPs(RES_FAST_PS, 10000).then((raw) => {
    const now = Date.now();
    const dtSec = prevProbeAt ? Math.max(0.5, (now - prevProbeAt) / 1000) : 0;
    const cores = os.cpus().length;
    let memApp = 0, appCpuRaw = 0, procCount = 0;
    const processes = [];
    for (const p of asArray(raw.procs)) {
      if (!treePids.has(String(p.id))) continue;
      const meta = treeProcesses.get(String(p.id));
      const hint = meta?.hint || "";
      const described = describeAppProcess({ name: meta?.name || p.name, hint, pid: p.id, portalPid: process.pid });
      if (described.kind === "conhost") continue;
      procCount++;
      memApp += p.ws || 0;
      const prev = prevProcCpu.get(String(p.id));
      const cpu = prev !== undefined && dtSec > 0 ? Math.max(0, (p.cpu - prev) / dtSec) : 0;
      appCpuRaw += cpu;
      let cursor = String(p.id), service = "", rootPid = null;
      const visited = new Set();
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const owner = [...children].find(([, rec]) => String(rec.child?.pid) === cursor);
        const cursorMeta = treeProcesses.get(cursor);
        const cursorKind = describeAppProcess({
          name: cursorMeta?.name || "",
          hint: cursorMeta?.hint || "",
          pid: Number(cursor),
          portalPid: process.pid,
        }).kind;
        if (owner || SERVICE_KINDS.has(cursorKind)) {
          service = owner ? owner[0] : cursorKind;
          rootPid = Number(cursor);
          break;
        }
        cursor = cursorMeta ? String(cursorMeta.parent) : "";
      }
      processes.push(buildProcessRow({
        pid: p.id,
        parentPid: meta?.parent || null,
        name: meta?.name || p.name,
        hint,
        started: p.started,
        memory: p.ws,
        privateMemory: p.private,
        cpu: Math.min(100, Math.round((cpu / cores) * 1000) / 10),
        portalPid: process.pid,
        service,
        rootPid,
      }));
    }
    const nextCpu = new Map();
    for (const p of asArray(raw.procs)) nextCpu.set(String(p.id), p.cpu || 0);
    prevProcCpu = nextCpu;
    prevProbeAt = now;
    let conns = 0;
    for (const pid of asArray(raw.connPids)) { if (treePids.has(String(pid))) conns++; }
    let netDown = 0, netUp = 0;
    if (prevNic && dtSec > 0) {
      netDown = Math.max(0, Math.round((raw.nicRx - prevNic.rx) / dtSec));
      netUp = Math.max(0, Math.round((raw.nicTx - prevNic.tx) / dtSec));
    }
    prevNic = { rx: raw.nicRx, tx: raw.nicTx };
    const cpuTotal = cpuTotalPct();
    const cpuApp = procCount ? Math.min(100, Math.round((appCpuRaw / cores) * 1000) / 10) : 0;
    return {
      ok: true, at: now,
      cpuApp, cpuTotal,
      memApp, memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(),
      netDown, netUp, netConns: conns, procCount, processes,
    };
  });
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: "进程结束失败，请刷新状态" }));
  });
}

function getResources() {
  ensureTree();
  const waitTree = treePids.size === 0 && treeRefresh ? treeRefresh : Promise.resolve();
  return waitTree.then(() => {
    if (resCache && Date.now() - resCache.at < RES_POLL_MS) return resCache;
    if (resInFlight) return resInFlight;
    resInFlight = refreshResources()
      .then((data) => { resCache = data; return data; })
      .catch((e) => ({ ok: false, at: Date.now(), error: String(e.message || e) }))
      .finally(() => { resInFlight = null; });
    return resInFlight;
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api", "plugins", "hello-tool"]
  const method = req.method || "GET";

  try {
    if (parts[0] !== "api") return false;

    // ── 任务通知队列（宿主 → portal → 系统通知 / 事件板）────────────
    // dsh / pi 在目标完成或受阻时 POST 到这里；前端轮询 /api/notifications
    // 取走后经 Tauri 发系统通知。队列有界（最近 50 条），portal 重启即清空。
    //
    // kind 决定这条通知会不会上「事件板」：事件板只放人工推的（manual，默认），
    // 宿主自动播报的终态通知标记 auto，只弹系统通知、不上板。
    if (parts[1] === "notify" && method === "POST") {
      const body = await readJsonBody(req);
      const title = String(body?.title || "").slice(0, 160);
      const text = String(body?.body || "").slice(0, 4000);
      const kind = body?.kind === "auto" ? "auto" : "manual";
      if (!title && !text) {
        sendJson(res, 400, { ok: false, error: "title or body required" });
        return true;
      }
      notifySeq += 1;
      const item = { id: notifySeq, title: title || "mcca", body: text, kind, at: Date.now() };
      let source = normalizeSource(body?.source);
      if (source) {
        try { source = await enrichNotifySource(source); } catch { /* 对不上会话也不影响入队 */ }
        item.source = source;
      }
      notifyQueue.push(item);
      while (notifyQueue.length > NOTIFY_QUEUE_MAX) notifyQueue.shift();
      appendNotifyArchive(item);
      sendJson(res, 200, { ok: true, id: notifySeq });
      return true;
    }
    // 用量报表：pi（会话文件 usage）+ dsh（tok-heatmap.json）
    if (parts[1] === "usage" && method === "GET") {
      sendJson(res, 200, usageReport());
      return true;
    }
    if (parts[1] === "agenda" && method === "GET") {
      sendJson(res, 200, { ok: true, items: listAgenda() });
      return true;
    }
    if (parts[1] === "agenda" && method === "POST" && !parts[2]) {
      const body = await readJsonBody(req);
      const made = addAgenda(body);
      if (!made.ok) {
        sendJson(res, 400, made);
        return true;
      }
      const handed = handAgendaToHermes();
      sendJson(res, handed.ok ? 200 : 409, {
        ok: handed.ok,
        item: made.item,
        items: listAgenda(),
        error: handed.ok ? undefined : handed.error,
        note: handed.note || "",
      });
      return true;
    }
    if (parts[1] === "agenda" && parts[2] && method === "POST") {
      const body = await readJsonBody(req);
      const result = patchAgenda(decodeURIComponent(parts[2]), body);
      sendJson(res, result.ok ? 200 : 404, result);
      return true;
    }
    if (parts[1] === "agenda" && parts[2] && method === "DELETE") {
      const result = deleteAgenda(decodeURIComponent(parts[2]));
      sendJson(res, result.ok ? 200 : 404, result);
      return true;
    }
    if (parts[1] === "cli-providers" && method === "GET") {
      sendJson(res, 200, { ok: true, providers: cliProviders.list(), selection: cliProviders.readSelection() });
      return true;
    }
    if (parts[1] === "cli-providers" && parts[2] === "discover" && method === "POST") {
      const body = await readJsonBody(req);
      const found = await cliProviders.discover(body);
      sendJson(res, found && found.error ? 400 : 200, found && found.error ? { ok: false, error: found.error } : { ok: true, models: found.models || [] });
      return true;
    }
    if (parts[1] === "cli-providers" && parts[2] === "catalog" && parts[3] && method === "PUT") {
      const body = await readJsonBody(req);
      const saved = cliProviders.save(decodeURIComponent(parts[3]), body);
      sendJson(res, saved.ok ? 200 : (saved.status || 400), saved.ok ? { ok: true, providers: cliProviders.list() } : saved);
      return true;
    }
    if (parts[1] === "cli-providers" && parts[2] === "catalog" && parts[3] && method === "DELETE") {
      const removed = cliProviders.remove(decodeURIComponent(parts[3]));
      sendJson(res, removed.ok ? 200 : (removed.status || 400), removed.ok ? { ok: true, providers: cliProviders.list() } : removed);
      return true;
    }
    if (parts[1] === "cli-providers" && parts[2] && method === "POST") {
      const body = await readJsonBody(req);
      const result = cliProviders.select(decodeURIComponent(parts[2]), body && body.provider, body && body.modelId);
      sendJson(res, result.ok ? 200 : (result.status || 400), result);
      return true;
    }
    if (parts[1] === "desk" && method === "GET") {
      const snap = await Promise.race([
        deskSnapshot(),
        new Promise((resolve) => setTimeout(() => resolve(null), 2200)),
      ]);
      const body = snap || { running: [], recent: [], offline: deskSides().map((side) => side.agent) };
      sendJson(res, 200, { ok: true, running: body.running, recent: body.recent, offline: body.offline, at: Date.now() });
      return true;
    }
    if (parts[1] === "notifications" && parts[2] && method === "DELETE") {
      const id = Number(parts[2]);
      if (!Number.isFinite(id)) {
        sendJson(res, 400, { ok: false, error: "bad id" });
        return true;
      }
      deleteNotify(id);
      sendJson(res, 200, { ok: true, id });
      return true;
    }
    if (parts[1] === "notifications" && parts[2] === "garbled" && method === "DELETE") {
      const ids = notifyQueue.filter(garbledNotify).map((item) => item.id);
      for (const id of ids) deleteNotify(id);
      sendJson(res, 200, { ok: true, removed: ids.length, ids });
      return true;
    }
    if (parts[1] === "notifications" && method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const items = notifyQueue.filter((n) => n.id > since);
      sendJson(res, 200, { ok: true, items, latest: notifySeq });
      return true;
    }
    if (parts[1] === "diary" && method === "GET") {
      sendJson(res, 200, { ok: true, entries: listDiary() });
      return true;
    }
    if (parts[1] === "diary" && method === "POST") {
      const body = await readJsonBody(req);
      const result = addDiary(body);
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }
    if (parts[1] === "diary" && parts[2] && method === "DELETE") {
      const result = deleteDiary(decodeURIComponent(parts[2]));
      sendJson(res, result.ok ? 200 : 404, result);
      return true;
    }
    if (parts[1] === "memory" && method === "GET") {
      try {
        sendJson(res, 200, { ok: true, ...(await memorySnapshot()) });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || String(error) });
      }
      return true;
    }

    if (parts[1] === "updates" && method === "GET") {
      sendJson(res, 200, await checkUpdates());
      return true;
    }
    if (parts[1] === "updates" && parts[2] === "hermes" && method === "POST") {
      const body = await readJsonBody(req);
      const wanted = hermesTagFrom(body && body.version ? `/${body.version}` : "") || await hermesLatestTag();
      if (!wanted) {
        sendJson(res, 502, { ok: false, error: "没有读到Hermes Agent的最新版本" });
        return true;
      }
      const result = await runHermesInstall(wanted);
      sendJson(res, result.ok ? 200 : 500, result.ok ? { ok: true, version: result.version || wanted } : result);
      return true;
    }

    if (parts[1] === "status" && method === "GET") {
      sendJson(res, 200, {
        ok: true,
        agents: [agentStatus("dsh"), agentStatus("pi-web"), agentStatus("codex-cli"), agentStatus("openhands-web"), agentStatus("grok-web"), agentStatus("hermes-web"), agentStatus("canvas"), agentStatus("mobile")],
      });
      return true;
    }

    if (parts[1] === "pick-dir" && method === "POST") {
      sendJson(res, 200, await pickDirectory());
      return true;
    }

    if (parts[1] === "cli-history" && parts[2] && method === "GET") {
      const agent = decodeURIComponent(parts[2]);
      if (!AGENTS[agent] || !(AGENTS[agent].cli || AGENTS[agent].terminal)) {
        sendJson(res, 404, { ok: false, error: "不是命令行" });
        return true;
      }
      sendJson(res, 200, { ok: true, sessions: listCliHistory(agent, { hermesHome: hermes.home }) });
      return true;
    }
    if (parts[1] === "cli-history" && parts[2] && parts[3] && method === "DELETE") {
      const agent = decodeURIComponent(parts[2]);
      const id = decodeURIComponent(parts[3]);
      if (!AGENTS[agent] || !(AGENTS[agent].cli || AGENTS[agent].terminal)) {
        sendJson(res, 404, { ok: false, error: "不是命令行" });
        return true;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(id)) {
        sendJson(res, 400, { ok: false, error: "会话编号不对" });
        return true;
      }
      const result = deleteCliHistory(agent, id, { hermesHome: hermes.home });
      sendJson(res, result.ok ? 200 : 404, result);
      return true;
    }

    if (parts[1] === "pty" && parts[2] && parts[3] === "stream" && method === "GET") {
      ptyHost.stream(req, res, decodeURIComponent(parts[2]));
      return true;
    }
    if (parts[1] === "pty" && parts[2] && parts[3] === "input" && method === "POST") {
      const body = await readJsonBody(req);
      sendJson(res, 200, ptyHost.write(decodeURIComponent(parts[2]), body.data));
      return true;
    }
    if (parts[1] === "pty" && parts[2] && parts[3] === "resize" && method === "POST") {
      const body = await readJsonBody(req);
      sendJson(res, 200, ptyHost.resize(decodeURIComponent(parts[2]), body.cols, body.rows));
      return true;
    }
    if (parts[1] === "pty" && parts[2] && !parts[3] && method === "DELETE") {
      sendJson(res, 200, ptyHost.close(decodeURIComponent(parts[2])));
      return true;
    }

    if (parts[1] === "process" && parts[3] && (method === "POST")) {
      const agent = parts[2];
      const action = parts[3];
      if (action === "start") {
        const body = await readJsonBody(req);
        sendJson(res, 200, await startAgent(agent, body || {}));
      }
      else if (action === "stop") sendJson(res, 200, stopAgent(agent));
      else if (action === "restart") sendJson(res, 200, await restartAgent(agent));
      else if (action === "install") sendJson(res, 200, installInstance(agent));
      else if (action === "delete") sendJson(res, 200, deleteInstance(agent));
      else if (action === "resident") {
        const body = await readJsonBody(req);
        sendJson(res, 200, setResident(agent, Boolean(body && body.on)));
      }
      else sendJson(res, 400, { ok: false, error: `unknown action ${action}` });
      return true;
    }

    if (parts[1] === "resource-process" && method === "POST") {
      // Only act on a current application-owned process, never an arbitrary supplied PID.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
        sendJson(res, 403, { ok: false, error: "不允许跨站进程操作" }); return true;
      }
      const body = await readJsonBody(req);
      const pid = Number(body.pid);
      const action = body.action;
      if (!Number.isSafeInteger(pid) || pid <= 0 || !["stop", "restart"].includes(action)) {
        sendJson(res, 400, { ok: false, error: "无效进程操作" }); return true;
      }
      await refreshTree();
      const current = await refreshResources();
      const row = (current.processes || []).find((item) => item.pid === pid && String(item.started) === String(body.started || ""));
      if (!row) {
        sendJson(res, 409, { ok: false, error: "进程已退出或已变化，请刷新" }); return true;
      }
      let result;
      if (action === "restart") {
        if (!row.canRestart || !AGENTS[row.service] || !isInstalled(row.service)) {
          sendJson(res, 409, { ok: false, error: "这个进程不能单独重启，请刷新" }); return true;
        }
        result = await restartAgent(row.service);
      } else if (!row.canStop) {
        sendJson(res, 409, { ok: false, error: "不允许在这里结束这个进程，请刷新" }); return true;
      } else if (row.service && row.pid === row.rootPid && children.has(row.service)) {
        result = stopAgent(row.service);
      } else {
        result = await taskkillTree(pid);
      }
      resCache = null;
      treeAt = 0;
      sendJson(res, result.ok ? 200 : 409, result); return true;
    }

    // ── Shared plugin library ───────────────────────────────────
    // ── Resource monitor (manage-view side panel) ───────────────
    if (parts[1] === "resources" && method === "GET") {
      sendJson(res, 200, await getResources());
      return true;
    }

    if (parts[1] === "plugins" && method === "GET") {
      sendJson(res, 200, { ok: true, plugins: await listPlugins() });
      return true;
    }
    if (parts[1] === "plugins" && parts[2] && method === "POST") {
      const body = await readJsonBody(req);
      const surface = body.surface || "shared";
      // Accept both a single-agent toggle and a combined {ds, pi} patch so the
      // UI can flip one switch that writes both sides in one click.
      const result = { ok: true };
      if (body.agent) {
        Object.assign(result, await setPluginEnabled(parts[2], body.agent, body.enabled, surface));
      } else {
        for (const agent of ["ds", "pi"]) {
          if (body.enabled && agent in body.enabled) {
            await setPluginEnabled(parts[2], agent, body.enabled[agent], surface);
          }
        }
      }
      sendJson(res, 200, result);
      return true;
    }

    // ── Shared MCP registry ─────────────────────────────────────
    if (parts[1] === "mcp" && method === "GET") {
      sendJson(res, 200, { ok: true, servers: await listMcp() });
      return true;
    }
    if (parts[1] === "mcp" && parts[2] && method === "POST") {
      const body = await readJsonBody(req);
      const result =
        body.action === "delete"
          ? await deleteMcpServer(parts[2])
          : await setMcpEnabled(parts[2], body.agent, body.enabled);
      sendJson(res, 200, result);
      return true;
    }
    if (parts[1] === "mcp" && method === "PUT") {
      // Register a new server (or replace one with the same serverName).
      const body = await readJsonBody(req);
      const result = await upsertMcpServer(body);
      sendJson(res, 200, result);
      return true;
    }

    // ── Shared skill library ────────────────────────────────────
    if (parts[1] === "skills" && method === "GET") {
      sendJson(res, 200, { ok: true, skills: listSkills() });
      return true;
    }
    if (parts[1] === "skills" && parts[2] && method === "DELETE") {
      sendJson(res, 200, await deleteSkill(parts[2]));
      return true;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
    return true;
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
    return true;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

  if (pathname.startsWith("/api/")) {
    if (await handleApi(req, res, url)) return;
  }

  if (VENDOR[pathname]) {
    const resolved = resolveVendor(VENDOR[pathname]);
    const ext = resolved ? path.extname(resolved) : "";
    const mime = ext === ".mjs" ? MIME[".js"] : (MIME[ext] || "application/octet-stream");
    if (resolved) sendFile(res, resolved, mime);
    else {
      res.writeHead(500);
      res.end("vendor react build not found; run pnpm install");
    }
    return;
  }

    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  sendFile(res, filePath, MIME[path.extname(filePath)] || "application/octet-stream");
});

server.on("error", (error) => {
  console.error(`[portal] cannot listen on 127.0.0.1:${PORT}: ${error.message}`);
  if (error.code === "EADDRINUSE") {
    console.error(`[portal] another portal instance already owns port ${PORT}; exiting`);
    process.exit(1);
  }
});

async function restoreManagedProcesses() {
  if (!process.env.MCCA_PORTAL_HANDOVER) return;
  const records = JSON.parse(process.env.MCCA_PORTAL_HANDOVER);
  delete process.env.MCCA_PORTAL_HANDOVER;
  if (!Array.isArray(records)) throw new Error("Invalid process handover");
  for (const record of records) {
    const pid = Number(record.pid);
    if (!AGENTS[record.agent] || !Number.isSafeInteger(pid) || pid <= 0) continue;
    let live;
    try {
      live = await runPs(`$p = Get-Process -Id ${pid} -ErrorAction Stop; @{ started = $p.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress`, 10000);
    } catch (error) {
      console.error(`[portal] handover skip ${record.agent} pid ${pid}: ${error.message}`);
      continue;
    }
    if (!live || String(live.started) !== String(record.started)) {
      console.error(`[portal] handover skip ${record.agent} pid ${pid}: process changed`);
      continue;
    }
    children.set(record.agent, {
      child: watchedChild(pid),
      startedAt: record.startedAt,
      adopted: true,
      log: ["[portal] 已接管原有服务，任务未重启"],
    });
  }
}

restoreManagedProcesses().then(async () => {
  for (const agent of webAgents()) {
    if (!isInstalled(agent)) continue;
    try { adoptListener(agent); } catch (error) { console.error(`[portal] adopt ${agent}: ${error.message}`); }
  }
  // adopt 只接上还活着的；标了常驻的由这里补起来，之后交给巡检看护。
  try {
    await ensureResidentAgents();
  } catch (error) {
    console.error(`[portal] resident startup: ${error.message}`);
  }
  startResidentWatch();
  server.listen(PORT, "127.0.0.1", () => {
  console.log(`portal → http://localhost:${PORT}`);
  console.log(`  dsh        : ${AGENTS.dsh.cmd} ${AGENTS.dsh.args.join(" ")} (port ${AGENTS.dsh.port})`);
  // 打开应用不拉起 IDE、命令行和工具。上面的 adopt 只接上上次还开着的进程。
  void regenerateDshMcpPatch().then((count) => {
    if (count) console.log(`  dsh mcp patch regenerated: ${count} server(s)`);
  });
  if (!hermes.installed()) {
    void hermesLatestTag().then((tag) => runHermesInstall(tag)).then((result) => {
      console.log(result.ok ? `  hermes installed ${result.version}` : `  hermes install skipped: ${result.error}`);
    });
  }
  });
}).catch(error => { console.error("[portal] handover failed:", error.message); process.exitCode = 1; });
