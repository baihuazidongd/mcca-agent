# Architecture

How one plugin library ends up running in two agent runtimes, and why neither
runtime had to be modified.

## The problem

dsh and pi are independent agent runtimes. Each has its own extension
mechanism, its own tool schema, its own event names, and its own idea of what a
"plugin" is. If you write a tool for pi, dsh cannot load it, and the reverse is
equally true.

The naive fix is to duplicate every capability — two copies of each tool, two
copies of each MCP registration, two skill directories. That works until the
first rename, at which point the two runtimes disagree about a tool name and the
divergence is silent.

This project takes the other route: a narrow neutral contract, plus one adapter
per runtime that translates the contract into that runtime's native
registration calls.

```
                    plugins/          config/mcp.json        skills/
                       │                    │                   │
                       ▼                    ▼                   ▼
                 ┌───────────────────────────────────────────────────┐
                 │  @mcca/plugin-host  (runtime-agnostic)            │
                 │  discovery · enable state · load/unload · isolate │
                 └───────────┬───────────────────────┬───────────────┘
                             │ PluginApiImpl         │ PluginApiImpl
                  ┌──────────▼──────────┐  ┌─────────▼─────────────┐
                  │   pi-adapter        │  │   dsh-adapter         │
                  │  pi extension       │  │  Cordis bundle        │
                  └──────────┬──────────┘  └─────────┬─────────────┘
                             ▼                       ▼
                           pi (npm)              dsh (npm)
```

## The contract

`packages/plugin-sdk` defines the whole surface, and it is deliberately small:
a manifest type, six registration methods, and a disposer rule. It contains no
runtime-specific code and imports nothing from either runtime.

A plugin exports a factory that receives the API:

```ts
export type PluginFactory = (api: PluginAPI) => void | Promise<void>;

export interface PluginAPI {
  registerTool(def: ToolDefinition): Disposer;
  registerCommand(name: string, def: CommandDefinition): Disposer;
  registerMcpServer(cfg: McpServerConfig): Disposer;
  registerSkill(skill: SkillDefinition): Disposer;
  registerUi(def: UiDefinition): Disposer;
  on(event: PluginEventName, handler: PluginEventHandler): Disposer;
}
```

Two details carry most of the weight.

**Every registration returns a disposer.** `createPluginApi` wraps a native
implementation and collects the disposers it produces, so a plugin author never
has to manage teardown. `dispose()` runs them in reverse registration order and
keeps going if one throws. Hot-unload is therefore a property of the contract
rather than something each plugin has to remember to implement.

**Events are neutral.** The contract names `session_start`, `session_end`,
`input` and `turn_end`. Each adapter maps those onto whatever its runtime
actually emits, which is where the naming discrepancies get absorbed rather than
leaking into plugin code.

## The loader

`packages/plugin-host` knows nothing about dsh or pi. It:

- scans the shared plugin directory for `manifest.json` (or `plugin.json`),
- filters by `targets` and by the per-agent enable state in
  `config/plugins.json`,
- loads each entry through a `PluginApiImpl` supplied by the adapter,
- records `loaded` or `error` per plugin, so one plugin failing to load does not
  prevent the rest — the failure is reported in the management UI instead,
- keeps each plugin's `dispose()` for hot-unload.

The important consequence is that both adapters share one implementation of
discovery, enable state and lifecycle. Only the thin translation layer differs
between runtimes.

## The pi adapter

A pi extension is a factory `(pi) => void | Promise<void>` receiving pi's
`ExtensionAPI`. `packages/pi-adapter` loads the shared plugins through the host
and maps the contract onto `pi.registerTool`, `pi.registerCommand` and `pi.on`.

Its event mapping is:

| Neutral event | pi event | Note |
| --- | --- | --- |
| `session_start` | `session_start` | direct |
| `session_end` | `session_shutdown` | pi has no `session_end`; shutdown fires on quit, reload, new, resume and fork, which is the closest teardown signal |
| `input` | `input` | direct |
| `turn_end` | `turn_end` | direct |

Hot reload does not call `session.reload()`. pi's own runtime API is sufficient:

- `pi.registerTool()` is valid after load and refreshes the tool set itself, so
  a new or changed tool implementation is live on the next agent turn.
- `pi.setActiveTools(names)` swaps the active tool set and rebuilds the system
  prompt, also on the next turn, and ignores unknown names.

pi has no per-tool unregister. A plugin that is disabled or removed is therefore
hidden from the active set rather than deleted from the registry — identical
from the model's point of view. Commands are the exception: pi's command map is
built at load time, so a newly added command still needs a new session, while
tools and their behaviour do not.

## The dsh adapter

