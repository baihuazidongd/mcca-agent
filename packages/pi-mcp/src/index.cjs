"use strict";

/**
 * @pi-dsh-bridge/pi-mcp — MCP client for pi.
 *
 * Reads MCP server configs (shared registry + any servers plugins register
 * through the adapter) and exposes each server's tools as pi tools named
 * `mcp__<server>__<tool>`, matching DeepSeek Harness's `mcp__<server>__<tool>`
 * naming so both runtimes surface the same tool names.
 *
 * Two transports:
 *  - "stdio": spawn a child process and speak newline-delimited JSON-RPC 2.0.
 *  - "sse":   Streamable HTTP — POST JSON-RPC to `url`; accepts a JSON body or
 *             a `text/event-stream` response.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// `${VAR}` / `${VAR:-fallback}` expansion for machine-specific values in the
// shared registry. config/mcp.json is committed, so an absolute path that
// carries a user name has to be expressed as `${USERPROFILE}/...` instead. A
// variable that is unset and has no fallback is left verbatim: a visibly
// unexpanded placeholder beats silently spawning an empty command.
//
// Expansion belongs here, at connect time, rather than in readMcpServers:
// portal rewrites this file on every enable/disable toggle, so resolving
// earlier would persist the local path back into the committed config.
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function expandEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(ENV_PLACEHOLDER, (match, name, fallback) => {
    const resolved = process.env[name];
    if (resolved) return resolved;
    return fallback === undefined ? match : fallback;
  });
}

function expandEnvMap(values) {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, expandEnv(value)]));
}

// Windows command-line quoting, mirroring Node's internal algorithm, so a
// command line rebuilt for `cmd.exe /c` parses back to the same argv.
function windowsQuote(value) {
  const s = String(value);
  if (s !== "" && !/[\s"]/.test(s)) return s;
  let escaped = s.replace(/(\\*)"/g, "$1$1\\\"");
  escaped = escaped.replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

// ── stdio transport ─────────────────────────────────────────────

class StdioJsonRpc {
  constructor(options = {}) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env ?? {};
    this.logger = options.logger;
    this.nextId = 0;
    this.pending = new Map();
    this.child = null;
    this.buffer = "";
  }

  start() {
    return new Promise((resolve, reject) => {
      const spawnOpts = {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      };
      const wire = (child, onFatalError) => {
        child.once("error", onFatalError);
        child.once("spawn", () => resolve());
        // A child dying mid-write makes stdin emit EPIPE; swallow it — the
        // 'close'/'error' handlers already fail pending requests.
        child.stdin.on("error", () => {});
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this._onData(chunk));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          if (typeof this.logger === "function") this.logger(String(chunk));
        });
        child.once("close", () => {
          // A failed first spawn emits 'close' after the cmd.exe retry has
          // already replaced this.child — only tear down if still current.
          if (this.child !== child) return;
          const error = new Error("MCP stdio server exited");
          for (const { reject: fail } of this.pending.values()) fail(error);
          this.pending.clear();
          this.child = null;
        });
      };

      let child;
      try {
        child = spawn(this.command, this.args, spawnOpts);
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      let viaCmd = false;
      wire(child, (error) => {
        // On Windows a bare command name that is a .cmd shim (npx, pnpm, …)
        // cannot be spawned directly: CreateProcess only resolves .exe, and
        // Node refuses .cmd without a shell since the 2024 argv-injection
        // fix. Retry the full command line through cmd.exe once.
        if (!viaCmd && process.platform === "win32" && error.code === "ENOENT") {
          viaCmd = true;
          const line = [this.command, ...this.args].map(windowsQuote).join(" ");
          const shelled = spawn("cmd.exe", ["/d", "/s", "/c", line], spawnOpts);
          this.child = shelled;
          wire(shelled, reject);
          return;
        }
        reject(error);
      });
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = safeJsonParse(line);
      if (message) this._dispatch(message);
    }
  }

  _dispatch(message) {
    if (message.id !== undefined && message.id !== null && this.pending.has(String(message.id))) {
      const { resolve, reject } = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      if (message.error) reject(new Error(message.error.message || "MCP request failed"));
      else resolve(message.result);
    }
  }

  request(method, params) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) return Promise.reject(new Error("MCP stdio server is not running"));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // child is gone; ignore
    }
  }

  close() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
    }
    for (const { reject } of this.pending.values()) reject(new Error("MCP connection closed"));
    this.pending.clear();
  }
}

// ── Streamable HTTP / SSE transport ─────────────────────────────

function parseSseBlocks(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^\s/, ""));
    }
    if (data.length) events.push(data.join("\n"));
  }
  return events;
}

class HttpJsonRpc {
  constructor(options = {}) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async request(method, params) {
    if (this.closed) throw new Error("MCP HTTP connection closed");
    if (typeof this.fetchImpl !== "function") throw new Error("global fetch is unavailable");
    const id = String(++this.nextId);
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const contentType = String(response.headers?.get?.("content-type") ?? "");
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`);

    if (contentType.includes("text/event-stream")) {
      for (const block of parseSseBlocks(text)) {
        const payload = safeJsonParse(block);
        if (payload && String(payload.id) === id) {
          if (payload.error) throw new Error(payload.error.message || "MCP request failed");
          return payload.result;
        }
      }
      throw new Error("MCP SSE response contained no result");
    }

    const payload = safeJsonParse(text);
    if (!payload) throw new Error("MCP HTTP response was not valid JSON");
    if (payload.error) throw new Error(payload.error.message || "MCP request failed");
    return payload.result;
  }

  async notify(method, params) {
    if (this.closed) return;
    if (typeof this.fetchImpl !== "function") return;
    try {
      await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      });
    } catch {
      // notifications are best-effort
    }
  }

  close() {
    this.closed = true;
  }
}

// ── MCP client ──────────────────────────────────────────────────

class McpClient {
  constructor(config, options = {}) {
    this.serverName = config.serverName;
    // Per-call timeout: a hung MCP server must fail the call, not hang the
    // agent turn forever.
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
    this.transport =
      config.transport === "stdio"
        ? new StdioJsonRpc({
            command: expandEnv(config.command),
            args: (config.args ?? []).map(expandEnv),
            env: expandEnvMap(config.env),
            logger: options.logger,
          })
        : new HttpJsonRpc({
            url: expandEnv(config.url),
            headers: expandEnvMap(config.headers),
            fetchImpl: options.fetchImpl,
          });
    this.tools = null;
  }

  /** 带超时的请求：initialize/tools/list 也必须限时，否则一个挂起的
   *  MCP server 会让会话构建（createPiMcpExtension 的 allSettled）永不落定。 */
  async requestWithTimeout(method, params) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`MCP ${this.serverName}/${method} timed out after ${this.callTimeoutMs}ms`)),
        this.callTimeoutMs,
      );
    });
    try {
      return await Promise.race([this.transport.request(method, params), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async start() {
    await this.transport.start?.();
    const init = await this.requestWithTimeout("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pdb-pi-mcp", version: "0.1.0" },
    });
    await this.transport.notify("notifications/initialized", {});
    this.serverInfo = init?.serverInfo;
    return this;
  }

  async listTools() {
    const result = await this.requestWithTimeout("tools/list", {});
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  async callTool(name, args) {
    return this.requestWithTimeout("tools/call", { name, arguments: args ?? {} });
  }

  close() {
    this.transport.close?.();
  }
}

/** Convert an MCP tools/call result into pi's AgentToolResult shape. */
function normalizeMcpToolResult(raw) {
  const content = Array.isArray(raw?.content)
    ? raw.content.map((part) => ({
        type: part?.type || "text",
        text: part?.text !== undefined ? String(part.text) : JSON.stringify(part),
      }))
    : [{ type: "text", text: JSON.stringify(raw ?? {}) }];
  const out = { content };
  const details = {};
  if (raw?.structuredContent !== undefined) details.structuredContent = raw.structuredContent;
  if (raw?.isError) details.isError = true;
  if (Object.keys(details).length) out.details = details;
  return out;
}

/**
 * Read the shared MCP server registry. Accepts either a bare array of
 * `McpServerConfig` objects or `{ servers: [...] }`.
 */
function readMcpServers(configPath) {
  const file = path.resolve(configPath);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.servers)) return raw.servers;
    return [];
  } catch {
    return [];
  }
}

