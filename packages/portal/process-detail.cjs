"use strict";

const SERVICE_KINDS = new Set(["pi-web", "codex-cli", "openhands-web", "grok-web", "hermes-web", "mobile", "dsh", "canvas"]);
const HELPER_KINDS = new Set(["gpu", "network", "storage", "crashpad", "utility"]);
const SERVICE_LABELS = {
  dsh: "dsh 服务",
  "pi-web": "pi / 工具服务",
  "codex-cli": "Codex",
  "openhands-web": "OpenHands 服务",
  "grok-web": "Grok Build 服务",
  "hermes-web": "Hermes Agent",
  canvas: "画布服务",
  mobile: "手机桥接",
};

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

/** Pull a short identity out of a command line. The raw command line stays on the server. */
function commandHint(commandLine) {
  const cl = String(commandLine || "");
  let match = cl.match(/--utility-sub-type=([\w.]+)/);
  if (match) return "utility:" + match[1];
  match = cl.match(/--type=([\w-]+)/);
  if (match) return match[1];
  if (cl.toLowerCase().includes("mcca-browser")) return "mcca-browser";
  if (cl.includes("--embedded-browser-webview")) return "webview-host";
  const scripts = [...cl.matchAll(/(?:[A-Za-z]:[\\/])?[\w.()-]+(?:[\\/][\w.()-]+)+\.(?:cjs|mjs|js|py)\b/gi)];
  if (scripts.length) return scripts[scripts.length - 1][0];
  const exes = [...cl.matchAll(/(?:[A-Za-z]:[\\/])[^\s"]+\.exe\b/gi)];
  for (let i = exes.length - 1; i >= 0; i -= 1) {
    const exe = exes[i][0];
    if (/(^|[\\/])(node|python|pythonw|cmd|powershell|pwsh|conhost)\.exe$/i.test(exe)) continue;
    return exe;
  }
  return "";
}

function describeAppProcess({ name, hint, pid, portalPid }) {
  const processName = String(name || "");
  const pathHint = String(hint || "").replaceAll("\\", "/");
  const low = pathHint.toLowerCase();
  if (pid === portalPid || /\/portal\/server\.cjs$/i.test(pathHint)) {
    return { kind: "portal", label: "门户服务" };
  }
  if (hint === "renderer") return { kind: "renderer", label: "聊天页面渲染" };
  if (hint === "gpu-process") return { kind: "gpu", label: "界面 GPU" };
  if (hint === "crashpad-handler") return { kind: "crashpad", label: "界面崩溃上报" };
  if (hint === "webview-host") return { kind: "webview-host", label: "界面浏览器" };
  if (String(hint || "").startsWith("utility:")) {
    const sub = String(hint).slice("utility:".length);
    if (/network/i.test(sub)) return { kind: "network", label: "界面网络" };
    if (/storage/i.test(sub)) return { kind: "storage", label: "界面存储" };
    const short = sub.split(".").filter(Boolean).pop();
    return { kind: "utility", label: short ? "界面组件 " + short : "界面组件" };
  }
  if (low.includes("/pi-web/server.cjs")) return { kind: "pi-web", label: "pi / 工具服务" };
  if (/(^|[\\/])codex(\.exe)?$/i.test(pathHint)) return { kind: "codex-cli", label: "Codex" };
  if (low.includes("/openhands-web/server.cjs")) return { kind: "openhands-web", label: "OpenHands 服务" };
  if (low.includes("/grok-web/server.cjs")) return { kind: "grok-web", label: "Grok Build 服务" };
  if (low.includes("/hermes-web/server.cjs") || /(^|[\\/])hermes(\.exe)?$/i.test(pathHint)) {
    return { kind: "hermes-web", label: "Hermes Agent" };
  }
  if (low.includes("/mobile-bridge/server.cjs")) return { kind: "mobile", label: "手机桥接" };
  if (low.includes("/apps/cli/src/bin.ts") || (low.includes("/bin.ts") && low.includes("dsh"))) {
    return { kind: "dsh", label: "dsh 服务" };
  }
  if (hint === "mcca-browser" || low.includes("mcca-browser")) return { kind: "browser", label: "轻量浏览器" };
  if (low.includes("playwright") && low.endsWith("/cli.js")) return { kind: "playwright", label: "Playwright 浏览器工具" };
  if (low.includes("/zhipin/")) return { kind: "zhipin", label: "招聘工具" };
  if (low.includes("/everything/")) return { kind: "everything", label: "Everything 文件搜索" };
  if (low.includes("ldplayer") || low.includes("mcp_ldplayer")) return { kind: "ldplayer", label: "雷电模拟器工具" };
  if (low.includes("comfy-mcp") || /comfy/i.test(processName)) return { kind: "comfy", label: "ComfyUI 工具" };
  if (low.endsWith("/main.py") && low.includes("comfyui")) return { kind: "canvas", label: "画布服务" };
  if (/mcca-desktop/i.test(processName) || low.endsWith("/mcca-desktop.exe")) {
    return { kind: "desktop", label: "桌面外壳" };
  }
  if (/^conhost(\.exe)?$/i.test(processName)) return { kind: "conhost", label: "控制台" };
  const base = pathHint.split("/").filter(Boolean).pop();
  return { kind: "other", label: base || processName || "进程" };
}

function displayHint(hint) {
  const text = String(hint || "");
  if (!text || text.startsWith("utility:") || /^(renderer|gpu-process|crashpad-handler|webview-host)$/.test(text)) return "";
  const norm = text.replaceAll("\\", "/");
  const marker = "/dshpi/";
  const at = norm.toLowerCase().lastIndexOf(marker);
  const shown = at >= 0 ? norm.slice(at + 1) : norm.split("/").slice(-3).join("/");
  return shown.length > 96 ? "…" + shown.slice(-95) : shown;
}

function actionFlags({ kind, pid, portalPid, service, rootPid, started }) {
  const alive = Boolean(started);
  const tracked = Boolean(service);
  const serviceRoot = tracked && pid === rootPid;
  const protectedKind = kind === "portal" || kind === "desktop" || kind === "webview-host" || kind === "renderer" || kind === "conhost";
  return {
    canStop: alive && !protectedKind && (tracked || HELPER_KINDS.has(kind)),
    canRestart: alive && serviceRoot,
    canReload: kind === "renderer" || kind === "webview-host",
    // Portal is not detached from its services on Windows; exiting it would take them down.
    canRestartPortal: false,
  };
}

function buildProcessRow({ pid, parentPid, name, hint, started, memory, privateMemory, cpu, portalPid, service, rootPid }) {
  const described = describeAppProcess({ name, hint, pid, portalPid });
  const flags = actionFlags({
    kind: described.kind,
    pid,
    portalPid,
    service,
    rootPid,
    started,
  });
  const label = service && pid === rootPid && SERVICE_LABELS[service] ? SERVICE_LABELS[service] : described.label;
  return {
    pid,
    parentPid: parentPid || null,
    name: name || "",
    started: started == null || started === "" ? "" : String(started),
    memory: memory || 0,
    privateMemory: privateMemory || 0,
    cpu: cpu || 0,
    service: service || "",
    rootPid: rootPid || null,
    group: service || (described.kind === "portal" ? "portal" : "desktop"),
    kind: described.kind,
    label,
    detail: displayHint(hint),
    ...flags,
  };
}

module.exports = {
  SERVICE_KINDS,
  HELPER_KINDS,
  asArray,
  commandHint,
  describeAppProcess,
  displayHint,
  actionFlags,
  buildProcessRow,
};
