"use strict";

/**
 * @pi-dsh-bridge/portal — the desktop-app core.
 *
 * A Node process that:
 *  - spawns / stops / supervises the dsh and pi child processes,
 *  - serves a four-tab React frontend (dsh iframe / pi iframe / canvas / manage),
 *  - exposes a small JSON management API (plugins, MCP, skills, processes).
 *
 * This is the process the Tauri shell (desktop/) wraps in a native window.
 * Keeping dsh, pi and portal as three separate processes means one crashing
 * does not take the others down.
 */

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { readMcpServers } = require("@pi-dsh-bridge/pi-mcp");
const os = require("node:os");

// This file lives at packages/portal/server.cjs, so the repo root is two levels up.
const ROOT = path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = Number(process.env.PORTAL_PORT) || 3470;

const PLUGINS_DIR = process.env.PDB_PLUGINS_DIR || path.join(ROOT, "plugins");
const PLUGINS_CONFIG = process.env.PDB_PLUGINS_CONFIG || path.join(ROOT, "config", "plugins.json");
const MCP_CONFIG = process.env.PDB_MCP_CONFIG || path.join(ROOT, "config", "mcp.json");
const SKILLS_DIR = process.env.PDB_SKILLS_DIR || path.join(ROOT, "skills");

// The dsh MCP overlay lives in the shared config dir. dsh is launched from its
// npm installation with this as an extra layer, so dsh sources stay untouched.
// Bridge plugins are NOT mounted here: they live in the profile's watched
// cordis layer, so changing the plugin set needs no dsh restart.
const DSH_MCP_PATCH = process.env.PDB_DSH_MCP_PATCH || path.join(ROOT, "config", "dsh-mcp.patch.yml");

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
const DSH_HOME = process.env.PDB_DSH_HOME || path.join(ROOT, "config", "dsh-home");

const AGENTS = {
  dsh: {
    label: "dsh",
    port: Number(process.env.DSH_PORT) || 3081,
    // dsh 由本仓库的 npm 依赖提供，运行时从 node_modules 解析，因此工作区里
    // 不需要（也不携带）上游仓库的副本；DSH_HOME 单独指向本地数据目录。
    cmd: process.env.DSH_CMD || process.execPath,
    args: process.env.DSH_ARGS
      ? process.env.DSH_ARGS.split(" ")
      : [
          path.join(ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
          "web",
          "--profile",
          "web",
          "--patch",
          dshMcpPatchArg(),
          "--port",
          String(process.env.DSH_PORT || 3081),
        ],
    cwd: process.env.DSH_CWD || ROOT,
    env: { DSH_HOME },
  },
  "pi-web": {
    // pi 侧原生 Web UI：REST + SSE 直连 pi，不再套 dsh 壳。
    label: "pi",
    port: Number(process.env.PI_PORT) || 3458,
    cmd: process.env.PI_WEB_CMD || process.execPath,
    args: process.env.PI_WEB_ARGS
      ? process.env.PI_WEB_ARGS.split(" ")
      : [path.join("packages", "pi-web", "server.cjs")],
    cwd: ROOT,
    env: { PI_MODEL: process.env.PI_MODEL || "" },
  },
  canvas: {
    // 画布：本机生图服务（ComfyUI）—— portal 画布页签 iframe 的后端，dsh/pi 经
    // comfy MCP 出生图工具。默认不假设安装位置：用 CANVAS_CMD / CANVAS_CWD
    // 指向 ComfyUI 自带的 python 与它所在的目录。解释器必须是 ComfyUI 自己
    // venv 里的 python——无 stdlib 的魔改解释器会在启动时报
    // `No module named 'encodings'`。
    label: "canvas",
    port: Number(process.env.CANVAS_PORT) || 8188,
    cmd: process.env.CANVAS_CMD || (process.platform === "win32" ? "python.exe" : "python"),
    args: process.env.CANVAS_ARGS
      ? process.env.CANVAS_ARGS.split(" ")
      : ["main.py", "--port", String(process.env.CANVAS_PORT || 8188)],
    cwd: process.env.CANVAS_CWD || ROOT,
    env: {},
  },
};

function dshMcpPatchArg() {
  return DSH_MCP_PATCH.replaceAll("\\", "/");
}

const children = new Map(); // agent -> { child, startedAt, log }
const startInFlight = new Set(); // agents with a startAgent() currently awaiting
/** 崩溃退出留档：agent → { code, signal, at, logTail }；成功 start 时清除。 */
const lastExit = new Map();

/** 任务通知队列：宿主 POST /api/notify 入队，前端 GET /api/notifications 取走。 */
const NOTIFY_QUEUE_MAX = 50;
const notifyQueue = [];
let notifySeq = 0;

function logLine(agent, text) {
  const rec = children.get(agent);
  if (!rec) return;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim()) rec.log.push(line);
  }
  if (rec.log.length > 200) rec.log.splice(0, rec.log.length - 200);
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
  "pi-web": "pi-web",
  canvas: "main.py",
};

