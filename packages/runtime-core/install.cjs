"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { run } = require("./android.cjs");
const { writeJson } = require("./paths.cjs");

function createInstaller({ paths, fetchFile = fetch, extract = run }) {
  const jobs = new Map();
  function artifact(row) {
    const a = row.artifacts?.[`${process.platform}-${process.arch}`];
    if (!a) throw new Error("该组件尚未提供当前平台的可下载安装包，可先使用已安装的本地程序");
    const url = new URL(a.url);
    if (url.protocol !== "https:" || url.username || url.password || !/^[a-f0-9]{64}$/i.test(a.sha256 || "") || !["zip", "file"].includes(a.format)) throw new Error("安装包需要 HTTPS 地址、SHA-256 和 zip/file 格式");
    if (a.format === "file" && (!/^[\w-][\w.-]{0,119}$/.test(a.filename || "") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(a.filename))) throw new Error("Invalid artifact filename");
    return a;
  }
  async function install(row) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(row.id)) throw new Error("Invalid runtime id");
    if (jobs.get(row.id)?.state === "installing") return jobs.get(row.id);
    const a = artifact(row), base = path.join(paths.runtimes, row.id);
    const stage = path.join(base, "stage-" + randomUUID());
    const archive = path.join(stage, "download"), payload = path.join(stage, "payload");
    const job = { id: row.id, state: "installing", bytes: 0, at: Date.now() }; jobs.set(row.id, job);
    fs.mkdirSync(payload, { recursive: true });
    try {
      const response = await fetchFile(a.url, { signal: AbortSignal.timeout(15 * 60000), redirect: "follow" });
      if (!response.ok || !response.body || (response.url && !response.url.startsWith("https://"))) throw new Error(`Download failed: HTTP ${response.status}`);
      const hash = createHash("sha256");
      const handle = await fs.promises.open(archive, "wx");
      try {
        for await (const chunk of response.body) {
          job.bytes += chunk.length;
          if (job.bytes > 2 * 1024 ** 3) throw new Error("Download exceeds 2 GB");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) { const { bytesWritten } = await handle.write(chunk, offset); offset += bytesWritten; }
        }
      } finally { await handle.close(); }
      if (hash.digest("hex") !== a.sha256.toLowerCase()) throw new Error("SHA-256 mismatch; installed version was not changed");
      if (a.format === "zip") {
        if (process.platform !== "win32") throw new Error("ZIP installer currently supports Windows");
        await extract("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "extract.ps1"), "-Archive", archive, "-Destination", payload], { timeout: 180000 });
      } else fs.renameSync(archive, path.join(payload, a.filename));
      writeJson(path.join(payload, "mcca-install.json"), { schemaVersion: 1, version: a.version || "", sha256: a.sha256, at: Date.now() });
      const current = path.join(base, "current"), previous = path.join(base, "previous-" + Date.now());
      const hadPrevious = fs.existsSync(current);
      if (hadPrevious) fs.renameSync(current, previous);
      try { fs.renameSync(payload, current); }
      catch (error) { if (hadPrevious) fs.renameSync(previous, current); throw error; }
      Object.assign(job, { state: "installed", directory: current, previous: hadPrevious ? previous : null });
    } catch (error) { Object.assign(job, { state: "failed", error: error.message }); }
    finally {
      // stage is always a newly generated child of this runtime's directory.
      const resolvedStage = path.resolve(stage);
      if (!resolvedStage.startsWith(path.resolve(base) + path.sep)) throw new Error("Invalid staging directory");
      fs.rmSync(resolvedStage, { recursive: true, force: true });
    }
    return { ...job };
  }
  return { install, jobs: () => [...jobs.values()].map(j => ({ ...j })) };
}
module.exports = { createInstaller };
