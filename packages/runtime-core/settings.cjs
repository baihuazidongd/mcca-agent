"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { writeJson } = require("./paths.cjs");
function readSettings(paths) {
  const file = path.join(paths.state, "settings.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { schemaVersion: 1 };
}
function saveSettings(paths, input) {
  const next = { ...readSettings(paths), schemaVersion: 1 };
  for (const key of ["adb", "browser", "fridaPython", "ldconsole", "emulator", "scrcpy", "jadx", "mitmdump", "java", "uv"]) {
    if (!(key in input)) continue;
    const value = input[key]; if (!value) { delete next[key]; continue; }
    if (typeof value !== "string" || !path.isAbsolute(value) || !fs.statSync(value).isFile()) throw new Error(`${key} 需要已有可执行文件的绝对路径`);
    next[key] = value;
  }
  writeJson(path.join(paths.state, "settings.json"), next); return next;
}
module.exports = { readSettings, saveSettings };
