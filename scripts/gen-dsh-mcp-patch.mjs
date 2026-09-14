// Generate config/dsh-mcp.patch.yml from the shared config/mcp.json registry:
// one official @deepseek-ai/dsh-mcp-client row per server, so dsh exposes the
// same mcp__<server>__<tool> names as the pi side. Rows are emitted as inline
// JSON (valid YAML flow style) to avoid pulling in a YAML writer.
//
// Usage:
//   import { generateMcpPatch } from '../scripts/gen-dsh-mcp-patch.mjs'
//   generateMcpPatch('config/mcp.json', 'config/dsh-mcp.patch.yml')
// or CLI: node scripts/gen-dsh-mcp-patch.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readServers(mcpConfigPath) {
  const file = path.resolve(mcpConfigPath);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.servers)) return raw.servers;
    return [];
  } catch {
    return [];
  }
}

/** Neutral McpServerConfig → dsh-mcp-client config row (transport renamed). */
export function mcpRow(cfg) {
  if (!cfg || typeof cfg.serverName !== "string" || !cfg.serverName) return null;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(cfg.serverName)) {
    console.warn(`[pdb] skipping MCP server "${cfg.serverName}": dsh requires [A-Za-z0-9_-]{1,32}`);
    return null;
  }
  const config = { serverName: cfg.serverName };
  if (cfg.transport === "stdio") {
    config.transport = "stdio";
    if (cfg.command !== undefined) config.command = cfg.command;
    if (cfg.args !== undefined) config.args = cfg.args;
    if (cfg.env !== undefined) config.env = cfg.env;
  } else {
    // neutral "sse" covers Streamable HTTP; dsh's transport name differs.
    config.transport = "streamable-http";
    if (cfg.url !== undefined) config.url = cfg.url;
    if (cfg.headers !== undefined) config.headers = cfg.headers;
  }
  return {
    id: `pdb-mcp-${cfg.serverName}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config,
  };
}

export function generateMcpPatch(mcpConfigPath, outPath) {
  const rows = readServers(mcpConfigPath)
    // `dsh: false` marks servers dsh already mounts through its own profile
    // patch (e.g. copied dsh-home rows); emitting them again would collide on
    // serverName. Those rows still reach the pi side via @pi-dsh-bridge/pi-mcp.
    .filter((cfg) => cfg?.dsh !== false)
    .map(mcpRow)
    .filter(Boolean);
  const body = rows.length
    // A patch replaces rows by id; new servers must go under `insert:`.
    ? `- insert:\n${rows.map((row) => `    - ${JSON.stringify(row)}`).join("\n")}\n`
    // An empty/comments-only patch file throws on load; keep one no-op row.
    : "- insert: []\n";
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, body, "utf8");
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const rows = generateMcpPatch(
    path.join(ROOT, "config", "mcp.json"),
    path.join(ROOT, "config", "dsh-mcp.patch.yml"),
  );
  console.log(`[pdb] dsh-mcp.patch.yml: ${rows.length} server row(s)`);
}
