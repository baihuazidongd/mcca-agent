#!/usr/bin/env node
/**
 * Materialise the generated configuration from the committed templates.
 *
 * The MCP registry, the hot-plugin manifest and the dsh profile's mount layer
 * all have to name this checkout by absolute path. Keeping those three as
 * templates and generating them here means a clone never carries another
 * machine's paths, and this script stays the single place that resolves them.
 *
 * Generated files are gitignored. Re-running is safe: every output is rewritten
 * from its template, so hand edits are intentionally not preserved.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateMcpPatch } from "./gen-dsh-mcp-patch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR = path.join(ROOT, "config");
const DSH_HOME = process.env.PDB_DSH_HOME || path.join(CONFIG_DIR, "dsh-home");
const PROFILE_DIR = path.join(DSH_HOME, "profiles", "web");

/** Committed templates carry {{ROOT}}; generated files carry the real path. */
function resolveTemplate(text) {
  return text.replaceAll("{{ROOT}}", ROOT.replaceAll("\\", "/"));
}

function fromTemplate(templateRel, outRel) {
  const source = path.join(ROOT, templateRel);
  if (!fs.existsSync(source)) throw new Error(`missing template: ${templateRel}`);
  const target = path.join(ROOT, outRel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, resolveTemplate(fs.readFileSync(source, "utf8")), "utf8");
  return path.relative(ROOT, target).replaceAll("\\", "/");
}

function ensureFile(rel, contents) {
  const target = path.join(ROOT, rel);
  if (fs.existsSync(target)) return null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
  return path.relative(ROOT, target).replaceAll("\\", "/");
}

function requireDependencies() {
  const missing = [];
  for (const dep of ["@deepseek-ai/dsh", "@earendil-works/pi-coding-agent"]) {
    if (!fs.existsSync(path.join(ROOT, "node_modules", ...dep.split("/")))) missing.push(dep);
  }
  if (missing.length) {
    console.error(`[setup] dependencies are not installed yet: ${missing.join(", ")}`);
    console.error("[setup] run `pnpm install` first.");
    process.exit(1);
  }
}

function main() {
  requireDependencies();

  const written = [
    fromTemplate("config/mcp.example.json", "config/mcp.json"),
    fromTemplate("config/hot-plugins.example.json", "config/hot-plugins.json"),
    fromTemplate("dsh/profiles/web/package.json", path.join("config", "dsh-home", "profiles", "web", "package.json")),
    fromTemplate("dsh/profiles/web/cordis.patch.template.yml", path.join("config", "dsh-home", "profiles", "web", "cordis.patch.yml")),
  ];

  // dsh's MCP rows are derived from the shared registry, never hand-edited, so
  // the two runtimes cannot drift apart on server names or arguments.
  generateMcpPatch(path.join(CONFIG_DIR, "mcp.json"), path.join(CONFIG_DIR, "dsh-mcp.patch.yml"));
  written.push("config/dsh-mcp.patch.yml");

  const created = [
    ensureFile(path.join("config", "plugins.json"), '{ "ds": { "hello-tool": true }, "pi": { "hello-tool": true } }\n'),
    ensureFile(path.join("config", "client-plugins.json"), "{}\n"),
  ].filter(Boolean);

  // dsh writes sessions, storages and attachments under its home on first boot.
  for (const dir of ["sessions", "storages", "attachments", "mcp"]) {
    fs.mkdirSync(path.join(DSH_HOME, dir), { recursive: true });
  }

  console.log("[setup] generated:");
  for (const file of written) console.log(`  ${file}`);
  if (created.length) {
    console.log("[setup] created:");
    for (const file of created) console.log(`  ${file}`);
  }
  console.log(`[setup] dsh home: ${path.relative(ROOT, DSH_HOME).replaceAll("\\", "/")}`);
  console.log("[setup] done. Next: pnpm start");
}

main();
