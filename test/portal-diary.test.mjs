import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEntry, readDiary, writeDiary } = require("../packages/portal/diary.cjs");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcca-diary-"));
  return path.join(dir, "portal-diary.json");
}

test("a missing diary file is an empty journal", () => {
  assert.deepEqual(readDiary(tempFile()), []);
});

test("blank text is refused and a real entry round-trips", () => {
  assert.equal(createEntry("   ").ok, false);
  const made = createEntry("  今天把画布接上了\n晚些再看手机  ", 1_700_000_000_000);
  assert.equal(made.ok, true);
  assert.equal(made.entry.text, "今天把画布接上了\n晚些再看手机");
  assert.equal(made.entry.at, 1_700_000_000_000);
  const file = tempFile();
  writeDiary(file, [made.entry, { id: "no", text: "", at: 1 }]);
  assert.deepEqual(readDiary(file), [made.entry]);
});

test("corrupt json does not throw away the page", () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{");
  assert.deepEqual(readDiary(file), []);
});