/**
 * Create the pi extension factory that registers MCP tools.
 *
 * @param {object} [options]
 * @param {Array<import("@pi-dsh-bridge/plugin-sdk").McpServerConfig>} [options.servers]
 * @param {string} [options.cwd]
 * @param {(message: string) => void} [options.logger]
 * @param {Function} [options.fetchImpl]  Injectable fetch for the SSE transport (tests).
 * @returns {(pi: object) => Promise<void>}
 */
// Process-level shared MCP clients. pi rebuilds the whole session on every
// page load, and stdio servers are expensive to boot (comfy-mcp alone takes
// ~3s), so live connections and their tool lists are cached per server
// config and reused by every session in this process. Stdio JSON-RPC
// multiplexes requests by id, so one client can serve concurrent sessions.
const sharedMcpClients = new Map();
const inflightMcpStarts = new Map();

function mcpCacheKey(config) {
  return JSON.stringify([
    config.serverName,
    config.transport ?? "stdio",
    config.command,
    config.args,
    config.url,
    config.headers,
    config.env,
  ]);
}

function getSharedMcpClient(config, opts) {
  const key = mcpCacheKey(config);
  const cached = sharedMcpClients.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = inflightMcpStarts.get(key);
  if (inflight) return inflight;
  const start = (async () => {
    try {
      const client = await new McpClient(config, { fetchImpl: opts.fetchImpl, logger: opts.logger }).start();
      const tools = await client.listTools();
      const entry = { client, tools };
      sharedMcpClients.set(key, entry);
      return entry;
    } finally {
      inflightMcpStarts.delete(key);
    }
  })();
  inflightMcpStarts.set(key, start);
  return start;
}

