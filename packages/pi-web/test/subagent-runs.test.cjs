"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SubagentRuns, pidLiveness, runnerVerdict, classifyFailure } = require("../subagent-runs.cjs");

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

test("foreground workflow (async:false) finalizes children instead of leaving them working", () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-a" });
  registry.begin("call-wf", { async: false, workflowScript: "runs.all([])" });
  registry.tool("call-wf", {
    content: [{ type: "text", text: "Run fan-out: 1/64 used\nWorkflow completed." }],
    details: {
      id: "call-wf",
      mode: "workflow",
      progress: [{ index: 0, agent: "reviewer", model: "OpenCode Go X/deepseek-flash:high", thinking: "high", status: "working" }],
    },
  }, true, true);
  const errored = registry.snapshot().runs[0];
  assert.equal(errored.agent, "reviewer");
  assert.equal(errored.status, "failed");

  const ok = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-b" });
  ok.begin("call-wf2", { async: false, workflowScript: "runs.all([])" });
  ok.tool("call-wf2", {
    content: [{ type: "text", text: "Run fan-out: 1/64 used\nWorkflow completed." }],
    details: {
      id: "call-wf2",
      mode: "workflow",
      progress: [{ index: 0, agent: "reviewer", status: "working" }],
    },
  }, true, false);
  assert.equal(ok.snapshot().runs[0].status, "completed");
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

test("atomic restore normalizes stale working runs and fails orphans", () => {
  const dir = tmpDir();
  const file = path.join(dir, "sess-a.json");
  const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-async-"));
  const goneDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-async-"));
  fs.rmSync(goneDir, { recursive: true, force: true });
  // runner 还活着：这个 run 依然可能被 status.json 更新，不能当孤儿
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
    runId: "bg", sessionId: "sess-a", state: "running", pid: process.pid,
    startedAt: Date.now(), lastUpdate: Date.now(),
    steps: [{ index: 0, agent: "oracle", status: "running" }],
  }));
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessionId: "sess-a",
    runs: [
      { id: "fg:0", runId: "fg", index: 0, agent: "worker", status: "working", background: false, startedAt: 1 },
      { id: "bg:0", runId: "bg", index: 0, agent: "oracle", status: "working", background: true, startedAt: 2, asyncDir },
      { id: "orphan:0", runId: "orphan", index: 0, agent: "scout", status: "working", background: true, startedAt: 3 },
      // 目录被回收了：永远不可能再有终态事件，挂着 working 就是僵尸
      { id: "pruned:0", runId: "pruned", index: 0, agent: "delegate", status: "working", background: true, startedAt: 4, asyncDir: goneDir, childSessionId: "01a07ad9-21de-7006-84b6-5b6742496634" },
    ],
  }));
  const restored = new SubagentRuns({ dir, sessionId: "sess-a" });
  const byAgent = Object.fromEntries(restored.snapshot().agents.map((agent) => [agent.agent, agent.status]));
  assert.equal(byAgent.worker, "unknown");
  assert.equal(byAgent.oracle, "working");
  assert.equal(byAgent.scout, "failed");
  assert.equal(byAgent.delegate, "failed");
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
    sessionId: "D:\\repo\\sessions\\2026-09-07T07-50-45-470Z_" + sessionId + ".jsonl",
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

test("snapshot keeps callId so the UI can nest a child under its spawn point", () => {
  const dir = tmpDir();
  const asyncDir = path.join(dir, "async-anchor");
  fs.mkdirSync(asyncDir, { recursive: true });
  const registry = new SubagentRuns({ dir, sessionId: "sess-a" });
  registry.begin("call-anchor", { agent: "worker", task: "nested" });
  registry.tool("call-anchor", {
    details: {
      asyncId: "async-anchor",
      background: true,
      asyncDir,
      results: [{ index: 0, agent: "worker", task: "nested", finalOutput: "started" }],
    },
  }, true, false);
  const run = registry.snapshot().runs[0];
  // 锚点：父转录里 details.tool[data-call] 就是这个 callId，
  // 子对话靠它挂到自己被派出来的那一行下面
  assert.equal(run.callId, "call-anchor");
  // 本地绝对路径仍然不出网
  assert.equal("asyncDir" in run, false);
  assert.equal("sessionFile" in run, false);
  assert.equal("transcriptPath" in run, false);
});

test("callId survives a snapshot round-trip so reloads still nest", () => {
  const dir = tmpDir();
  const first = new SubagentRuns({ dir, sessionId: "sess-b" });
  first.put({ runId: "async-b", index: 0, agent: "worker", status: "working", background: true, callId: "call-b" });
  first.save();
  const reopened = new SubagentRuns({ dir, sessionId: "sess-b" });
  assert.equal(reopened.snapshot().runs[0].callId, "call-b");
});

