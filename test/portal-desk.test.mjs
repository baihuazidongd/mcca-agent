import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createDesk } = require("../packages/portal/desk.cjs");

const SIDES = [
  { agent: "pi", port: 3458 },
  { agent: "openhands", port: 3460 },
  { agent: "grok", port: 3461 },
];

function fakeGet(tables) {
  return async (port, pathname) => {
    const table = tables[port];
    if (!table) return null;
    if (pathname === "/api/sessions/running") return { sessions: table.running || [] };
    if (pathname === "/api/sessions") return { sessions: table.all || table.running || [] };
    return null;
  };
}

test("a running grok session is listed even when pi is down", async () => {
  const desk = createDesk();
  const snap = await desk.snapshot({
    sides: SIDES,
    recentEveryMs: 1e15,
    getJson: fakeGet({
      3461: { running: [{ id: "g1", title: "改事件板", cwd: "D:\\dshpi", running: true, updatedAt: 50 }] },
    }),
    terminals: [],
  });
  assert.deepEqual(snap.running.map((row) => row.agent + ":" + row.id), ["grok:g1"]);
  assert.deepEqual(snap.offline.sort(), ["openhands", "pi"]);
});

test("an idle session stays out of the running list and a live terminal counts", async () => {
  const desk = createDesk();
  const snap = await desk.snapshot({
    sides: SIDES,
    recentEveryMs: 0,
    getJson: fakeGet({
      3458: {
        running: [
          { id: "p1", title: "闲着", running: false, updatedAt: 10 },
          { id: "p2", title: "正在写", running: true, updatedAt: 20 },
        ],
        all: [
          { id: "p1", title: "闲着", running: false, updatedAt: 10 },
          { id: "p2", title: "正在写", running: true, updatedAt: 20 },
        ],
      },
      3460: { running: [], all: [] },
      3461: { running: [], all: [] },
    }),
    terminals: [
      { id: "t1", agent: "hermes-web", title: "Hermes Agent", cwd: "D:\\dshpi", exited: null },
      { id: "c1", agent: "codex-web", title: "Codex", cwd: "D:\\dshpi", exited: null },
    ],
  });
  assert.deepEqual(snap.running.map((row) => row.id).sort(), ["c1", "p2", "t1"]);
  assert.equal(snap.offline.length, 0);
  assert.equal(snap.recent.find((row) => row.id === "p1").title, "闲着");
});

test("a side that drops offline keeps its previous recent rows", async () => {
  const desk = createDesk();
  const first = {
    3458: { running: [], all: [{ id: "p1", title: "pi 旧会话", running: false, updatedAt: 5 }] },
    3461: { running: [], all: [{ id: "g1", title: "grok 旧会话", running: false, updatedAt: 9 }] },
  };
  await desk.snapshot({ sides: SIDES, recentEveryMs: 0, now: 1000, getJson: fakeGet(first), terminals: [] });
  const snap = await desk.snapshot({
    sides: SIDES,
    recentEveryMs: 0,
    now: 2000,
    getJson: fakeGet({
      3458: { running: [], all: [{ id: "p2", title: "pi 新会话", running: false, updatedAt: 30 }] },
    }),
    terminals: [],
  });
  assert.ok(snap.offline.includes("grok"));
  assert.equal(snap.recent.find((row) => row.id === "g1").title, "grok 旧会话");
  assert.equal(snap.recent.find((row) => row.id === "p2").title, "pi 新会话");
  assert.equal(snap.recent.find((row) => row.id === "p1"), undefined);
});
