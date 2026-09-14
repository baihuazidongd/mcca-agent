#!/usr/bin/env node
/**
 * Start the portal, which supervises the dsh and pi-web child processes and
 * serves the management UI. Children are detached from this launcher, so
 * Ctrl-C here stops the supervisor and its children with it.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTAL = path.join(ROOT, "packages", "portal", "server.cjs");

if (!fs.existsSync(path.join(ROOT, "config", "mcp.json"))) {
  console.error("[start] configuration is not generated yet. Run `pnpm install` then `pnpm run setup`.");
  process.exit(1);
}

const port = process.env.PORTAL_PORT || "3470";
console.log(`[start] portal -> http://127.0.0.1:${port}/`);
console.log("[start] pi-web :3458   dsh :3081   (start them from the portal's manage tab)");

const child = spawn(process.execPath, [PORTAL], { cwd: ROOT, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
