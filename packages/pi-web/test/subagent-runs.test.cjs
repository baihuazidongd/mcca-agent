"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SubagentRuns } = require("../subagent-runs.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-subagent-"));
}

test("background tool end stays working until async terminal", () => {
  const dir = tmpDir();
  const registry = new SubagentRuns({ dir, sessionId: "sess-a" });
  registry.begin("call-1", { agent: "worker", task: "bg" });
  registry.tool("call-1", {
    details: {
      asyncId: "async-1",
      background: true,
      results: [{ index: 0, agent: "worker", task: "bg", finalOutput: "started" }],
    },
  }, true, false);
  const snap = registry.snapshot();
  assert.equal(snap.agents.length, 1);
  assert.equal(snap.agents[0].status, "working");
  assert.equal(snap.runs[0].status, "working");
});

test("management tool calls do not create icons", () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.begin("call-m", { action: "list" });
  registry.tool("call-m", { details: { mode: "management", results: [{ agent: "worker" }] } }, true, false);
  assert.equal(registry.snapshot().agents.length, 0);
});

test("async-complete ends a background run", () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.event("subagent:async-started", { id: "async-1", asyncDir: path.join(os.tmpdir(), "nope"), agent: "worker", sessionId: "sess-a" });
  registry.event("subagent:async-complete", { id: "async-1", sessionId: "sess-a", success: true, summary: "done" });
  assert.equal(registry.snapshot().agents[0].status, "completed");
});

test("acceptance rejection closes a working child", () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.begin("call-r", { agent: "reviewer", task: "review", async: true });
  registry.tool("call-r", {
    content: [{ type: "text", text: "Acceptance rejected: commands-run evidence missing" }],
    details: { asyncId: "async-rejected", background: true, results: [{ index: 0, agent: "reviewer", task: "review", finalOutput: "" }] },
  }, true, true);
  const run = registry.snapshot().runs[0];
  assert.equal(run.status, "failed");
  assert.match(run.error, /commands-run/);
});

test("same-name concurrency stays working if any child is working", () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.put({ runId: "r1", index: 0, agent: "worker", status: "completed", task: "one" });
  registry.put({ runId: "r2", index: 0, agent: "worker", status: "working", task: "two" });
  const agent = registry.snapshot().agents[0];
  assert.equal(agent.status, "working");
  assert.equal(agent.activeCount, 1);
});

test("sessions are isolated and disabled does not cover working", () => {
  const dir = tmpDir();
  const a = new SubagentRuns({ dir, sessionId: "sess-a" });
  const b = new SubagentRuns({ dir, sessionId: "sess-b" });
  a.put({ runId: "r1", index: 0, agent: "worker", status: "working" });
  b.put({ runId: "r1", index: 0, agent: "oracle", status: "completed" });
  assert.equal(a.snapshot().agents[0].agent, "worker");
  assert.equal(b.snapshot().agents[0].agent, "oracle");
  const covered = a.snapshot([{ name: "worker", disabled: true }]);
  assert.equal(covered.agents[0].status, "working");
  a.put({ runId: "r1", index: 0, agent: "worker", status: "completed" });
  assert.equal(a.snapshot([{ name: "worker", disabled: true }]).agents[0].status, "stopped");
});

test("atomic restore turns stale foreground working into unknown", () => {
  const dir = tmpDir();
  const file = path.join(dir, "sess-a.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessionId: "sess-a",
    runs: [
      { id: "fg:0", runId: "fg", index: 0, agent: "worker", status: "working", background: false, startedAt: 1 },
      { id: "bg:0", runId: "bg", index: 0, agent: "oracle", status: "working", background: true, startedAt: 2 },
    ],
  }));
  const restored = new SubagentRuns({ dir, sessionId: "sess-a" });
  const byAgent = Object.fromEntries(restored.snapshot().agents.map((agent) => [agent.agent, agent.status]));
  assert.equal(byAgent.worker, "unknown");
  assert.equal(byAgent.oracle, "working");
});

test("stop writes control file and keeps working until terminal", async () => {
  const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-async-"));
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.put({ runId: "async-9", index: 1, agent: "worker", status: "working", background: true, asyncDir });
  const calls = [];
  const result = await registry.stop("async-9:1", async (method, params) => {
    calls.push({ method, params });
    return { state: "rpc" };
  });
  assert.equal(result.state, "stopping");
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(asyncDir, "control", "stop.json")), true);
  assert.equal(registry.snapshot().agents[0].status, "working");
  assert.equal(registry.runs.get("async-9:1").stopRequested, true);
});

