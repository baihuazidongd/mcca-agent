import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requireRelay = createRequire(path.join(root, "packages", "mobile-relay", "package.json"));
const WebSocket = requireRelay("ws");

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function nextMessage(ws, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("message timeout"));
    }, timeoutMs);
    function onMessage(data) {
      const parsed = JSON.parse(String(data));
      if (!predicate(parsed)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(parsed);
    }
    ws.on("message", onMessage);
  });
}

test("relay: 桌面/App 双端配对，请求 id 往返映射与事件广播", async () => {
  const port = await freePort();
  const configFile = path.join(os.tmpdir(), `mcca-relay-test-${Date.now()}.json`);
  fs.writeFileSync(configFile, JSON.stringify({ token: "test-token" }));
  const child = spawn(process.execPath, [path.join(root, "packages", "mobile-relay", "server.cjs")], {
    env: { ...process.env, RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1", RELAY_CONFIG: configFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cleanup = () => {
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(configFile, { force: true }); } catch { /* ignore */ }
  };
  try {
    // 等监听就绪
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const tick = () => {
        const probe = net.connect(port, "127.0.0.1");
        probe.once("connect", () => { probe.destroy(); resolve(); });
        probe.once("error", () => {
          probe.destroy();
          if (Date.now() > deadline) reject(new Error("relay did not start"));
          else setTimeout(tick, 150);
        });
      };
      tick();
    });

    const desktop = new WebSocket(`ws://127.0.0.1:${port}/desktop?token=test-token`);
    await waitOpen(desktop);
    desktop.send(JSON.stringify({ t: "hello", d: { name: "test-desktop" } }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const app = new WebSocket(`ws://127.0.0.1:${port}/app?token=test-token`);
    await waitOpen(app);

    // 应用 → 桌面：relay 换号转发（gN），并把桌面回包按原 id 送回该 App
    const desktopReq = nextMessage(desktop, (m) => m.t === "req");
    app.send(JSON.stringify({ t: "req", id: "app-1", m: "hello", p: { a: 1 } }));
    const forwarded = await desktopReq;
    assert.equal(forwarded.t, "req");
    assert.equal(forwarded.m, "hello");
    assert.deepEqual(forwarded.p, { a: 1 });
    assert.match(String(forwarded.id), /^g\d+$/);
    assert.equal(forwarded.id, "g1", "第一笔请求编号从 g1 起");

    const appRes = nextMessage(app, (m) => m.t === "res" && m.id === "app-1");
    desktop.send(JSON.stringify({ t: "res", id: forwarded.id, ok: true, d: { ok: 42 } }));
    const routed = await appRes;
    assert.equal(routed.t, "res");
    assert.equal(routed.id, "app-1", "回包 id 必须是 App 发出去的那个");
    assert.deepEqual(routed.d, { ok: 42 });

    // 第二笔：编号递增且互不串号
    const desktopReq2 = nextMessage(desktop, (m) => m.t === "req");
    app.send(JSON.stringify({ t: "req", id: "app-2", m: "sessions.list" }));
    const forwarded2 = await desktopReq2;
    assert.equal(forwarded2.id, "g2");
    const appRes2 = nextMessage(app, (m) => m.t === "res" && m.id === "app-2");
    desktop.send(JSON.stringify({ t: "res", id: "g1", ok: false, e: "迟到的旧回包" }));
    desktop.send(JSON.stringify({ t: "res", id: "g2", ok: true, d: { n: 2 } }));
    const routed2 = await appRes2;
    assert.equal(routed2.id, "app-2");
    assert.deepEqual(routed2.d, { n: 2 });

    // 桌面事件广播给 App
    const evt = nextMessage(app, (m) => m.t === "evt" && m.m === "notify");
    desktop.send(JSON.stringify({ t: "evt", m: "notify", d: { item: { title: "完成" } } }));
    const event = await evt;
    assert.equal(event.m, "notify");
    assert.equal(event.d.item.title, "完成");

    // 桌面离线时 App 请求得到明确错误
    desktop.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const offline = nextMessage(app, (m) => m.t === "res" && m.id === "app-3");
    app.send(JSON.stringify({ t: "req", id: "app-3", m: "hello" }));
    const offlineRes = await offline;
    assert.equal(offlineRes.id, "app-3");
    assert.equal(offlineRes.ok, false);
    assert.match(offlineRes.e, /桌面端未连接/);
    app.close();
  } finally {
    cleanup();
  }
});
