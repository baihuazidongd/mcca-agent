import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapter = require("@mcca/dsh-adapter");
const {
  createDshApiImpl,
  normalizeResult,
  renderNeutral,
  sanitizeCommandName,
  EVENT_MAP,
} = adapter;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pluginsDir = path.join(root, "plugins");
const realConfig = path.join(root, "config", "plugins.json");

function fakeCtx() {
  const ctx = {
    tools: [],
    commands: [],
    listeners: [],
    effects: [],
    cleanups: [],
    register(anchor) {
      ctx.tools.push(anchor);
      return () => {
        const i = ctx.tools.indexOf(anchor);
        if (i >= 0) ctx.tools.splice(i, 1);
      };
    },
  };
  ctx.tools = Object.assign([], { register: (def) => ctx.register(def) });
  ctx.commands = {
    registered: [],
    register(def) {
      ctx.commands.registered.push(def);
      return () => {};
    },
  };
  ctx.on = (event, handler) => {
    ctx.listeners.push({ event, handler });
    return () => {};
  };
  ctx.effect = (fn, label) => {
    ctx.effects.push(label);
    const cleanup = fn();
    ctx.cleanups.push(cleanup);
    return cleanup;
  };
  return ctx;
}

function waitUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = fn();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() > deadline) return reject(new Error("condition not met in time"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("normalizeResult maps every neutral shape to a canonical value", () => {
  assert.deepEqual(normalizeResult(null), { content: [] });
  assert.deepEqual(normalizeResult("hi"), { content: [{ type: "text", text: "hi" }] });
  assert.deepEqual(normalizeResult([{ type: "text", text: "a" }]), {
    content: [{ type: "text", text: "a" }],
  });
  assert.deepEqual(
    normalizeResult({ content: [{ type: "text", text: "b" }], details: { n: 1 } }),
    { content: [{ type: "text", text: "b" }], details: { n: 1 } },
  );
});

test("renderNeutral projects content blocks, stringifying non-text blocks", () => {
  const value = {
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "x" },
    ],
  };
  assert.deepEqual(renderNeutral(undefined, value), [
    { type: "text", text: "hello" },
    { type: "text", text: '{"type":"image","data":"x"}' },
  ]);
});

test("sanitizeCommandName enforces the dsh command contract", () => {
  assert.equal(sanitizeCommandName("greet"), "greet");
  assert.equal(sanitizeCommandName("My Tool!"), "my-tool");
  assert.equal(sanitizeCommandName("1st"), "cmd-1st");
});

test("EVENT_MAP routes neutral events to dsh extension points", () => {
  assert.equal(EVENT_MAP.session_start.event, "agent/created");
  assert.equal(EVENT_MAP.session_end.event, "agent/disposed");
  assert.equal(EVENT_MAP.input.type, "user/message");
  assert.equal(EVENT_MAP.turn_end.type, "turn/end");
});

test("registerTool maps onto a raw dsh ToolDefinition and executes", async () => {
  const ctx = fakeCtx();
  const impl = createDshApiImpl(ctx, { cwd: root });
  impl.registerTool({
    name: "hello",
    description: "greet",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    async execute(args) {
      return { content: [{ type: "text", text: `Hello, ${args.name}!` }], details: { agent: "ds" } };
    },
  });

  assert.equal(ctx.tools.length, 1);
  const def = ctx.tools[0];
  assert.equal(def.name, "hello");
  assert.equal(def.description, "greet");
  assert.equal(typeof def.output.render, "function");

  const value = await def.execute({ name: "Ada" }, { signal: undefined });
  assert.deepEqual(value, {
    content: [{ type: "text", text: "Hello, Ada!" }],
    details: { agent: "ds" },
  });
  assert.deepEqual(def.output.render(undefined, value), [
    { type: "text", text: "Hello, Ada!" },
  ]);
});