// 端口号是否必须出现在命令行里才算“同一个服务”。
//   dsh / canvas：签名不唯一（3080 的 `bin.ts web`、别的 `python main.py`
//     都长得一样），必须靠端口号区分，否则误伤无关实例；
//   pi：端口是 server.cjs 的代码默认值，命令行不出现——同旧 pi-dsh-web 的
//     结论，免端口校验。
const RECLAIM_REQUIRE_PORT = {
  dsh: true,
  "pi-web": false,
  canvas: true,
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

function reclaimStaleInstance(agent, cfg) {
  const signature = RECLAIM_SIGNATURES[agent];
  if (!signature) return null;
  try {
    const pid = listeningPid(cfg.port);
    if (!pid) return null;
    const { execSync } = require("node:child_process");
    const commandLine = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    ).trim();
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

async function startAgent(agent) {
  const cfg = AGENTS[agent];
  if (!cfg) return { ok: false, error: `unknown agent: ${agent}` };
  if (children.has(agent)) return { ok: false, error: `${agent} is already running` };
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
        env: { ...process.env, ...(cfg.env || {}), PDB_PORT: String(cfg.port) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: cfg.shell === true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      // Spawn can fail synchronously (missing binary, bad args): release the
      // reserved slot, otherwise the agent shows a phantom "running, pid null".
      children.delete(agent);
      return { ok: false, error: `spawn failed: ${error.message}` };
    }
    rec.child = child;
    lastExit.delete(agent); // 重新起来就清掉上次的崩溃留档，避免状态页误导

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
            logTail: rec.log.slice(-12),
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
  return { ok: true };
}

/**
 * 重启一个实例：停止 → 等进程树真正退出 → 复用 startAgent 拉起新实例。
 * startAgent 内部自带端口回收与可绑定等待，所以这里只需保证旧进程已死，
 * 避免 taskkill 还没杀完就 spawn 出新旧并存或 EADDRINUSE 闪退。
 */
async function restartAgent(agent) {
  const cfg = AGENTS[agent];
  if (!cfg) return { ok: false, error: `unknown agent: ${agent}` };
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
    port: cfg.port,
    running: Boolean(rec?.child && rec.child.exitCode === null),
    pid: rec?.child?.pid ?? null,
    startedAt: rec?.startedAt ?? null,
    log: rec?.log ?? [],
    // 上一次崩溃退出（主动停止不记）：状态页据此区分“我停的”与“它自己死的”。
    lastExit: lastExit.get(agent) ?? null,
  };
}

// Process-level safety net for the portal itself: it supervises both agents,
// so an unhandled error must never take the supervisor down.
process.on("uncaughtException", (error) => {
  console.error("[portal] uncaughtException:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[portal] unhandledRejection:", reason);
});

// ── Shared-config readers (plugins / mcp / skills) ───────────────

let pluginHost = null;
async function getPluginHost() {
  if (!pluginHost) pluginHost = await import("@pi-dsh-bridge/plugin-host");
  return pluginHost;
}

async function listPlugins() {
  const { discoverPlugins, readEnableConfig, isEnabled } = await getPluginHost();
  const config = readEnableConfig(PLUGINS_CONFIG);
  const shared = discoverPlugins(PLUGINS_DIR).map((d) => ({
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
      if (!dirent.isDirectory() || !dirent.name.startsWith("pdb-")) continue;
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
  "pdb-dsh-adapter": "共享插件库的 dsh 侧适配器：把 plugins/ 里的工具、命令挂进 dsh",
  "pdb-session-delete": "会话删除：挂 POST /pdb/sessions/delete，补齐 dsh 缺失的删除会话能力",
  "pdb-client-flags": "客户端插件开关：挂 GET /pdb/client-flags，让界面插件禁用即刻生效、免重启",
  "pdb-task-notify": "任务通知：目标完成/失败时推给 portal 发系统通知，兜底 agent 运行期报错",
  "pdb-hot-mount": "热挂载监管器：按 config/hot-plugins.json 清单装载/卸载宿主插件，免重启",
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
 * 自己服从 GET /pdb/client-flags，禁用即不产生任何效果。
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
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    let description = "";
    if (fs.existsSync(skillFile)) {
      const text = fs.readFileSync(skillFile, "utf8");
      const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
      if (fm) {
        const desc = /^description:\s*(.+)$/m.exec(fm[1]);
        if (desc) description = desc[1].trim();
      }
    }
    out.push({ name: entry.name, description, dir: path.join(SKILLS_DIR, entry.name) });
  }
  return out;
}

/** Remove one skill bundle from the shared library. */
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
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
const RES_TREE_TTL_MS = 60000;
let resCache = null;
let resInFlight = null;
let treePids = new Set();
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
  $items.Add(@{ id = $g.Id; ws = [long]$g.WorkingSet64; cpu = $cpu })
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
$byId = @{}
$children = @{}
foreach ($p in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name)) {
  $k = [string]$p.ProcessId
  $byId[$k] = $p
  $pk = [string]$p.ParentProcessId
  if (-not $children.ContainsKey($pk)) { $children[$pk] = New-Object System.Collections.Generic.List[string] }
  $children[$pk].Add($k)
}
$inTree = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $byId.Values) {
  if ($p.Name -ieq 'pdb-desktop.exe' -or $p.ProcessId -eq $portalPid) { [void]$inTree.Add([string]$p.ProcessId) }
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
@{ pids = @(@($inTree)) } | ConvertTo-Json -Compress
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
  return runPs(RES_TREE_PS.replace("__PORTALPID__", String(process.pid)), 15000)
    .then((raw) => { treePids = new Set((raw.pids || []).map(String)); treeAt = Date.now(); })
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
    for (const p of raw.procs || []) {
      if (!treePids.has(String(p.id))) continue;
      procCount++;
      memApp += p.ws || 0;
      const prev = prevProcCpu.get(String(p.id));
      if (prev !== undefined && dtSec > 0) appCpuRaw += Math.max(0, (p.cpu - prev) / dtSec);
    }
    const nextCpu = new Map();
    for (const p of raw.procs || []) nextCpu.set(String(p.id), p.cpu || 0);
    prevProcCpu = nextCpu;
    prevProbeAt = now;
    let conns = 0;
    for (const pid of raw.connPids || []) { if (treePids.has(String(pid))) conns++; }
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
      netDown, netUp, netConns: conns, procCount,
    };
  });
}

