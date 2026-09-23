"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const subagents = require("../subagents.cjs");

const registry = {
  getAvailable() {
    return [{ provider: "openai", id: "gpt-test", name: "gpt-test" }];
  },
};

test("unknown fields are rejected", async () => {
  const result = await subagents.manage("create", { name: "x", bogus: 1 });
  assert.equal(result.isError, true);
  assert.match(subagents.errorText(result), /unknown field: bogus/);
});

test("unknown action is rejected", async () => {
  const result = await subagents.manage("explode", { name: "worker" });
  assert.equal(result.isError, true);
  assert.match(subagents.errorText(result), /Unknown action/);
});

test("effective list includes builtin roles", () => {
  const names = subagents.effective().map((agent) => agent.name);
  for (const name of ["delegate", "oracle", "researcher", "reviewer", "scout", "worker"]) {
    assert.ok(names.includes(name), name);
  }
  const worker = subagents.effective().find((agent) => agent.name === "worker");
  assert.equal(worker.source, "builtin");
  assert.equal(worker.scope, "user");
});

test("create/update/disable in a temp PI_CODING_AGENT_DIR", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-agent-dir-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmp;
  try {
    const name = "webtest-" + Date.now();
    const created = await subagents.manage("create", {
      name,
      description: "temporary web test agent",
      model: "gpt-test",
      thinking: "low",
      systemPrompt: "You are a test subagent.",
      tools: "read",
      scope: "user",
    }, tmp, registry);
    assert.equal(created.isError, false, subagents.errorText(created));
    const listed = subagents.effective(tmp);
    const agent = listed.find((item) => item.name === name);
    assert.ok(agent, "created agent missing from effective list");
    assert.equal(agent.source, "user");
    assert.equal(agent.thinking, "low");
    const updated = await subagents.manage("update", {
      name,
      agent: name,
      description: "updated web test agent",
      thinking: "high",
      systemPrompt: "Updated prompt.",
    }, tmp, registry);
    assert.equal(updated.isError, false, subagents.errorText(updated));
    const after = subagents.effective(tmp).find((item) => item.name === name);
    assert.equal(after.thinking, "high");
    const disabled = await subagents.manage("disable", { name, agent: name, agentScope: "user" }, tmp, registry);
    assert.equal(disabled.isError, false, subagents.errorText(disabled));
    assert.equal(subagents.effective(tmp).find((item) => item.name === name).disabled, true);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});
