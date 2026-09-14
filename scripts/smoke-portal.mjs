// One-off smoke check for @pi-dsh-bridge/portal: boots the portal, fetches static
// assets, exercises the management API, and starts/stops the pi child process.
// Not part of `pnpm test`.
//
// Usage: node scripts/smoke-portal.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const portalDir = path.resolve(__dirname, "..", "packages", "portal");
const PORT = 3471;
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["server.cjs"], {
  cwd: portalDir,
  env: { ...process.env, PORTAL_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await wait(200);
  }
  return false;
}

async function json(pathname, options) {
  const res = await fetch(`${BASE}${pathname}`, options);
  return res.json();
}

async function main() {
  try {
    if (!(await waitReady(15000))) throw new Error("portal did not become ready\n" + log);

    for (const asset of ["/", "/styles.css", "/app.js", "/vendor/react.js", "/vendor/react-dom.js"]) {
      const res = await fetch(`${BASE}${asset}`);
      if (!res.ok) throw new Error(`asset ${asset} returned ${res.status}`);
      console.log(`[ok] ${asset} -> ${res.status}`);
    }

    const status0 = await json("/api/status");
    console.log("[ok] status:", JSON.stringify(status0.agents.map((a) => ({ agent: a.agent, running: a.running }))));

    const plugins = await json("/api/plugins");
    const mcp = await json("/api/mcp");
    const skills = await json("/api/skills");
    console.log("[ok] plugins:", plugins.plugins.map((p) => p.name).join(", "));
    console.log("[ok] mcp servers:", mcp.servers.length, "| skills:", skills.skills.map((s) => s.name).join(", "));

    const startBody = await json("/api/process/pi/start", { method: "POST" });
    console.log("[ok] pi start:", JSON.stringify(startBody));
    await wait(2000);
    const piRunning = (await json("/api/status")).agents.find((a) => a.agent === "pi");
    console.log("[ok] pi running:", piRunning.running, "pid:", piRunning.pid);
    if (!piRunning.running) throw new Error("pi did not start");

    const stopBody = await json("/api/process/pi/stop", { method: "POST" });
    console.log("[ok] pi stop:", JSON.stringify(stopBody));
    await wait(1000);
    const piStopped = (await json("/api/status")).agents.find((a) => a.agent === "pi");
    console.log("[ok] pi stopped:", !piStopped.running);

    // plugin toggle round-trip (restore original value in finally)
    await json("/api/plugins/hello-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "pi", enabled: false }),
    });
    const afterToggle = (await json("/api/plugins")).plugins.find((p) => p.name === "hello-tool");
    console.log("[ok] hello-tool pi toggled off:", afterToggle.enabled.pi === false);

    console.log("\nPORTAL SMOKE OK");
  } finally {
    try {
      await fetch(`${BASE}/api/process/pi/stop`, { method: "POST" });
    } catch {
      // ignore
    }
    try {
      await fetch(`${BASE}/api/plugins/hello-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "pi", enabled: true }),
      });
    } catch {
      // ignore
    }
    child.kill();
    await wait(200);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("\nPORTAL SMOKE FAILED:", error.message);
    if (log.trim()) console.error("--- portal log ---\n" + log.trim());
    process.exit(1);
  },
);
