import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "everything", "server.mjs");

/**
 * Spawn the demo server and speak newline-delimited JSON-RPC 2.0 to it.
 *
 * Deliberately not McpClient from packages/pi-mcp: this test guards the demo
 * server's own wire behaviour, and the demo server is what a fresh checkout can
 * run before any dependency install, so its test must be able to do the same.
 */
function connect() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 0;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  });

  return {
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close() {
      child.kill();
    },
  };
}

function textOf(result) {
  return result.content[0].text;
}

test("demo server: handshake, tool list and all three tools over stdio", async () => {
  const client = connect();
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(init.protocolVersion, "2024-11-05");
    assert.equal(init.serverInfo.name, "everything");
    client.notify("notifications/initialized", {});

    const { tools } = await client.request("tools/list", {});
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["echo", "add", "now"],
    );
    // These schemas are what both runtimes advertise as tool parameters, so
    // they are part of the contract rather than an implementation detail. The
    // draft-07 marker is kept because the SDK-backed version of this server
    // emitted it and consumers read the schema as-is.
    assert.deepEqual(tools[0].inputSchema, {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    });
    assert.deepEqual(tools[1].inputSchema.required, ["a", "b"]);
    assert.deepEqual(tools[2].inputSchema, {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {},
    });
    for (const tool of tools) {
      assert.deepEqual(tool.execution, { taskSupport: "forbidden" });
    }

    assert.equal(textOf(await client.request("tools/call", { name: "echo", arguments: { text: "hello" } })), "hello");
    assert.equal(textOf(await client.request("tools/call", { name: "add", arguments: { a: 2, b: 3 } })), "5");

    const stamp = textOf(await client.request("tools/call", { name: "now", arguments: {} }));
    assert.ok(!Number.isNaN(Date.parse(stamp)), `now returned an unparseable timestamp: ${stamp}`);
  } finally {
    client.close();
  }
});

test("demo server: rejects an unknown method and reports failed invocations", async () => {
  const client = connect();
  try {
    // A protocol-level error: no such method.
    await assert.rejects(() => client.request("does/not/exist", {}), /Method not found/);

    // A failed invocation is an isError tool result, not a protocol error, so
    // both of these resolve rather than reject.
    const unknownTool = await client.request("tools/call", { name: "nope", arguments: {} });
    assert.equal(unknownTool.isError, true);
    assert.equal(textOf(unknownTool), "MCP error -32602: Tool nope not found");

    const badArgs = await client.request("tools/call", { name: "add", arguments: { a: 1, b: "two" } });
    assert.equal(badArgs.isError, true);
    assert.match(textOf(badArgs), /^MCP error -32602: Input validation error: Invalid arguments for tool add: /);
  } finally {
    client.close();
  }
});
