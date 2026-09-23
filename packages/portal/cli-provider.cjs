"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const piProviders = require("../pi-web/pi-providers.cjs");
const { ensurePiModel, modelSlug } = require("../grok-web/bridge.cjs");

const TOOLS = ["codex", "openhands", "grok", "hermes"];
const MARK_START = "# mcca-pi-provider:start";
const MARK_END = "# mcca-pi-provider:end";

function createCliProviders({ root }) {
  const file = process.env.MCCA_CLI_PROVIDERS || path.join(root, "config", "cli-providers.json");
  const hermesHome = process.env.MCCA_HERMES_HOME || path.join(root, "vendor", "cli", "hermes");

  function modelsFile() {
    return process.env.MCCA_PI_MODELS
      || path.join(process.env.USERPROFILE || os.homedir(), ".pi", "agent", "models.json");
  }

  function readPi() {
    try {
      const parsed = JSON.parse(fs.readFileSync(modelsFile(), "utf8").replace(/^\uFEFF/, ""));
      if (parsed && parsed.providers && typeof parsed.providers === "object") return parsed.providers;
    } catch { /* pi 还没有服务商 */ }
    return {};
  }

  function list() {
    return piProviders.publicProviders().map((row) => ({
      id: row.id,
      api: row.entry.api || "",
      baseUrl: row.entry.baseUrl || "",
      hasKey: Boolean(row.entry.hasKey),
      retryCount: row.entry.retryCount,
      retryWaitMs: row.entry.retryWaitMs,
      models: (row.entry.models || []).filter((model) => model && model.id).map((model) => ({
        id: model.id,
        name: model.name || model.id,
      })),
    }));
  }

  function readSelection() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const out = {};
      for (const tool of TOOLS) {
        const row = parsed && parsed[tool];
        if (row && row.provider && row.modelId) out[tool] = { provider: String(row.provider), modelId: String(row.modelId) };
      }
      return out;
    } catch {
      return {};
    }
  }

  function writeSelection(selection) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(selection, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  function quote(value) {
    return JSON.stringify(String(value ?? ""));
  }

  function hermesMode(api) {
    if (api === "openai-responses") return "codex_responses";
    if (api === "anthropic-messages") return "anthropic_messages";
    return "chat_completions";
  }

  function openhandsModel(api, modelId) {
    if (api === "anthropic-messages") return `anthropic/${modelId}`;
    if (api === "google-generative-ai") return `gemini/${modelId}`;
    return `openai/${modelId}`;
  }

  function writeHermes(entry, choice) {
    const configPath = path.join(hermesHome, "config.yaml");
    fs.mkdirSync(hermesHome, { recursive: true });
    let text = "";
    try { text = fs.readFileSync(configPath, "utf8"); } catch { text = ""; }
    const block = choice ? [
      "model:",
      `  default: ${quote(choice.modelId)}`,
      `  provider: ${quote(choice.provider)}`,
      "providers:",
      `  ${quote(choice.provider)}:`,
      `    api: ${quote(String(entry.baseUrl || "").replace(/\/+$/, ""))}`,
      `    api_key: ${quote(entry.apiKey || "")}`,
      `    api_mode: ${hermesMode(entry.api)}`,
      `    default_model: ${quote(choice.modelId)}`,
    ].join("\n") : "";
    const marked = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
    const chunk = block ? `${MARK_START}\n${block}\n${MARK_END}\n` : "";
    const next = marked.test(text)
      ? text.replace(marked, chunk)
      : `${text.replace(/\s*$/, "")}${chunk ? `\n\n${chunk}` : ""}`;
    fs.writeFileSync(configPath, next.trim() ? `${next.replace(/\s*$/, "")}\n` : "");
  }

  function chosen(tool) {
    const choice = readSelection()[tool];
    if (!choice) return null;
    const entry = readPi()[choice.provider];
    if (!entry || !entry.baseUrl) return null;
    const known = (entry.models || []).some((model) => model && model.id === choice.modelId);
    if (!known) return null;
    return { choice, entry };
  }

  function tomlKey(id) {
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : JSON.stringify(id);
  }

  function tomlArg(key, value) {
    if (typeof value === "boolean" || typeof value === "number") return `${key}=${value}`;
    return `${key}=${JSON.stringify(String(value ?? ""))}`;
  }

  function codexArgs(choice) {
    const overlay = piProviders.codexOverlay(choice.provider);
    const spec = overlay && overlay.model_providers && overlay.model_providers[choice.provider];
    if (!spec) return [];
    const prefix = `model_providers.${tomlKey(choice.provider)}`;
    const args = ["-m", choice.modelId, "-c", tomlArg("model_provider", choice.provider)];
    for (const [key, value] of Object.entries(spec)) {
      if (value && typeof value === "object") {
        for (const [inner, innerValue] of Object.entries(value)) {
          if (innerValue == null || typeof innerValue === "object") continue;
          args.push("-c", tomlArg(`${prefix}.${key}.${tomlKey(inner)}`, innerValue));
        }
        continue;
      }
      args.push("-c", tomlArg(`${prefix}.${key}`, value));
    }
    return args;
  }

  function launch(tool) {
    const hit = chosen(tool);
    if (!hit) return { args: [], env: {} };
    const { choice, entry } = hit;
    const base = String(entry.baseUrl).replace(/\/+$/, "");
    if (tool === "codex") return { args: codexArgs(choice), env: {} };
    if (tool === "grok") {
      return { args: ["-m", modelSlug(choice.provider, choice.modelId)], env: ensurePiModel(choice.provider, choice.modelId) };
    }
    if (tool === "openhands") {
      return {
        args: ["--override-with-envs"],
        env: {
          LLM_API_KEY: entry.apiKey || "",
          LLM_BASE_URL: base,
          LLM_MODEL: openhandsModel(entry.api, choice.modelId),
          OPENHANDS_SUPPRESS_BANNER: "1",
        },
      };
    }
    if (tool === "hermes") {
      writeHermes(entry, choice);
      return { args: ["--provider", choice.provider, "-m", choice.modelId], env: {} };
    }
    return { args: [], env: {} };
  }

  function select(tool, provider, modelId) {
    if (!TOOLS.includes(tool)) return { ok: false, status: 400, error: "没有这个命令行" };
    const selection = readSelection();
    const name = String(provider || "").trim();
    const model = String(modelId || "").trim();
    if (!name && !model) {
      delete selection[tool];
      writeSelection(selection);
      if (tool === "hermes") writeHermes(null, null);
      return { ok: true, selection };
    }
    const entry = readPi()[name];
    if (!entry) return { ok: false, status: 404, error: "pi 里没有这个服务商" };
    if (!(entry.models || []).some((row) => row && row.id === model)) {
      return { ok: false, status: 400, error: "这个服务商里没有这个模型" };
    }
    selection[tool] = { provider: name, modelId: model };
    writeSelection(selection);
    if (tool === "hermes") writeHermes(entry, selection[tool]);
    if (tool === "grok") ensurePiModel(name, model);
    return { ok: true, selection };
  }

  function save(id, draft) {
    return piProviders.saveProvider(id, draft || {});
  }

  function remove(id) {
    return piProviders.deleteProvider(id);
  }

  function discover(body) {
    return piProviders.discoverModels(body || {});
  }

  return { list, readSelection, select, launch, save, remove, discover, TOOLS };
}

module.exports = { createCliProviders };