test("tool cwd follows the dsh session header when the agent has one", async () => {
  const ctx = fakeCtx();
  const impl = createDshApiImpl(ctx, { cwd: root });
  let seen = "";
  impl.registerTool({
    name: "where",
    description: "cwd",
    parameters: { type: "object" },
    async execute(_args, pluginCtx) {
      seen = pluginCtx.cwd;
      return { content: [{ type: "text", text: pluginCtx.cwd }] };
    },
  });
  await ctx.tools[0].execute({}, {
    agent: { session: { header: { cwd: "D:\\work\\app" } } },
    signal: undefined,
  });
  assert.equal(seen, "D:\\work\\app");
});

test("registerCommand sanitizes the name and maps the handler to CommandResult", async () => {
  const ctx = fakeCtx();
  const impl = createDshApiImpl(ctx, { cwd: root });
  impl.registerCommand("My Tool", {
    description: "demo",
    handler: async (args) => `ran with ${args}`,
  });

  assert.equal(ctx.commands.registered.length, 1);
  const def = ctx.commands.registered[0];
  assert.equal(def.name, "my-tool");
  const result = await def.handler({ rawInput: "x", signal: undefined });
  assert.deepEqual(result, { kind: "success", text: "ran with x" });
});

test("on() subscribes through agent and session extension points", async () => {
  const ctx = fakeCtx();
  const impl = createDshApiImpl(ctx, { cwd: root });
  const seen = [];
  impl.on("session_start", (event) => seen.push(event));
  impl.on("turn_end", (event) => seen.push(event));
  impl.on("input", (event) => seen.push(event));
  impl.on("unknown_event", () => seen.push({ type: "nope" }));

  assert.equal(ctx.listeners.length, 3);
  const sessionHandlers = ctx.listeners
    .filter((l) => l.event === "session/event")
    .map((l) => l.handler);
  const agentHandler = ctx.listeners.find((l) => l.event === "agent/created")?.handler;
  assert.ok(agentHandler);
  assert.equal(sessionHandlers.length, 2);

  await agentHandler({ agent: {} });
  for (const handler of sessionHandlers) {
    handler(null, { type: "turn/end", data: { turnIndex: 1 } });
    handler(null, { type: "user/message", data: { text: "hi" } });
    handler(null, { type: "assistant/message", data: {} });
  }

  assert.deepEqual(seen, [
    { type: "session_start" },
    { turnIndex: 1, type: "turn_end" },
    { text: "hi", type: "input" },
  ]);
});

test("apply() loads the shared hello-tool through the real plugin host", async () => {
  const ctx = fakeCtx();
  const disposeSpies = [];
  // Wrap register so apply()'s effect cleanup can be observed.
  const rawRegister = ctx.tools.register.bind(ctx.tools);
  ctx.tools.register = (def) => {
    disposeSpies.push(rawRegister(def));
    return disposeSpies[disposeSpies.length - 1];
  };

  // 受控开关：真实 config/plugins.json 里 hello-tool 可能被用户禁用
  const configPath = path.join(os.tmpdir(), `mcca-dsh-plugins-${process.pid}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ ds: { "hello-tool": true } }));
  try {
    adapter.apply(ctx, { cwd: root, pluginsDir, configPath });
    const def = await waitUntil(() => ctx.tools.find((d) => d.name === "hello"));
    const memory = await waitUntil(() => ctx.tools.find((d) => d.name === "memory_write"));
    const shot = await waitUntil(() => ctx.tools.find((d) => d.name === "computer_screenshot"));
    const open = await waitUntil(() => ctx.tools.find((d) => d.name === "browser_open"));
    assert.equal(memory.description.includes("功能记忆"), true);
    assert.equal(typeof shot.execute, "function");
    assert.equal(open.description.includes("Playwright"), false);

    const value = await def.execute({ name: "World" }, { signal: undefined });
    assert.equal(value.content[0].text, "你好，World！");
    assert.equal(value.details.agent, "ds");

    // The effect cleanup disposes the host, which unregisters the tool.
    assert.equal(ctx.effects.includes("mcca.plugins()"), true);
    const cleanup = ctx.cleanups[ctx.cleanups.length - 1];
    if (typeof cleanup === "function") await cleanup();
  } finally {
    fs.rmSync(configPath, { force: true });
  }
});
