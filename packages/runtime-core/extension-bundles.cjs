"use strict";
const fs = require("node:fs"), path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { writeJson } = require("./paths.cjs");
function createExtensionBundles({ paths, files, onChange = async () => ({ reloadRequired: true }) }) {
  const history = path.join(paths.state, "bundle-history"); let queue = Promise.resolve();
  function inventory(root) {
    const entries = []; let bytes = 0;
    if (!fs.existsSync(root)) return { exists: false, entries, sha256: null };
    function walk(dir, prefix, depth) {
      if (depth > 8 || fs.lstatSync(dir).isSymbolicLink()) throw new Error("扩展不能包含链接或超过八层目录");
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("扩展不能包含符号链接");
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        if (entry.name.startsWith(".") || /[\:\x00-\x1f]/.test(entry.name) || /[. ]$/.test(entry.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(entry.name)) throw new Error("无效扩展文件名");
        const file = path.join(dir, entry.name), relative = prefix + entry.name;
        if (entry.isDirectory()) walk(file, relative + "/", depth + 1);
        else {
          const size = fs.statSync(file).size; bytes += size;
          if (!/\.(mjs|cjs|js|json|md|txt|ya?ml|css|svg)$/i.test(relative) || size > 1024 * 1024 || bytes > 8 * 1024 * 1024 || entries.length >= 1000) throw new Error("扩展仅支持文本文件，单文件 1MB、总计 8MB/1000 个文件");
          const text = fs.readFileSync(file, "utf8"); if (text.includes("\0")) throw new Error("扩展不能包含二进制内容");
          entries.push({ file: relative, text });
        }
      }
    }
    walk(root, "", 0); entries.sort((a,b) => a.file.localeCompare(b.file));
    return { exists: true, entries, sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
  }
  function destination(kind, name) {
    if (!["plugin", "skill"].includes(kind) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name || "") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw new Error("需要 plugin/skill 类型及合法名称");
    const root = path.resolve(files.roots[kind]); if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("扩展根目录不能是链接");
    return path.join(root, name);
  }
  async function check(kind, entries) {
    const required = kind === "plugin" ? "manifest.json" : "SKILL.md";
    if (!entries.some(e => e.file === required)) throw new Error("目录缺少 " + required);
    for (const entry of entries) await files.validate("bundle/" + entry.file, entry.text, kind);
    if (kind === "plugin") {
      const manifest = JSON.parse(entries.find(e => e.file === required).text);
      if (!entries.some(e => e.file === manifest.entry)) throw new Error("manifest 入口文件不存在");
    }
  }
  async function apply(kind, name, next, expected) {
    const dest = destination(kind, name), before = inventory(dest);
    if (before.sha256 !== (expected || null)) throw new Error("扩展已变化，请重新预览后再更新");
    if (next.exists) await check(kind, next.entries);
    if (inventory(dest).sha256 !== before.sha256) throw new Error("验证期间扩展已变化");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const revision = randomUUID(), stage = dest + ".stage-" + revision, backup = path.join(history, revision, "before");
    if (next.exists) {
      fs.mkdirSync(stage);
      for (const entry of next.entries) { const target = path.join(stage, entry.file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, entry.text); }
    }
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    const record = { revision, kind, name, at: Date.now(), beforeExists: before.exists, beforeSha256: before.sha256, afterSha256: next.sha256 };
    writeJson(path.join(history, revision, "revision.json"), { ...record, state: "prepared" });
    if (before.exists) fs.renameSync(dest, backup);
    try { if (next.exists) fs.renameSync(stage, dest); }
    catch (error) { if (before.exists) fs.renameSync(backup, dest); throw error; }
    writeJson(path.join(history, revision, "revision.json"), { ...record, state: "applied" });
    let reload; try { reload = await onChange(kind, name); } catch (error) { reload = { error: error.message }; }
    return { ...record, reload, directory: dest, note: "语法验证通过；现有会话继续运行，新会话加载更新。可按修订回滚。" };
  }
  async function perform(a) {
    if (a.action === "bundle_history") {
      if (!fs.existsSync(history)) return [];
      return fs.readdirSync(history).filter(n => /^[a-f0-9-]{36}$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(history,n,"revision.json"),"utf8"))).filter(r => (!a.kind || r.kind === a.kind) && (!a.name || r.name === a.name)).sort((a,b) => b.at-a.at).slice(0,100);
    }
    if (a.action === "rollback_bundle") {
      if (!/^[a-f0-9-]{36}$/.test(a.revision || "")) throw new Error("无效修订");
      const record = JSON.parse(fs.readFileSync(path.join(history,a.revision,"revision.json"),"utf8"));
      if (record.state !== "applied") throw new Error("修订未成功应用，请先检查文件");
      return apply(record.kind, record.name, inventory(path.join(history,a.revision,"before")), a.expectedSha256);
    }
    const dest = destination(a.kind, a.name), current = inventory(dest);
    if (a.action === "bundle_status") return { kind: a.kind, name: a.name, sha256: current.sha256, exists: current.exists, files: current.entries.map(e => e.file) };
    if (typeof a.source !== "string" || !path.isAbsolute(a.source) || !fs.statSync(a.source).isDirectory()) throw new Error("需要本机扩展目录绝对路径");
    const next = inventory(a.source); await check(a.kind, next.entries);
    if (a.action === "inspect_bundle") return { kind: a.kind, name: a.name, source: a.source, sourceSha256: next.sha256, currentSha256: current.sha256, files: next.entries.map(e => e.file), replacesExisting: current.exists };
    if (a.action === "import_bundle") {
      if (!a.sourceSha256 || next.sha256 !== a.sourceSha256) throw new Error("源目录已变化，请先预览安装内容");
      return apply(a.kind, a.name, next, a.expectedSha256);
    }
    throw new Error("未知扩展包操作");
  }
  function call(a) { const next = queue.catch(() => {}).then(() => perform(a)); queue = next; return next; }
  return { call };
}
module.exports = { createExtensionBundles };
