"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function modelsFile() {
  return process.env.MCCA_PI_MODELS
    || path.join(process.env.USERPROFILE || os.homedir(), ".pi", "agent", "models.json");
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"];

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsFile(), "utf8").replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") return parsed;
  } catch {
    // 没有文件就当空目录，不另起一份
  }
  return { providers: {} };
}

function writeStore(data) {
  const file = modelsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function effortsOf(model) {
  const map = model && model.thinkingLevelMap;
  if (model && model.reasoning === false) return [];
  if (!map) return model && model.reasoning ? ["medium", "high"] : [];
  return LEVELS.filter((level) => typeof map[level] === "string" || (level === "off" && map[level] === undefined));
}

function thinkingEffortsText(model) {
  if (model && model.reasoning === false) return false;
  const efforts = effortsOf(model);
  return efforts.length ? efforts.join(",") : "";
}

function normalizeEfforts(raw) {
  if (raw === false) return false;
  const text = String(raw || "").trim();
  if (!text) return null;
  const valid = new Set(LEVELS);
  const levels = [...new Set(text.split(",").map((part) => part.trim()).filter(Boolean))];
  if (!levels.length) return null;
  const bad = levels.filter((level) => !valid.has(level));
  if (bad.length) return { invalid: bad.join(",") };
  if (!levels.some((level) => level !== "off")) return { invalid: "至少声明一个 off 以外的思考级别" };
  const map = {};
  for (const level of LEVELS) {
    if (level === "off") {
      if (!levels.includes("off")) map.off = null;
    } else {
      map[level] = levels.includes(level) ? level : null;
    }
  }
  return map;
}

function publicProviders() {
  const configured = readStore().providers || {};
  return Object.entries(configured).map(([id, entry]) => ({
    id,
    name: id,
    shadowNative: false,
    configured: true,
    active: Boolean(entry && entry.baseUrl && entry.apiKey),
    entry: {
      api: (entry && entry.api) || "",
      baseUrl: (entry && entry.baseUrl) || "",
      hasKey: Boolean(entry && entry.apiKey),
      retryCount: entry && entry.retryCount != null ? entry.retryCount : null,
      retryWaitMs: entry && entry.retryWaitMs != null ? entry.retryWaitMs : null,
      models: ((entry && entry.models) || []).map((model) => ({
        id: model.id,
        name: model.name || model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: Boolean(model.reasoning),
        thinkingEfforts: thinkingEffortsText(model),
        input: model.input,
      })),
    },
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function catalogGroups() {
  const groups = [];
  for (const row of publicProviders()) {
    const models = (row.entry.models || []).filter((model) => model.id);
    if (!models.length) continue;
    groups.push({
      id: row.id,
      name: row.id,
      models: models.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        reasoning: Boolean(model.reasoning),
        efforts: effortsOf((readStore().providers[row.id].models || []).find((item) => item.id === model.id) || model),
      })),
    });
  }
  return groups;
}

function wireApi(api) {
  return api === "openai-completions" ? "chat" : "responses";
}

/** Codex thread config overlay. Includes the key; never log the result. */
function codexOverlay(providerId) {
  const entry = readStore().providers[providerId];
  if (!entry || !entry.baseUrl) return null;
  const spec = {
    name: providerId,
    base_url: String(entry.baseUrl).replace(/\/+$/, ""),
    wire_api: wireApi(entry.api),
    requires_openai_auth: false,
  };
  if (typeof entry.apiKey === "string" && entry.apiKey) spec.experimental_bearer_token = entry.apiKey;
  if (Number.isInteger(entry.retryCount)) spec.request_max_retries = entry.retryCount;
  if (entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)) spec.http_headers = entry.headers;
  return { model_providers: { [providerId]: spec } };
}

function saveProvider(id, draft) {
  const route = String(id || "").trim();
  if (!route) return { ok: false, status: 400, error: "需要服务商 ID" };
  const data = readStore();
  const renameFrom = typeof draft.renameFrom === "string" ? draft.renameFrom.trim() : "";
  let existing = data.providers[route] || null;
  if (renameFrom && renameFrom !== route) {
    const moved = data.providers[renameFrom] || null;
    if (moved && existing && existing !== moved) return { ok: false, status: 409, error: `服务商「${route}」已存在，不能覆盖` };
    if (moved) {
      existing = moved;
      delete data.providers[renameFrom];
    }
  }
  const next = { ...(existing || {}) };
  const api = String(draft.api || "").trim();
  const baseUrl = String(draft.baseUrl || "").trim();
  if (api) next.api = api;
  else if (!next.api) next.api = "openai-completions";
  if (baseUrl) next.baseUrl = baseUrl;
  if (draft.retryCount === null || draft.retryCount === undefined) delete next.retryCount;
  else if (Number.isInteger(Number(draft.retryCount))) next.retryCount = Number(draft.retryCount);
  if (draft.retryWaitSeconds === null || draft.retryWaitSeconds === undefined) delete next.retryWaitMs;
  else if (Number(draft.retryWaitSeconds) > 0) next.retryWaitMs = Math.round(Number(draft.retryWaitSeconds) * 1000);
  if (typeof draft.apiKey === "string" && draft.apiKey.trim()) next.apiKey = draft.apiKey.trim();
  if (!next.baseUrl) return { ok: false, status: 400, error: "自定义服务商需要 API 地址" };
  if (Array.isArray(draft.models)) {
    const prev = new Map(((existing && existing.models) || []).map((model) => [model.id, model]));
    next.models = draft.models.filter((model) => model && String(model.id || "").trim()).map((model) => {
      const modelId = String(model.id).trim();
      const merged = { ...(prev.get(modelId) || {}), id: modelId, name: String(model.name || "").trim() || modelId };
      if (Number(model.contextWindow) > 0) merged.contextWindow = Number(model.contextWindow);
      if (Number(model.maxTokens) > 0) merged.maxTokens = Number(model.maxTokens);
      if (Array.isArray(model.input) && model.input.length) merged.input = model.input;
      const efforts = normalizeEfforts(model.thinkingEfforts);
      if (efforts && efforts.invalid) return { invalid: efforts.invalid };
      if (efforts === false) {
        merged.reasoning = false;
        delete merged.thinkingLevelMap;
      } else if (efforts) {
        merged.reasoning = true;
        merged.thinkingLevelMap = efforts;
      } else {
        merged.reasoning = Boolean(model.reasoning);
      }
      return merged;
    });
    const bad = next.models.find((model) => model && model.invalid);
    if (bad) return { ok: false, status: 400, error: `思考强度无法识别：${bad.invalid}` };
  }
  data.providers[route] = next;
  writeStore(data);
  return { ok: true };
}

function deleteProvider(id) {
  const route = String(id || "").trim();
  const data = readStore();
  if (!data.providers[route]) return { ok: false, status: 404, error: "没有这个服务商" };
  delete data.providers[route];
  writeStore(data);
  return { ok: true };
}

async function discoverModels({ provider, baseUrl, apiKey } = {}) {
  const route = String(provider || "").trim();
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  let key = String(apiKey || "").trim();
  if (!key && route) {
    const stored = readStore().providers[route];
    if (stored && typeof stored.apiKey === "string") key = stored.apiKey;
  }
  if (!base) {
    const configured = route && readStore().providers[route];
    const models = configured ? (configured.models || []).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: Boolean(model.reasoning),
      thinkingEfforts: thinkingEffortsText(model),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })) : [];
    return models.length ? { models } : { error: "请先填写 API 地址再获取模型" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${base}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return { error: `${base}/models → HTTP ${res.status}` };
    const body = await res.json();
    const rows = Array.isArray(body && body.data) ? body.data : Array.isArray(body && body.models) ? body.models : [];
    const models = [];
    const seen = new Set();
    for (const row of rows) {
      const id = typeof row === "string" ? row.trim() : row && typeof row.id === "string" ? row.id.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: row && row.name && row.name !== id ? row.name : undefined });
    }
    return models.length ? { models } : { error: "端点未返回任何模型" };
  } catch (error) {
    return { error: error.name === "AbortError" ? "获取模型超时" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  modelsFile,
  publicProviders,
  catalogGroups,
  codexOverlay,
  saveProvider,
  deleteProvider,
  discoverModels,
  wireApi,
};
