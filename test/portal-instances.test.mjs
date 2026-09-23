import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  INSTANCE_IDS,
  INSTANCE_GROUPS,
  readInstalled,
  writeInstalled,
  readResident,
  writeResident,
} = require("../packages/portal/instances.cjs");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcca-instances-"));
  return path.join(dir, "portal-instances.json");
}

test("a missing file keeps every instance installed", () => {
  assert.deepEqual(readInstalled(tempFile()), INSTANCE_IDS);
});

test("an empty list stays empty and unknown ids are dropped", () => {
  const file = tempFile();
  writeInstalled(file, []);
  assert.deepEqual(readInstalled(file), []);
  writeInstalled(file, ["canvas", "nope", "canvas", "mobile"]);
  assert.deepEqual(readInstalled(file), ["canvas", "mobile"]);
  writeInstalled(file, ["codex-web", "pi-web", "codex-cli"]);
  assert.deepEqual(readInstalled(file), ["codex-cli", "pi-web"]);
});

test("corrupt json falls back to the full set", () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{");
  assert.deepEqual(readInstalled(file), INSTANCE_IDS);
});

test("ides and extensions stay in their groups", () => {
  assert.deepEqual(
    INSTANCE_IDS.filter((id) => INSTANCE_GROUPS[id] === "ide"),
    ["dsh", "pi-web"],
  );
  assert.deepEqual(
    INSTANCE_IDS.filter((id) => INSTANCE_GROUPS[id] === "extension"),
    ["canvas", "mobile"],
  );
  assert.deepEqual(
    INSTANCE_IDS.filter((id) => INSTANCE_GROUPS[id] === "cli"),
    ["codex-cli", "openhands-web", "grok-web", "hermes-web"],
  );
});

test("resident defaults to empty and drops unknown ids", () => {
  const file = tempFile();
  assert.deepEqual(readResident(file), []);
  assert.deepEqual(writeResident(file, ["mobile", "nope", "mobile", "codex-web"]), ["mobile", "codex-cli"]);
  assert.deepEqual(readResident(file), ["mobile", "codex-cli"]);
});

test("installed and resident share one file without clobbering each other", () => {
  const file = tempFile();
  writeResident(file, ["mobile"]);
  writeInstalled(file, ["mobile", "pi-web"]);
  assert.deepEqual(readResident(file), ["mobile"]);
  assert.deepEqual(readInstalled(file), ["mobile", "pi-web"]);
  writeResident(file, []);
  assert.deepEqual(readResident(file), []);
  assert.deepEqual(readInstalled(file), ["mobile", "pi-web"]);
});
