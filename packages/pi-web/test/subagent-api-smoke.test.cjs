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

function request(url, { method = "GET", json } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: { "content-type": "application/json" },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    if (json) req.write(JSON.stringify(json));
    req.end();
  });
}

test("API and UI smoke on an isolated port", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-smoke-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.cjs")], {
    cwd: path.join(__dirname, "..", "..", ".."),
    env: {
      ...process.env,
      PI_WEB_PORT: "3468",
      PI_PORT: "3468",
      PDB_PI_WEB_SESSIONS: path.join(tmp, "sessions"),
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
  const list = await get(base + "/api/subagents");
  assert.equal(list.status, 200);
  const agents = JSON.parse(list.body).agents;
  assert.ok(agents.some((agent) => agent.name === "worker"));
  const unknown = await request(base + "/api/subagents", { method: "PUT", json: { action: "create", name: "x", bogus: 1 } });
  assert.equal(unknown.status, 400);
  const missing = await get(base + "/api/sessions/does-not-exist/subagents");
  assert.equal(missing.status, 404);
  const page = await get(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /id="agent-dock"/);
  assert.match(page.body, /id="agents-dlg"/);
  assert.match(page.body, /data-action="agents"/); // 设置菜单收拢后的子代理管理入口
  const js = await get(base + "/app.js");
  assert.match(js.body, /子代理管理/);
  assert.match(js.body, /工作中/);
});

