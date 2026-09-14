"use strict";

/**
 * @pi-dsh-bridge/pi-adapter — the pi-side adapter for the neutral plugin contract.
 *
 * A pi extension is a factory `(pi) => void | Promise<void>` where `pi` is
 * pi's `ExtensionAPI`. This adapter loads the shared neutral plugins through
 * `@pi-dsh-bridge/plugin-host` and maps their neutral registration calls onto pi's
 * `registerTool` / `registerCommand` / `on`.
 *
 * Hot reload does NOT need `session.reload()`. pi's own runtime API is enough:
 *   - `pi.registerTool()` is valid after load and calls `refreshTools()` itself
 *     (`extensions/loader.js`), so a new or changed tool implementation is live
 *     on the next agent turn;
 *   - `pi.setActiveTools(names)` swaps `agent.state.tools` and rebuilds the
 *     system prompt, also next-turn, and ignores unknown names.
 * pi has no per-tool unregister, so a plugin that disappears or is disabled is
 * hidden from the active set instead of deleted from the registry — from the
 * model's point of view that is identical to removal. See `applyActiveTools`.
 *
 * Commands have no equivalent (pi's command map is load-time only), so a new
 * command still needs a new session; tools and their behavior do not.
 */

/** Neutral plugin event name → pi extension event name. */
const EVENT_MAP = {
  session_start: "session_start",
  // pi has no direct "session_end"; session_shutdown fires on quit/reload/
  // new/resume/fork, which is the closest teardown signal.
  session_end: "session_shutdown",
  input: "input",
  turn_end: "turn_end",
};

/** Normalize a neutral tool result payload into pi's content-array shape. */
function normalizeContent(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === "object" && "type" in part) return part;
      return { type: "text", text: part == null ? "" : String(part) };
    });
  }
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (typeof content === "object" && "type" in content) return [content];
  return [{ type: "text", text: String(content) }];
}

/** Normalize a neutral `ToolResult` (or string/array) into pi's AgentToolResult. */
function normalizeResult(result) {
  if (result == null) return { content: [] };
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  if (Array.isArray(result)) return { content: normalizeContent(result) };
  const out = { content: normalizeContent(result.content) };
  if (result.details !== undefined) out.details = result.details;
  return out;
}

/** Build the neutral `PluginCtx` pi plugins see, from a pi extension context. */
function toPluginCtx(piCtx, extra) {
  return {
    cwd: piCtx?.cwd,
    agent: "pi",
    signal: piCtx?.signal,
    ...(extra || {}),
  };
}

/**
 * Build the native `PluginApiImpl` that maps neutral registration onto `pi`.
 *
 * @param {object} pi          pi's ExtensionAPI.
 * @param {object} [options]
 * @param {Set<string>} [options.toolNames]
 *   Collects every tool name registered by the current load; the adapter
 *   reconciles pi's active set against it.
 * @param {(cfg: import("@pi-dsh-bridge/plugin-sdk").McpServerConfig) => void} [options.onMcpServer]
 * @param {(skill: import("@pi-dsh-bridge/plugin-sdk").SkillDefinition) => void} [options.onSkill]
 * @param {(def: import("@pi-dsh-bridge/plugin-sdk").UiDefinition) => void} [options.onUi]
 */
function createPiApiImpl(pi, options = {}) {
  const { onMcpServer, onSkill, onUi, toolNames } = options;
  return {
    registerTool(def) {
      if (toolNames) toolNames.add(def.name);
      pi.registerTool({
        name: def.name,
        label: def.name,
        description: def.description,
        // pi accepts a plain JSON Schema object for `parameters` (its own
        // bundled extensions pass one directly), so no TypeBox conversion is
        // needed.
        parameters: def.parameters ?? { type: "object", properties: {} },
        async execute(_toolCallId, params, signal, _onUpdate, piCtx) {
          const ctx = toPluginCtx(piCtx, { signal });
          const result = await def.execute(params, ctx);
          return normalizeResult(result);
        },
      });
    },

    registerCommand(name, def) {
      pi.registerCommand(name, {
        description: def.description,
        // pi passes the command's trailing text as a string argument.
        async handler(args, piCtx) {
          await def.handler(args, toPluginCtx(piCtx));
        },
      });
    },

    registerMcpServer(cfg) {
      // MCP servers are bridged by @pi-dsh-bridge/pi-mcp: hand the config upstream so the
      // host registers the tools. Connections are process-shared and survive a
      // session reload — @pi-dsh-bridge/pi-mcp exports closeSharedMcpClients() but no
      // caller wires it to session_shutdown, so a reload neither drops nor
      // reconnects them. Say so here because the opposite used to be claimed.
      if (typeof onMcpServer === "function") onMcpServer(cfg);
    },

    registerSkill(skill) {
      // Skills are wired in stage 4 by pointing pi's resource loader at the
      // shared skills/ directory. Collect them so that wiring can pick them up.
      if (typeof onSkill === "function") onSkill(skill);
    },

    registerUi(def) {
      // Web surfaces bridge UI plugins: collect the definition so the host can
      // list it and serve the module. Hot reload re-collects per session build;
      // the host dedupes by name.
      if (typeof onUi === "function") onUi(def);
    },

    on(event, handler) {
      const piEvent = EVENT_MAP[event];
      if (!piEvent) return;
      pi.on(piEvent, async (payload, piCtx) => {
        const pluginEvent = { ...(payload || {}), type: event };
        await handler(pluginEvent, toPluginCtx(piCtx));
      });
    },
  };
}

