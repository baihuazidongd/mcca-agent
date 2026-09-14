"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PiWebBridge } = require("../bridge.cjs");
const http = require("node:http");

test("new model discovery carries reasoning metadata without prior configuration", async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [
      { id: "new-model", reasoning_efforts: ["low", "high"] },
      { id: "plain", reasoning: false },
      { id: "unknown" },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const bridge = new PiWebBridge();
  const result = await bridge.discoverModels({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal(result.models[0].thinkingEfforts, "low,high");
  assert.equal(result.models[1].thinkingEfforts, false);
  assert.equal(result.models[2].thinkingEfforts, undefined);
});

test("thinking refresh uses Pi capabilities without model requests or extensions", async () => {
  const bridge = new PiWebBridge();
  const model = { provider: "test", id: "test", api: "openai-completions", reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } };
  bridge.sessions.set("test", { id: "test", events: [], manager: {
    buildSessionContext: () => ({ model: { provider: "test", modelId: "test" }, thinkingLevel: "medium" }),
  } });
  bridge.runtime = async () => ({ getModels: () => [model], stream: () => { throw new Error("Unexpected inference"); } });
  bridge.buildSession = async () => { throw new Error("Unexpected extension initialization"); };
  const result = await bridge.thinkingInfo("test");
  assert.equal(result.ok, true);
  assert.equal(result.source, "configuration");
  assert.equal(result.level, "medium");
  assert.ok(result.levels.includes("high"));
  assert.ok(!result.levels.includes("max"));
  model.reasoning = false;
  assert.deepEqual((await bridge.thinkingInfo("test")).levels, ["off"]);
});
