"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const LIMIT = 80;

function clip(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function workspaceName(cwd) {
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "";
}

function decodeGrokCwd(name) {
  if (!name || name.startsWith(".")) return "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function grokBase() {
  const root = process.env.GROK_HOME || path.join(os.homedir(), ".grok", "sessions");
  return root.endsWith(`${path.sep}sessions`) ? root : path.join(root, "sessions");
}

function insideDir(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function listGrok() {
  const base = grokBase();
  if (!fs.existsSync(base)) return [];
  const rows = [];
  let groups;
  try { groups = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(base, group.name);
    let cwd = decodeGrokCwd(group.name);
    const cwdFile = path.join(groupDir, ".cwd");
    if (fs.existsSync(cwdFile)) {
      try { cwd = fs.readFileSync(cwdFile, "utf8").trim() || cwd; } catch { /* keep decoded name */ }
    }
    let sessions;
    try { sessions = fs.readdirSync(groupDir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const summaryPath = path.join(groupDir, session.name, "summary.json");
      let summary;
      try { summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")); } catch { continue; }
      const info = summary.info || {};
      const updated = Date.parse(summary.updated_at || summary.last_active_at || summary.created_at || "") || 0;
      rows.push({
        id: String(info.id || session.name),
        title: clip(summary.generated_title || summary.session_summary || info.id || session.name, 80),
        cwd: info.cwd || cwd,
        workspace: workspaceName(info.cwd || cwd),
        updatedAt: updated,
      });
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, LIMIT);
}

function readMetaHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const id = (text.match(/"conversation_id"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const cwd = (text.match(/"working_dir"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
    const title = (text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
    const first = (text.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
    return {
      id,
      cwd: cwd.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      title: (title || first).replace(/\\n/g, " ").replace(/\\"/g, '"'),
    };
  } catch {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function listOpenhands() {
  const roots = [
    process.env.OPENHANDS_HOME,
    path.join(os.homedir(), ".openhands"),
  ].filter(Boolean);
  const seen = new Set();
  const rows = [];
  function walk(dir, depth) {
    if (depth > 4 || rows.length > 400) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const meta = path.join(full, "meta.json");
      if (fs.existsSync(meta)) {
        const head = readMetaHead(meta);
        if (!head) continue;
        const id = String(head.id || entry.name);
        if (seen.has(id)) continue;
        seen.add(id);
        let updatedAt = 0;
        try { updatedAt = fs.statSync(meta).mtimeMs; } catch { /* leave 0 */ }
        rows.push({
          id,
          title: clip(head.title || id, 80),
          cwd: head.cwd,
          workspace: workspaceName(head.cwd),
          updatedAt,
        });
        continue;
      }
      walk(full, depth + 1);
    }
  }
  for (const root of roots) walk(root, 0);
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, LIMIT);
}

function hermesDbPath(home) {
  const explicit = process.env.HERMES_STATE_DB;
  if (explicit) return explicit;
  const candidates = [
    path.join(home, "state.db"),
    path.join(process.env.LOCALAPPDATA || "", "hermes", "state.db"),
    path.join(os.homedir(), ".hermes", "state.db"),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || "";
}

function listHermes(home) {
  const file = hermesDbPath(home);
  if (!file) return [];
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const cols = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((col) => col.name));
    const title = cols.has("title") ? "title" : "NULL AS title";
    const cwd = cols.has("cwd") ? "cwd" : "NULL AS cwd";
    const started = cols.has("started_at") ? "started_at" : "0 AS started_at";
    const archived = cols.has("archived") ? "AND COALESCE(archived, 0) = 0" : "";
    const source = cols.has("source") ? "AND (source IS NULL OR source = 'cli')" : "";
    const parent = cols.has("parent_session_id") ? "AND parent_session_id IS NULL" : "";
    const rows = db.prepare(
      `SELECT id, ${title}, ${cwd}, ${started} FROM sessions WHERE 1=1 ${archived} ${source} ${parent} ORDER BY started_at DESC LIMIT ${LIMIT}`,
    ).all();
    return rows.map((row) => ({
      id: String(row.id),
      title: clip(row.title || row.id, 80),
      cwd: row.cwd || "",
      workspace: workspaceName(row.cwd || ""),
      updatedAt: Number(row.started_at) ? Math.round(Number(row.started_at) * 1000) : 0,
    }));
  } catch {
    return [];
  } finally {
    if (db) try { db.close(); } catch { /* already closed */ }
  }
}

function removeTree(root, target) {
  if (!insideDir(root, target) || path.resolve(root) === path.resolve(target)) {
    return { ok: false, error: "不能删这个位置" };
  }
  fs.rmSync(target, { recursive: true, force: true });
  return { ok: true };
}

function deleteGrok(id) {
  const base = grokBase();
  if (!fs.existsSync(base)) return { ok: false, error: "没有这条对话" };
  let hit = "";
  let groups;
  try { groups = fs.readdirSync(base, { withFileTypes: true }); } catch { return { ok: false, error: "没有这条对话" }; }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const dir = path.join(base, group.name, id);
    if (fs.existsSync(path.join(dir, "summary.json"))) { hit = dir; break; }
  }
  if (!hit) return { ok: false, error: "没有这条对话" };
  return removeTree(base, hit);
}

function openhandsRoots() {
  return [process.env.OPENHANDS_HOME, path.join(os.homedir(), ".openhands")].filter(Boolean);
}

function findOpenhandsDir(id) {
  const bare = id.replace(/-/g, "");
  let hit = "";
  function walk(dir, depth) {
    if (hit || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hit || !entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, "meta.json")) && (entry.name === id || entry.name === bare)) {
        hit = full;
        return;
      }
      walk(full, depth + 1);
    }
  }
  for (const root of openhandsRoots()) walk(root, 0);
  return hit;
}

function deleteOpenhands(id) {
  const hit = findOpenhandsDir(id);
  if (!hit) return { ok: false, error: "没有这条对话" };
  const root = openhandsRoots().find((dir) => insideDir(dir, hit));
  if (!root) return { ok: false, error: "不能删这个位置" };
  return removeTree(root, hit);
}

function deleteHermes(home, id) {
  const file = hermesDbPath(home);
  if (!file) return { ok: false, error: "没有这条对话" };
  let db;
  try {
    db = new DatabaseSync(file);
    const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);
    if (!row) return { ok: false, error: "没有这条对话" };
    const cols = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((col) => col.name));
    const child = cols.has("parent_session_id")
      ? "id = ? OR parent_session_id = ?"
      : "id = ?";
    const params = cols.has("parent_session_id") ? [id, id] : [id];
    db.exec("BEGIN");
    db.prepare(`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE ${child})`).run(...params);
    db.prepare(`DELETE FROM sessions WHERE ${child}`).run(...params);
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    if (db) try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
    return { ok: false, error: error.message || "删除失败" };
  } finally {
    if (db) try { db.close(); } catch { /* already closed */ }
  }
}

function listCliHistory(agent, { hermesHome } = {}) {
  if (agent === "grok-web") return listGrok();
  if (agent === "openhands-web") return listOpenhands();
  if (agent === "hermes-web") return listHermes(hermesHome);
  return [];
}

function deleteCliHistory(agent, id, { hermesHome } = {}) {
  if (agent === "grok-web") return deleteGrok(id);
  if (agent === "openhands-web") return deleteOpenhands(id);
  if (agent === "hermes-web") return deleteHermes(hermesHome, id);
  return { ok: false, error: "不是命令行" };
}

module.exports = { listCliHistory, deleteCliHistory, listGrok, listOpenhands, listHermes };
