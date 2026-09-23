import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyEvent, reduceFrames, createSessionState } = require("../packages/mobile-bridge/reducer.cjs");
const { PiSource } = require("../packages/mobile-bridge/pi-source.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("reducer: 历史回放（回放里没有 assistant-start/delta）", () => {
  const frames = [
    { event: { type: "turn-start", turn: 1 } },
    { event: { type: "user", text: "你好", id: "e1" } },
    { event: { type: "assistant-end", text: "你好，有什么可以帮你？", stopReason: "stop", usage: { output: 12 }, tokPerSec: 30 } },
    { event: { type: "tool", callId: "c1", phase: "start", name: "read", args: "{\"path\":\"a\"}" } },
    { event: { type: "tool", callId: "c1", phase: "end", name: "read", output: "content", isError: false } },
    { event: { type: "assistant-end", text: "读完了", stopReason: "stop" } },
    { event: { type: "turn-end", turn: 1, durationMs: 1234 } },
  ];
  const state = reduceFrames("s1", frames);
  assert.equal(state.messages.length, 3, "两条 assistant 消息 + 一条 user 消息");
  const [user, first, second] = state.messages;
  assert.equal(user.role, "user");
  assert.equal(user.id, "e1");
  assert.equal(user.text, "你好");
  assert.equal(first.role, "agent");
  assert.equal(first.text, "你好，有什么可以帮你？");
  assert.equal(first.status, "done");
  assert.equal(first.tools.length, 1);
  assert.equal(first.tools[0].name, "read");
  assert.equal(first.tools[0].output, "content");
  assert.equal(second.text, "读完了");
  assert.equal(second.status, "done");
  assert.equal(second.turn, 1);
  assert.equal(state.meta.running, false);
});

test("reducer: 实时流式（start → delta → tool → end → turn-end）", () => {
  const state = createSessionState("s2");
  const patches = [];
  const feed = (ev) => patches.push(...applyEvent(state, ev, 1000));
  feed({ type: "user", text: "跑个任务" });
  feed({ type: "turn-start", turn: 1 });
  feed({ type: "assistant-start" });
  const streamId = state.streamMsgId;
  feed({ type: "assistant-delta", text: "先看" });
  feed({ type: "assistant-delta", text: "一下" });
  feed({ type: "thinking-delta", text: "思考中" });
  feed({ type: "assistant-end", text: "先看一下", stopReason: "toolUse" });
  feed({ type: "tool", callId: "t1", phase: "start", name: "bash", args: "{\"cmd\":\"ls\"}" });
  feed({ type: "tool", callId: "t1", phase: "end", name: "bash", output: "ok", isError: false });
  feed({ type: "assistant-end", text: "跑完了" });
  feed({ type: "turn-end", turn: 1, durationMs: 5000 });
  feed({ type: "status", status: "idle" });

  const kinds = patches.map((p) => p.t);
  assert.ok(kinds.includes("delta"), "有流式增量补丁");
  assert.ok(kinds.includes("session"), "有会话状态补丁");
  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[0].role, "user");
  assert.equal(state.messages[1].text, "先看一下", "assistant-end 收口为权威文本");
  assert.equal(state.messages[1].thinking, "思考中");
  assert.equal(state.messages[1].status, "done");
  assert.equal(state.messages[1].id, streamId);
  assert.equal(state.messages[2].text, "跑完了");
  assert.equal(state.messages[1].tools.length, 1, "工具挂在发起调用的那条消息上");
  assert.equal(state.messages[1].tools[0].name, "bash");
  assert.equal(state.messages[2].durationMs, 5000);
  assert.equal(state.meta.running, false);
  assert.equal(state.streamMsgId, "");
});

test("reducer: transcript-reset 重建整段", () => {
  const state = createSessionState("s3");
  applyEvent(state, { type: "user", text: "旧消息" }, 1);
  const patches = applyEvent(
    state,
    { type: "transcript-reset", events: [{ type: "user", text: "新对话", id: "n1" }, { type: "assistant-end", text: "答复" }] },
    2,
  );
  assert.equal(patches[0].t, "reset");
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0].text, "新对话");
  assert.equal(state.messages[1].text, "答复");
});

function makeFakePiWeb() {
  const state = {
    sessions: [{ id: "sess-1", title: "会话一", updatedAt: 111, messageCount: 2, running: false, cwd: "D:/ws" }],
    prompts: [],
    enqueued: [],
    historyFrames: [
      { seq: 1, id: "b:1", event: { type: "turn-start", turn: 1 } },
      { seq: 2, id: "b:2", event: { type: "user", text: "hi", id: "u1" } },
      { seq: 3, id: "b:3", event: { type: "assistant-end", text: "hello", stopReason: "stop" } },
      { seq: 4, id: "b:4", event: { type: "turn-end", turn: 1 } },
    ],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/sessions") return json(200, { sessions: state.sessions });
    if (url.pathname === "/api/sessions/sess-1/history") {
      return json(200, {
        session: { id: "sess-1", title: "会话一", cwd: "D:/ws", running: false, turn: 1, promptQueue: [] },
        events: state.historyFrames,
        bootId: "b",
      });
    }
    if (url.pathname === "/api/sessions/sess-1/prompt") {
      state.prompts.push(req.url);
      return json(400, { ok: false, status: 409, error: "任务进行中：先点「■ 停止」停止当前任务" });
    }
    if (url.pathname === "/api/sessions/sess-1/enqueue") return json(200, { ok: true });
    if (url.pathname === "/api/sessions/sess-1/subagents") return json(200, { sessionId: "sess-1", agents: [], runs: [] });
    return json(404, { error: "no route " + url.pathname });
  });
  return { server, state };
}

test("PiSource: 列表 / 打开（含 SSE 去重）/ 发送回退排队", async () => {
  const { server, state } = makeFakePiWeb();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const notes = [];
  const patchLog = [];
  const source = new PiSource({
    baseUrl: `http://127.0.0.1:${port}`,
    onPatch: (id, patches) => patchLog.push({ id, patches }),
    onSessions: () => {},
    onNotify: (item) => notes.push(item),
    log: () => {},
  });
  try {
    const list = await source.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "会话一");

    const opened = await source.open("sess-1");
    assert.equal(opened.messages.length, 2);
    assert.equal(opened.messages[1].text, "hello");
    assert.equal(opened.session.title, "会话一");

    const sent = await source.send("sess-1", "下一条");
    assert.equal(sent.ok, true);
    assert.equal(sent.mode, "queued", "prompt 409 时自动走 enqueue");
    assert.equal(state.prompts.length, 1);

    const tasks = await source.subagents("sess-1");
    assert.equal(tasks.ok, true);
  } finally {
    source.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await new Promise((resolve) => server.close(resolve));
  }
});

test("PiSource: 运行态翻转产出完成通知", async () => {
  const { server, state } = makeFakePiWeb();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const notes = [];
  const source = new PiSource({
    baseUrl: `http://127.0.0.1:${port}`,
    onPatch: () => {},
    onSessions: () => {},
    onNotify: (item) => notes.push(item),
    log: () => {},
  });
  try {
    await source.list();
    await source.open("sess-1");
    state.sessions[0] = { ...state.sessions[0], running: true, updatedAt: 222 };
    await source.poll();
    state.sessions[0] = { ...state.sessions[0], running: false, updatedAt: 333 };
    await source.poll();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(notes.length >= 1, "完成时应产出通知");
    assert.match(notes[0].title, /完成/);
  } finally {
    source.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await new Promise((resolve) => server.close(resolve));
  }
});
