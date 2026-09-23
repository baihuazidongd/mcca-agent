/**
 * @mcca/plugin-host — shared plugin library loader.
 *
 * Scans the shared plugins directory, filters by agent target and enable
 * state, loads each plugin entry through a native `PluginApiImpl`, and tracks
 * the returned disposers so plugins can be hot-unloaded and re-loaded.
 *
 * This package is runtime-agnostic: the dsh adapter and the pi adapter each
 * provide their own `PluginApiImpl` and call the same loaders.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPluginApi,
  type Disposer,
  type PluginApiImpl,
  type PluginFactory,
  type PluginManifest,
  type PluginTarget,
} from "@mcca/plugin-sdk";

const MANIFEST_FILES = ["manifest.json", "plugin.json"] as const;

/** A plugin discovered on disk, before it is loaded. */
export interface DiscoveredPlugin {
  dir: string;
  entryPath: string;
  manifest: PluginManifest;
}

/** A plugin after loading (or a per-plugin load failure). */
export interface LoadedPlugin {
  name: string;
  dir: string;
  entryPath: string;
  manifest: PluginManifest;
  state: "loaded" | "error";
  error?: string;
  dispose(): Promise<void>;
}

/** Per-agent enable state: `{ ds: { name: boolean }, pi: { name: boolean } }`. */
export type EnableConfig = Partial<Record<PluginTarget, Record<string, boolean>>>;

export interface LoadAgentOptions {
  agent: PluginTarget;
  pluginsDir: string;
  config: EnableConfig;
  impl: PluginApiImpl;
}

export interface PluginHostOptions {
  agent: PluginTarget;
  pluginsDir: string;
  configPath: string;
  impl: PluginApiImpl;
}

export interface PluginHost {
  readonly agent: PluginTarget;
  discover(): DiscoveredPlugin[];
  load(): Promise<LoadedPlugin[]>;
  loaded(): LoadedPlugin[];
  setEnabled(name: string, enabled: boolean): Promise<void>;
  reload(): Promise<LoadedPlugin[]>;
  disposeAll(): Promise<void>;
  /** Watch the plugins dir + config file; returns a stop function. */
  watch(onChange: () => void | Promise<void>): () => void;
}

export function discoverPlugins(pluginsDir: string): DiscoveredPlugin[] {
  const root = path.resolve(pluginsDir);
  const found: DiscoveredPlugin[] = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    found.push({ dir, entryPath: resolveEntry(dir, manifest), manifest });
  }
  return found.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

function readManifest(dir: string): PluginManifest | null {
  for (const name of MANIFEST_FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      const raw = JSON.parse(text) as PluginManifest;
      if (typeof raw?.name === "string" && raw.name) return raw;
      return null;
    } catch (error) {
      console.warn(`[plugin-host] failed to parse manifest in ${dir}:`, error instanceof Error ? error.message : error);
      return null;
    }
  }
  return null;
}

function resolveEntry(dir: string, manifest: PluginManifest): string {
  const candidates = [
    manifest.entry,
    "index.mjs",
    "index.js",
    "index.cjs",
    "index.ts",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const candidate of candidates) {
    const file = path.resolve(dir, candidate);
    if (fs.existsSync(file)) return file;
  }
  return path.resolve(dir, candidates[0] ?? "index.mjs");
}

export function readEnableConfig(configPath: string): EnableConfig {
  const file = path.resolve(configPath);
  if (!fs.existsSync(file)) return {};
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text) as unknown;
    return raw && typeof raw === "object" ? (raw as EnableConfig) : {};
  } catch (error) {
    // A silently-unreadable config means "everything enabled" downstream —
    // surface it instead of quietly discarding every toggle.
    console.warn(`[plugin-host] failed to parse enable config ${file}:`, error instanceof Error ? error.message : error);
    return {};
  }
}

/** A plugin is active for an agent when it targets the agent and isn't disabled. */
export function isEnabled(
  manifest: PluginManifest,
  agent: PluginTarget,
  config: EnableConfig,
): boolean {
  const targets = manifest.targets;
  if (targets && targets.length > 0 && !targets.includes(agent)) return false;
  return config[agent]?.[manifest.name] ?? true;
}

async function resolveFactory(entryPath: string): Promise<PluginFactory> {
  // Append the mtime so re-loading a hot-edited file bypasses the ESM cache.
  const mtimeMs = fs.existsSync(entryPath) ? fs.statSync(entryPath).mtimeMs : Date.now();
  const href = `${pathToFileURL(entryPath).href}?t=${mtimeMs}`;
  const mod = (await import(href)) as Record<string, unknown>;
  const candidate = mod.factory ?? mod.default ?? (typeof mod === "function" ? mod : undefined);
  if (typeof candidate === "function") return candidate as PluginFactory;
  const keys = Object.keys(mod).join(", ") || "(empty module)";
  throw new Error(`plugin entry must export a factory (default or named "factory"); got: ${keys}`);
}

