"use strict";
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const { createHash, randomUUID } = require("node:crypto");
const { componentPath, locate } = require("./components.cjs");
function readZip(file) {
  const fd = fs.openSync(file, "r"), size = fs.fstatSync(fd).size;
  const read = (offset, length) => { if (offset < 0 || length < 0 || offset + length > size || length > 32 * 1024 * 1024) throw new Error("APK ZIP 范围无效或条目过大"); const b = Buffer.alloc(length); if (fs.readSync(fd, b, 0, length, offset) !== length) throw new Error("APK 文件读取不完整"); return b; };
  try {
    const tail = read(Math.max(0, size - 65557), Math.min(size, 65557)); let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    if (eocd < 0) throw new Error("不是可识别的 APK ZIP");
    const count = tail.readUInt16LE(eocd + 10), offset = tail.readUInt32LE(eocd + 16), length = tail.readUInt32LE(eocd + 12);
    if (count === 65535 || length > 16 * 1024 * 1024) throw new Error("不支持 ZIP64 或过大的目录");
    const directory = read(offset, length), entries = []; let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error("APK ZIP 目录损坏");
      const n = directory.readUInt16LE(cursor + 28), extra = directory.readUInt16LE(cursor + 30), comment = directory.readUInt16LE(cursor + 32);
      if (cursor + 46 + n + extra + comment > directory.length) throw new Error("APK ZIP 目录截断");
      entries.push({ name: directory.subarray(cursor + 46, cursor + 46 + n).toString("utf8"), method: directory.readUInt16LE(cursor + 10), compressed: directory.readUInt32LE(cursor + 20), size: directory.readUInt32LE(cursor + 24), offset: directory.readUInt32LE(cursor + 42), encrypted: Boolean(directory.readUInt16LE(cursor + 8) & 1) });
      cursor += 46 + n + extra + comment;
    }
    const entry = name => {
      const row = entries.find(r => r.name === name); if (!row) return null;
      if (row.encrypted || row.size > 16 * 1024 * 1024 || row.compressed > 16 * 1024 * 1024) throw new Error("APK 条目加密或过大");
      const header = read(row.offset, 30); if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("无效 ZIP 条目");
      const buffer = read(row.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), row.compressed);
      const result = row.method === 0 ? buffer : row.method === 8 ? zlib.inflateRawSync(buffer, { maxOutputLength: 16 * 1024 * 1024 }) : null;
      if (!result || result.length !== row.size) throw new Error("APK 条目长度不符"); return result;
    };
    return { entries, manifest: entry("AndroidManifest.xml") };
  } finally { fs.closeSync(fd); }
}
function parseManifest(buffer) {
  if (!buffer || buffer.length < 8 || buffer.readUInt16LE(0) !== 3) throw new Error("APK 缺少 Android binary XML manifest");
  let strings = [], cursor = buffer.readUInt16LE(2); const nodes = [], stack = [];
  while (cursor + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(cursor), header = buffer.readUInt16LE(cursor + 2), size = buffer.readUInt32LE(cursor + 4), end = cursor + size;
    if (size < 8 || header < 8 || end > buffer.length) throw new Error("Android XML chunk 损坏");
    if (type === 1) {
      if (header < 28) throw new Error("Invalid string pool");
      const count = buffer.readUInt32LE(cursor + 8), flags = buffer.readUInt32LE(cursor + 16), start = buffer.readUInt32LE(cursor + 20);
      if (count > 100000 || cursor + header + count * 4 > end) throw new Error("String pool too large");
      strings = [];
      for (let i = 0; i < count; i++) {
        let p = cursor + start + buffer.readUInt32LE(cursor + header + i * 4);
        const len8 = () => { if (p >= end) throw new Error("String outside pool"); const first = buffer[p++]; if (first & 128) { if (p >= end) throw new Error("String outside pool"); return ((first & 127) << 8) | buffer[p++]; } return first; };
        if (flags & 256) { len8(); const length = len8(); if (p + length > end) throw new Error("String outside pool"); strings.push(buffer.subarray(p, p + length).toString("utf8")); }
        else { if (p + 2 > end) throw new Error("String outside pool"); let length = buffer.readUInt16LE(p); p += 2; if (length & 32768) { if (p + 2 > end) throw new Error("String outside pool"); length = ((length & 32767) * 65536) + buffer.readUInt16LE(p); p += 2; } if (p + length * 2 > end) throw new Error("String outside pool"); strings.push(buffer.subarray(p, p + length * 2).toString("utf16le")); }
      }
    } else if (type === 0x0102) {
      const ext = cursor + header; if (ext + 20 > end) throw new Error("Invalid XML node");
      const name = strings[buffer.readUInt32LE(ext + 4)], begin = ext + buffer.readUInt16LE(ext + 8), stride = buffer.readUInt16LE(ext + 10), count = buffer.readUInt16LE(ext + 12);
      if (stride < 20 || begin + stride * count > end) throw new Error("Invalid XML attributes");
      const attrs = {};
      for (let i = 0; i < count; i++) { const at = begin + i * stride, key = strings[buffer.readUInt32LE(at + 4)], raw = buffer.readUInt32LE(at + 8), kind = buffer[at + 15], data = buffer.readUInt32LE(at + 16); attrs[key] = raw !== 0xffffffff ? strings[raw] : kind === 3 ? strings[data] : kind === 0x12 ? data !== 0 : kind === 0x10 ? data : "@0x" + data.toString(16); }
      const node = { tag: name, attrs, parent: stack.at(-1)?.tag || null }; nodes.push(node); stack.push(node);
    } else if (type === 0x0103) stack.pop();
    cursor = end;
  }
  return { manifest: nodes.find(n => n.tag === "manifest")?.attrs || {}, sdk: nodes.find(n => n.tag === "uses-sdk")?.attrs || {}, application: nodes.find(n => n.tag === "application")?.attrs || {}, permissions: nodes.filter(n => n.tag === "uses-permission" || n.tag === "uses-permission-sdk-23").map(n => n.attrs.name), components: nodes.filter(n => ["activity", "activity-alias", "service", "receiver", "provider"].includes(n.tag)).map(n => ({ type: n.tag, ...n.attrs })) };
}
function createApkService({ paths, jobs }) {
  async function call(a) {
    if (a.action === "jobs") return jobs.list().filter(j => j.kind === "apk");
    if (a.action === "stop") { if (!jobs.list().some(j => j.id === a.id && j.kind === "apk")) throw new Error("分析任务不存在"); return jobs.stop(a.id); }
    if (typeof a.file !== "string" || !path.isAbsolute(a.file) || !a.file.toLowerCase().endsWith(".apk") || !fs.statSync(a.file).isFile()) throw new Error("需要已有 APK 的绝对路径");
    if (a.action === "inspect") {
      const archive = readZip(a.file), hash = createHash("sha256"); for await (const chunk of fs.createReadStream(a.file)) hash.update(chunk);
      return { file: a.file, sha256: hash.digest("hex"), size: fs.statSync(a.file).size, ...parseManifest(archive.manifest), dex: archive.entries.filter(r => /^classes[0-9]*\.dex$/.test(r.name)).map(r => ({ name: r.name, size: r.size })), libraries: archive.entries.filter(r => /^lib\/.+\.so$/.test(r.name)).map(r => ({ name: r.name, size: r.size })), files: archive.entries.slice(0, 500).map(r => ({ name: r.name, size: r.size })), fileCount: archive.entries.length, signatureNote: "这是静态元数据分析，不验证签名有效性或自动执行 APK" };
    }
    if (a.action === "decompile") {
      const executable = componentPath(paths, "jadx"); if (!executable) throw new Error("请先按需安装 jadx 组件");
      const root = path.dirname(executable), java = locate(root, "java.exe"), lib = fs.existsSync(path.join(root, "lib")) ? path.join(root, "lib", "*") : null;
      if (!java || !lib) throw new Error("jadx 包未包含 Java/lib，请检查组件目录");
      const output = path.join(paths.state, "analysis", randomUUID()); fs.mkdirSync(output, { recursive: true });
      return jobs.start({ kind: "apk", file: java, cwd: root, args: ["-Xmx1536m", "-cp", lib, "jadx.cli.JadxCLI", "--threads-count", "2", "--output-dir", output, a.file], output, durationMs: 1800000 });
    }
    throw new Error("未知 APK 操作");
  }
  return { call };
}
module.exports = { readZip, parseManifest, createApkService };
