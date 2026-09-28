"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { componentPath } = require("./components.cjs");
const { readSettings } = require("./settings.cjs");
function createDeviceTools({ paths, android, jobs }) {
  async function call(a) {
    if (a.action === "list") return jobs.list().filter(j => j.kind === "screen");
    if (a.action === "stop") { if (!jobs.list().some(j => j.id === a.id && j.kind === "screen")) throw new Error("投屏会话不存在"); return jobs.stop(a.id); }
    if (!["mirror", "record"].includes(a.action)) throw new Error("未知投屏操作");
    const device = (await android.call({ action: "devices" })).find(d => d.serial === a.serial && d.state === "device");
    if (!device) throw new Error("需要已连接并授权的明确设备 serial");
    const file = componentPath(paths, "scrcpy"); if (!file) throw new Error("请在组件页按需安装 scrcpy");
    const seconds = a.seconds ?? 3600; if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error("时长需要 1–86400 秒");
    const args = ["--serial", a.serial, "--no-audio", "--max-size=1280", "--max-fps=30", "--time-limit=" + seconds];
    let output;
    if (a.action === "record") {
      const dir = path.join(paths.state, "downloads"); fs.mkdirSync(dir, { recursive: true }); output = path.join(dir, "screen-" + randomUUID() + ".mkv");
      args.push("--no-playback", "--no-window", "--no-control", "--record=" + output);
    } else args.push("--window-title=MCCA - " + a.serial);
    const adb = readSettings(paths).adb;
    return jobs.start({ kind: "screen", serial: a.serial, file, args, output, env: adb ? { ADB: adb } : {}, durationMs: (seconds + 10) * 1000 });
  }
  return { call };
}
module.exports = { createDeviceTools };
