"use strict";
const path = require("node:path");
const { spawn } = require("node:child_process");
function createFridaService({ paths } = {}) {
  let child, pending = new Map(), sequence = 0, buffer = "", stderr = "";
  function fail(error) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); }
  function start() {
    if (child) return child;
    const python = process.env.MCCA_FRIDA_PYTHON || (paths && require("./settings.cjs").readSettings(paths).fridaPython) || "python";
    const proc = spawn(python, ["-u", path.join(__dirname, "frida-worker.py")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child = proc; buffer = ""; stderr = "";
    proc.stdin.on("error", error => fail(error));
    proc.stderr.on("data", b => { stderr = (stderr + String(b)).slice(-3000); });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { fail(new Error("Frida response too large")); proc.kill(); return; }
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const p = pending.get(msg.id); if (!p) continue; pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
      }
    });
    proc.on("error", error => { fail(new Error(`Frida Python 未就绪：${error.message}。可设置 MCCA_FRIDA_PYTHON。`)); });
    proc.on("close", () => { if (child === proc) { child = null; fail(new Error(`Frida helper 已退出：${stderr || "请安装匹配版本的 frida Python 包和设备 frida-server"}`)); } });
    return proc;
  }
  return {
    call(args) {
      const proc = start(), id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Frida operation timed out; inspect sessions before retrying")); }, 30000);
        pending.set(id, { resolve, reject, timer }); proc.stdin.write(JSON.stringify({ id, arguments: args }) + "\n");
      });
    },
    dispose() { fail(new Error("Workbench closing")); child?.stdin.end(); },
  };
}
module.exports = { createFridaService };
