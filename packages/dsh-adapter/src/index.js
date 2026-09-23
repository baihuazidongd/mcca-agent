/**
 * @mcca/dsh-adapter 鈥?the dsh-side adapter for the neutral plugin contract.
 *
 * A Cordis function plugin (`name` / `inject` / `apply`) that loads the shared
 * neutral plugins through `@mcca/plugin-host` and maps their registration
 * calls onto dsh:
 *
 *   registerTool      鈫?ctx.tools.register(raw JSON-Schema ToolDefinition)
 *                       (the same entry MCP-sourced tools use; execute returns
 *                       one canonical JSON value, output.render projects the
 *                       neutral content blocks to model-facing text)
 *   registerCommand   鈫?ctx.commands.register({ name, description, handler })
 *   on(...)           鈫?ctx.on('agent/created' | 'agent/disposed' |
 *                              'session/event')
 *   registerMcpServer 鈫?NOT mounted here: dsh's official per-server plugin is
 *                       `@deepseek-ai/dsh-mcp-client`; declare servers in the
 *                       shared config/mcp.json and mount them through the
 *                       generated config/dsh-mcp.patch.yml rows instead.
 *   registerSkill     鈫?files, not runtime objects: the shared skills/ dir is
 *                       wired via skill-filesystem `customSkillDirs` in
 *                       config/dsh.patch.yml.
 *   registerUi        鈫?no-op under dsh: the dsh UI renders its own native
 *                       client-bundle rows (ui-message-jump, content-preview
 *                       in config/dsh.patch.yml); the old shared-UI registry
 *                       (GET /mcca/ui-plugins) had no consumer and is gone.
 *
 * The module deliberately imports nothing from dsh 鈥?`ctx` is duck-typed 鈥?so
 * the adapter has zero peer-dependency resolution constraints and can sit in
 * any repo. Hot reload does NOT rely on dsh HMR: the plugin host watches the
 * shared plugins dir + enable config itself and re-runs load (disposing old
 * registrations through its tracked disposers) on change.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginHost, discoverPlugins, readEnableConfig } from "@mcca/plugin-host";

/** Repo root (this file is packages/dsh-adapter/src/index.js). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Cordis function-plugin name. */
export const name = "mcca-dsh-adapter";

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

/** Session cwd when dsh put one on the agent; otherwise the adapter fallback. */
export function sessionCwd(exec, fallback) {
  const fromHeader = exec?.agent?.session?.header?.cwd;
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader;
  return fallback;
}

/**
 * Build the native PluginApiImpl that maps neutral registration onto a dsh
 * Context. Exported for tests; `apply` wires it to the real ctx.
 */
export function createDshApiImpl(ctx, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const pluginCtx = (exec) => ({ cwd: sessionCwd(exec, cwd), agent: "ds", signal: exec?.signal });

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
          const result = await def.execute(args, pluginCtx(exec));
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
          const out = await def.handler(invocation.rawInput, pluginCtx(invocation));
          return typeof out === "string" ? { kind: "success", text: out } : { kind: "success" };
        },
      });
    },

    registerMcpServer(cfg) {
      console.warn(
        `[mcca] registerMcpServer(${cfg?.serverName}) is a no-op under dsh: ` +
          `declare the server in config/mcp.json 鈥?it is mounted through the ` +
          `official @deepseek-ai/dsh-mcp-client rows in config/dsh-mcp.patch.yml.`,
      );
    },

    registerSkill() {
      console.warn(
        "[mcca] registerSkill() is a no-op under dsh: put SKILL.md bundles in " +
          "the shared skills/ dir (wired via skill-filesystem customSkillDirs).",
      );
    },

    // UI-kind shared plugins: nothing consumes a dsh-side UI registry
    // (the old /mcca/ui-plugins routes are gone), so the registration is a
    // no-op that still returns a disposer to honor the contract.
    registerUi() {
      console.warn(
        "[mcca] registerUi() is a no-op under dsh: the shared-UI mount surface " +
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
 *   Row config from the patch file. Defaults point at the mcca repo root.
 */
export function apply(ctx, config) {
  const root = config?.cwd ?? ROOT;
  const pluginsDir = config?.pluginsDir ?? path.join(root, "plugins");
  const configPath = config?.configPath ?? path.join(root, "config", "plugins.json");

  const impl = createDshApiImpl(ctx, { cwd: root });
  const host = createPluginHost({ agent: "ds", pluginsDir, configPath, impl });
  // Built-in IDE tools (memory, computer) live in the package so they are not
  // lost with the gitignored local plugins/ tree.
  const ideDir = path.join(ROOT, "packages", "agent-ide", "plugins");
  const ideHost = createPluginHost({ agent: "ds", pluginsDir: ideDir, configPath, impl });

  ctx.effect(() => {
    let stopped = false;
    const load = () => {
      if (stopped) return;
      void host.load();
      void ideHost.load();
    };
    load();
    const stopWatch = host.watch(() => load());
    const stopIde = ideHost.watch(() => load());
    return () => {
      stopped = true;
      stopWatch();
      stopIde();
      return Promise.all([host.disposeAll(), ideHost.disposeAll()]);
    };
  }, "mcca.plugins()");
}