test("fan-out children found in status.json inherit the one spawn callId", () => {
  const dir = tmpDir();
  const sessionId = "sess-fan";
  const asyncDir = path.join(dir, "async-fan");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
    runId: "run-fan",
    sessionId,
    state: "running",
    steps: [
      { index: 0, agent: "worker", status: "working" },
      { index: 1, agent: "worker", status: "working" },
      { index: 2, agent: "reviewer", status: "working" },
    ],
  }));
  const registry = new SubagentRuns({ dir, sessionId });
  registry.begin("call-fan", { workflowScript: "runs.all([])" });
  // 扇出只有一次工具调用，子代理全是之后从 status.json 里发现的
  registry.tool("call-fan", {
    content: [{ type: "text", text: "Run fan-out: 3/64 used" }],
    details: { id: "run-fan", mode: "workflow", background: true, asyncDir },
  }, false, false);
  const runs = registry.snapshot().runs;
  assert.equal(runs.length, 3);
  for (const run of runs) assert.equal(run.callId, "call-fan");
});

test("spawn callId is rebuilt from disk so a reload still nests the fan-out", () => {
  const dir = tmpDir();
  const first = new SubagentRuns({ dir, sessionId: "sess-g" });
  first.put({ runId: "run-g", index: 0, agent: "worker", status: "working", background: true, callId: "call-g" });
  first.save();
  const reopened = new SubagentRuns({ dir, sessionId: "sess-g" });
  // 重启后 this.calls 已经空了，新发现的兄弟 run 仍然要拿到锚点
  reopened.put({ runId: "run-g", index: 1, agent: "reviewer", status: "working", background: true });
  assert.equal(reopened.snapshot().runs.find((r) => r.index === 1).callId, "call-g");
});

test("status.json toolCallId repairs the anchor on runs saved before it existed", () => {
  const dir = tmpDir();
  const asyncDir = path.join(dir, "async-old");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
    runId: "run-old",
    sessionId: "sess-old",
    toolCallId: "call-ancient",
    state: "running",
    steps: [{ index: 0, agent: "worker", status: "working" }],
  }));
  // 老快照：run 由 status.json 发现，落盘时还没有 callId 这条通路
  fs.writeFileSync(path.join(dir, "sess-old.json"), JSON.stringify({
    version: 1,
    sessionId: "sess-old",
    runs: [{ id: "run-old:0", sessionId: "sess-old", runId: "run-old", index: 0, agent: "worker",
      status: "working", background: true, asyncDir, startedAt: Date.now() }],
  }));
  const registry = new SubagentRuns({ dir, sessionId: "sess-old" });
  // 没有 begin()/tool()：锚点只能从 status.json 里捞
  assert.equal(registry.snapshot().runs.find((r) => r.id === "run-old:0").callId, "call-ancient");
});

test("runnerVerdict mirrors the upstream PID rule", () => {
  const now = Date.now();
  const st = (extra) => ({ state: "running", pid: 4242, startedAt: now, lastUpdate: now, ...extra });
  assert.match(runnerVerdict(st(), now, () => "dead"), /4242/);
  assert.equal(runnerVerdict(st(), now, () => "alive"), null);
  assert.equal(runnerVerdict(st(), now, () => "unknown"), null);
  assert.match(runnerVerdict(st({ lastUpdate: now - 25 * 60 * 60 * 1000 }), now, () => "alive"), /cannot be verified/);
  assert.equal(runnerVerdict(st({ state: "complete" }), now, () => "dead"), null);
  assert.equal(runnerVerdict(st({ pid: undefined }), now, () => "dead"), null);
});

test("a dead runner pid closes every open child of the fan-out", () => {
  const { spawnSync } = require("node:child_process");
  const done = spawnSync(process.execPath, ["-e", ""], { timeout: 10000 });
  assert.equal(done.error, undefined);
  assert.equal(pidLiveness(done.pid), "dead");
  const dir = tmpDir();
  const asyncDir = path.join(dir, "async-dead");
  fs.mkdirSync(asyncDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
    runId: "run-dead", sessionId: "sess-dead", state: "running", pid: done.pid,
    startedAt: now, lastUpdate: now, toolCallId: "call-dead",
    steps: [
      { index: 0, agent: "worker", status: "running" },
      { index: 1, agent: "worker", status: "running" },
      { index: 2, agent: "worker", status: "complete", finalOutput: "done" },
    ],
  }));
  const registry = new SubagentRuns({ dir, sessionId: "sess-dead" });
  for (const index of [0, 1, 2]) {
    registry.put({ runId: "run-dead", index, agent: "worker", status: index === 2 ? "completed" : "working", background: true, asyncDir, callId: "call-dead" });
  }
  registry.refreshFiles();
  const runs = registry.snapshot().runs;
  assert.equal(runs.find((r) => r.index === 2).status, "completed");
  for (const run of runs.filter((r) => r.index !== 2)) {
    assert.equal(run.status, "failed");
    assert.match(run.error, /exited or disappeared before writing a result/);
    assert.equal(run.callId, "call-dead");
  }
});

