"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function request(url, { method = "GET", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

/** 订阅 SSE，返回 {frames, close}；frames 被持续追加。 */
function subscribe(url) {
  const frames = [];
  let buf = "";
  const req = http.get(url, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let index;
      while ((index = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, index);
        buf = buf.slice(index + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data: "));
        if (line) frames.push(JSON.parse(line.slice(6)));
      }
    });
  });
  return { frames, close: () => req.destroy() };
}

test("edit resends as a new branch: reset replay + edited user message", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-edit-"));
  const sessions = path.join(tmp, "sessions");
  const cwd = path.join(__dirname, "..", "..", "..");
  const id = "01a07ad9-cccc-7006-84b6-5b6742496634";
  const file = path.join(sessions, "2026-09-07T08-00-00-000Z_" + id + ".jsonl");
  writeJsonl(file, [
    { type: "session", version: 3, id, timestamp: "2026-09-07T08:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-07T08:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first question" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-07T08:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-07T08:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "second question" }] } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-09-07T08:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } },
  ]);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.cjs")], {
    cwd,
    env: {
      ...process.env,
      PI_WEB_PORT: "3467",
      PI_PORT: "3467",
      MCCA_PI_WEB_SESSIONS: sessions,
      MCCA_PI_WEB_SETTINGS: path.join(tmp, "settings.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 30000);
    const onData = (buf) => {
      const match = String(buf).match(/http:\/\/[^\s:]+:(\d+)/) || String(buf).match(/port\s+(\d+)/i);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        // 继续抽空管道：子进程日志写满 stdout pipe 后会阻塞整个事件循环，SSE 帧再也发不出来
        child.stdout.resume();
        child.stderr.resume();
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code));
    });
  });
  const base = "http://127.0.0.1:" + port;

  const sse = subscribe(base + "/api/sessions/" + id + "/stream");
  t.after(() => sse.close());
  // 等首帧回放再动手：subscribe 会触发会话 attach，机器忙时 SDK 装载要几十秒，
  // 固定 sleep 会抢跑，后面就等不到 transcript-reset
  for (let i = 0; i < 120 && sse.frames.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(sse.frames.length > 0, "subscribe should replay the transcript");

  const edit = await request(base + "/api/sessions/" + id + "/edit", {
    method: "POST",
    body: JSON.stringify({ entryId: "u2", text: "second question EDITED" }),
  });
  assert.equal(edit.status, 200, "edit should succeed: " + edit.body);

  // 等 transcript-reset + user 事件（prompt 无模型会以错误收尾，也一并等待）。
  // 机器忙时子进程主线程会被 SDK 装载占住几十秒，固定 sleep 会抢跑。
  for (let i = 0; i < 120 && !sse.frames.some((f) => f.event && f.event.type === "transcript-reset"); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const types = sse.frames.map((f) => f.event.type);
  assert.equal(types.includes("transcript-reset"), true, "expected transcript-reset, got: " + types.join(","));
  const reset = sse.frames.find((f) => f.event.type === "transcript-reset").event;
  const resetTypes = (reset.events || []).map((e) => e.type);
  // 新分支回放：只包含编辑点之前的内容（user u1 → assistant a1），旧回复 a2/u2 收起
  assert.equal(JSON.stringify(resetTypes), JSON.stringify(["turn-start", "user", "assistant-end", "turn-end"]),
    "reset replay should be the pre-edit branch: " + JSON.stringify(reset.events));
  assert.equal(reset.events[1].id, "u1");
  // 重发的用户消息在 reset 之后
  const userIdx = types.lastIndexOf("user");
  assert.ok(userIdx > types.lastIndexOf("transcript-reset"), "resend user event should follow the reset");
  const resent = sse.frames[userIdx].event;
  assert.equal(resent.text, "second question EDITED");
  // 落盘后补推条目 id（同机忙时也要给足时间）
  for (let i = 0; i < 60 && !sse.frames.some((f) => f.event.type === "user-id"); i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const idFrames = sse.frames.filter((f) => f.event.type === "user-id");
  assert.equal(idFrames.length, 1, "expected one user-id frame, got: " + JSON.stringify(sse.frames.map((f) => f.event.type)));
  assert.ok(idFrames[0].event.id, "user-id carries entry id");
  assert.equal(idFrames[0].event.text, "second question EDITED");
});
