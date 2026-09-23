import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relayRequire = createRequire(path.join(root, "packages", "mobile-relay", "package.json"));
const { WebSocketServer } = relayRequire("ws");
const { applyEvent, reduceEntries, createSessionState } = require("../packages/mobile-bridge/dsh-reducer.cjs");
const { DshSource } = require("../packages/mobile-bridge/dsh-source.cjs");

// 这个文件会拉起真实的 HTTP/WebSocket 连接（DshSource 的两种通道），
// 关闭后仍有底层 socket 处于半关状态会拖住 node:test 的退出；测完显式退出。
test.after(() => {
  setImmediate(() => process.exit(0));
});

test("dsh reducer: 历史回放（过滤插件消息/工具结果，保留人发的）", () => {
  const entries = [
    { event: { type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } } },
    { event: { type: "user/message", seq: 2, time: 1001, data: { id: "u1", role: "user", content: [{ type: "text", text: "看一下项目" }], source: { kind: "user" } } } },
    { event: { type: "user/message", seq: 3, time: 1002, data: { id: "sys1", role: "user", content: [{ type: "text", text: "Current runtime context..." }], source: { kind: "plugin" } } } },
    { event: { type: "assistant/chunk", seq: 4, time: 1003, data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", text: "先看目录" } } } },
    { event: { type: "assistant/chunk", seq: 5, time: 1004, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "好的" } } } },
    { event: { type: "assistant/chunk", seq: 6, time: 1005, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "，我看一下" } } } },
    { event: { type: "tool/call", seq: 7, time: 1006, data: { turn: 1, step: 1, callId: "c1", name: "pwsh", arguments: '{"command":"ls"}' } } },
    { event: { type: "tool/result", seq: 8, time: 1007, data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", isError: false, content: [{ type: "text", text: "a.txt\nb.txt" }] }] } } } },
    {
      event: {
        type: "assistant/message", seq: 9, time: 1008, data: {
          turn: 1, step: 1,
          message: {
            role: "assistant",
            content: [{ type: "reasoning", text: "先看目录" }, { type: "text", text: "好的，我看一下" }, { type: "tool-call", id: "c1", name: "pwsh", arguments: '{"command":"ls"}' }],
          },
        },
      },
    },
    { event: { type: "session/title", seq: 10, time: 1009, data: { title: "看一下项目" } } },
    { event: { type: "turn/end", seq: 11, time: 1010, data: { turn: 1, reason: { kind: "completed" } } } },
  ];
  const state = reduceEntries("s1", entries);
  assert.equal(state.messages.length, 2, "只有一条人发消息 + 一条 agent 消息（插件消息被过滤）");
  const [user, agent] = state.messages;
  assert.equal(user.role, "user");
  assert.equal(user.text, "看一下项目");
  assert.equal(user.pending, false);
  assert.equal(agent.role, "agent");
  assert.equal(agent.text, "好的，我看一下", "assistant/message 的全文是权威值");
  assert.equal(agent.thinking, "先看目录");
  assert.equal(agent.status, "done");
  assert.equal(agent.tools.length, 1);
  assert.equal(agent.tools[0].name, "pwsh");
  assert.equal(agent.tools[0].output, "a.txt\nb.txt");
  assert.equal(state.meta.title, "看一下项目");
  assert.equal(state.meta.running, false);
});