// Failed boot records: a server that could not start stays "unreachable"
// for this short window instead of re-paying the boot cost on every peek.
// Peek-only — real session boots (createPiMcpExtension) are unaffected and
// always retry, matching pi's own session-build semantics.
const failedMcpBoots = new Map();
const MCP_BOOT_RETRY_MS = 30_000;

async function peekSharedMcpTools(config) {
  const key = mcpCacheKey(config);
  const cached = sharedMcpClients.get(key);
  if (cached) return { connected: true, tools: cached.tools };
  const failedAt = failedMcpBoots.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < MCP_BOOT_RETRY_MS) {
    return { connected: false, tools: [] };
  }
  try {
    const entry = await getSharedMcpClient(config, {});
    return { connected: true, tools: entry.tools };
  } catch {
    failedMcpBoots.set(key, Date.now());
    return { connected: false, tools: [] };
  }
}

/** Close every shared MCP client (process teardown / tests). */
async function closeSharedMcpClients() {
  const entries = [...sharedMcpClients.values()];
  sharedMcpClients.clear();
  failedMcpBoots.clear();
  await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        entry.client.close();
      } catch {
        // ignore
      }
    }),
  );
}

function createPiMcpExtension(options = {}) {
  const { servers = [], logger, fetchImpl } = options;
  return async function piMcpExtension(pi) {
    // Parallel startup across servers; each server connects at most once per
    // process — every later session reuses the live client instead of paying
    // the boot cost again.
    const started = await Promise.allSettled(
      servers
        .filter((config) => config && typeof config.serverName === "string" && config.serverName)
        .map(async (config) => {
          try {
            const entry = await getSharedMcpClient(config, { fetchImpl, logger });
            return { config, entry };
          } catch (error) {
            return { config, error };
          }
        }),
    );
    for (const result of started) {
      const item = result.status === "fulfilled" ? result.value : null;
      if (!item) continue;
      if (item.error) {
        const message = `[mcp:${item.config.serverName}] ${errorMessage(item.error)}`;
        if (typeof logger === "function") logger(message);
        else console.error(message);
        continue;
      }
      const { config, entry } = item;
      for (const tool of entry.tools) {
        const toolName = `mcp__${config.serverName}__${tool.name}`;
        pi.registerTool({
          name: toolName,
          label: toolName,
          description: tool.description || `MCP tool ${tool.name} from ${config.serverName}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted) {
              return { content: [{ type: "text", text: "Cancelled" }], details: { cancelled: true } };
            }
            const raw = await entry.client.callTool(tool.name, params);
            return normalizeMcpToolResult(raw);
          },
        });
      }
    }
  };
}

module.exports = {
  createPiMcpExtension,
  readMcpServers,
  expandEnv,
  mcpCacheKey,
  McpClient,
  StdioJsonRpc,
  HttpJsonRpc,
  normalizeMcpToolResult,
  closeSharedMcpClients,
  peekSharedMcpTools,
};
