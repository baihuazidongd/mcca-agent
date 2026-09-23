import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createPiMcpExtension,
  McpClient,
  readMcpServers,
  normalizeMcpToolResult,
  closeSharedMcpClients,
} = require("@mcca/pi-mcp");

// A tiny MCP stdio server speaking newline-delimited JSON-RPC over stdin/stdout.
const SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const tools = [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\\n");
  } else if (msg.method === "tools/call") {
    const text = msg.params.arguments.text;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + text }] } }) + "\\n");
  }
});
`;

const STDIO = { serverName: "demo", transport: "stdio", command: process.execPath, args: ["-e", SERVER] };

test("stdio MCP client lists tools and calls one", async () => {
  const client = new McpClient(STDIO);
  await client.start();
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "echo");
  const raw = await client.callTool("echo", { text: "hi" });
  assert.deepEqual(normalizeMcpToolResult(raw), { content: [{ type: "text", text: "echo:hi" }] });
  assert.deepEqual(
    normalizeMcpToolResult({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }),
    { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
  );
  client.close();
});

test("registers mcp__demo__echo as a pi tool; shared client survives sessions", async () => {
  const pi = {
    tools: [],
    handlers: {},
    registerTool(def) {
      pi.tools.push(def);
    },
    on(event, handler) {
      pi.handlers[event] = handler;
    },
  };
  const factory = createPiMcpExtension({ servers: [STDIO] });
  await factory(pi);

  assert.equal(pi.tools.length, 1);
  const tool = pi.tools[0];
  assert.equal(tool.name, "mcp__demo__echo");

  const result = await tool.execute("c", { text: "yo" }, undefined, undefined, { cwd: process.cwd() });
  assert.deepEqual(result, { content: [{ type: "text", text: "echo:yo" }] });

  // Shared clients deliberately outlive sessions (cheap reloads); tests tear
  // them down explicitly.
  await closeSharedMcpClients();
});

test("marks configured MCP tools as background and reports completion", async () => {
  const messages = [];
  const pi = {
    tools: [],
    registerTool(def) { pi.tools.push(def); },
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  const factory = createPiMcpExtension({ servers: [{ ...STDIO, backgroundTools: ["echo"] }] });
  await factory(pi);
  const tool = pi.tools[0];
  assert.match(tool.description, /异步工具/);
  const immediate = await tool.execute("mcp-bg", { text: "later" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(immediate.details.background, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.customType, "async-tool-result");
  assert.equal(messages[0].options.triggerTurn, true);
  await closeSharedMcpClients();
});

test("HTTP (Streamable HTTP) transport lists and calls tools", async () => {
  const byMethod = {
    initialize: { jsonrpc: "2.0", id: "1", result: { serverInfo: { name: "http" } } },
    "tools/list": {
      jsonrpc: "2.0",
      id: "2",
      result: { tools: [{ name: "add", description: "add numbers", inputSchema: { type: "object" } }] },
    },
    "tools/call": {
      jsonrpc: "2.0",
      id: "3",
      result: { content: [{ type: "text", text: "5" }] },
    },
  };
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const payload = byMethod[body.method];
    return {
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(payload),
    };
  };

  const client = new McpClient(
    { serverName: "http", transport: "sse", url: "http://localhost/mcp" },
    { fetchImpl },
  );
  await client.start();
  const tools = await client.listTools();
  assert.equal(tools[0].name, "add");
  const raw = await client.callTool("add", {});
  assert.equal(normalizeMcpToolResult(raw).content[0].text, "5");
});

test("readMcpServers accepts a bare array or a { servers } object", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcca-mcp-config-"));
  try {
    const arrayFile = path.join(dir, "array.json");
    fs.writeFileSync(arrayFile, JSON.stringify([{ serverName: "a" }, { serverName: "b" }]));
    assert.equal(readMcpServers(arrayFile).length, 2);

    const objectFile = path.join(dir, "object.json");
    fs.writeFileSync(objectFile, JSON.stringify({ servers: [{ serverName: "c" }] }));
    assert.equal(readMcpServers(objectFile)[0].serverName, "c");

    assert.deepEqual(readMcpServers(path.join(dir, "missing.json")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
