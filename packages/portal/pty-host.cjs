"use strict";

const crypto = require("node:crypto");
const pty = require("node-pty");

const LOG_CAP = 2 * 1024 * 1024;

function createPtyHost({ cwd, commandOf }) {
  const sessions = new Map();

  function open(agent, workspace, resume) {
    const spec = commandOf(agent, resume);
    if (!spec) return { ok: false, error: "不是命令行" };
    if (spec.error) return { ok: false, error: spec.error };
    if (!spec.file) return { ok: false, error: `找不到 ${spec.title} 的命令` };
    if (sessions.size >= 8) return { ok: false, error: "终端开得太多了" };
    const dir = workspace || cwd;
    let term;
    try {
      term = pty.spawn(spec.file, spec.args, {
        name: "xterm-256color",
        cols: 120,
        rows: 32,
        cwd: dir,
        env: { ...process.env, ...(spec.env || {}) },
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const id = crypto.randomBytes(8).toString("hex");
    const rec = {
      id,
      agent,
      title: spec.title,
      cwd: dir,
      term,
      seq: 0,
      log: [],
      size: 0,
      listeners: new Set(),
      exited: null,
    };
    term.onData((data) => push(rec, data));
    term.onExit(({ exitCode }) => {
      rec.exited = exitCode ?? 0;
      for (const fn of rec.listeners) fn(null);
    });
    sessions.set(id, rec);
    return { ok: true, cli: true, ptyId: id, title: spec.title, cwd: dir };
  }

  function push(rec, data) {
    const item = { seq: rec.seq + 1, data };
    rec.seq = item.seq;
    rec.log.push(item);
    rec.size += data.length;
    while (rec.size > LOG_CAP && rec.log.length > 1) rec.size -= rec.log.shift().data.length;
    for (const fn of rec.listeners) fn(item);
  }

  function get(id) {
    return sessions.get(id) || null;
  }

  function write(id, data) {
    const rec = sessions.get(id);
    if (!rec || rec.exited != null) return { ok: false, error: "终端已退出" };
    rec.term.write(String(data ?? ""));
    return { ok: true };
  }

  function resize(id, cols, rows) {
    const rec = sessions.get(id);
    if (!rec || rec.exited != null) return { ok: false, error: "终端已退出" };
    const nextCols = Math.max(2, Math.min(500, Number(cols) || 80));
    const nextRows = Math.max(2, Math.min(200, Number(rows) || 24));
    rec.term.resize(nextCols, nextRows);
    return { ok: true };
  }

  function close(id) {
    const rec = sessions.get(id);
    if (!rec) return { ok: true, gone: true };
    if (rec.exited == null) {
      try { rec.term.kill(); } catch { /* already gone */ }
    }
    sessions.delete(id);
    return { ok: true };
  }

  function closeAll() {
    for (const id of [...sessions.keys()]) close(id);
  }

  function diary(agent) {
    const rows = [];
    for (const rec of sessions.values()) {
      if (rec.agent !== agent) continue;
      const state = rec.exited == null ? "运行中" : `已退出 ${rec.exited}`;
      rows.push(`[${rec.title}] ${state} · ${rec.cwd || ""}`);
      const text = rec.log.map((item) => item.data).join("");
      const lines = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      rows.push(...lines.slice(-12));
    }
    return rows.slice(-40);
  }

  function list(agent) {
    const rows = [];
    for (const rec of sessions.values()) {
      if (agent && rec.agent !== agent) continue;
      rows.push({
        id: rec.id,
        agent: rec.agent,
        title: rec.title,
        cwd: rec.cwd || "",
        exited: rec.exited,
      });
    }
    return rows;
  }

  function closeAgent(agent) {
    for (const [id, rec] of [...sessions]) {
      if (rec.agent === agent) close(id);
    }
  }

  function stream(req, res, id) {
    const rec = sessions.get(id);
    if (!rec) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("没有这个终端");
      return;
    }
    const since = Number(req.headers["last-event-id"] || 0);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    let last = Number.isFinite(since) ? since : 0;
    const send = (item) => {
      if (!item) {
        res.write("event: exit\ndata: {}\n\n");
        return;
      }
      if (item.seq <= last) return;
      last = item.seq;
      res.write(`id: ${item.seq}\ndata: ${JSON.stringify(item.data)}\n\n`);
    };
    rec.listeners.add(send);
    for (const item of rec.log) send(item);
    if (rec.exited != null) send(null);
    req.on("close", () => rec.listeners.delete(send));
  }

  return { open, get, list, diary, write, resize, close, closeAll, closeAgent, stream };
}

module.exports = { createPtyHost };
