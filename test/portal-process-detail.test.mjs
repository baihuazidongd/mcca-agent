import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { commandHint, describeAppProcess, buildProcessRow } = require("../packages/portal/process-detail.cjs");

const PORTAL = 19556;

test("command hints identify app processes without keeping the raw command line", () => {
  assert.equal(commandHint('"C:\\Program Files\\nodejs\\node.exe" packages\\pi-web\\server.cjs'), "packages\\pi-web\\server.cjs");
  assert.equal(commandHint("node D:/dshpi/mcp/zhipin/server.mjs"), "D:/dshpi/mcp/zhipin/server.mjs");
  assert.equal(commandHint("node D:/dshpi/mcp/everything/server.mjs"), "D:/dshpi/mcp/everything/server.mjs");
  assert.equal(
    commandHint("node D:/dshpi/node_modules/@playwright/mcp/cli.js"),
    "playwright/mcp/cli.js",
  );
  assert.match(
    commandHint('python.exe "D:\\dshpi\\config\\dsh-home\\mcp\\mcp-ldplayer\\mcp_ldplayer\\mcp_server.py" --ldplayer-path D:/leidian'),
    /mcp_server\.py$/,
  );
  assert.match(commandHint('"D:\\ComfyUI\\venv\\Scripts\\python.exe" "D:\\ComfyUI\\venv\\Scripts\\comfy-mcp.exe"'), /comfy-mcp\.exe$/);
  assert.equal(commandHint("msedgewebview2.exe --type=renderer --user-data-dir=C:\\temp"), "renderer");
  assert.equal(commandHint("msedgewebview2.exe --type=gpu-process"), "gpu-process");
  assert.equal(
    commandHint("msedgewebview2.exe --type=utility --utility-sub-type=network.mojom.NetworkService"),
    "utility:network.mojom.NetworkService",
  );
  assert.equal(commandHint("msedgewebview2.exe --embedded-browser-webview=1"), "webview-host");
  assert.equal(
    commandHint("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe --user-data-dir=C:\\Temp\\mcca-browser"),
    "mcca-browser",
  );
  assert.equal(commandHint("\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4"), "");
});

test("labels say what the process is for", () => {
  const cases = [
    ["packages/pi-web/server.cjs", "node", "pi-web", "pi / 工具服务"],
    ["C:/Users/me/AppData/Local/OpenAI/Codex/bin/codex.exe", "codex", "codex-web", "Codex"],
    ["vendor/cli/openhands/.venv/Scripts/openhands.exe", "openhands", "openhands-web", "OpenHands 服务"],
    ["packages/mini-web/server.cjs --tool=grok", "node", "grok-web", "Grok Build 服务"],
    ["packages/mini-web/server.cjs --tool=codex", "node", "codex-web", "Codex"],
    ["vendor/cli/hermes/hermes.exe", "hermes", "hermes-web", "Hermes Agent"],
    ["packages/mobile-bridge/server.cjs", "node", "mobile", "手机桥接"],
    ["packages/portal/server.cjs", "node", "portal", "门户服务"],
    ["vendor/dsh/apps/cli/src/bin.ts", "node", "dsh", "dsh 服务"],
    ["playwright/mcp/cli.js", "node", "playwright", "Playwright 浏览器工具"],
    ["mcca-browser", "msedge", "browser", "轻量浏览器"],
    ["D:/dshpi/mcp/zhipin/server.mjs", "node", "zhipin", "招聘工具"],
    ["D:/dshpi/mcp/everything/server.mjs", "node", "everything", "Everything 文件搜索"],
    ["D:/dshpi/config/dsh-home/mcp/mcp-ldplayer/mcp_ldplayer/mcp_server.py", "python", "ldplayer", "雷电模拟器工具"],
    ["D:/ComfyUI/venv/Scripts/comfy-mcp.exe", "comfy-mcp", "comfy", "ComfyUI 工具"],
    ["D:/ComfyUI/main.py", "python", "canvas", "画布服务"],
    ["renderer", "msedgewebview2", "renderer", "聊天页面渲染"],
    ["gpu-process", "msedgewebview2", "gpu", "界面 GPU"],
    ["utility:network.mojom.NetworkService", "msedgewebview2", "network", "界面网络"],
    ["utility:storage.mojom.StorageService", "msedgewebview2", "storage", "界面存储"],
    ["crashpad-handler", "msedgewebview2", "crashpad", "界面崩溃上报"],
    ["webview-host", "msedgewebview2", "webview-host", "界面浏览器"],
    ["", "mcca-desktop", "desktop", "桌面外壳"],
    ["", "conhost", "conhost", "控制台"],
    ["", "conhost.exe", "conhost", "控制台"],
  ];
  for (const [hint, name, kind, label] of cases) {
    const described = describeAppProcess({ name, hint, pid: 10, portalPid: PORTAL });
    assert.equal(described.kind, kind, hint || name);
    assert.equal(described.label, label, hint || name);
  }
});

test("stop and restart stay inside the owning service", () => {
  const portal = buildProcessRow({ pid: PORTAL, name: "node", hint: "packages/portal/server.cjs", started: "100", portalPid: PORTAL });
  assert.equal(portal.canStop, false);
  assert.equal(portal.canRestart, false);
  assert.equal(portal.canRestartPortal, false);

  const shell = buildProcessRow({ pid: 4, name: "mcca-desktop", hint: "", started: "100", portalPid: PORTAL });
  assert.equal(shell.canStop, false);
  assert.equal(shell.canReload, false);

  const browser = buildProcessRow({ pid: 5, name: "msedgewebview2", hint: "webview-host", started: "100", portalPid: PORTAL });
  assert.equal(browser.canStop, false);
  assert.equal(browser.canReload, true);

  const renderer = buildProcessRow({ pid: 6, name: "msedgewebview2", hint: "renderer", started: "100", portalPid: PORTAL });
  assert.equal(renderer.canStop, false);
  assert.equal(renderer.canReload, true);

  const gpu = buildProcessRow({ pid: 7, name: "msedgewebview2", hint: "gpu-process", started: "100", portalPid: PORTAL });
  assert.equal(gpu.canStop, true);
  assert.equal(gpu.canRestart, false);
  assert.equal(buildProcessRow({ pid: 7, name: "msedgewebview2", hint: "gpu-process", started: "", portalPid: PORTAL }).canStop, false);

  const pi = buildProcessRow({
    pid: 20, name: "node", hint: "packages/pi-web/server.cjs", started: "100", portalPid: PORTAL, service: "pi-web", rootPid: 20,
  });
  assert.equal(pi.label, "pi / 工具服务");
  assert.equal(pi.canStop, true);
  assert.equal(pi.canRestart, true);

  const tool = buildProcessRow({
    pid: 21, name: "node", hint: "D:/dshpi/mcp/zhipin/server.mjs", started: "100", portalPid: PORTAL, service: "pi-web", rootPid: 20,
  });
  assert.equal(tool.label, "招聘工具");
  assert.equal(tool.detail, "dshpi/mcp/zhipin/server.mjs");
  assert.equal(tool.canStop, true);
  assert.equal(tool.canRestart, false);

  const codex = buildProcessRow({
    pid: 30, name: "codex", hint: "C:/Users/me/AppData/Local/OpenAI/Codex/bin/codex.exe", started: "100", portalPid: PORTAL, service: "codex-web", rootPid: 30,
  });
  assert.equal(codex.label, "Codex");
  assert.equal(codex.canRestart, true);
});
