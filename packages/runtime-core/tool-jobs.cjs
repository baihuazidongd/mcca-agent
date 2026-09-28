"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writeJson } = require("./paths.cjs");
function createToolJobs({ paths, launch = require("./tool-process.cjs").launchOwnedPty }) {
  const file = path.join(paths.state, "tool-jobs.json"), live = new Map();
  const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).jobs || [] : [];
  for (const row of rows) if (["running", "starting", "stopping"].includes(row.state)) { row.state = "interrupted"; row.detail = "门户已重启；请检查输出文件，旧 PID 不会被复用或误停止"; }
  const save = () => writeJson(file, { schemaVersion: 1, jobs: rows.slice(-200) });
  async function start({ kind, serial, file: executable, args, cwd, env = {}, output, durationMs = 3600000 }) {
    const active=rows.filter(r=>["starting","running","stopping"].includes(r.state));
    if (active.length >= 8) throw new Error("最多同时运行八个工具任务");
    if (serial && active.some(r => r.kind === kind && r.serial === serial)) throw new Error("此设备已经有同类工具会话");
    const row = { id: randomUUID(), kind, serial, output, state: "starting", at: Date.now(), log: "" };
    rows.push(row); save();
    let terminal;
    try { terminal = await launch(executable, args, { name: "xterm-color", cols: 120, rows: 35, cwd: cwd || path.dirname(executable), env: { ...process.env, ...env }, useConpty: true }); }
    catch (error) { row.state = "failed"; row.detail = error.message; save(); throw error; }
    row.pid = terminal.pid; row.state = "running"; save();
    let resolve; const ended = new Promise(r => { resolve = r; });
    const job = { row, terminal, ended, timer: null }; live.set(row.id, job);
    terminal.onData(data => { row.log = (row.log + data).slice(-30000); });
    terminal.onExit(event => {
      clearTimeout(job.timer); live.delete(row.id);
      row.state = row.state === "stopping" ? "stopped" : event.exitCode === 0 ? "finished" : "failed";
      if (row.kind === "apk" && row.state === "failed" && fs.existsSync(path.join(row.output,"sources")) && fs.existsSync(path.join(row.output,"resources","AndroidManifest.xml"))) { row.state = "partial"; row.detail = "已导出源码和资源，但部分代码反编译失败，请查看日志"; }
      row.exitCode = event.exitCode; row.endedAt = Date.now(); save();
      resolve();
    });
    job.timer = setTimeout(() => void stop(row.id).catch(() => {}), durationMs); job.timer.unref();
    return { ...row };
  }
  async function stop(id) {
    const job = live.get(id); if (!job) { const row = rows.find(r => r.id === id); if (!row) throw new Error("工具会话不存在"); return { ...row }; }
    job.row.state = "stopping"; save(); job.terminal.write("");
    const timer = setTimeout(() => { try { job.terminal.kill(); } catch {} }, 4000);
    await job.ended; clearTimeout(timer); return { ...job.row };
  }
  const cleanup = () => { for (const job of live.values()) { try { job.terminal.kill(); } catch {} } };
  process.once("exit", cleanup);
  return { start, stop, list: () => rows.slice(-200).map(r => ({ ...r })).reverse(), async dispose() { await Promise.allSettled([...live.keys()].map(stop)); process.removeListener("exit", cleanup); } };
}
module.exports = { createToolJobs };
