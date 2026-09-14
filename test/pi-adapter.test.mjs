import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPiAdapter } = require("@pi-dsh-bridge/pi-adapter");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pluginsDir = path.join(root, "plugins");
const realConfig = path.join(root, "config", "plugins.json");

function recordingPi() {
  const pi = {
    tools: [],
    commands: [],
    events: [],
    registerTool(def) {
      pi.tools.push(def);
    },
    registerCommand(name, options) {
      pi.commands.push({ name, ...options });
    },
    on(event, handler) {
      pi.events.push({ event, handler });
    },
  };
  return pi;
}

function writePlugin(pluginsDir, manifest, indexSource) {
  const dir = path.join(pluginsDir, manifest.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "index.mjs"), indexSource);
}

/** 与共享 plugins/ 目录解耦：把 hello-tool 副本放进临时插件目录再交给 adapter */
function stageHelloPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdb-pi-adapter-stage-"));
  fs.cpSync(path.join(pluginsDir, "hello-tool"), path.join(dir, "hello-tool"), {
    recursive: true,
  });
  // 受控开关：真实 config/plugins.json 里 hello-tool 可能被用户禁用
  fs.writeFileSync(
    path.join(dir, "plugins.json"),
    JSON.stringify({ pi: { "hello-tool": true } }),
  );
  return dir;
}

/** 触发适配器注册的 session_shutdown 钩子：关掉 host.watch 的文件监视器。
 *  不关的话 FSWatcher 挂住事件循环，测试进程永远不退出（整文件超时）。 */
async function shutdownAdapter(pi) {
  for (const entry of pi?.events ?? []) {
    if (entry.event === "session_shutdown") await entry.handler({ type: "session_shutdown" }, { cwd: root });
  }
}

test("maps hello-tool onto pi.registerTool with a 5-arg execute", async () => {
  const stage = stageHelloPlugin();
  let pi;
  try {
    pi = recordingPi();
    const factory = createPiAdapter({ pluginsDir: stage, configPath: path.join(stage, "plugins.json"), cwd: root });
    await factory(pi);

    assert.equal(pi.tools.length, 1);
    const tool = pi.tools[0];
    assert.equal(tool.name, "hello");
    assert.equal(tool.label, "hello");
    // pi's execute signature is (toolCallId, params, signal, onUpdate, ctx).
    assert.equal(tool.execute.length, 5);

    const result = await tool.execute("call-1", { name: "Ada" }, undefined, undefined, { cwd: root });
    assert.deepEqual(result, {
      content: [{ type: "text", text: "你好，Ada！" }],
      details: { agent: "pi" },
    });
  } finally {
    await shutdownAdapter(pi);
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("maps registerCommand to pi.registerCommand with a string-arg handler", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdb-pi-adapter-cmd-"));
  let pi;
  try {
    writePlugin(
      dir,
      { name: "cmd", version: "1.0.0", kind: "command" },
      `export default (api) => {
        api.registerCommand("greet", {
          description: "greet someone",
          handler: async (args, ctx) => {
            globalThis.__greet = { args, agent: ctx.agent };
          },
        });
      };`,
    );
    pi = recordingPi();
    const factory = createPiAdapter({ pluginsDir: dir, configPath: realConfig, cwd: root });
    await factory(pi);

    assert.equal(pi.commands.length, 1);
    assert.equal(pi.commands[0].name, "greet");
    await pi.commands[0].handler("world", { cwd: root });
    assert.deepEqual(globalThis.__greet, { args: "world", agent: "pi" });
    delete globalThis.__greet;
  } finally {
    await shutdownAdapter(pi);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maps neutral events onto pi events and rewrites the type field", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdb-pi-adapter-on-"));
  let pi;
  try {
    writePlugin(
      dir,
      { name: "events", version: "1.0.0", kind: "tool" },
      `export default (api) => {
        api.on("turn_end", async (event, ctx) => {
          globalThis.__seen = globalThis.__seen || [];
          globalThis.__seen.push({ type: event.type, agent: ctx.agent });
        });
        api.on("session_end", async () => {
          globalThis.__sessionEnd = true;
        });
        api.on("input", async () => {
          globalThis.__input = true;
        });
      };`,
    );
    pi = recordingPi();
    const factory = createPiAdapter({ pluginsDir: dir, configPath: realConfig, cwd: root });
    await factory(pi);

    const eventNames = pi.events.map((e) => e.event);
    assert.ok(eventNames.includes("turn_end"));
    assert.ok(eventNames.includes("session_shutdown"), "session_end maps to session_shutdown");
    assert.ok(eventNames.includes("input"));

    const turnEnd = pi.events.find((e) => e.event === "turn_end");
    await turnEnd.handler({ type: "turn_end", turnIndex: 0 }, { cwd: root });
    assert.deepEqual(globalThis.__seen, [{ type: "turn_end", agent: "pi" }]);
    delete globalThis.__seen;
  } finally {
    await shutdownAdapter(pi);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the adapter factory is re-runnable (simulating extension re-discovery)", async () => {
  const stage = stageHelloPlugin();
  let pi;
  try {
    pi = recordingPi();
    const factory = createPiAdapter({ pluginsDir: stage, configPath: path.join(stage, "plugins.json"), cwd: root });
    await factory(pi);
    assert.equal(pi.tools.length, 1);
    await factory(pi);
    assert.equal(pi.tools.length, 2, "re-running the factory re-registers the shared plugins");
  } finally {
    await shutdownAdapter(pi);
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
