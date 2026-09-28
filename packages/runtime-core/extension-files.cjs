"use strict";
const fs = require("node:fs"), path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { writeJson } = require("./paths.cjs");
const { run } = require("./android.cjs");
const hash = text => createHash("sha256").update(text).digest("hex");
function createExtensionFiles({ paths, onChange = async () => {} }) {
  const roots = { plugin: process.env.MCCA_PLUGINS_DIR || path.join(paths.app, "plugins"), skill: process.env.MCCA_SKILLS_DIR || path.join(paths.app, "skills"), config: paths.data };
  const history = path.join(paths.state, "extension-history");
  function target(kind, relative) {
    if (!(kind in roots) || typeof relative !== "string" || !relative || relative.length > 300 || /[\\:\x00-\x1f]/.test(relative)) throw new Error("无效扩展路径");
    if (kind === "config" && !["mcp.json", "plugins.json", "dsh.patch.yml"].includes(relative)) throw new Error("仅允许编辑 MCP、插件开关和 dsh patch");
    const parts = relative.split("/"); if (parts.some(p => !p || p === "." || p === ".." || p.startsWith(".") || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("扩展路径越界或无效");
    if (!/\.(?:mjs|cjs|js|json|md|txt|yaml|yml|css|svg)$/i.test(relative)) throw new Error("仅支持扩展文本文件");
    const root = path.resolve(roots[kind]); let current = root;
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("不允许符号链接扩展根目录");
    for (const part of parts) { current = path.join(current, part); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("不允许编辑符号链接或目录联接"); }
    if (!current.startsWith(root + path.sep)) throw new Error("扩展路径越界"); return current;
  }
  function read(kind, relative) {
    const file = target(kind, relative); if (!fs.existsSync(file)) return { kind, file: relative, exists: false, sha256: null, text: "" };
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw new Error("文件不是文本文件或超过 1MB");
    const text = fs.readFileSync(file, "utf8"); return { kind, file: relative, exists: true, sha256: hash(text), text };
  }
  function list(kind) {
    if (!(kind in roots)) throw new Error("Unknown extension kind");
    if (kind === "config") return ["mcp.json", "plugins.json", "dsh.patch.yml"].map(file => ({ file, exists: fs.existsSync(target(kind, file)) }));
    const output = [];
    function walk(dir, prefix, depth) {
      if (!fs.existsSync(dir) || depth > 6 || output.length >= 1000) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const relative = prefix + entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relative + "/", depth + 1);
        else if (/\.(?:mjs|cjs|js|json|md|txt|yaml|yml|css|svg)$/i.test(relative)) output.push({ file: relative, size: fs.statSync(path.join(dir, entry.name)).size });
      }
    }
    walk(roots[kind], "", 0); return output;
  }
  async function validate(file, text, kind) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024 || text.includes("\0")) throw new Error("文本无效或超过 1MB");
    if (file.endsWith(".json")) {
      const data = JSON.parse(text);
      if (kind === "plugin" && file.endsWith("/manifest.json")) { if (!data.name || typeof data.entry !== "string" || data.entry.includes("..") || path.isAbsolute(data.entry) || !Array.isArray(data.targets) || data.targets.some(t => !["pi", "ds"].includes(t))) throw new Error("插件 manifest 需要 name、相对 entry 和 pi/ds targets"); }
      if (kind === "config" && file === "mcp.json" && !Array.isArray(data)) throw new Error("本应用 MCP 配置需要数组格式");
    }
    if (/\.ya?ml$/.test(file)) { const doc = require("yaml").parseDocument(text); if (doc.errors.length) throw new Error(doc.errors[0].message); }
    if (/\.(mjs|cjs|js)$/.test(file)) {
      fs.mkdirSync(history, { recursive: true }); const temp = path.join(history, randomUUID() + path.extname(file));
      try { fs.writeFileSync(temp, text); await run(paths.node, ["--check", temp]); } finally { fs.rmSync(temp, { force: true }); }
    }
  }
  async function write(a) {
    const current = read(a.kind, a.file), expected = a.expectedSha256 || null;
    if (current.sha256 !== expected) throw new Error("文件已变化，请重新读取后修改；未覆盖其他编辑");
    await validate(a.file, a.text, a.kind);
    const latest = read(a.kind, a.file); if (latest.sha256 !== expected) throw new Error("验证期间文件已变化，请重试读取");
    const revision = randomUUID(), record = { revision, kind: a.kind, file: a.file, at: Date.now(), before: current, afterSha256: hash(a.text) };
    writeJson(path.join(history, revision + ".json"), record);
    const file = target(a.kind, a.file); fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + "." + randomUUID() + ".tmp"; try { fs.writeFileSync(temp, a.text); fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
    let reload; try { reload = await onChange(a.kind, a.file); } catch (error) { reload = { error: error.message }; }
    return { ...read(a.kind, a.file), revision, reload, note: "配置和扩展仅针对支持的宿主；新会话或宿主重载生效，正在执行的任务未重启" };
  }
  async function call(a) {
    if (a.action === "list") return list(a.kind);
    if (a.action === "read") return read(a.kind, a.file);
    if (a.action === "write") return write(a);
    if (a.action === "history") {
      if (!fs.existsSync(history)) return [];
      return fs.readdirSync(history).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(history, n), "utf8"))).filter(r => (!a.kind || r.kind === a.kind) && (!a.file || r.file === a.file)).sort((a,b) => b.at-a.at).slice(0,100).map(({ before, ...r }) => r);
    }
    if (a.action === "rollback") {
      if (!/^[a-f0-9-]{36}$/.test(a.revision || "")) throw new Error("Invalid revision");
      const record = JSON.parse(fs.readFileSync(path.join(history, a.revision + ".json"), "utf8"));
      if (!record.before.exists) {
        const current = read(record.kind, record.file);
        if (!a.expectedSha256 || current.sha256 !== a.expectedSha256 || current.sha256 !== record.afterSha256) throw new Error("文件已变化，请重新读取后回滚");
        const revision = randomUUID(); writeJson(path.join(history, revision + ".json"), { revision, kind: record.kind, file: record.file, at: Date.now(), before: current, afterSha256: null });
        fs.unlinkSync(target(record.kind, record.file));
        return { ...read(record.kind, record.file), revision, reload: await onChange(record.kind, record.file) };
      }
      return write({ kind: record.kind, file: record.file, expectedSha256: a.expectedSha256, text: record.before.text });
    }
    throw new Error("Unknown extension file action");
  }
  return { call, validate, roots };
}
module.exports = { createExtensionFiles };