/**
 * Create the pi extension factory for the shared plugins.
 *
 * The returned factory is called by pi's extension loader; it dynamically
 * imports the (ESM) plugin host, so the factory itself is a plain function and
 * the module stays CommonJS.
 *
 * @param {object} [options]
 * @param {string} options.pluginsDir   Shared plugins directory.
 * @param {string} options.configPath   Path to plugins.json (enable state).
 * @param {string} [options.cwd]
 * @param {(cfg: import("@pi-dsh-bridge/plugin-sdk").McpServerConfig) => void} [options.onMcpServer]
 * @param {(skill: import("@pi-dsh-bridge/plugin-sdk").SkillDefinition) => void} [options.onSkill]
 * @param {(def: import("@pi-dsh-bridge/plugin-sdk").UiDefinition) => void} [options.onUi]
 * @param {(info: { loaded: Array<object>, host: object }) => void} [options.onLoaded]
 * @returns {(pi: object) => Promise<void>}
 */
function createPiAdapter(options = {}) {
  const { pluginsDir, configPath, cwd, onMcpServer, onSkill, onUi, onLoaded } = options;
  return async function piAdapterExtension(pi) {
    const { createPluginHost } = await import("@pi-dsh-bridge/plugin-host");
    // `collected` accumulates the tool names of the load in progress; `offered`
    // snapshots the load currently in effect. registerTool writes into
    // `collected` for every plugin the host loads.
    const collected = new Set();
    let offered = new Set();

    /**
     * Make pi's active tool set match the library after a reload: newly
     * registered tools go in, tools that vanished (deleted or disabled) come
     * out. pi keeps no unregister, so "out" means "not offered to the model",
     * which is the observable effect that matters.
     *
     * Only called on reload: the initial load needs no reconcile because pi
     * composes the session's first active set from the extension's own tools.
     */
    function reconcileActiveTools() {
      const next = new Set(collected);
      const previous = offered;
      offered = next;
      if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
      const added = [...next].filter((name) => !previous.has(name));
      const gone = [...previous].filter((name) => !next.has(name));
      if (!added.length && !gone.length) return;
      const active = new Set(pi.getActiveTools());
      for (const name of added) active.add(name);
      for (const name of gone) active.delete(name);
      pi.setActiveTools([...active]);
      console.log(`[pdb.pi] tools reconciled: +${added.length} -${gone.length}, active ${active.size}`);
    }

    const impl = createPiApiImpl(pi, { onMcpServer, onSkill, onUi, toolNames: collected });
    const host = createPluginHost({ agent: "pi", pluginsDir, configPath, impl });

    const loaded = await host.load();
    offered = new Set(collected);
    if (typeof onLoaded === "function") onLoaded({ loaded, host });

    // Watch the library and the enable config: reload in place. pi's
    // registerTool refreshes the registry itself, so no session reload and no
    // process restart is involved.
    const stopWatching = host.watch(async () => {
      collected.clear();
      try {
        await host.load();
      } catch (error) {
        console.error(`[pdb.pi] reload failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      reconcileActiveTools();
    });

    pi.on("session_shutdown", async () => {
      // pi invalidates this extension ctx on reload/replacement; stop watching
      // so a replaced session's adapter cannot keep registering into it.
      stopWatching();
    });
  };
}

module.exports = {
  createPiAdapter,
  createPiApiImpl,
  normalizeContent,
  normalizeResult,
  toPluginCtx,
  EVENT_MAP,
};
