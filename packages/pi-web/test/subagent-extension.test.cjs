"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { isolateInitializer, requestRpc, nativeFactory, GLOBAL_KEYS } = require("../subagent-extension.cjs");

function mockPi(id) {
  const events = new EventEmitter();
  const origOn = events.on.bind(events);
  events.on = (name, fn) => { origOn(name, fn); return () => events.off(name, fn); };
  return new Proxy({
    events,
    sessionManager: { getSessionId: () => id, getSessionFile: () => null },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      return () => () => {};
    },
  });
}

test("RPC timeout unsubscribes the reply listener", async () => {
  const bus = new EventEmitter();
  let unsubscribed = false;
  const origOn = bus.on.bind(bus);
  bus.on = (name, fn) => {
    origOn(name, fn);
    return () => { unsubscribed = true; bus.off(name, fn); };
  };
  await assert.rejects(() => requestRpc(bus, "ping", {}, 30), /timed out/);
  assert.equal(unsubscribed, true);
});

test("isolateInitializer does not let a second session clean the first", () => {
  let cleaned = 0;
  globalThis.__piSubagentRuntimeCleanup = () => { cleaned += 1; };
  isolateInitializer(() => {
    const previous = globalThis.__piSubagentRuntimeCleanup;
    if (typeof previous === "function") previous();
    globalThis.__piSubagentRuntimeCleanup = () => {};
  }, {});
  assert.equal(cleaned, 0);
  assert.equal(typeof globalThis.__piSubagentRuntimeCleanup, "function");
  delete globalThis.__piSubagentRuntimeCleanup;
});

test("native extension loads twice and answers ping", async () => {
  const agentDir = path.join(process.env.USERPROFILE || "", ".pi", "agent");
  const factory = await nativeFactory(agentDir);
  const first = mockPi("sess-a");
  const second = mockPi("sess-b");
  isolateInitializer(factory, first);
  isolateInitializer(factory, second);
  const [a, b] = await Promise.all([
    requestRpc(first.events, "ping", {}, 4000),
    requestRpc(second.events, "ping", {}, 4000),
  ]);
  assert.equal(a.version, 1);
  assert.equal(b.version, 1);
  assert.ok(a.methods.includes("status"));
  assert.ok(a.methods.includes("stop"));
  for (const key of GLOBAL_KEYS) delete globalThis[key];
});
