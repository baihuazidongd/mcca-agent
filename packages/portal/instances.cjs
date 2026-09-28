"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Managed services the portal can show, start, and drop from its list.
// Delete never removes the program on disk — only this membership.
const { registry } = require("../runtime-core/registry.cjs");
const INSTANCE_IDS = registry().all().map(row => row.id);
const INSTANCE_GROUPS = Object.fromEntries(registry().all().map(row => [row.id, row.group]));
function defaultInstalled() {
  return registry().all().filter(row => row.defaultInstalled).map(row => row.id);
}

// 老配置里 Codex 叫 codex-cli（那时它只有命令行，没有页面）。
function normalizeInstalled(value) {
  if (!Array.isArray(value)) return null;
  const known = new Set(registry().all().map(row => row.id));
  const out = [];
  for (const id of value) {
    const next = id === "codex-cli" ? "codex-web" : id;
    if (known.has(next) && !out.includes(next)) out.push(next);
  }
  return out;
}

function normalizeResident(value) {
  if (!Array.isArray(value)) return [];
  const known = new Set(registry().all().map(row => row.id));
  const out = [];
  for (const id of value) {
    const next = id === "codex-cli" ? "codex-web" : id;
    if (known.has(next) && !out.includes(next)) out.push(next);
  }
  return out;
}

// One file holds both lists, so a write from one editor cannot erase the other.
function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { installed: defaultInstalled(), resident: [] };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      installed: normalizeInstalled(parsed && parsed.installed) || defaultInstalled(),
      resident: normalizeResident(parsed && parsed.resident),
    };
  } catch {
    return { installed: defaultInstalled(), resident: [] };
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

function readInstalled(file) {
  return readState(file).installed;
}

function writeInstalled(file, installed) {
  const next = normalizeInstalled(installed);
  if (!next) throw new Error("invalid installed set");
  writeState(file, { installed: next, resident: readState(file).resident });
  return next;
}

function readResident(file) {
  return readState(file).resident;
}

function writeResident(file, resident) {
  const next = normalizeResident(resident);
  writeState(file, { installed: readState(file).installed, resident: next });
  return next;
}

module.exports = {
  INSTANCE_IDS,
  INSTANCE_GROUPS,
  defaultInstalled,
  normalizeInstalled,
  normalizeResident,
  readInstalled,
  writeInstalled,
  readResident,
  writeResident,
};
