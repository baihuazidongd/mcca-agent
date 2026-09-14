/**
 * @pi-dsh-bridge/plugin-sdk — the neutral plugin contract.
 *
 * This is the ONLY package a shared plugin author depends on. It is a small,
 * stable surface that both runtimes (DeepSeek Harness and pi) adapt to, so a
 * tool / command / MCP server / skill written once works on both agents
 * without per-agent modification.
 */

/** What kind of capability a plugin contributes. */
export type PluginKind = "tool" | "command" | "mcp" | "skill" | "ui";

/**
 * Where a registered UI extension anchors inside a web surface that can host
 * it. Slots are advisory metadata: the surface decides how each anchor renders,
 * and an unknown anchor on any given surface is simply ignored (e.g. dsh's own
 * client keeps using its official client-bundle mechanism).
 */
export type UiSlot = "sidebar" | "message-actions" | "overlay";

/** A browser-side extension contributed by a UI-kind plugin. */
export interface UiDefinition {
  /**
   * Stable identifier, `[A-Za-z0-9_-]+`. Conventionally the plugin directory
   * name; hosts serve the entry module from `/ui-plugins/<name>/<entry>`.
   */
  name: string;
  /** Human title (display language free — the pdb library uses Chinese). */
  title: string;
  /** One-line explanation of what the extension does. */
  description?: string;
  /** Anchor the extension prefers. */
  slot: UiSlot;
  /** Browser module relative to the plugin directory. Defaults to "ui/main.js". */
  entry?: string;
}

/** Which agent runtime a plugin supports. */
export type PluginTarget = "ds" | "pi";

/** JSON Schema (draft-07-ish) object describing a tool's parameters. */
export type JsonSchema = Record<string, unknown>;

export interface PluginManifest {
  name: string;
  version: string;
  kind: PluginKind;
  /** Runtime targets. Omitted or empty means both ds and pi. */
  targets?: PluginTarget[];
  description?: string;
  /** Entry module relative to the plugin directory. Defaults to index.{mjs,js,cjs,ts}. */
  entry?: string;
}

export interface PluginCtx {
  /** The agent's working directory. */
  cwd: string;
  /** Which agent this plugin is running under. */
  agent: PluginTarget;
  [key: string]: unknown;
}

export interface ToolResult {
  content: unknown;
  details?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: unknown, ctx: PluginCtx): Promise<ToolResult>;
}

export interface CommandDefinition {
  description: string;
  handler(args: unknown, ctx: PluginCtx): void | Promise<void>;
}

export interface McpServerConfig {
  serverName: string;
  transport: "stdio" | "sse";
  /** stdio transport. */
  command?: string;
  args?: string[];
  /** sse transport. */
  url?: string;
  env?: Record<string, string>;
}

export interface SkillDefinition {
  name: string;
  description: string;
  /** Markdown body (SKILL.md content without frontmatter). */
  body: string;
}

export type PluginEventName = "session_start" | "session_end" | "input" | "turn_end";

export interface PluginEvent {
  type: PluginEventName;
  [key: string]: unknown;
}

export type PluginEventHandler = (
  event: PluginEvent,
  ctx: PluginCtx,
) => void | Promise<void>;

/** Reverses a registration. Hot-unload runs each plugin's disposers in reverse order. */
export type Disposer = () => void | Promise<void>;

/**
 * The API handed to a plugin factory. Every register* call returns a disposer;
 * the host tracks them automatically, so authors do not need to return them.
 */
export interface PluginAPI {
  registerTool(def: ToolDefinition): Disposer;
  registerCommand(name: string, def: CommandDefinition): Disposer;
  registerMcpServer(cfg: McpServerConfig): Disposer;
  registerSkill(skill: SkillDefinition): Disposer;
  /** Declare a browser-side extension; the hosting web surface mounts it. */
  registerUi(def: UiDefinition): Disposer;
  on(event: PluginEventName, handler: PluginEventHandler): Disposer;
}

/** A plugin entry module exports a factory (default, named `factory`, or bare). */
export type PluginFactory = (api: PluginAPI) => void | Promise<void>;

/**
 * The native side of the contract. Each adapter (dsh / pi) implements these
 * five operations against its own runtime, and hands the result to
 * `createPluginApi`, which wraps them with disposer tracking.
 */
export interface PluginApiImpl {
  registerTool(def: ToolDefinition): Disposer | void;
  registerCommand(name: string, def: CommandDefinition): Disposer | void;
  registerMcpServer(cfg: McpServerConfig): Disposer | void;
  registerSkill(skill: SkillDefinition): Disposer | void;
  registerUi(def: UiDefinition): Disposer | void;
  on(event: PluginEventName, handler: PluginEventHandler): Disposer | void;
}

/** A fully wired PluginAPI plus the disposers accumulated by a single plugin. */
export interface PluginApiInstance extends PluginAPI {
  disposers: Disposer[];
  /** Run all accumulated disposers in reverse order (hot-unload). */
  dispose(): Promise<void>;
}

/**
 * Wrap a native `PluginApiImpl` with disposer tracking. Adapters call this once
 * per plugin, pass the returned object to the plugin factory, and keep the
 * returned `dispose()` for hot-unload.
 */
export function createPluginApi(impl: PluginApiImpl): PluginApiInstance {
  const disposers: Disposer[] = [];
  const track = (disposer: Disposer | void): Disposer => {
    const d = typeof disposer === "function" ? disposer : () => {};
    disposers.push(d);
    return d;
  };
  const api: PluginAPI = {
    registerTool: (def) => track(impl.registerTool(def)),
    registerCommand: (name, def) => track(impl.registerCommand(name, def)),
    registerMcpServer: (cfg) => track(impl.registerMcpServer(cfg)),
    registerSkill: (skill) => track(impl.registerSkill(skill)),
    registerUi: (def) => track(impl.registerUi(def)),
    on: (event, handler) => track(impl.on(event, handler)),
  };
  return {
    ...api,
    disposers,
    async dispose() {
      for (const d of disposers.splice(0).reverse()) {
        try {
          await d();
        } catch {
          // Keep disposing the rest even if one disposer throws.
        }
      }
    },
  };
}

/**
 * Type helper for plugin authors: bundles a manifest and factory into one
 * descriptor. Purely ergonomic — the runtime reads the manifest from disk.
 */
export function definePlugin(manifest: PluginManifest, factory: PluginFactory) {
  return { manifest, factory };
}