test("dsh reducer: 实时增量 + 工具图片 + 失败回合", () => {
  const state = createSessionState("s2");
  const patches = [];
  const feed = (ev) => patches.push(...applyEvent(state, ev));
  feed({ type: "turn/start", seq: 1, time: 1, data: { turn: 3 } });
  feed({ type: "user/message", seq: 2, time: 2, data: { id: "u9", role: "user", content: [{ type: "text", text: "画一张图" }], source: { kind: "user" } } });
  feed({ type: "assistant/chunk", seq: 3, time: 3, data: { turn: 3, step: 1, chunk: { type: "text-delta", text: "正在" } } });
  feed({ type: "assistant/chunk", seq: 4, time: 4, data: { turn: 3, step: 1, chunk: { type: "text-delta", text: "生成" } } });
  feed({
    type: "tool/result", seq: 5, time: 5, data: {
      turn: 3, step: 1,
      message: {
        source: { kind: "tool", callId: "t9" },
        content: [{ type: "tool-result", toolCallId: "t9", content: [{ type: "text", text: "done" }, { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png", bytes: 1234 } }] }],
      },
    },
  });
  feed({ type: "assistant/message", seq: 6, time: 6, data: { turn: 3, step: 1, message: { role: "assistant", content: [{ type: "text", text: "正在生成" }] } } });
  feed({ type: "turn/end", seq: 7, time: 7, data: { turn: 3, reason: { kind: "error", error: { message: "连接失败" } } } });

  assert.equal(state.meta.turn, 3);
  const kinds = patches.map((p) => p.t);
  assert.ok(kinds.includes("delta"));
  const agent = state.messages.find((m) => m.role === "agent");
  assert.equal(agent.text, "正在生成");
  assert.equal(agent.status, "error");
  assert.equal(agent.error, "连接失败");
  const tool = agent.tools.find((t) => t.callId === "t9");
  assert.ok(tool, "工具结果落在同一 step 的消息上");
  assert.equal(tool.output, "done");
  assert.equal(tool.images.length, 1);
  assert.equal(tool.images[0].attachmentId, "att-1");
  assert.equal(tool.images[0].mimeType, "image/png");
});

test("dsh reducer: seq 去重（同一条事件重复到达只应用一次）", () => {
  const state = createSessionState("s3");
  const ev = { type: "user/message", seq: 5, time: 10, data: { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } };
  applyEvent(state, ev);
  applyEvent(state, ev);
  applyEvent(state, { ...ev, data: { ...ev.data, id: "u1" } });
  assert.equal(state.messages.length, 1);
});

function fakeDsh() {
  const calls = [];
  const socketClients = new Set();
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
      calls.push({ method: body.method, payload: body.payload });
      const reply = (value) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } }));
      };
      if (body.method === "session.list") {
        return reply({ items: [{ sessionId: "sess-a", updatedAt: 200, running: false, blank: false, cwd: "D:/ws", projections: { asOfSeq: 3, values: { title: "会话 A" } } }] });
      }
      if (body.method === "session.history") {
        return reply({
          hasMore: false,
          projections: { asOfSeq: 3, values: { title: "会话 A" } },
          events: [
            { event: { type: "user/message", seq: 1, time: 100, data: { id: "u1", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } } } },
            { event: { type: "assistant/message", seq: 2, time: 200, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "你好呀" }] } } } },
            { event: { type: "turn/end", seq: 3, time: 300, data: { turn: 1, reason: { kind: "completed" } } } },
          ],
        });
      }
      if (body.method === "session.prompt") return reply({ accepted: true });
      if (body.method === "session.cancel") return reply({ accepted: true });
      if (body.method === "session.attachment") return reply({ attachment: { mediaType: "image/png" }, data: "AAAA" });
      return reply({});
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  const rawSockets = new Set();
  httpServer.on("upgrade", (req, socket, head) => {
    rawSockets.add(socket);
    socket.on("close", () => rawSockets.delete(socket));
    wss.handleUpgrade(req, socket, head, (ws) => {
      socketClients.add(ws);
      ws.send(JSON.stringify({ type: "server-request", rpcId: "f1", method: "session/subscribed", payload: { type: "session/subscribed", sessionId: "sess-a", lastSeq: 0 } }));
      ws.on("close", () => socketClients.delete(ws));
    });
  });
  return { httpServer, calls, socketClients, wss, rawSockets };
}

test("DshSource: 列表 / 打开 / 发送 / 附件 / 实时事件补丁", async () => {
  const fake = fakeDsh();
  await new Promise((resolve) => fake.httpServer.listen(0, "127.0.0.1", resolve));
  const port = fake.httpServer.address().port;
  const patches = [];
  const sessionsUpdates = [];
  const source = new DshSource({
    baseUrl: `http://127.0.0.1:${port}`,
    log: () => {},
    onPatch: (id, list) => patches.push({ id, list }),
    onSessions: (list) => sessionsUpdates.push(list),
  });
  try {
    source.start();
    const list = await source.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].agent, "dsh");
    assert.equal(list[0].title, "会话 A");

    const opened = await source.open("sess-a");
    assert.equal(opened.messages.length, 2);
    assert.equal(opened.messages[1].text, "你好呀");
    assert.equal(opened.session.agent, "dsh");

    const sent = await source.send("sess-a", "继续");
    assert.equal(sent.ok, true);
    const promptCall = fake.calls.find((c) => c.method === "session.prompt");
    assert.deepEqual(promptCall.payload.content, [{ type: "text", text: "继续" }]);

    const sentImg = await source.send("sess-a", "看图", [{ mimeType: "image/png", data: "QUJD" }]);
    assert.equal(sentImg.ok, true);
    const imgCall = fake.calls.filter((c) => c.method === "session.prompt").pop();
    assert.equal(imgCall.payload.content.length, 2);
    assert.deepEqual(imgCall.payload.content[1], { type: "image", mediaType: "image/png", data: "QUJD" });

    const att = await source.attachment("sess-a", "att-1");
    assert.deepEqual(att, { mimeType: "image/png", data: "AAAA" });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const ws = [...fake.socketClients][0];
    assert.ok(ws, "DshSource 应连上事件流");
    ws.send(JSON.stringify({
      type: "server-request", rpcId: "f2", method: "session/event",
      payload: {
        type: "session/event", sessionId: "sess-a",
        event: { type: "assistant/chunk", seq: 99, time: 500, data: { turn: 2, step: 1, chunk: { type: "text-delta", text: "追加" } } },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const deltas = patches.flatMap((p) => p.list).filter((p) => p.t === "delta");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, "追加");
  } finally {
    source.stop();
    for (const ws of fake.wss.clients) ws.terminate();
    for (const socket of fake.rawSockets) socket.destroy();
    fake.wss.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    fake.httpServer.closeAllConnections();
    fake.httpServer.close();
  }
});
