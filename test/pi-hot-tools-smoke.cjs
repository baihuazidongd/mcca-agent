/**
 * pi 增量热生效的机制测试（不依赖真实 pi 会话）。
 *
 * 用一个桩 pi（ExtensionAPI）驱动 @mcca/pi-adapter，验证：
 *   1. 首次装载：工具注册进 pi，激活集不被适配器干预（pi 自己组建初始集合）；
 *   2. 新增插件文件：watcher 触发 → registerTool 自动刷新 → 适配器把新工具
 *      加进 setActiveTools；
 *   3. 禁用插件（config/plugins.json 的 pi 段置 false）：该插件不再注册，
 *      适配器把它从激活集里摘掉（pi 无 unregister，摘出即对模型不可见）。
 *
 * 运行：node test/pi-hot-tools-smoke.cjs
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcca-pi-hot-"));
const pluginsDir = path.join(tmp, "plugins");
fs.mkdirSync(pluginsDir, { recursive: true });
const configPath = path.join(tmp, "plugins.json");
fs.writeFileSync(configPath, JSON.stringify({ pi: {} }), "utf8");

function writePlugin(name, toolName) {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name, version: "0.0.1", kind: "tool", targets: ["ds", "pi"], description: "t", entry: "index.mjs" }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "index.mjs"),
    `export default function (api) {
       api.registerTool({ name: "${toolName}", description: "t", parameters: { type: "object", properties: {} },
         async execute() { return { content: [{ type: "text", text: "ok" }] }; } });
       return () => {};
     }\n`,
    "utf8",
  );
}

// ── 桩 pi ──────────────────────────────────────────────────────────────
const registered = new Map();
let active = [];
const handlers = new Map();
const pi = {
  registerTool(def) { registered.set(def.name, def); },
  registerCommand() {},
  on(event, handler) { handlers.set(event, handler); },
  getActiveTools() { return [...active]; },
  setActiveTools(names) { active = [...names]; },
};

writePlugin("alpha", "alpha_tool");

(async () => {
  const { createPiAdapter } = require(path.join(ROOT, "packages", "pi-adapter", "src", "index.cjs"));
  const factory = createPiAdapter({ pluginsDir, configPath, cwd: tmp });
  await factory(pi);

  assert.ok(registered.has("alpha_tool"), "1) alpha_tool 应在首次装载时注册");
  assert.strictEqual(active.length, 0, "1) 首次装载不应改动激活集（pi 自己组建）");
  // pi 组建初始激活集时会把扩展注册的工具纳入；桩按同一事实模拟，后续断言
  // 才能反映真实宿主里的“增量”语义。
  active = [...registered.keys()];
  console.log("1) 首次装载：注册 alpha_tool，未干预激活集  OK");

  // 2) 新增插件文件 → watcher 触发 → registerTool 自动刷新 → 纳入激活集
  writePlugin("beta", "beta_tool");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !registered.has("beta_tool")) await new Promise((r) => setTimeout(r, 300));
  assert.ok(registered.has("beta_tool"), "2) beta_tool 应被增量注册（无 reload）");
  assert.ok(active.includes("beta_tool"), "2) beta_tool 应进入激活集");
  assert.ok(active.includes("alpha_tool"), "2) 增量不应误伤已在用的 alpha_tool");
  console.log(`2) 新增插件：增量注册 beta_tool，激活集=[${active.join(",")}]  OK`);

  // 3) 禁用 alpha → 从激活集摘除
  fs.writeFileSync(configPath, JSON.stringify({ pi: { alpha: false } }), "utf8");
  const d3 = Date.now() + 15000;
  while (Date.now() < d3 && active.includes("alpha_tool")) await new Promise((r) => setTimeout(r, 300));
  assert.ok(!active.includes("alpha_tool"), "3) alpha_tool 应被摘出激活集");
  assert.ok(active.includes("beta_tool"), "3) beta_tool 应仍在激活集");
  console.log(`3) 禁用插件：alpha_tool 摘出，激活集=[${active.join(",")}]  OK`);

  // 4) session_shutdown 应停掉 watcher（新会话会重建适配器）
  assert.ok(handlers.has("session_shutdown"), "4) 适配器应挂 session_shutdown 清理");
  await handlers.get("session_shutdown")({}, pi);
  const before = registered.size;
  writePlugin("gamma", "gamma_tool");
  await new Promise((r) => setTimeout(r, 3000));
  assert.strictEqual(registered.size, before, "4) 关闭后不应再注册（watcher 已停）");
  console.log("4) session_shutdown 停掉 watcher，不再向失效 ctx 注册  OK");

  console.log("\nALL PASS — pi 侧插件增/改/禁用均可在不 reload、不重启的前提下生效");
})().catch((error) => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
