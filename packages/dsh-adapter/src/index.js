/**
 * @pi-dsh-bridge/dsh-adapter -- the dsh-side adapter for the neutral plugin contract.
 *
 * A Cordis function plugin (`name` / `inject` / `apply`) that loads the shared
 * neutral plugins through `@pi-dsh-bridge/plugin-host` and maps their registration
 * calls onto dsh:
 *
 *   registerTool      -> ctx.tools.register(raw JSON-Schema ToolDefinition)
 *                        (the same entry MCP-sourced tools use; execute returns
 *                        one canonical JSON value, output.render projects the
 *                        neutral content blocks to model-facing text)
 *   registerCommand   -> ctx.commands.register({ name, description, handler })
 *   on(...)           -> ctx.on('agent/created' | 'agent/disposed' |
 *                               'session/event')
 *   registerMcpServer -> NOT mounted here: dsh's official per-server plugin is
 *                        `@deepseek-ai/dsh-mcp-client`; declare servers in the
 *                        shared config/mcp.json and mount them through the
 *                        generated config/dsh-mcp.patch.yml rows instead.
 *   registerSkill     -> files, not runtime objects: the shared skills/ dir is
 *                        wired via skill-filesystem `customSkillDirs` in the
 *                        web profile's cordis patch layer.
 *   registerUi        -> no-op under dsh: the dsh UI renders its own native
 *                        client-bundle rows; the old shared-UI registry
 *                        (GET /pdb/ui-plugins) had no consumer and is gone.
 *
 * The module deliberately imports nothing from dsh -- `ctx` is duck-typed -- so
 * the adapter has zero peer-dependency resolution constraints and can sit in
 * any repo. Hot reload does NOT rely on dsh HMR: the plugin host watches the
 * shared plugins dir + enable config itself and re-runs load (disposing old
 * registrations through its tracked disposers) on change.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginHost, discoverPlugins, readEnableConfig } from "@pi-dsh-bridge/plugin-host";

/** Repo root (this file is packages/dsh-adapter/src/index.js). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Cordis function-plugin name. */
export const name = "pdb-dsh-adapter";

/** Services required before the shared plugins may register. */
export const inject = ["tools", "commands"];

/** Normalize a neutral ToolResult into dsh's canonical JSON value. */
export function normalizeResult(result) {
  if (result == null) return { content: [] };
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  if (Array.isArray(result)) return { content: result };
  const out = { content: result.content ?? [] };
  if (result.details !== undefined) out.details = result.details;
  return out;
}

/** Project a canonical neutral value into model-facing text blocks. */
export function renderNeutral(_args, value) {
  const blocks = Array.isArray(value?.content) ? value.content : [];
  return blocks.map((block) =>
    block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
      ? { type: "text", text: block.text }
      : { type: "text", text: JSON.stringify(block) },
  );
}

/** dsh command names must match /^[a-z][a-z0-9_-]*$/. */
export function sanitizeCommandName(input) {
  const cleaned = String(input || "command")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `cmd-${cleaned}`;
}

/** Map a neutral event name onto its dsh extension point. */
export const EVENT_MAP = {
  session_start: { kind: "agent", event: "agent/created" },
  session_end: { kind: "agent", event: "agent/disposed" },
  input: { kind: "session", type: "user/message" },
  turn_end: { kind: "session", type: "turn/end" },
};

/**
 * Build the native PluginApiImpl that maps neutral registration onto a dsh
 * Context. Exported for tests; `apply` wires it to the real ctx.
 */
export function createDshApiImpl(ctx, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const pluginCtx = (signal) => ({ cwd, agent: "ds", signal });

  return {
    registerTool(def) {
      return ctx.tools.register({
        name: def.name,
        description: def.description,
        // Raw JSON Schema is accepted directly (the MCP-tool entry path).
        parameters: def.parameters ?? { type: "object" },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: renderNeutral,
        },
        async execute(args, exec) {
          const result = await def.execute(args, pluginCtx(exec?.signal));
          return normalizeResult(result);
        },
      });
    },

    registerCommand(input, def) {
      const commandName = sanitizeCommandName(input);
      return ctx.commands.register({
        name: commandName,
        description: def.description || `command ${commandName}`,
        async handler(invocation) {
          const out = await def.handler(invocation.rawInput, pluginCtx(invocation.signal));
          return typeof out === "string" ? { kind: "success", text: out } : { kind: "success" };
        },
      });
    },

    registerMcpServer(cfg) {
      console.warn(
        `[pdb] registerMcpServer(${cfg?.serverName}) is a no-op under dsh: ` +
          `declare the server in config/mcp.json -- it is mounted through the ` +
          `official @deepseek-ai/dsh-mcp-client rows in config/dsh-mcp.patch.yml.`,
      );
    },

    registerSkill() {
      console.warn(
        "[pdb] registerSkill() is a no-op under dsh: put SKILL.md bundles in " +
          "the shared skills/ dir (wired via skill-filesystem customSkillDirs).",
      );
    },

    // UI-kind shared plugins: nothing consumes a dsh-side UI registry
    // (the old /pdb/ui-plugins routes are gone), so the registration is a
    // no-op that still returns a disposer to honor the contract.
    registerUi() {
      console.warn(
        "[pdb] registerUi() is a no-op under dsh: the shared-UI mount surface " +
          "had no consumer and was removed; dsh UIs are native client-bundles.",
      );
      return () => {};
    },

    on(event, handler) {
      const mapping = EVENT_MAP[event];
      if (!mapping) return () => {};
      if (mapping.kind === "agent") {
        return ctx.on(mapping.event, () => {
          void handler({ type: event }, pluginCtx());
        });
      }
      return ctx.on("session/event", (_session, dshEvent) => {
        if (dshEvent?.type !== mapping.type) return;
        const data = dshEvent && typeof dshEvent === "object" ? dshEvent.data : undefined;
        void handler(
          { ...(data && typeof data === "object" ? data : {}), type: event },
          pluginCtx(),
        );
      });
    },
  };
}


/**
 * Cordis plugin entry.
 *
 * @param {object} ctx - dsh Context (duck-typed: tools/commands/on/effect).
 * @param {{ pluginsDir?: string, configPath?: string, cwd?: string }} [config]
 *   Row config from the patch file. Defaults point at the pdb repo root.
 */
export function apply(ctx, config) {
  const root = config?.cwd ?? ROOT;
  const pluginsDir = config?.pluginsDir ?? path.join(root, "plugins");
  const configPath = config?.configPath ?? path.join(root, "config", "plugins.json");

  const impl = createDshApiImpl(ctx, { cwd: root });
  const host = createPluginHost({ agent: "ds", pluginsDir, configPath, impl });

  ctx.effect(() => {
    let stopped = false;
    const load = () => {
      if (stopped) return;
      void host.load();
    };
    load();
    const stopWatch = host.watch(() => load());
    return () => {
      stopped = true;
      stopWatch();
      return host.disposeAll();
    };
  }, "pdb.plugins()");
}