test("foreground interrupt uses runId and index", async () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.put({ runId: "fg-2", index: 3, agent: "scout", status: "working", background: false });
  const calls = [];
  await registry.stop("fg-2:3", async (method, params) => { calls.push({ method, params }); return { state: "stopping" }; });
  assert.deepEqual(calls[0], { method: "interrupt", params: { runId: "fg-2", index: 3 } });
  assert.equal(registry.snapshot().agents[0].status, "working");
});


test("workflow async start with empty results still shows working", () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.begin("call-1", { agent: "worker", async: true, task: "pong", model: "omen-alpha" });
  registry.tool("call-1", {
    content: [{ type: "text", text: "Async workflow [5003850b-bd2f-417f-a432-e9b73d89defb]" }],
    details: { mode: "workflow", asyncId: "5003850b-bd2f-417f-a432-e9b73d89defb", runId: "5003850b-bd2f-417f-a432-e9b73d89defb", asyncDir: "/tmp/async", results: [] },
  }, true, false);
  const snap = registry.snapshot();
  assert.equal(snap.agents.length, 1);
  assert.equal(snap.agents[0].agent, "worker");
  assert.equal(snap.agents[0].status, "working");
});

test("parses async id from tool text when details are missing", () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.begin("call-2", JSON.stringify({ agent: "oracle", async: true, task: "hi" }));
  registry.tool("call-2", {
    content: [{ type: "text", text: "Async workflow [abc-123]" }],
  }, true, false);
  assert.equal(registry.snapshot().agents[0].agent, "oracle");
  assert.equal(registry.snapshot().agents[0].status, "working");
});

test("path-style status.json sessionId still completes the run", () => {
  const { sameSession, idFromSessionFile, extractDelegatedTask, conversationEvents, isChildSessionInfo } = require("../subagent-runs.cjs");
  assert.equal(sameSession("01a07ad9-21de-7006-84b6-5b6742496634", "D:\\x\\2026-09-07T07-50-45-470Z_01a07ad9-21de-7006-84b6-5b6742496634.jsonl"), true);
  assert.equal(idFromSessionFile("D:\\x\\2026-09-07T07-51-00-030Z_01a07ad9-5abd-7006-84b6-5b685de658e8.jsonl"), "01a07ad9-5abd-7006-84b6-5b685de658e8");
  assert.equal(isChildSessionInfo({ parentSession: "parent.jsonl" }), true);
  assert.equal(isChildSessionInfo({ name: "subagent-worker-9fa93358-1" }), true);
  assert.equal(isChildSessionInfo({ name: "普通对话" }), false);
  const task = extractDelegatedTask("Preamble\nTask:\nReply with only the word pong.\n\n## Acceptance Contract\nHuge blob");
  assert.equal(task, "Reply with only the word pong.");
  const view = conversationEvents([
    { type: "user", text: "inherited parent" },
    { type: "user", text: "You are a delegated subagent.\nTask:\nReply with only the word pong.\n\n## Acceptance Contract\nblob" },
    { type: "assistant-end", text: "pong" },
  ]);
  assert.equal(view[0].text, "Reply with only the word pong.");
  assert.equal(view[1].text, "pong");

  const dir = tmpDir();
  const asyncDir = path.join(dir, "async");
  fs.mkdirSync(asyncDir);
  const sessionId = "01a07ad9-21de-7006-84b6-5b6742496634";
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
    runId: "async-1",
    sessionId: "D:\\ws\\sessions\\2026-09-07T07-50-45-470Z_" + sessionId + ".jsonl",
    state: "complete",
    steps: [{
      agent: "worker",
      status: "completed",
      sessionFile: "D:\\x\\2026-09-07T07-51-00-030Z_01a07ad9-5abd-7006-84b6-5b685de658e8.jsonl",
      recentOutput: ["pong"],
      finalOutput: "pong",
    }],
  }));
  const registry = new SubagentRuns({ dir, sessionId });
  registry.put({ runId: "async-1", index: 0, agent: "worker", status: "working", background: true, asyncDir });
  registry.refreshFiles();
  const snap = registry.snapshot();
  assert.equal(snap.agents[0].status, "completed");
  assert.equal(snap.runs[0].result, "pong");
  assert.equal(snap.runs[0].childSessionId, "01a07ad9-5abd-7006-84b6-5b685de658e8");
  assert.equal(snap.agents[0].sessionId, "01a07ad9-5abd-7006-84b6-5b685de658e8");
});
