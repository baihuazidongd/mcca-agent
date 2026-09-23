"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DIARY_MAX = 500;
const TEXT_MAX = 8000;

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const text = String(raw.text || "").replace(/\u0000/g, "").trim();
  const at = Number(raw.at);
  if (!/^[\w-]{6,80}$/.test(id)) return null;
  if (!text || text.length > TEXT_MAX) return null;
  if (!Number.isFinite(at)) return null;
  return { id, at, text };
}

function readDiary(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.entries;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeEntry).filter(Boolean).slice(0, DIARY_MAX);
  } catch {
    return [];
  }
}

function writeDiary(file, entries) {
  const next = entries.map(normalizeEntry).filter(Boolean).slice(0, DIARY_MAX);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ entries: next }, null, 2) + "\n");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
  return next;
}

function createEntry(text, at) {
  const clean = String(text || "").replace(/\u0000/g, "").trim();
  if (!clean) return { ok: false, error: "写点什么再记" };
  if (clean.length > TEXT_MAX) return { ok: false, error: "一篇最多 8000 字" };
  const now = Date.now();
  let when = Number(at);
  if (!Number.isFinite(when) || when < 1_500_000_000_000 || when > now + 60_000) when = now;
  const id = `${when.toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  return { ok: true, entry: { id, at: when, text: clean } };
}

module.exports = {
  DIARY_MAX,
  TEXT_MAX,
  normalizeEntry,
  readDiary,
  writeDiary,
  createEntry,
};
