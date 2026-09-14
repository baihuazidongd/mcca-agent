"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("history hides child forks and dock transcript stays in the queue", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-queue-"));
  const sessions = path.join(tmp, "sessions");
  const cwd = path.join(__dirname, "..", "..", "..");
  const parentId = "01a07ad9-aaaa-7006-84b6-5b6742496634";
  const childId = "01a07ad9-bbbb-7006-84b6-5b6742496634";
  const parentFile = path.join(sessions, "2026-09-07T07-50-45-470Z_" + parentId + ".jsonl");
  const childFile = path.join(sessions, "2026-09-07T07-51-00-030Z_" + childId + ".jsonl");
  writeJsonl(parentFile, [
    { type: "session", version: 3, id: parentId, timestamp: "2026-09-07T07:50:45.470Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-07T07:50:46.000Z", message: { role: "user", content: [{ type: "text", text: "parent hello" }] } },
  ]);
  writeJsonl(childFile, [
    { type: "session", version: 3, id: childId, timestamp: "2026-09-07T07:51:00.030Z", cwd, parentSession: parentFile },
    { type: "session_info", id: "n1", parentId: null, timestamp: "2026-09-07T07:51:00.040Z", name: "subagent-worker-9fa93358-1" },
    { type: "message", id: "u2", parentId: "n1", timestamp: "2026-09-07T07:51:01.000Z", message: { role: "user", content: [{ type: "text", text: "You are a delegated subagent.\nTask:\nReply with only the word pong.\n\n## Acceptance Contract\nHuge injected blob" }] } },
    { type: "message", id: "a1", parentId: "u2", timestamp: "2026-09-07T07:51:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "pong" }] } },
  ]);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.cjs")], {
    cwd,
    env: {
      ...process.env,
      PI_WEB_PORT: "3469",
      PI_PORT: "3469",
      PDB_PI_WEB_SESSIONS: sessions,
      PDB_PI_WEB_SETTINGS: path.join(tmp, "settings.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 20000);
    const onData = (buf) => {
      const text = String(buf);
      const match = text.match(/http:\/\/[^\s:]+:(\d+)/) || text.match(/port\s+(\d+)/i);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
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
  const listed = JSON.parse((await get(base + "/api/sessions")).body);
  assert.equal(listed.sessions.some((item) => item.id === parentId), true);
  assert.equal(listed.sessions.some((item) => item.id === childId), false);
  assert.equal(listed.sessions.some((item) => /subagent-worker/i.test(item.title || "")), false);
  const queue = JSON.parse((await get(base + "/api/sessions/" + parentId + "/subagents")).body);
  assert.equal(queue.agents.some((agent) => agent.name === "worker" && agent.sessionId === childId), true);
  const transcript = JSON.parse((await get(base + "/api/sessions/" + parentId + "/subagents/" + childId + "/transcript")).body);
  assert.equal(transcript.events.some((event) => event.type === "user" && event.text.includes("pong")), true);
  assert.equal(transcript.events.some((event) => /Acceptance Contract/.test(event.text || "")), false);
  assert.equal(transcript.events.some((event) => event.type === "assistant-end" && event.text === "pong"), true);
  const page = await get(base + "/");
  assert.match(page.body, /id="agent-dock"/);
  const js = await get(base + "/app.js");
  assert.match(js.body, /function renderAgentDock/);
  assert.match(js.body, /openAgentRuns/);
});
