"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { writeJson } = require("./paths.cjs");
const { createTasks } = require("./tasks.cjs");
const { createBrowserService } = require("./browser.cjs");
const { createAndroidService } = require("./android.cjs");
const { createInstaller } = require("./install.cjs");
const { createFridaService } = require("./frida.cjs");

const string = { type: "string" }, number = { type: "number" }, bool = { type: "boolean" };
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const enumOf = values => ({ type: "string", enum: values.split(" ") });
const TOOLS = [
  { name: "app_extension_packages", description: "安装或更新本机共享插件/技能目录。先 inspect_bundle 验证并取得源和目标摘要，再 import_bundle；历史和回滚同样校验摘要，避免覆盖其他编辑。只验证语法，不执行待安装代码。", inputSchema: schema({ action: enumOf("inspect_bundle import_bundle bundle_status bundle_history rollback_bundle"), kind: enumOf("plugin skill"), name: string, source: string, sourceSha256: string, expectedSha256: string, revision: string }, ["action"]) },
  { name: "app_extension_files", description: "读写共享 pi/dsh 插件、技能、MCP 配置和 dsh patch。write 必须先 read 获取 expectedSha256；验证语法后备份写入。history/rollback 提供回滚，不自动重启任务。不接受越界路径。", inputSchema: schema({ action: enumOf("list read write history rollback"), kind: enumOf("plugin skill config"), file: string, text: string, expectedSha256: string, revision: string }, ["action"]) },
  { name: "app_components", description: "按需安装投屏/反编译工具；官方版本与 SHA256 固定，安装过程可在 overview 查询。", inputSchema: schema({ action: enumOf("list install"), id: string }, ["action"]) },
  { name: "android_screen", description: "明确设备的 scrcpy 实时投屏/录屏、会话列表和停止。record 不显示窗口，输出 MKV；mirror 打开该设备的可交互投屏窗口。", inputSchema: schema({ action: enumOf("list mirror record stop"), serial: string, id: string, seconds: number }, ["action"]) },
  { name: "network_capture", description: "本机 HTTP/CONNECT 抓包代理。start 可绑定明确 Android serial 并保存原代理；stop 恢复设置。HTTPS 只记录加密隧道元数据，不解密。正文单条 256KB、总记录 64MB/1000条。restart 后 needs_restore 必须恢复。", inputSchema: schema({ action: enumOf("list start stop restore flows detail export"), serial: string, id: string, flow: string, minutes: number }, ["action"]) },
  { name: "android_apk", description: "APK 静态权限、组件、SDK、DEX/原生库与 SHA256 分析；decompile 使用按需安装的 jadx，jobs/stop 管理任务。不会执行 APK。", inputSchema: schema({ action: enumOf("inspect decompile jobs stop"), file: string, id: string }, ["action"]) },
  { name: "assistant_jobs", description: "由 Hermes 原生计划任务持久执行长期委托；list/inspect 查看，create 必须给定内容、范围及分钟周期，pause/resume 暂停或恢复后续执行。暂停计划不停止正在运行的任务。结果仅保存在本机，定时执行需要 Hermes gateway/调度器运行。创建失败先查询，勿重复创建。", inputSchema: schema({ action: enumOf("list create inspect pause resume"), id: string, text: string, scope: string, title: string, minutes: number, cwd: string }, ["action"]) },
  { name: "personal_browser", description: "通过用户配对的浏览器扩展操作明确允许的标签页，无需浏览器调试端口。先 list 获取 browser/page。snapshot 为可访问性树；click/fill 需要唯一 CSS selector；release 撤回单页，revoke 撤销浏览器配对。超时结果未知，不自动重试。", inputSchema: schema({ action: enumOf("list snapshot screenshot navigate click fill eval release revoke"), browser: string, page: string, url: string, selector: string, text: string, expression: string }, ["action"]) },
  { name: "android_emulator", description: "管理多种模拟器实例。先 providers/list 确认能力和实例 ID。register 通过 JSON 定义接入其他模拟器控制台或适配程序，list 输出 [{id,name,running}]；动作使用参数数组和明确 {instance}，不经过 shell。设备交互用 android_control。", inputSchema: schema({ action: enumOf("providers list start stop restart create clone configure register"), provider: string, definition: string, instance: string, name: string, serial: string, cpu: number, memory: number, resolution: string }, ["action"]) },
  { name: "android_instrument", description: "持久 Frida 会话：枚举设备/进程，attach 后 load 真正加载脚本，messages 获取事件，unload/detach 释放。需要本机 Frida Python 和匹配的设备 frida-server；只在明确选定的设备、目标和授权任务中使用。", inputSchema: schema({ action: enumOf("devices processes attach sessions load unload messages detach"), device: string, target: string, session: string, script: string, source: string, clear: bool }, ["action"]) },
  { name: "app_overview", description: "了解工作台的 IDE、真实能力、任务状态和事件。先查询能力再执行操作。idle 只代表会话空闲，不代表目标已完成。", inputSchema: schema({}) },
  { name: "app_runtime", description: "管理已注册的 IDE。start/stop/restart 控制服务进程，停止服务会影响其全部会话；停止单个任务请用 app_tasks。install 按清单下载并校验组件。", inputSchema: schema({ id: string, action: enumOf("start stop restart install enable" ) }, ["id", "action"]) },
  { name: "app_tasks", description: "发布、监工、检查或停止已适配 IDE 的会话任务。submit 必须传唯一 key，重试沿用同一个 key。断线或提交超时不会自动重发。permission 回答 OpenHands 的待授权操作；只能在用户委托范围内选取返回的选项。", inputSchema: schema({ action: enumOf("list submit inspect stop permission"), id: string, key: string, runtime: string, session: string, text: string, title: string, cwd: string, provider: string, modelId: string, stopAfterMs: number, request: string, option: string }, ["action"]) },
  { name: "app_extensions", description: "查询共享插件、MCP 和技能；切换当前明确支持的 pi/ds 插件或 MCP，不宣称其他 IDE 自动兼容。", inputSchema: schema({ action: enumOf("list toggle"), kind: enumOf("plugin mcp"), name: string, target: enumOf("pi ds"), enabled: bool, surface: string }, ["action"]) },
  { name: "browser_control", description: "AI 独立浏览器或连接用户已开启调试端口的浏览器。open 返回 session 和 page。每次操作必须明确 session/page，避免串页。role/name 精确定位，selector 作为补充；snapshot 保留可访问性语义。personal close 只断开连接。", inputSchema: schema({ action: enumOf("list open close tabs new_tab close_tab navigate frames snapshot screenshot eval cookies network network_detail export_har route key click fill wait upload download"), session: string, page: string, mode: enumOf("ai personal"), endpoint: string, profile: string, url: string, frame: string, role: string, name: string, selector: string, text: string, key: string, expression: string, request: string, capture: bool, clear: bool, pattern: string, behavior: enumOf("block mock"), remove: bool, status: number, contentType: string, body: string, cookies: { type: "array", items: { type: "object" } }, files: { type: "array", items: string }, state: enumOf("visible hidden attached detached"), timeoutMs: number }, ["action"]) },
  { name: "android_control", description: "通过同一个 ADB server 管理不同模拟器、多个实例及真机。先 devices，再明确 serial；同一设备的命令串行执行。ui 返回 ref，tap_element 验证页面未改变再点击；text 仅 ASCII。shell 使用参数数组；截图直接 exec-out 返回 PNG。不会自动启动模拟器或绕过 USB 授权。", inputSchema: schema({ action: enumOf("devices shell screenshot ui tap_element text tap swipe key install launch stop_app packages logcat push pull forward"), serial: string, ref: string, text: string, args: { type: "array", items: string }, x: number, y: number, toX: number, toY: number, durationMs: number, code: number, file: string, remote: string, package: string, lines: number, localPort: number, remotePort: number, remove: bool }, ["action"]) },
];
async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 1024 * 1024) throw new Error("Request exceeds 1 MB"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function json(res, code, value) { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value)); }
function validateInput(def, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected argument object");
  for (const name of def.required || []) if (!(name in args)) throw new Error(`Missing ${name}`);
  for (const [key, value] of Object.entries(args)) {
    const field = def.properties[key]; if (!field) throw new Error(`Unknown argument: ${key}`);
    if (field.type === "array" ? !Array.isArray(value) : typeof value !== field.type) throw new Error(`Invalid type: ${key}`);
    if (field.enum && !field.enum.includes(value)) throw new Error(`Invalid ${key}`);
    if (field.type === "number" && !Number.isFinite(value)) throw new Error(`Invalid number: ${key}`);
    if (field.items?.type === "string" && value.some(item => typeof item !== "string")) throw new Error(`Invalid array: ${key}`);
  }
}
function createWorkbench({ paths, registry, runtime, status, control, extensions, toggleExtension, registerRuntime, port, onExtensionChange, onRuntimeInstalled = async () => {}, extraRuntimeInstallers = {} }) {
  const authFile = path.join(paths.state, "assistant-auth.json");
  if (!fs.existsSync(authFile)) writeJson(authFile, { schemaVersion: 1, token: randomBytes(32).toString("hex") });
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(auth.token || "")) throw new Error("Invalid assistant token");
  const eventFile = path.join(paths.state, "events.json");
  let events = fs.existsSync(eventFile) ? JSON.parse(fs.readFileSync(eventFile, "utf8")).events || [] : [];
  const tasks = createTasks({ paths, runtime, onEvent: event => { events.push(event); events = events.slice(-200); writeJson(eventFile, { schemaVersion: 1, events }); } });
  const browser = createBrowserService({ paths });
  const browserExtension = require("./browser-extension.cjs").createExtensionBridge({ paths, port });
  const android = createAndroidService({ paths });
  const emulators = require("./emulators.cjs").createEmulatorService({ paths, android });
  const frida = createFridaService({ paths });
  const installer = createInstaller({ paths });
  const recipes = require("./runtime-recipes.cjs").createRuntimeRecipes({ paths });
  const extensionFiles = require("./extension-files.cjs").createExtensionFiles({ paths, onChange: onExtensionChange });
  const extensionPackages = require("./extension-bundles.cjs").createExtensionBundles({ paths, files: extensionFiles, onChange: onExtensionChange });
  const components = require("./components.cjs").createComponents({ paths });
  const toolJobs = require("./tool-jobs.cjs").createToolJobs({ paths });
  const screen = require("./device-tools.cjs").createDeviceTools({ paths, android, jobs: toolJobs });
  const capture = require("./network-capture.cjs").createNetworkCapture({ paths, android });
  const apk = require("./apk.cjs").createApkService({ paths, jobs: toolJobs });
  const assistantJobs = require("./assistant-jobs.cjs").createAssistantJobs({ runtime });
  const sharedMcp = require("./shared-mcp.cjs").createSharedMcp({ paths });
  async function overview() {
    return { runtimes: registry.all().map(r => ({ id: r.id, page: r.page, label: r.label, group: r.group, capabilities: r.capabilities, taskProtocol: r.taskProtocol || null, downloadable: Boolean(r.artifacts?.[process.platform+"-"+process.arch]) || recipes.supports(r.id) || Boolean(extraRuntimeInstallers[r.id]), status: status(r.id) })), tasks: tasks.list(), events, installs: [...installer.jobs(), ...recipes.jobs()] };
  }
  async function call(name, args = {}) {
    const def = TOOLS.find(t => t.name === name); if (!def) throw new Error("Unknown tool");
    validateInput(def.inputSchema, args);
    switch (name) {
      case "app_overview": return overview();
      case "app_extension_files": return extensionFiles.call(args);
      case "app_extension_packages": return extensionPackages.call(args);
      case "app_components": return components.call(args);
      case "android_screen": return screen.call(args);
      case "network_capture": return capture.call(args);
      case "android_apk": return apk.call(args);
      case "assistant_jobs": return assistantJobs.call(args);
      case "app_runtime": {
        const r = registry.all().find(r => r.id === args.id); if (!r) throw new Error("Unknown runtime");
        if (args.action === "install") {
          if (status(r.id).running || tasks.list().some(t => t.runtime === r.id && ["running","submitted","dispatching"].includes(t.state))) throw new Error("请先停止该 IDE 及其任务再安装或更新");
          const result = extraRuntimeInstallers[r.id] ? await extraRuntimeInstallers[r.id]() : recipes.supports(r.id) ? await recipes.install(r.id) : await installer.install(r);
          if (result.state === "installed" || result.ok === true) { await onRuntimeInstalled(r.id); await control(r.id, "enable"); }
          return result;
        }
        return control(r.id, args.action);
      }
      case "app_tasks": return args.action === "permission" ? tasks.permission(args.id, args.request, args.option) : args.action === "submit" ? tasks.submit(args) : args.action === "inspect" ? tasks.inspect(args.id) : args.action === "stop" ? tasks.stop(args.id) : tasks.list();
      case "app_extensions":
        if (args.action === "list") return extensions();
        if (!args.kind || !args.name || !args.target || typeof args.enabled !== "boolean") throw new Error("toggle requires kind, name, target, enabled");
        return toggleExtension(args);
      case "browser_control": return browser.call(args);
      case "personal_browser": return browserExtension.call(args);
      case "android_control": return android.call(args);
      case "android_emulator": return emulators.call(args);
      case "android_instrument": return frida.call(args);
    }
  }
  function authorized(req) {
    const candidate = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const a = Buffer.from(candidate), b = Buffer.from(auth.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  function localUI(req) {
    const host = req.headers.host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    return !req.headers.origin || req.headers.origin === `http://${host}`;
  }
  async function handle(req, res, url) {
    const mcp = url.pathname === "/mcp";
    if (!mcp && !url.pathname.startsWith("/api/workbench/")) return false;
    if (!authorized(req) && (mcp || !localUI(req))) { json(res, 403, { error: "Unauthorized" }); return true; }
    try {
      if (mcp) {
        if (req.method !== "POST") { json(res, 405, { error: "Use POST JSON-RPC" }); return true; }
        const rpc = await body(req);
        if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") { json(res, 400, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32600, message: "Invalid Request" } }); return true; }
        if (rpc.id === undefined) { res.writeHead(202); res.end(); return true; }
        let result;
        if (rpc.method === "initialize") result = { protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mcca-workbench", version: "0.1.0" }, instructions: "先 app_overview 查看能力。管理和任务是两层；服务停止影响全部会话。browser/Android 必须指定会话、页面或设备。只在用户委托范围内操作。监工时仅在状态变化、结束或需要用户介入时通知。" };
        else if (rpc.method === "ping") result = {};
        else if (rpc.method === "tools/list") result = { tools: TOOLS.map(tool => {
          // OpenHands reserves "kind" on its Action base class. Expose a neutral
          // MCP field while keeping existing local HTTP clients compatible.
          if (!tool.inputSchema.properties.kind) return tool;
          const {kind,...properties}=tool.inputSchema.properties;
          return {...tool,inputSchema:{...tool.inputSchema,properties:{...properties,extensionType:kind},required:tool.inputSchema.required.map(key=>key==="kind"?"extensionType":key)}};
        }).concat(await sharedMcp.list()) };
        else if (rpc.method === "tools/call") {
          try {
            if (String(rpc.params?.name).startsWith("shared__")) {
              result = await sharedMcp.call(rpc.params.name, rpc.params.arguments || {});
              json(res, 200, { jsonrpc: "2.0", id: rpc.id, result }); return true;
            }
            const args={...(rpc.params?.arguments || {})};
            if ("extensionType" in args) { args.kind=args.extensionType;delete args.extensionType; }
            const value = await call(rpc.params?.name, args);
            result = value?.mimeType && value?.data ? { content: [{ type: "image", mimeType: value.mimeType, data: value.data }] } : { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
            if (value?.ok === false || value?.state === "failed") result.isError = true;
          } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
        } else { json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }); return true; }
        json(res, 200, { jsonrpc: "2.0", id: rpc.id, result }); return true;
      }
      if (req.method === "GET" && url.pathname.endsWith("/overview")) json(res, 200, await overview());
      else if (req.method === "POST" && url.pathname.endsWith("/prepare-restart")) {
        await body(req);
        const busy = toolJobs.list().filter(j => ["running","starting","stopping"].includes(j.state));
        const acpTasks = tasks.list().filter(t => t.runtime === "openhands-web" && ["submitted","running","dispatching"].includes(t.state));
        if (busy.length || acpTasks.length) json(res,409,{error:"门户自有工具或 ACP 任务仍在运行，请完成或明确停止后再更新",jobs:busy.map(j=>j.id),tasks:acpTasks.map(t=>t.id)});
        else { await capture.dispose(); await browser.dispose(); json(res,200,{ok:true}); }
      }
      else if (req.method === "POST" && url.pathname.endsWith("/browser-pair")) { await body(req); json(res, 200, browserExtension.pair()); }
      else if (req.method === "GET" && url.pathname.endsWith("/settings")) json(res, 200, require("./settings.cjs").readSettings(paths));
      else if (req.method === "POST" && url.pathname.endsWith("/settings")) json(res, 200, require("./settings.cjs").saveSettings(paths, await body(req)));
      else if (req.method === "GET" && url.pathname.endsWith("/connection")) json(res, 200, { mcpServers: { "mcca-workbench": { command: paths.node, args: [path.join(paths.app, "packages/runtime-core/mcp-stdio.cjs")], env: { MCCA_HOME: paths.app, MCCA_DATA_DIR: paths.data, PORTAL_PORT: String(port) } } } });
      else if (req.method === "POST" && url.pathname.endsWith("/call")) { const input = await body(req); json(res, 200, await call(input.name, input.arguments || {})); }
      else if (req.method === "POST" && url.pathname.endsWith("/register")) { const input = await body(req); json(res, 200, await registerRuntime(input)); }
      else if (req.method === "POST" && url.pathname.endsWith("/connect-hermes")) { await body(req); json(res, 200, require("./assistant-config.cjs").connectHermes(paths)); }
      else json(res, 404, { error: "Not found" });
    } catch (error) { json(res, 400, { error: error.message }); }
    return true;
  }
  return { handle, call, attach: browserExtension.attach, async dispose() { sharedMcp.dispose(); tasks.dispose(); frida.dispose(); browserExtension.dispose(); await Promise.allSettled([browser.dispose(), capture.dispose(), toolJobs.dispose()]); } };
}
module.exports = { createWorkbench, TOOLS, validateInput };
