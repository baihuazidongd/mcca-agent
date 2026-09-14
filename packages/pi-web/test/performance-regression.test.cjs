"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PiWebBridge } = require("../bridge.cjs");

test("parallel requests share one runtime initialization", async () => {
  const bridge = new PiWebBridge();
  let builds = 0;
  bridge.sessions.set("test", { cwd: process.cwd(), manager: {} });
  bridge.buildSession = async () => {
    builds++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { subscribe: () => () => {} };
  };
  bridge.refreshSessionRuntime = async () => {};
  await Promise.all(Array.from({ length: 24 }, () => bridge.attach("test")));
  assert.equal(builds, 1);
});

test("history and context do not initialize extensions", async () => {
  const bridge = new PiWebBridge();
  bridge.sessions.set("test", { id: "test", events: [], manager: {
    buildSessionContext: () => ({ model: { provider: "test", modelId: "test" }, thinkingLevel: "high" }),
  } });
  bridge.buildSession = async () => { throw new Error("Unexpected initialization"); };
  const history = await bridge.history("test");
  assert.equal(history.session.thinkingLevel, "high");
  assert.equal((await bridge.contextInfo("test")).total, null);
});

test("concurrent disk reads share discovery and refresh after expiration", async () => {
  const bridge = new PiWebBridge();
  let scans = 0;
  bridge.scanDiskSessions = async () => { scans++; return []; };
  await Promise.all(Array.from({ length: 24 }, () => bridge.diskSessions()));
  assert.equal(scans, 1);
  bridge.diskCacheUntil = 0;
  await bridge.diskSessions();
  assert.equal(scans, 2);
});
