"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

const GLOBAL_KEYS = ["__piSubagentRuntimeCleanup", "__piSubagentEventUnsubscribes", "__piSubagentVisibleControlNotices"];
let nativePromise;

function existing(file) {
  return file && fs.existsSync(file) ? file : null;
}

function resolveAliases(agentDir, packageRoot) {
  const local = path.resolve(__dirname, "..", "..", "node_modules");
  const globalMods = path.join(agentDir, "npm", "node_modules");
  const pick = (...candidates) => candidates.map(existing).find(Boolean);
  const ai = path.join(globalMods, "@earendil-works", "pi-ai", "dist");
  const tui = path.join(globalMods, "@earendil-works", "pi-tui", "dist", "index.js");
  const coding = pick(
    path.join(local, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    path.join(globalMods, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
  );
  const core = pick(
    path.join(globalMods, "@earendil-works", "pi-agent-core", "dist", "index.js"),
    path.join(local, "@earendil-works", "pi-agent-core", "dist", "index.js"),
    coding,
  );
  const aliases = {};
  if (coding) {
    aliases["@earendil-works/pi-coding-agent"] = coding;
    aliases["@mariozechner/pi-coding-agent"] = coding;
  }
  if (core) {
    aliases["@earendil-works/pi-agent-core"] = core;
    aliases["@mariozechner/pi-agent-core"] = core;
  }
  const compat = existing(path.join(ai, "compat.js"));
  if (compat) {
    aliases["@earendil-works/pi-ai"] = compat;
    aliases["@earendil-works/pi-ai/compat"] = compat;
    aliases["@mariozechner/pi-ai"] = compat;
    aliases["@mariozechner/pi-ai/compat"] = compat;
  }
  const oauth = existing(path.join(ai, "oauth.js"));
  if (oauth) {
    aliases["@earendil-works/pi-ai/oauth"] = oauth;
    aliases["@mariozechner/pi-ai/oauth"] = oauth;
  }
  const providers = existing(path.join(ai, "providers", "all.js"));
  if (providers) {
    aliases["@earendil-works/pi-ai/providers/all"] = providers;
    aliases["@mariozechner/pi-ai/providers/all"] = providers;
  }
  if (existing(tui)) {
    aliases["@earendil-works/pi-tui"] = tui;
    aliases["@mariozechner/pi-tui"] = tui;
  }
  aliases["pi-subagents"] = path.join(packageRoot, "index.ts");
  return aliases;
}

function nativeFactory(agentDir) {
  if (!nativePromise) {
    nativePromise = (async () => {
      const root = path.join(agentDir, "npm", "node_modules", "pi-subagents");
      if (!fs.existsSync(path.join(root, "package.json"))) {
        throw new Error("pi-subagents package not found at " + root);
      }
      const req = createRequire(path.join(root, "package.json"));
      const jitiMod = req("jiti");
      const aliases = resolveAliases(agentDir, root);
      const jiti = typeof jitiMod.createJiti === "function"
        ? jitiMod.createJiti(__filename, { interopDefault: true, alias: aliases })
        : jitiMod(__filename, { interopDefault: true, alias: aliases });
      const mod = await jiti.import(pathToFileURL(path.join(root, "index.ts")).href);
      const factory = mod && (mod.default || mod);
      if (typeof factory !== "function") throw new Error("pi-subagents default export is not a factory");
      return factory;
    })();
  }
  return nativePromise;
}

function isolateInitializer(factory, pi) {
  const saved = GLOBAL_KEYS.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of GLOBAL_KEYS) delete globalThis[key];
  try {
    const result = factory(pi);
    if (result && typeof result.then === "function") {
      throw new Error("native subagent initializer must be synchronous");
    }
    return result;
  } finally {
    for (const key of GLOBAL_KEYS) delete globalThis[key];
    saved.forEach((descriptor, index) => {
      if (descriptor) Object.defineProperty(globalThis, GLOBAL_KEYS[index], descriptor);
    });
  }
}

function createNativeSubagents(agentDir) {
  return async (pi) => {
    const factory = await nativeFactory(agentDir);
    isolateInitializer(factory, pi);
  };
}

function requestRpc(bus, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!bus || typeof bus.emit !== "function" || typeof bus.on !== "function") {
      reject(new Error("subagent RPC unavailable"));
      return;
    }
    const requestId = randomUUID();
    let unsubscribe;
    const finish = (error, data) => {
      clearTimeout(timer);
      try { unsubscribe && unsubscribe(); } catch {}
      unsubscribe = null;
      error ? reject(error) : resolve(data);
    };
    const timer = setTimeout(() => finish(new Error("Subagent RPC timed out")), timeoutMs);
    const handler = (reply) => {
      if (!reply || reply.requestId !== requestId) return;
      finish(reply.success ? null : new Error((reply.error && reply.error.message) || "Subagent RPC failed"), reply.data);
    };
    unsubscribe = bus.on("subagents:rpc:v1:reply:" + requestId, handler);
    try {
      bus.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId,
        method,
        params,
        source: { extension: "pi-web" },
      });
    } catch (error) {
      finish(error);
    }
  });
}

function createObserver(registry, onBus, onConfig) {
  return (pi) => {
    if (onBus) onBus(pi.events);
    const names = ["subagent:async-started", "subagent:async-complete", "subagent:foreground-complete", "subagent:process-terminal"];
    const unsubscribers = names.map((name) => pi.events.on(name, (event) => {
      try { registry.event(name, event); } catch (error) { registry.lastError = error.message; }
    }));
    const offTool = typeof pi.on === "function" ? pi.on("tool_result", (event) => {
      if (event && event.toolName === "subagent" && event.details && event.details.mode === "management" && onConfig) onConfig();
    }) : null;
    if (typeof pi.on === "function") {
      pi.on("session_shutdown", () => {
        unsubscribers.forEach((unsubscribe) => { try { unsubscribe && unsubscribe(); } catch {} });
        try { offTool && offTool(); } catch {}
      });
    }
  };
}

module.exports = {
  GLOBAL_KEYS,
  createNativeSubagents,
  createObserver,
  requestRpc,
  isolateInitializer,
  nativeFactory,
};
