"use strict";
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { workbenchMcp } = require("./mcp-config.cjs");
function connectHermes(paths) {
  const home = process.env.MCCA_HERMES_HOME || path.join(paths.app, "vendor/cli/hermes");
  if (!fs.existsSync(home)) throw new Error("请先在应用中安装 Hermes Agent");
  const file = path.join(home, "config.yaml");
  const source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const doc = YAML.parseDocument(source || "{}\n");
  if (doc.errors.length) throw new Error("Hermes 配置无效；未修改原文件");
  const mcp = workbenchMcp(paths);
  const servers = doc.get("mcp_servers", true);
  if (!servers || (YAML.isScalar(servers) && servers.value == null)) {
    const replacement = doc.createNode({});
    if (servers) { replacement.comment = servers.comment; replacement.commentBefore = servers.commentBefore; }
    doc.set("mcp_servers", replacement);
  } else if (!YAML.isMap(servers)) throw new Error("Hermes mcp_servers 需要映射格式；未修改原文件");
  doc.setIn(["mcp_servers", "mcca-workbench"], { command: mcp.command, args: mcp.args, env: mcp.env });
  const backup = file + ".before-workbench-" + Date.now();
  if (source) fs.copyFileSync(file, backup);
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, String(doc), { mode: 0o600 }); fs.renameSync(temp, file);
  return { ok: true, file, backup: source ? backup : null, note: "已接入。新建 Hermes 会话或重载 MCP 后使用；现有任务未重启。" };
}
module.exports = { connectHermes };