export async function loadPlugin(
  discovered: DiscoveredPlugin,
  impl: PluginApiImpl,
): Promise<LoadedPlugin> {
  const base = {
    name: discovered.manifest.name,
    dir: discovered.dir,
    entryPath: discovered.entryPath,
    manifest: discovered.manifest,
  };
  try {
    const factory = await resolveFactory(discovered.entryPath);
    const api = createPluginApi(impl);
    const returned = await factory(api);
    if (typeof returned === "function") api.disposers.push(returned as Disposer);
    return { ...base, state: "loaded" as const, dispose: api.dispose };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, state: "error" as const, error: message, dispose: async () => {} };
  }
}

export async function loadAgentPlugins(options: LoadAgentOptions): Promise<LoadedPlugin[]> {
  const { agent, pluginsDir, config, impl } = options;
  const enabled = discoverPlugins(pluginsDir).filter((d) => isEnabled(d.manifest, agent, config));
  const results: LoadedPlugin[] = [];
  for (const plugin of enabled) {
    results.push(await loadPlugin(plugin, impl));
  }
  return results;
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const { agent, pluginsDir, configPath, impl } = options;
  let instances: LoadedPlugin[] = [];
  // Serialize load/reload cycles: a burst of file events must not run
  // concurrent dispose+load passes, which would interleave disposers and
  // double-register tools.
  let loadChain: Promise<LoadedPlugin[]> = Promise.resolve([]);

  async function disposeAll(): Promise<void> {
    const current = instances;
    instances = [];
    for (const plugin of current) {
      try {
        await plugin.dispose();
      } catch {
        // A failing disposer must not block unloading the rest.
      }
    }
  }

  async function load(): Promise<LoadedPlugin[]> {
    // Chain onto the in-flight pass; every caller receives its own snapshot.
    const run = loadChain.then(async () => {
      await disposeAll();
      const config = readEnableConfig(configPath);
      instances = await loadAgentPlugins({ agent, pluginsDir, config, impl });
      return [...instances];
    });
    loadChain = run.then(() => [], () => []);
    return run;
  }

  async function setEnabled(name: string, enabled: boolean): Promise<void> {
    const config = readEnableConfig(configPath);
    const perAgent = { ...(config[agent] ?? {}) };
    perAgent[name] = enabled;
    config[agent] = perAgent;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  function watch(onChange: () => void | Promise<void>): () => void {
    let pending: NodeJS.Timeout | null = null;
    const schedule = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        void onChange();
      }, 120);
    };
    const watchers: fs.FSWatcher[] = [];

    // Coarse fingerprint (plugin dir names plus every manifest/entry mtime and
    // the config mtime). Used by the polling fallback below; content edits move
    // an mtime, so they are covered.
    const stamp = (): string => {
      const parts: string[] = [];
      try {
        for (const name of fs.readdirSync(pluginsDir).sort()) {
          parts.push(name);
          for (const file of ["manifest.json", "index.mjs", "index.js"]) {
            try {
              parts.push(`${Math.round(fs.statSync(path.join(pluginsDir, name, file)).mtimeMs)}`);
            } catch {
              parts.push("0");
            }
          }
        }
      } catch {
        parts.push("nodir");
      }
      try {
        parts.push(`cfg:${Math.round(fs.statSync(configPath).mtimeMs)}`);
      } catch {
        parts.push("cfg:0");
      }
      return parts.join("|");
    };

    // Windows raises EPERM on an FSWatcher whose path was deleted, and an
    // unhandled 'error' event on a watcher takes the whole host process down.
    // A dead watcher therefore degrades to polling instead of killing anything.
    let pollTimer: NodeJS.Timeout | null = null;
    let lastStamp = stamp();
    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        const next = stamp();
        if (next !== lastStamp) {
          lastStamp = next;
          schedule();
        }
      }, 2000);
    };
    const attach = (watcher: fs.FSWatcher) => {
      watcher.on("error", (error: NodeJS.ErrnoException) => {
        console.warn(`[mcca.host] plugin watcher failed (${error?.code ?? "unknown"}); falling back to polling`);
        const at = watchers.indexOf(watcher);
        if (at >= 0) watchers.splice(at, 1);
        try {
          watcher.close();
        } catch {
          // already closed
        }
        lastStamp = stamp();
        startPolling();
        schedule();
      });
      watchers.push(watcher);
    };

    if (fs.existsSync(pluginsDir)) {
      attach(fs.watch(pluginsDir, { recursive: true }, () => schedule()));
    }
    if (fs.existsSync(configPath)) {
      attach(fs.watch(configPath, () => schedule()));
    }
    return () => {
      if (pending) clearTimeout(pending);
      if (pollTimer) clearInterval(pollTimer);
      for (const w of watchers) w.close();
    };
  }

  return {
    agent,
    discover: () => discoverPlugins(pluginsDir),
    load,
    loaded: () => [...instances],
    setEnabled,
    reload: load,
    disposeAll,
    watch,
  };
}
