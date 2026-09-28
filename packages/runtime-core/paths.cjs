"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function createPaths(env = process.env) {
  const app = path.resolve(env.MCCA_HOME || path.join(__dirname, "../.."));
  // Development keeps the existing configuration. Distributions opt into a
  // separate writable data directory; never silently move users' credentials.
  const data = path.resolve(env.MCCA_DATA_DIR || path.join(app, "config"));
  const state = path.join(data, "workbench");
  return { app, data, state, runtimes: path.join(data, "runtimes"),
    node: env.MCCA_NODE || (fs.existsSync(path.join(app, "runtime/node.exe")) ? path.join(app, "runtime/node.exe") : process.execPath),
    recommendedData: path.join(env.LOCALAPPDATA || path.join(os.homedir(), ".local/share"), "mcca") };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${require("node:crypto").randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
module.exports = { createPaths, writeJson };
