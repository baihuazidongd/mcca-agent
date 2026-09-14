"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..", "..");
const ALLOWED_FIELDS = new Set([
  "action", "name", "agent", "description", "model", "fallbackModels",
  "thinking", "systemPrompt", "tools", "scope", "agentScope", "cwd", "existing",
]);
const ALLOWED_ACTIONS = new Set(["create", "update", "enable", "disable", "reset"]);
const CONFIG_FIELDS = ["description", "model", "fallbackModels", "thinking", "systemPrompt", "tools", "scope"];
const SOURCE_RANK = { builtin: 0, package: 1, user: 2, project: 3 };

function agentDir() {
  return process.env.PDB_AGENT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent");
}

function packageRoot() {
  const bases = [process.env.PDB_AGENT_DIR, path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent")].filter(Boolean);
  for (const base of bases) {
    const root = path.join(base, "npm", "node_modules", "pi-subagents");
    if (fs.existsSync(path.join(root, "package.json"))) return root;
  }
  throw new Error("pi-subagents is not installed");
}

let loaded;
function load() {
  if (loaded) return loaded;
  const root = packageRoot();
  const req = createRequire(path.join(root, "package.json"));
  const jitiFactory = req("jiti");
  const jiti = typeof jitiFactory === "function"
    ? jitiFactory(__filename, { interopDefault: true })
    : jitiFactory.createJiti(__filename, { interopDefault: true });
  const base = path.join(root, "src", "agents");
  const agents = jiti(path.join(base, "agents.ts"));
  const management = jiti(path.join(base, "agent-management.ts"));
  loaded = {
    discoverAgentsAll: agents.discoverAgentsAll,
    handleManagementAction: management.handleManagementAction,
  };
  return loaded;
}

function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function project(cwd = ROOT) {
  const discovered = load().discoverAgentsAll(cwd);
  return ["builtin", "package", "user", "project"].flatMap((source) => (discovered[source] || []).map((agent) => {
    const custom = source === "user" || source === "project";
    return {
      name: agent.name,
      description: agent.description || "",
      source: agent.source || source,
      scope: custom ? (agent.source || source) : ((agent.override && agent.override.scope) || "user"),
      model: agent.model || "",
      fallbackModels: agent.fallbackModels || [],
      thinking: agent.thinking || "",
      systemPrompt: agent.systemPrompt || "",
      tools: agent.tools || [],
      mcpDirectTools: agent.mcpDirectTools || [],
      disabled: Boolean(agent.disabled || (agent.override && agent.override.disabled)),
    };
  }));
}

function effective(cwd = ROOT) {
  const map = new Map();
  for (const agent of project(cwd)) {
    const current = map.get(agent.name);
    if (!current || (SOURCE_RANK[agent.source] || 0) > (SOURCE_RANK[current.source] || 0)) map.set(agent.name, agent);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function errorText(result) {
  if (!result) return "management failed";
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.map((item) => (item && item.text) || "").filter(Boolean).join("\n").trim();
    if (text) return text;
  }
  return result.error || "management failed";
}

function nativeResult(result) {
  return result && typeof result.then === "function" ? result : Promise.resolve(result);
}

function managementContext(cwd, modelRegistry) {
  return {
    cwd: cwd || ROOT,
    modelRegistry,
    model: undefined,
    config: undefined,
    currentSessionId: undefined,
  };
}

async function callNative(action, params, cwd, modelRegistry) {
  return nativeResult(load().handleManagementAction(action, params, managementContext(cwd, modelRegistry)));
}

function buildConfig(action, input) {
  const config = {};
  for (const key of CONFIG_FIELDS) {
    if (input[key] === undefined || input[key] === null) continue;
    if (key === "thinking" && input[key] === "") continue;
    if (key === "model" && input[key] === "") continue;
    if (key === "tools") {
      config.tools = Array.isArray(input.tools) ? input.tools.join(",") : input.tools;
      continue;
    }
    if (key === "fallbackModels") {
      config.fallbackModels = Array.isArray(input.fallbackModels) ? input.fallbackModels.join(",") : input.fallbackModels;
      continue;
    }
    config[key] = input[key];
  }
  if (action === "create") {
    config.name = input.name;
    if (config.scope === undefined) config.scope = "user";
  }
  return config;
}

async function manage(action, input = {}, cwd = ROOT, modelRegistry) {
  if (!ALLOWED_ACTIONS.has(action)) {
    return { isError: true, content: [{ type: "text", text: "Unknown action: " + action }] };
  }
  for (const key of Object.keys(input || {})) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { isError: true, content: [{ type: "text", text: "unknown field: " + key }] };
    }
  }
  const name = String(input.agent || input.name || "").trim();
  if ((action === "create" || action === "update" || action === "enable" || action === "disable" || action === "reset") && !name) {
    return { isError: true, content: [{ type: "text", text: "name is required" }] };
  }
  const agentScope = input.agentScope || input.scope || "user";
  if (action === "update") {
    const current = effective(cwd).find((agent) => agent.name === name);
    if (current && (current.source === "builtin" || current.source === "package")) {
      const ejected = await callNative("eject", { agent: name, agentScope, config: {} }, cwd, modelRegistry);
      if (ejected && ejected.isError) return ejected;
    }
  }
  const params = {
    agent: name,
    agentScope,
    config: buildConfig(action, input),
  };
  return callNative(action, params, cwd, modelRegistry);
}

module.exports = {
  ALLOWED_ACTIONS,
  ALLOWED_FIELDS,
  agentDir,
  packageRoot,
  project,
  effective,
  manage,
  errorText,
};
