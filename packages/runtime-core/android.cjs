"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error((error.message + (stderr ? "\n" + String(stderr) : "")).slice(-3000))); else resolve(stdout);
  }));
}
function parseDevices(text) {
  return String(text).split(/\r?\n/).slice(1).filter(line => line.trim()).map(line => {
    const [serial, state, ...fields] = line.trim().split(/\s+/);
    return { serial, state, ...Object.fromEntries(fields.filter(f => f.includes(":")).map(f => { const i = f.indexOf(":"); return [f.slice(0, i), f.slice(i + 1)]; })) };
  });
}
function parseUi(xml) {
  const unescape = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const nodes = [];
  for (const match of String(xml).matchAll(/<node\b([^>]+)>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], unescape(m[2])]));
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds || "");
    if (!bounds || attrs.enabled === "false") continue;
    if (!attrs.text && !attrs["content-desc"] && attrs.clickable !== "true" && attrs.scrollable !== "true") continue;
    nodes.push({ text: attrs.text || "", description: attrs["content-desc"] || "", resourceId: attrs["resource-id"] || "", class: attrs.class || "", clickable: attrs.clickable === "true", bounds: bounds.slice(1).map(Number) });
    if (nodes.length >= 500) break;
  }
  return nodes;
}
function createAndroidService({ paths, execute = run } = {}) {
  const queues = new Map();
  const snapshots = new Map();
  function adb() {
    const candidates = [process.env.MCCA_ADB, require("./settings.cjs").readSettings(paths).adb, path.join(paths.runtimes, "android/platform-tools/adb.exe"), process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools/adb.exe"), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android/Sdk/platform-tools/adb.exe")];
    return candidates.find(p => p && fs.existsSync(p)) || "adb";
  }
  async function devices() { return parseDevices(await execute(adb(), ["devices", "-l"])); }
  async function perform(a) {
    const found = (await devices()).find(d => d.serial === a.serial);
    if (!found || found.state !== "device") throw new Error(`设备不可操作：${found?.state || "not found"}。请检查连接和 USB 调试授权。`);
    const command = (args, opts) => execute(adb(), ["-s", a.serial, ...args], opts);
    const shell = args => command(["shell", ...args]);
    const number = v => { const n = Number(v); if (!Number.isInteger(n) || Math.abs(n) > 100000) throw new Error("Invalid coordinate/value"); return String(n); };
    const localFile = value => { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("需要绝对文件路径"); return value; };
    const packageName = value => { if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+$/.test(value || "")) throw new Error("Invalid package name"); return value; };
    async function ui() {
      const remote = `/sdcard/mcca-ui-${randomUUID()}.xml`;
      try { await shell(["uiautomator", "dump", remote]); return await command(["exec-out", "cat", remote]); }
      finally { await shell(["rm", "-f", remote]).catch(() => {}); }
    }
    switch (a.action) {
      case "shell":
        if (!Array.isArray(a.args) || !a.args.length || a.args.some(v => typeof v !== "string" || v.includes("\0"))) throw new Error("shell args must be a nonempty string array");
        // adb shell performs another shell parse on the device; quote every argv entry.
        return shell(a.args.map(v => "'" + v.replaceAll("'", "'\\''") + "'"));
      case "screenshot": {
        const image = await command(["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
        if (!Buffer.isBuffer(image) || !image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("设备未返回 PNG 图像");
        return { mimeType: "image/png", data: image.toString("base64") };
      }
      case "ui": {
        const xml = await ui(), generation = randomUUID().slice(0, 8);
        const elements = parseUi(xml).map((node, i) => ({ ...node, ref: `${generation}-${i}` }));
        snapshots.set(a.serial, { at: Date.now(), elements });
        if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value);
        return { serial: a.serial, elements, count: elements.length, limit: 500 };
      }
      case "tap_element": {
        const snapshot = snapshots.get(a.serial);
        const target = snapshot?.elements.find(n => n.ref === a.ref);
        if (!target || Date.now() - snapshot.at > 60000) throw new Error("元素引用已失效，请重新读取 ui");
        const fresh = parseUi(await ui());
        const match = fresh.filter(n => n.text === target.text && n.description === target.description && n.resourceId === target.resourceId && n.class === target.class && JSON.stringify(n.bounds) === JSON.stringify(target.bounds));
        snapshots.delete(a.serial);
        if (match.length !== 1) throw new Error("页面已变化或元素不唯一，请重新读取 ui");
        const [x1,y1,x2,y2] = match[0].bounds;
        return shell(["input", "tap", String(Math.round((x1+x2)/2)), String(Math.round((y1+y2)/2))]);
      }
      case "text": {
        if (typeof a.text !== "string" || !/^[\x20-\x7e]{1,2000}$/.test(a.text) || a.text.includes("%s")) throw new Error("ADB input text 仅支持可打印 ASCII；中文输入需要设备输入法适配");
        snapshots.delete(a.serial);
        return shell(["input", "text", "'" + a.text.replaceAll(" ", "%s").replaceAll("'", "'\\''") + "'"]);
      }
      case "tap": return shell(["input", "tap", number(a.x), number(a.y)]);
      case "swipe": return shell(["input", "swipe", number(a.x), number(a.y), number(a.toX), number(a.toY), number(a.durationMs || 300)]);
      case "key": return shell(["input", "keyevent", number(a.code)]);
      case "install": return command(["install", "-r", localFile(a.file)], { timeout: 180000 });
      case "launch": return shell(["monkey", "-p", packageName(a.package), "-c", "android.intent.category.LAUNCHER", "1"]);
      case "stop_app": return shell(["am", "force-stop", packageName(a.package)]);
      case "packages": return shell(["pm", "list", "packages", "-f"]);
      case "logcat": return command(["logcat", "-d", "-t", String(Math.min(2000, Math.max(1, Number(a.lines) || 200)))]);
      case "push": if (!/^\/(sdcard|data\/local\/tmp)\/[\w./-]+$/.test(a.remote || "")) throw new Error("remote must be under /sdcard or /data/local/tmp"); return command(["push", localFile(a.file), a.remote]);
      case "pull": {
        if (typeof a.remote !== "string" || !a.remote.startsWith("/") || /[\r\n\0]/.test(a.remote)) throw new Error("Invalid remote path");
        const dir = path.join(paths.state, "downloads"); fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, randomUUID() + "-" + path.posix.basename(a.remote).replace(/[^a-zA-Z0-9._-]/g, "_"));
        await command(["pull", a.remote, file], { timeout: 180000 }); return { file };
      }
      case "reverse": {
        const port = value => { if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("Invalid reverse port"); return "tcp:" + value; };
        return command(a.remove ? ["reverse", "--remove", port(a.remotePort)] : ["reverse", "--no-rebind", port(a.remotePort), port(a.localPort)]);
      }
      case "forward": {
        const port = value => { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Invalid port"); return `tcp:${n}`; };
        return command(a.remove ? ["forward", "--remove", port(a.localPort)] : ["forward", port(a.localPort), port(a.remotePort)]);
      }
      default: throw new Error(`Unknown Android action: ${a.action}`);
    }
  }
  async function call(args) {
    if (args.action === "devices") return devices();
    if (typeof args.serial !== "string" || !/^[a-zA-Z0-9_.:[\]-]{1,150}$/.test(args.serial)) throw new Error("请指定设备 serial");
    const previous = queues.get(args.serial) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => perform(args)); queues.set(args.serial, operation);
    try { return await operation; } finally { if (queues.get(args.serial) === operation) queues.delete(args.serial); }
  }
  return { call, async emulatorCommand(serial, args) {
    if (!/^emulator-\d+$/.test(serial) || !(await devices()).some(d => d.serial === serial && d.state === "device")) throw new Error("模拟器未连接");
    return execute(adb(), ["-s", serial, "emu", ...args]);
  } };
}
module.exports = { createAndroidService, parseDevices, parseUi, run };
