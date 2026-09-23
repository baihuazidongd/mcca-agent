import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMemoryPrompt,
  forgetMemory,
  formatMemoryIndex,
  readMemory,
  searchMemory,
  writeMemory,
  INDEX_LINE_LIMIT,
} from "../packages/agent-ide/memory-store.mjs";
import { mapToScreen, parseKey, resetComputerState, runComputer, validateLaunch } from "../packages/agent-ide/computer.mjs";
import { assertWebUrl, browserStatus, compactTree, findBrowser } from "../packages/agent-ide/browser.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcca-memory-"));
}

test("feature memory and project memory stay in separate stores", () => {
  const root = tempRoot();
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const feature = writeMemory(root, {
    scope: "feature",
    type: "feature",
    title: "浏览器先看快照",
    body: "点击前先 browser_snapshot，不要猜选择器。",
  });
  const project = writeMemory(root, {
    scope: "project",
    cwd,
    type: "project",
    title: "运行时停在 Node 22",
    body: "这个仓库不升到下一档 Node。",
  });
  assert.match(feature.name, /^mem-/);
  assert.equal(project.name, "node-22");
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  assert.equal(searchMemory(root, { query: "Node 22", scope: "project", cwd: other }).length, 0);
  assert.equal(searchMemory(root, { query: "快照", scope: "feature", cwd: other }).length, 1);
  const prompt = buildMemoryPrompt(root, cwd);
  assert.match(prompt, /功能记忆/);
  assert.match(prompt, /项目记忆/);
  assert.match(prompt, new RegExp(cwd.replace(/\\/g, "\\\\")));
  const full = readMemory(root, { scope: "project", cwd, name: project.name });
  assert.match(full.body, /Node/);
  forgetMemory(root, { scope: "feature", name: feature.name });
  assert.equal(readMemory(root, { scope: "feature" }).index, "");
});

test("memory rejects secrets and an oversized index warns", () => {
  const root = tempRoot();
  assert.throws(
    () => writeMemory(root, { scope: "feature", type: "reference", title: "key", body: "api_key=sk-abcdefghijklmnopqrstuvwxyz" }),
    /密钥/,
  );
  const lines = Array.from({ length: INDEX_LINE_LIMIT + 1 }, (_, i) => `- [item ${i}](item-${i}.md) — hook`);
  const formatted = formatMemoryIndex(lines.join("\n"));
  assert.match(formatted, /超过上限/);
  assert.equal(formatted.split("\n").filter((line) => line.startsWith("- ")).length, INDEX_LINE_LIMIT);
});

test("click coordinates map from the screenshot back onto the screen", () => {
  resetComputerState();
  const frame = {
    screen: { x: 0, y: 0, width: 1920, height: 1080 },
    image: { width: 1280, height: 720 },
  };
  assert.deepEqual(mapToScreen(frame, 640, 360), { x: 960, y: 540, mapped: true });
  assert.deepEqual(mapToScreen(null, 12, 8), { x: 12, y: 8, mapped: false });
  assert.deepEqual(parseKey("ctrl+s"), { mods: [0x11], key: "S".charCodeAt(0) });
  assert.throws(() => validateLaunch("cmd /c calc"), /参数/);
  assert.equal(validateLaunch("notepad"), "notepad");
  assert.equal(validateLaunch("https://example.com"), "https://example.com");
});

test("browser snapshot keeps only a short list of named controls", () => {
  assert.equal(assertWebUrl("https://example.com/a"), "https://example.com/a");
  assert.throws(() => assertWebUrl("file:///C:/secret.html"), /http/);
  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Example" }, childIds: ["2", "3"] },
    { nodeId: "2", role: { value: "button" }, name: { value: "登录" }, backendDOMNodeId: 10, childIds: [] },
    { nodeId: "3", role: { value: "StaticText" }, name: { value: "一段不会进快照的长正文".repeat(20) }, backendDOMNodeId: 11, childIds: [] },
  ];
  const compact = compactTree(nodes);
  assert.match(compact.text, /e1 button "登录"/);
  assert.equal(compact.text.includes("长正文"), false);
  assert.equal(compact.refs.get("e1"), 10);
  const found = findBrowser();
  if (process.platform === "win32") assert.equal(typeof found, "string");
  assert.equal(browserStatus().open, false);
});

test("windows input struct compiles", async (t) => {
  if (process.platform !== "win32") return t.skip("computer control is Windows-only");
  const result = await runComputer({ op: "probe" });
  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.ok(result.inputSize === 28 || result.inputSize === 40);
});

