// Minimal self-contained MCP server over stdio.
//
// Deliberately dependency-free: the bridge ships this as the demo server that
// proves the MCP wiring end to end, so it has to start on a fresh checkout with
// no install step. It speaks newline-delimited JSON-RPC 2.0 directly and
// implements only the subset the bridge's client uses: initialize,
// notifications/initialized, tools/list and tools/call.
import readline from "node:readline";

// The client in packages/pi-mcp negotiates this exact version.
const PROTOCOL_VERSION = "2024-11-05";

// The draft-07 marker is part of the advertised schema: this server used to be
// built on the MCP SDK, which emitted it, and consumers read the schema as-is.
const SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";

// The SDK this server used to be built on marked every tool as not supporting
// task-based execution. The field is part of the advertised tool object, so it
// is kept to leave tools/list output equivalent.
const EXECUTION = { taskSupport: "forbidden" };

const TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Echoes the given text back unchanged.",
    inputSchema: {
      $schema: SCHEMA_DRAFT,
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    title: "Add",
    description: "Adds two numbers.",
    inputSchema: {
      $schema: SCHEMA_DRAFT,
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "now",
    title: "Now",
    description: "Returns the current ISO-8601 timestamp.",
    inputSchema: { $schema: SCHEMA_DRAFT, type: "object", properties: {} },
  },
].map((tool) => ({ ...tool, execution: EXECUTION }));

// Each handler returns the text payload, and throws a caller-facing message for
// arguments that do not match the advertised schema. A throw is reported as an
// isError tool result rather than a JSON-RPC error, which is what the MCP spec
// asks for on a failed tool invocation.
const HANDLERS = {
  echo(args) {
    if (typeof args.text !== "string") throw new Error("text must be a string");
    return args.text;
  },
  add(args) {
    if (typeof args.a !== "number" || typeof args.b !== "number") throw new Error("a and b must be numbers");
    return String(args.a + args.b);
  },
  now() {
    return new Date().toISOString();
  },
};

/** Failed invocations keep the -32602 prefix the SDK-backed server used. */
function invocationError(id, toolName, detail) {
  sendResult(id, {
    content: [{ type: "text", text: `MCP error -32602: Input validation error: Invalid arguments for tool ${toolName}: ${detail}` }],
    isError: true,
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  // Absent id means notification: the spec forbids replying to one, and
  // notifications/initialized is the one the client sends.
  const isNotification = message.id === undefined;
  if (isNotification) {
    if (message.method !== "notifications/initialized") {
      process.stderr.write(`[everything] ignoring notification: ${message.method}\n`);
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      sendResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "everything", version: "1.0.0" },
      });
      return;
    case "tools/list":
      sendResult(message.id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = message.params?.name;
      const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
      if (!handler) {
        // An unknown tool is a failed invocation, not a protocol error, so it
        // travels back as an isError tool result.
        sendResult(message.id, {
          content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }],
          isError: true,
        });
        return;
      }
      try {
        const text = handler(message.params?.arguments ?? {});
        sendResult(message.id, { content: [{ type: "text", text }] });
      } catch (error) {
        invocationError(message.id, name, error.message);
      }
      return;
    }
    default:
      sendError(message.id, -32601, "Method not found");
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // A malformed line carries no id, so there is nothing to correlate an error
    // with; drop it rather than desynchronising the stream.
    process.stderr.write("[everything] ignoring unparseable line\n");
    return;
  }
  handle(message);
});
