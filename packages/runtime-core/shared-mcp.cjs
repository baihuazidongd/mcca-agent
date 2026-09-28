"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { McpClient } = require("../pi-mcp/src/index.cjs");

// Only explicitly shared servers are hosted here. Legacy per-IDE servers stay
// with their existing adapters, and the workbench must never connect to itself.
function createSharedMcp({ paths, Client = McpClient }) {
  const entries = new Map();
  let disposed = false;
  function configs() {
    const file = process.env.MCCA_MCP_CONFIG || path.join(paths.data, "mcp.json");
    const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    const rows = Array.isArray(doc) ? doc : doc.servers;
    if (!Array.isArray(rows)) throw new Error("Invalid shared MCP registry");
    return rows.filter(row => row.shared === true && row.disabled !== true && row.serverName !== "mcca-workbench");
  }
  async function entry(config) {
    if (disposed) throw new Error("Shared MCP host is closed");
    const key = JSON.stringify(config);
    let current = entries.get(config.serverName);
    if (current && current.key === key && !(config.transport === "stdio" && current.ready && !current.client.transport.child)) return current.promise;
    current?.client.close();
    const client = new Client(config, { callTimeoutMs: 10000, logger: () => {} });
    current = { key, client, ready: false };
    entries.set(config.serverName, current);
    current.promise = (async () => {
      try {
        await client.start();
        const tools = await client.listTools();
        if (disposed || entries.get(config.serverName) !== current) throw new Error("Shared MCP configuration changed");
        current.ready = true;
        client.callTimeoutMs = 120000;
        current.tools = tools;
        return current;
      } catch (error) {
        client.close();
        if (entries.get(config.serverName) === current) entries.delete(config.serverName);
        throw error;
      }
    })();
    return current.promise;
  }
  function sync() {
    const rows = configs();
    for (const [name, value] of entries) if (!rows.some(row => row.serverName === name)) { value.client.close(); entries.delete(name); }
    return rows;
  }
  async function list() {
    const results = await Promise.allSettled(sync().map(async config => {
      const active = await entry(config);
      return active.tools.map(tool => ({ ...tool, name: "shared__" + config.serverName + "__" + tool.name }));
    }));
    // One unavailable optional MCP must not hide the workbench's own tools.
    return results.flatMap(result => result.status === "fulfilled" ? result.value : []);
  }
  async function call(name, args) {
    const config = sync().sort((a,b) => b.serverName.length-a.serverName.length).find(row => name.startsWith("shared__" + row.serverName + "__"));
    if (!config) throw new Error("Shared MCP server not found or disabled");
    const active = await entry(config);
    const toolName = name.slice(("shared__" + config.serverName + "__").length);
    if (!active.tools.some(tool => tool.name === toolName)) throw new Error("Unknown shared MCP tool");
    // Preserve content blocks and isError. Never replay a timed-out mutation.
    return active.client.callTool(toolName, args);
  }
  function dispose() { disposed = true; for (const value of entries.values()) value.client.close(); entries.clear(); }
  return { list, call, dispose };
}
module.exports = { createSharedMcp };
