import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createHermes } = require("../packages/portal/hermes.cjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcca-hermes-"));
}

test("the bundled launcher is preferred over a command shim", () => {
  const root = tempRoot();
  const hermes = createHermes({ root });
  fs.mkdirSync(path.join(hermes.home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(hermes.home, "bin", "hermes.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(hermes.home, "bin", "hermes.exe"), "");
  const found = hermes.launcher();
  assert.equal(found.file, path.join(hermes.home, "bin", "hermes.exe"));
  assert.deepEqual(found.args, []);
  assert.equal(hermes.installed(), true);
});

test("a command shim is used when the installer could not copy the exe", () => {
  const root = tempRoot();
  const hermes = createHermes({ root });
  fs.mkdirSync(path.join(hermes.home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(hermes.home, "bin", "hermes.cmd"), "@echo off\r\n");
  const found = hermes.launcher();
  assert.equal(found.file, process.env.ComSpec || "cmd.exe");
  assert.deepEqual(found.args, ["/d", "/c", path.join(hermes.home, "bin", "hermes.cmd")]);
});

test("the workspace is a folder inside the app and is created on demand", () => {
  const root = tempRoot();
  const hermes = createHermes({ root });
  assert.equal(hermes.workspace, path.join(root, "workspace", "hermes"));
  assert.equal(fs.existsSync(hermes.workspace), false);
  assert.equal(hermes.ensureWorkspace(), hermes.workspace);
  assert.equal(fs.statSync(hermes.workspace).isDirectory(), true);
});

test("an empty directory is not installed and remembers a version", () => {
  const root = tempRoot();
  const hermes = createHermes({ root });
  assert.equal(hermes.launcher(), null);
  assert.equal(hermes.installed(), false);
  hermes.writeVersion("2026.9.21");
  assert.equal(hermes.readVersion(), "2026.9.21");
});
