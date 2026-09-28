"use strict";
// A lightweight client, not a second tool host. All IDEs reach the same portal.
const fs = require("node:fs");
const path = require("node:path");
const { createPaths } = require("./paths.cjs");
const paths = createPaths();
const port = Number(process.env.PORTAL_PORT) || 3470;
let buffer = "", active = 0; const queue = [];
function pump() {
  while (active < 8 && queue.length) {
    active++; const next = queue.shift();
    next().catch(error => process.stderr.write(error.message + "\n")).finally(() => { active--; pump(); });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) { process.stderr.write("MCP input too large\n"); process.exit(1); }
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line.trim()) continue;
    if (queue.length >= 128) { process.stderr.write("MCP queue overflow\n"); process.exit(1); }
    queue.push(async () => {
      let rpc;
      try {
        rpc = JSON.parse(line);
        const auth = JSON.parse(fs.readFileSync(path.join(paths.state, "assistant-auth.json"), "utf8"));
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` }, body: line, signal: AbortSignal.timeout(20 * 60000) });
        if (rpc.id === undefined) return;
        if (!res.ok) throw new Error(`Portal HTTP ${res.status}`);
        process.stdout.write(JSON.stringify(await res.json()) + "\n");
      } catch (error) {
        if (rpc?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: `工作台未连接：${error.message}。请先启动 mcca。` } }) + "\n");
        else process.stderr.write(error.message + "\n");
      }
    }); pump();
  }
});
