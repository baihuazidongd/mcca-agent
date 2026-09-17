import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { expandEnv, mcpCacheKey } = require("@pi-dsh-bridge/pi-mcp");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { generateMcpPatch } = await import(
  new URL("../scripts/gen-dsh-mcp-patch.mjs", import.meta.url).href
);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pdb-mcp-config-"));
}

// ── expandEnv ────────────────────────────────────────────────────
// The committed MCP registry must not carry a machine-specific path, so a row
// may name an environment variable. These cases pin the contract that makes
// that safe: a missing variable stays visible instead of becoming an empty
// command, and a substituted value is never scanned again.

test("expandEnv substitutes a set variable", () => {
  process.env.PDB_TEST_VALUE = "resolved";
  try {
    assert.equal(expandEnv("${PDB_TEST_VALUE}/bin"), "resolved/bin");
  } finally {
    delete process.env.PDB_TEST_VALUE;
  }
});

test("expandEnv uses the fallback when the variable is unset", () => {
  delete process.env.PDB_TEST_UNSET;
  assert.equal(expandEnv("${PDB_TEST_UNSET:-fallback}/bin"), "fallback/bin");
});

test("expandEnv leaves an unset variable verbatim so the failure is visible", () => {
  delete process.env.PDB_TEST_UNSET;
  assert.equal(expandEnv("${PDB_TEST_UNSET}/bin"), "${PDB_TEST_UNSET}/bin");
});

test("expandEnv treats an empty variable as unset", () => {
  process.env.PDB_TEST_EMPTY = "";
  try {
    assert.equal(expandEnv("${PDB_TEST_EMPTY:-fallback}"), "fallback");
    assert.equal(expandEnv("${PDB_TEST_EMPTY}"), "${PDB_TEST_EMPTY}");
  } finally {
    delete process.env.PDB_TEST_EMPTY;
  }
});

test("expandEnv substitutes in a single pass", () => {
  // A resolved value that itself looks like a placeholder must survive as text,
  // otherwise an environment variable could inject further expansion.
  process.env.PDB_TEST_OUTER = "${PDB_TEST_INNER}";
  process.env.PDB_TEST_INNER = "leaked";
  try {
    assert.equal(expandEnv("${PDB_TEST_OUTER}"), "${PDB_TEST_INNER}");
  } finally {
    delete process.env.PDB_TEST_OUTER;
    delete process.env.PDB_TEST_INNER;
  }
});

test("expandEnv passes non-strings through untouched", () => {
  assert.equal(expandEnv(undefined), undefined);
  assert.equal(expandEnv(42), 42);
});

// ── generateMcpPatch ─────────────────────────────────────────────
// The dsh rows are derived from the shared registry, so the two per-agent
// flags have to be honoured here or the portal's toggle would be cosmetic.

test("generateMcpPatch skips rows marked dsh:false and disabledDs:true", () => {
  const dir = tmpDir();
  const registry = path.join(dir, "mcp.json");
  const out = path.join(dir, "dsh-mcp.patch.yml");
  fs.writeFileSync(
    registry,
    JSON.stringify([
      { serverName: "kept", transport: "stdio", command: "node", args: ["a.mjs"] },
      { serverName: "pi-only", transport: "stdio", command: "node", args: ["b.mjs"], dsh: false },
      { serverName: "toggled-off", transport: "stdio", command: "node", args: ["c.mjs"], disabledDs: true },
    ]),
  );

  const rows = generateMcpPatch(registry, out);

  assert.deepEqual(
    rows.map((row) => row.id),
    ["pdb-mcp-kept"],
  );
  const written = fs.readFileSync(out, "utf8");
  assert.match(written, /pdb-mcp-kept/);
  assert.doesNotMatch(written, /pi-only|toggled-off/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("generateMcpPatch writes a no-op row when nothing qualifies", () => {
  const dir = tmpDir();
  const registry = path.join(dir, "mcp.json");
  const out = path.join(dir, "dsh-mcp.patch.yml");
  fs.writeFileSync(registry, JSON.stringify([{ serverName: "x", dsh: false }]));

  const rows = generateMcpPatch(registry, out);

  assert.equal(rows.length, 0);
  // An empty or comments-only patch file throws on load, so a no-op row stands in.
  assert.equal(fs.readFileSync(out, "utf8"), "- insert: []\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── mcpCacheKey ──────────────────────────────────────────────────
// Live MCP clients are cached per config and shared across pi sessions, so two
// rows that differ only by auth header must not collide on one client.

test("mcpCacheKey separates configs that differ only by headers", () => {
  const base = { serverName: "sse", transport: "sse", url: "https://host/mcp" };
  const a = mcpCacheKey({ ...base, headers: { authorization: "Bearer one" } });
  const b = mcpCacheKey({ ...base, headers: { authorization: "Bearer two" } });

  assert.notEqual(a, b);
});

test("mcpCacheKey is stable for the same config", () => {
  const config = { serverName: "x", transport: "stdio", command: "node", args: ["s.mjs"] };
  assert.equal(mcpCacheKey(config), mcpCacheKey({ ...config }));
});
