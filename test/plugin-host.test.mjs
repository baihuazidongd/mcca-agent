import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPluginHost,
  discoverPlugins,
  isEnabled,
} from "@pi-dsh-bridge/plugin-host";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pluginsDir = path.join(root, "plugins");
const realConfig = path.join(root, "config", "plugins.json");

/**
 * 把真实的 hello-tool 复制到一个临时插件目录里做装载测试。
 * 共享 plugins/ 目录随时可能加入新的共享插件，装载类测试应该与
 * 目录内容解耦，只依赖这一份副本。
 */
function stageHelloPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdb-plugins-stage-"));
  fs.cpSync(path.join(pluginsDir, "hello-tool"), path.join(dir, "hello-tool"), {
    recursive: true,
  });
  // 受控开关：真实 config/plugins.json 里 hello-tool 可能被用户禁用，
  // 装载类测试自带配置，不耦合运行时数据。
  fs.writeFileSync(
    path.join(dir, "plugins.json"),
    JSON.stringify({ ds: { "hello-tool": true }, pi: { "hello-tool": true } }),
  );
  return dir;
}


function recordingImpl() {
  const state = {
    tools: [],
    commands: [],
    mcp: [],
    skills: [],
    events: [],
    disposals: 0,
  };
  const impl = {
    registerTool(def) {
      state.tools.push(def.name);
      return () => {
        state.disposals += 1;
      };
    },
    registerCommand(name) {
      state.commands.push(name);
      return () => {
        state.disposals += 1;
      };
    },
    registerMcpServer(cfg) {
      state.mcp.push(cfg.serverName);
      return () => {
        state.disposals += 1;
      };
    },
    registerSkill(skill) {
      state.skills.push(skill.name);
      return () => {
        state.disposals += 1;
      };
    },
    on(event) {
      state.events.push(event);
      return () => {
        state.disposals += 1;
      };
    },
  };
  return { state, impl };
}

function tmpConfig(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdb-plugins-"));
  const file = path.join(dir, "plugins.json");
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return { dir, file };
}

test("discovers the demo hello-tool plugin", () => {
  const found = discoverPlugins(pluginsDir);
  const names = found.map((p) => p.manifest.name);
  assert.ok(names.includes("hello-tool"), `expected hello-tool in ${names}`);
});

test("loads hello-tool for pi and registers its tool", async () => {
  const dir = stageHelloPlugin();
  try {
    const { state, impl } = recordingImpl();
    const host = createPluginHost({ agent: "pi", pluginsDir: dir, configPath: path.join(dir, "plugins.json"), impl });
    const loaded = await host.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].state, "loaded");
    assert.equal(loaded[0].name, "hello-tool");
    assert.deepEqual(state.tools, ["hello"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("targets restrict which agent sees a plugin", () => {
  const dsOnly = { name: "ds-only", version: "1.0.0", kind: "tool", targets: ["ds"] };
  assert.equal(isEnabled(dsOnly, "ds", {}), true);
  assert.equal(isEnabled(dsOnly, "pi", {}), false);

  const both = { name: "both", version: "1.0.0", kind: "tool" };
  assert.equal(isEnabled(both, "ds", {}), true);
  assert.equal(isEnabled(both, "pi", {}), true);
});

test("hot disable -> reload runs disposers; enable -> reload brings it back", async () => {
  const stage = stageHelloPlugin();
  const { dir, file } = tmpConfig({ ds: {}, pi: { "hello-tool": true } });
  try {
    const { state, impl } = recordingImpl();
    const host = createPluginHost({ agent: "pi", pluginsDir: stage, configPath: file, impl });

    const first = await host.load();
    assert.equal(first.length, 1);

    const disposalsAfterLoad = state.disposals;
    await host.setEnabled("hello-tool", false);
    const second = await host.reload();
    assert.equal(second.length, 0);
    assert.ok(state.disposals > disposalsAfterLoad, "disposer should run on unload");

    await host.setEnabled("hello-tool", true);
    const third = await host.reload();
    assert.equal(third.length, 1);
    assert.equal(third[0].state, "loaded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("concurrent load() calls are serialized, never interleaved", async () => {
  const stage = stageHelloPlugin();
  const { dir, file } = tmpConfig({ ds: {}, pi: { "hello-tool": true } });
  try {
    const { state, impl } = recordingImpl();
    let inFlight = 0;
    let maxInFlight = 0;
    // Wrap registerTool to observe overlap between load passes.
    const wrapped = {
      ...impl,
      registerTool(def) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const disposer = impl.registerTool(def);
        inFlight -= 1;
        return disposer;
      },
    };
    const host = createPluginHost({ agent: "pi", pluginsDir: stage, configPath: file, impl: wrapped });

    // Fire five loads at once; each pass must dispose before the next loads.
    const passes = await Promise.all([host.load(), host.load(), host.load(), host.load(), host.load()]);
    assert.equal(passes.length, 5);
    for (const pass of passes) {
      assert.equal(pass.length, 1);
      assert.equal(pass[0].state, "loaded");
    }
    // Serialized execution means registrations never overlapped.
    assert.ok(maxInFlight <= 1, `register calls overlapped (max in flight ${maxInFlight})`);
    assert.equal(state.tools.filter((t) => t === "hello").length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("a broken plugin is isolated as state=error and does not break others", async () => {
  const tmpPlugins = fs.mkdtempSync(path.join(os.tmpdir(), "pdb-plugins-dir-"));
  try {
    fs.mkdirSync(path.join(tmpPlugins, "good"));
    fs.writeFileSync(
      path.join(tmpPlugins, "good", "manifest.json"),
      JSON.stringify({ name: "good", version: "1.0.0", kind: "tool" }),
    );
    fs.writeFileSync(
      path.join(tmpPlugins, "good", "index.mjs"),
      `export default (api) => { api.registerTool({ name: "g", description: "d", parameters: {}, async execute() { return { content: [] }; } }); };`,
    );

    fs.mkdirSync(path.join(tmpPlugins, "broken"));
    fs.writeFileSync(
      path.join(tmpPlugins, "broken", "manifest.json"),
      JSON.stringify({ name: "broken", version: "1.0.0", kind: "tool" }),
    );
    fs.writeFileSync(path.join(tmpPlugins, "broken", "index.mjs"), `throw new Error("boom");`);

    const { state, impl } = recordingImpl();
    const host = createPluginHost({
      agent: "pi",
      pluginsDir: tmpPlugins,
      configPath: realConfig,
      impl,
    });
    const loaded = await host.load();
    const byName = Object.fromEntries(loaded.map((p) => [p.name, p]));
    assert.equal(byName.good.state, "loaded");
    assert.equal(byName.broken.state, "error");
    assert.match(byName.broken.error, /boom/);
    assert.deepEqual(state.tools, ["g"]);
  } finally {
    fs.rmSync(tmpPlugins, { recursive: true, force: true });
  }
});
