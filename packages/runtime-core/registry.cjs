"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createPaths, writeJson } = require("./paths.cjs");
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype", "board", "manage", "resources", "usage", "workbench"]);
function validate(rows) {
  if (!Array.isArray(rows) || rows.length > 200) throw new Error("runtimes must be an array (max 200)");
  const ids = new Set(), pages = new Set(), ports = new Set();
  for (const r of rows) {
    if (!r || !ID.test(r.id) || RESERVED.has(r.id) || ids.has(r.id)) throw new Error("Invalid or duplicate runtime id");
    ids.add(r.id);
    if (typeof r.label !== "string" || !r.label.trim() || r.label.length > 100) throw new Error(`Invalid label: ${r.id}`);
    if (!["ide", "cli", "extension"].includes(r.group)) throw new Error(`Invalid group: ${r.id}`);
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) throw new Error(`Invalid port: ${r.id}`);
    if (ports.has(r.port)) throw new Error(`Duplicate port: ${r.port}`); ports.add(r.port);
    if (r.page && (!ID.test(r.page) || RESERVED.has(r.page) || pages.has(r.page))) throw new Error(`Invalid or duplicate page: ${r.id}`);
    if (r.page) pages.add(r.page);
    if (typeof r.command !== "string" || (!r.command && !r.resolver)) throw new Error(`Missing command: ${r.id}`);
    if (!Array.isArray(r.args) || r.args.some(a => typeof a !== "string")) throw new Error(`args must be strings: ${r.id}`);
    if (!Array.isArray(r.capabilities) || r.capabilities.some(a => typeof a !== "string")) throw new Error(`Invalid capabilities: ${r.id}`);
    if (r.cwd !== undefined && typeof r.cwd !== "string") throw new Error(`Invalid cwd: ${r.id}`);
    if (r.env !== undefined && (!r.env || Array.isArray(r.env) || typeof r.env !== "object" || Object.entries(r.env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string"))) throw new Error(`Invalid env: ${r.id}`);
    for (const value of [r.command, r.cwd || "", ...r.args, ...Object.values(r.env || {})]) {
      for (const match of value.matchAll(/\$\{([^}]+)\}/g)) if (!["APP", "DATA", "STATE", "RUNTIMES", "NODE", "PORT", "DSH_HOME", "DSH_PATCH", "DSH_MCP_PATCH"].includes(match[1])) throw new Error(`Unknown variable: ${match[1]}`);
    }
    if (r.taskProtocol && !["sessions-v1", "dsh-rpc-v1", "dsh-remote-v1", "openhands-acp-v1"].includes(r.taskProtocol)) throw new Error(`Unknown task protocol: ${r.id}`);
    if (r.requires && (!Array.isArray(r.requires) || r.requires.some(id => typeof id !== "string"))) throw new Error(`Invalid dependencies: ${r.id}`);
  }
  const visiting = new Set(), done = new Set(), byId = new Map(rows.map(r => [r.id, r]));
  function visit(id) {
    if (!byId.has(id)) throw new Error(`Unknown dependency: ${id}`);
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${id}`);
    if (done.has(id)) return;
    visiting.add(id); for (const dep of byId.get(id).requires || []) visit(dep);
    visiting.delete(id); done.add(id);
  }
  rows.forEach(r => visit(r.id));
  return rows;
}
function readDocument(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (data.schemaVersion !== 1) throw new Error(`Unsupported runtime schema: ${file}`);
  return data.runtimes;
}
function createRegistry({ paths = createPaths(), env = process.env } = {}) {
  const file = env.MCCA_RUNTIME_REGISTRY || path.join(paths.app, "config/runtimes.json");
  const customFile = path.join(paths.state, "runtimes.json");
  const builtins = readDocument(file);
  let custom = fs.existsSync(customFile) ? readDocument(customFile) : [];
  let activeResolvers;
  const all = () => validate([...builtins, ...custom]);
  all();
  return {
    all,
    add(row) {
      // Generic registrations cannot inject code into the portal or adopt arbitrary processes.
      if (row.resolver || row.reclaim || row.windowsShell || row.commandEnv || row.argsEnv || row.cwdEnv || row.portEnv) throw new Error("Custom runtimes use an explicit executable and argument array");
      const next = [...custom.filter(r => r.id !== row.id), { ...row, defaultInstalled: false }];
      validate([...builtins, ...next]);
      const previous = custom; custom = next;
      try { if (activeResolvers) this.resolve(activeResolvers); writeJson(customFile, { schemaVersion: 1, runtimes: next }); }
      catch (error) { custom = previous; throw error; }
      return row.id;
    },
    resolve(resolvers = {}) {
      activeResolvers = resolvers;
      const result = Object.create(null), ports = new Set();
      for (const row of all()) {
        const port = Number((row.portEnv || []).map(key => env[key]).find(Boolean) || row.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || ports.has(port)) throw new Error(`Invalid or duplicate port: ${row.id}`);
        ports.add(port);
        const vars = { APP: paths.app, DATA: paths.data, STATE: paths.state, RUNTIMES: paths.runtimes, NODE: paths.node, PORT: String(port),
          DSH_HOME: env.MCCA_DSH_HOME || path.join(paths.data, "dsh-home"),
          DSH_PATCH: env.MCCA_DSH_PATCH || path.join(paths.app, "config/dsh.patch.yml"),
          DSH_MCP_PATCH: env.MCCA_DSH_MCP_PATCH || path.join(paths.data, "dsh-mcp.patch.yml") };
        const expand = value => String(value).replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
          if (!(key in vars)) throw new Error(`Unknown path variable: ${key}`); return vars[key];
        });
        let args = row.args.map(expand);
        if (env[row.argsEnv]) {
          const raw = env[row.argsEnv];
          // JSON argv preserves spaces in paths. Legacy overrides remain compatible.
          args = raw.trim().startsWith("[") ? JSON.parse(raw) : raw.split(" ");
          if (!Array.isArray(args) || args.some(a => typeof a !== "string")) throw new Error(`Invalid argv: ${row.id}`);
        }
        if (row.resolver && typeof resolvers[row.resolver] !== "function") throw new Error(`Missing resolver: ${row.resolver}`);
        result[row.id] = { ...row, port, cmd: env[row.commandEnv] || expand(row.command), args,
          cwd: env[row.cwdEnv] || expand(row.cwd || "${APP}"),
          env: Object.fromEntries(Object.entries(row.env || {}).map(([k, v]) => [k, expand(v)])),
          shell: row.windowsShell === true && process.platform === "win32",
          ...(row.resolver ? { resolve: resolvers[row.resolver] } : {}) };
        if (row.id === "dsh" && !env.DSH_CMD && !fs.existsSync(path.join(paths.app,"vendor/dsh/package.json"))) {
          const entry = require("./runtime-recipes.cjs").runtimeEntry(paths,"dsh");
          if (entry) Object.assign(result[row.id], { cmd:paths.node, args:[entry,...args.slice(1),"--no-open"], cwd:paths.app, shell:false, taskProtocol:"dsh-remote-v1" });
        }
      }
      return result;
    },
  };
}
let shared;
function registry() { return shared ||= createRegistry(); }
module.exports = { createRegistry, registry, validate };