dsh's plugin unit is a Cordis function plugin, declared by `name`, `inject` and
`apply`. `packages/dsh-adapter` is one, and it maps the contract like this:

| Contract call | Under dsh |
| --- | --- |
| `registerTool` | `ctx.tools.register` with a raw JSON Schema tool definition — the same entry point MCP-sourced tools use. `execute` returns one canonical JSON value, and `output.render` projects the neutral content blocks into model-facing text. |
| `registerCommand` | `ctx.commands.register({ name, description, handler })` |
| `on(...)` | `ctx.on('agent/created' \| 'agent/disposed' \| 'session/event')` |
| `registerMcpServer` | Not mounted here. dsh's official per-server plugin is `@deepseek-ai/dsh-mcp-client`; servers are declared in the shared registry and mounted through generated rows. |
| `registerSkill` | Not a runtime object. The shared `skills/` directory is mounted as files by the `skill-filesystem` provider. |
| `registerUi` | No-op. dsh renders its own native client-bundle rows, so there is no shared-UI mount surface to target. |

The module deliberately imports nothing from dsh — `ctx` is duck-typed. That
removes any peer-dependency constraint and lets the adapter sit in this
repository without depending on dsh's package layout, which matters because dsh
is an early release candidate.

The three unsupported surfaces call back with a message explaining where the
real mechanism lives rather than failing silently, so a plugin author who
registers an MCP server and sees nothing happen gets told why.

Hot reload does not rely on dsh HMR. The plugin host watches the shared plugin
directory and the enable config itself, and re-runs the load on change, which
disposes the previous registrations through the tracked disposers.

## Mounting dsh without changing it

dsh boots from a profile. This project ships one at `dsh/profiles/web/`, and the
interesting part is which layer its rows live in.

`scripts/bootstrap.mjs` materialises `dsh/profiles/web/cordis.patch.template.yml`
into the dsh home as `profiles/web/cordis.patch.yml`. That is the profile's
**watched** layer: dsh re-resolves the plugin set when the file changes. The
bridge's own plugin set is not baked into that file, though — it is decided at
runtime by `config/hot-plugins.json`, with `packages/hot-mount` acting as the
supervisor. Adding or removing a bridge plugin therefore needs no dsh restart.

The portal additionally passes `--patch` overlays when it launches dsh. Those
are one-shot layers read at start, one of which carries the generated MCP rows.
That is the split worth remembering: the bridge's own plugin set is decided at
runtime and needs no restart, while a change to the MCP registry does.

The profile's `package.json` declares its dependencies and its bundle graph:

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

The two bundles are the upstream boot graph; the profile's own dependencies are
the plugins the bridge mounts into dsh.

## MCP: one registry, two consumers

`config/mcp.json` is a single list, and the two runtimes consume it differently:

- **pi** reads it directly through `packages/pi-mcp`, a stdio/SSE JSON-RPC client
  that exposes each tool as `mcp__<serverName>__<tool>`.
- **dsh** gets one generated row per server in `config/dsh-mcp.patch.yml`,
  emitted by `scripts/gen-dsh-mcp-patch.mjs`, mounting dsh's own
  `@deepseek-ai/dsh-mcp-client`.

Generating the dsh side rather than maintaining it by hand is what makes the
shared registry real. There is no second list to drift, and both runtimes use
the same `mcp__<server>__<tool>` naming, so a name learned in one agent is valid
in the other. An entry marked `"dsh": false` is skipped during generation.

Values in the registry support `${VAR}` and `${VAR:-fallback}` placeholders,
expanded when a server is connected rather than when the registry is read — see
the configuration section of the README for the reasoning.

## Skills: files, not runtime objects

Skills occupy a different slot in each runtime. In pi they are discovered through
its resource loader. In dsh they are provided by `skill-filesystem`, which the
`web` profile disables by default.

The bridge re-enables that provider in the profile mount layer with a distinct
`providerName` and `includeDefaultRoots: false`, pointing `customSkillDirs` at
the shared `skills/` directory. The result is the same set of skills on both
sides, discovered from the same files — which is why `registerSkill` exists in
the contract for programmatic cases but the shipped directory needs no adapter
code at all.

## Summary of the seams

| Concern | Where it is absorbed |
| --- | --- |
| Tool registration | One adapter method per runtime |
| Event names | `EVENT_MAP` in the pi adapter; `ctx.on` translation in the dsh adapter |
| Teardown | `createPluginApi` disposer tracking in the contract |
| Tool removal | Active-set swap in pi; loader re-resolve in dsh |
| MCP servers | Generated per-server rows for dsh; direct client for pi |
| Skills | Filesystem provider re-enabled in the dsh profile |
| UI extensions | Native per-runtime mechanism; no shared surface |
| dsh version churn | Adapter imports nothing from dsh |
