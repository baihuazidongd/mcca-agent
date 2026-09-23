"use strict";
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const path = require("node:path");

async function main() {
  const start = performance.now();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.cjs")], {
    env: { ...process.env, PI_WEB_PORT: "0", MCCA_PI_WEB_SESSIONS: path.resolve(__dirname, "../../../config/.pi-web-verify/sessions") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Startup timeout")), 15000);
      child.stdout.on("data", (data) => {
        const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.on("error", reject);
    });
    console.log(JSON.stringify({ startupMs: Math.round(performance.now() - start) }));
    async function request(route, timeout = 15000) {
      const at = performance.now();
      try {
        const res = await fetch(base + route, { signal: AbortSignal.timeout(timeout) });
        const body = await res.text();
        return { ms: Math.round(performance.now() - at), status: res.status, body };
      } catch (error) { return { ms: Math.round(performance.now() - at), error: error.name }; }
    }
    const list = await request("/api/sessions");
    console.log(JSON.stringify({ coldListMs: list.ms, status: list.status }));
    const ids = JSON.parse(list.body).sessions.map((s) => s.id);
    const routes = ["/", "/api/sessions", "/api/workspaces", ...ids.map((id) => `/api/sessions/${id}/subagents`)];
    for (const concurrency of [1, 8, 24]) {
      const samples = [];
      const at = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
        for (let i = 0; i < 8; i++) samples.push(await request(routes[(worker + i) % routes.length]));
      }));
      const times = samples.map((s) => s.ms).sort((a, b) => a - b);
      console.log(JSON.stringify({ concurrency, requests: times.length, totalMs: Math.round(performance.now() - at), p50: times[Math.floor(times.length * .5)], p95: times[Math.floor(times.length * .95)], max: times.at(-1), errors: samples.filter((s) => s.error || s.status !== 200).length }));
    }
    if (ids[0]) {
      const history = await request(`/api/sessions/${ids[0]}/history`, 70000);
      console.log(JSON.stringify({ coldHistoryMs: history.ms, status: history.status, error: history.error }));
    }
    const sustained = [];
    const until = performance.now() + 4000;
    await Promise.all(Array.from({ length: 24 }, async (_, worker) => {
      while (performance.now() < until) {
        sustained.push(await request(routes[worker % routes.length]));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }));
    const times = sustained.map((s) => s.ms).sort((a, b) => a - b);
    console.log(JSON.stringify({ sustainedConcurrency: 24, seconds: 4, requests: times.length, p95: times[Math.floor(times.length * .95)], max: times.at(-1), errors: sustained.filter((s) => s.error || s.status !== 200).length }));
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
