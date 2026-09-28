"use strict";
const path = require("node:path");
const { createPaths } = require("./paths.cjs");
function workbenchMcp(paths = createPaths()) {
  return { serverName: "mcca-workbench", transport: "stdio", command: paths.node,
    args: [path.join(paths.app, "packages/runtime-core/mcp-stdio.cjs")],
    env: { MCCA_HOME: paths.app, MCCA_DATA_DIR: paths.data, PORTAL_PORT: process.env.PORTAL_PORT || "3470" } };
}
function acpMcp(paths) {
  const row = workbenchMcp(paths);
  return { name: row.serverName, command: row.command, args: row.args, env: Object.entries(row.env).map(([name, value]) => ({ name, value })) };
}
module.exports = { workbenchMcp, acpMcp };