function getResources() {
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

    // ── 任务通知队列（宿主 → portal → 系统通知）─────────────────────
    // dsh / pi 在目标完成或受阻时 POST 到这里；前端轮询 /api/notifications
    // 取走后经 Tauri 发系统通知。队列有界（最近 50 条），portal 重启即清空。
    if (parts[1] === "notify" && method === "POST") {
      const body = await readJsonBody(req);
      const title = String(body?.title || "").slice(0, 120);
      const text = String(body?.body || "").slice(0, 500);
      if (!title && !text) {
        sendJson(res, 400, { ok: false, error: "title or body required" });
        return true;
      }
      notifySeq += 1;
      notifyQueue.push({ id: notifySeq, title: title || "pdb", body: text, at: Date.now() });
      while (notifyQueue.length > NOTIFY_QUEUE_MAX) notifyQueue.shift();
      sendJson(res, 200, { ok: true, id: notifySeq });
      return true;
    }
    if (parts[1] === "notifications" && method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const items = notifyQueue.filter((n) => n.id > since);
      sendJson(res, 200, { ok: true, items, latest: notifySeq });
      return true;
    }

    if (parts[1] === "status" && method === "GET") {
      sendJson(res, 200, {
        ok: true,
        agents: [agentStatus("dsh"), agentStatus("pi-web"), agentStatus("canvas")],
      });
      return true;
    }

    if (parts[1] === "process" && parts[3] && (method === "POST")) {
      const agent = parts[2];
      const action = parts[3];
      if (action === "start") sendJson(res, 200, await startAgent(agent));
      else if (action === "stop") sendJson(res, 200, stopAgent(agent));
      else if (action === "restart") sendJson(res, 200, await restartAgent(agent));
      else sendJson(res, 400, { ok: false, error: `unknown action ${action}` });
      return true;
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
    if (resolved) sendFile(res, resolved, MIME[".js"]);
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`portal → http://localhost:${PORT}`);
  console.log(`  dsh        : ${AGENTS.dsh.cmd} ${AGENTS.dsh.args.join(" ")} (port ${AGENTS.dsh.port})`);
  void regenerateDshMcpPatch().then((count) => {
    if (count) console.log(`  dsh mcp patch regenerated: ${count} server(s)`);
  });
});
