"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createInstaller } = require("./install.cjs");
const { readSettings, saveSettings } = require("./settings.cjs");
// Release assets and publisher digests checked against GitHub's release API.
const CATALOG = [
  { id: "uv", label: "Python 运行环境管理器", license: "MIT OR Apache-2.0", source: "https://github.com/astral-sh/uv", executable: "uv.exe", artifacts: { "win32-x64": { version: "0.12.19", url: "https://github.com/astral-sh/uv/releases/download/0.12.19/uv-x86_64-pc-windows-msvc.zip", sha256: "6dbb02d79e419522f1c500f0adb1cddcff0cda7d59b0d66ea7f5e3b4a1b2f5f0", format: "zip" } } },
  { id: "scrcpy", label: "Android 投屏 / 录屏", license: "Apache-2.0", source: "https://github.com/Genymobile/scrcpy", executable: "scrcpy.exe", artifacts: { "win32-x64": { version: "4.1", url: "https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-win64-v4.1.zip", sha256: "5b12172b3264b2889f4583ee64752ce832e29bc8b1089dca81093459697165db", format: "zip" } } },
  { id: "jadx", label: "APK 反编译（含 Java）", license: "Apache-2.0", source: "https://github.com/skylot/jadx", executable: "jadx-gui.exe", artifacts: { "win32-x64": { version: "1.5.6", url: "https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-gui-1.5.6-with-jre-win.zip", sha256: "56a870460d03d3d6f22eb0908c33e298bc7370c952a6b7fa48c22a187ecd690b", format: "zip" } } },
];
function locate(root, name, depth = 0) {
  if (!fs.existsSync(root) || depth > 4) return null;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const file = path.join(root, item.name);
    if (item.isFile() && item.name.toLowerCase() === name.toLowerCase()) return file;
    if (item.isDirectory()) { const found = locate(file, name, depth + 1); if (found) return found; }
  }
  return null;
}
function componentPath(paths, id) {
  const row = CATALOG.find(r => r.id === id);
  const configured = readSettings(paths)[id];
  const root = path.join(paths.runtimes, id, "current");
  return configured && fs.existsSync(configured) ? configured : row ? locate(root, row.executable) || (id === "jadx" ? locate(root, "jadx-gui-1.5.6.exe") : null) : null;
}
function createComponents({ paths }) {
  const installer = createInstaller({ paths }), pending = new Map();
  function list() { return CATALOG.map(row => ({ ...row, path: componentPath(paths, row.id), job: installer.jobs().find(j => j.id === row.id), available: Boolean(row.artifacts[process.platform + "-" + process.arch]) })); }
  async function call(a) {
    if (a.action === "list") return list();
    const row = CATALOG.find(r => r.id === a.id); if (!row) throw new Error("Unknown component");
    if (a.action !== "install") throw new Error("Unknown component action");
    if (pending.has(row.id)) return { id: row.id, state: "installing" };
    const operation = installer.install(row).then(result => {
      if (result.state === "installed") { const file = componentPath(paths, row.id); if (file) saveSettings(paths, { ...readSettings(paths), [row.id]: file }); }
      return result;
    }).finally(() => pending.delete(row.id));
    pending.set(row.id, operation);
    return operation;
  }
  return { list, call };
}
module.exports = { CATALOG, locate, componentPath, createComponents };