test("a pruned async directory ages the run out, a fresh one does not", () => {
  const dir = tmpDir();
  const sessionId = "sess-pruned";
  const build = (runId, startedAt) => {
    const registry = new SubagentRuns({ dir, sessionId });
    registry.put({ runId, index: 0, agent: "worker", status: "working", background: true, asyncDir: path.join(dir, runId), startedAt });
    registry.refreshFiles(false);
    return registry.snapshot().runs[0];
  };
  const now = Date.now();
  const fresh = build("run-fresh", now - 60 * 1000);
  assert.equal(fresh.status, "working");
  const aged = build("run-aged", now - 2 * 60 * 60 * 1000);
  assert.equal(aged.status, "failed");
});

test("a failed run carries the failure class the UI can name", () => {
  const registry = new SubagentRuns({ dir: tmpDir(), sessionId: "sess-cls" });
  registry.put({ runId: "r1", index: 0, agent: "worker", status: "failed", error: "Run fan-out: 10/64 used\nSubagent produced no output (possible model cold-start or empty response)." });
  registry.put({ runId: "r2", index: 0, agent: "translator", status: "failed", error: "Unknown agent: translator" });
  registry.put({ runId: "r3", index: 0, agent: "scout", status: "failed", error: "provider 400 bad request" });
  registry.put({ runId: "r4", index: 0, agent: "worker", status: "failed", error: "Orphaned run: no async directory or child session to reconcile." });
  registry.put({ runId: "r5", index: 0, agent: "worker", status: "failed", error: "Async runner process 4211 exited or disappeared before writing a result." });
  const byRun = Object.fromEntries(registry.snapshot().runs.map((r) => [r.runId, r]));
  assert.equal(byRun.r1.failClass, "empty_output");
  assert.equal(byRun.r1.failLabel, "空返回");
  assert.match(byRun.r1.failHint, /fallbackModels/);
  assert.equal(byRun.r2.failClass, "unknown_agent");
  assert.equal(byRun.r3.failClass, "");
  assert.equal(byRun.r3.failLabel, undefined);
  // 判活回收掉的两条（目录被清、runner 进程没了）是同一个可执行结论：重跑
  assert.equal(byRun.r4.failClass, "runner_gone");
  assert.equal(byRun.r5.failClass, "runner_gone");
  assert.equal(byRun.r4.failLabel, "进程已退出");
  // 她自己的 110 条 run 里剩下的三种死法：内置 researcher 死于点名了 web_search 的白名单
  registry.put({ runId: "r6", index: 0, agent: "researcher", status: "failed", error: "Agent 'researcher' requested unavailable child tools: web_search, fetch_content." });
  registry.put({ runId: "r7", index: 0, agent: "reviewer", status: "failed", error: "Acceptance rejected: commands-run evidence missing from child report." });
  registry.put({ runId: "r8", index: 0, agent: "worker", status: "failed", error: '400: {"type":"invalid_request_error","message":"Error from provider (Console Go)"}' });
  const more = Object.fromEntries(registry.snapshot().runs.map((r) => [r.runId, r]));
  assert.equal(more.r6.failClass, "missing_tools");
  assert.match(more.r6.failHint, /继承父会话/);
  assert.equal(more.r7.failClass, "acceptance_rejected");
  assert.equal(more.r8.failClass, "provider_error");
  // 产物路径里的十六进制串不能被当成鉴权失败
  const noise = classifyFailure("Output artifact: D:\\repo\\config\\.pi-web\\sessions\\subagent-artifacts\\a401b7de_worker_0_output.md");
  assert.equal(noise, null);
  registry.put({ runId: "r1", index: 0, agent: "worker", status: "completed", result: "ok" });
  assert.equal(registry.snapshot().runs.find((r) => r.runId === "r1").failClass, undefined);
});

test("a snapshot written before failClass existed still gets classified", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "sess-old2.json"), JSON.stringify({
    version: 1, sessionId: "sess-old2",
    runs: [{ id: "r-old:0", sessionId: "sess-old2", runId: "r-old", index: 0, agent: "worker",
      status: "failed", background: true, error: "Subagent produced no output (possible model cold-start or empty response).",
      startedAt: 1, endedAt: 2 }],
  }));
  const reopened = new SubagentRuns({ dir, sessionId: "sess-old2" });
  const run = reopened.snapshot().runs[0];
  assert.equal(run.failClass, "empty_output");
  assert.equal(run.failLabel, "空返回");
});
