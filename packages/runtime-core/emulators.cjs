"use strict";
const { spawn } = require("node:child_process");
const { run } = require("./android.cjs");
const { readSettings } = require("./settings.cjs");

// Newer LDPlayer releases append width,height,dpi to the five status fields.
function parseLdInstances(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^(\d+),(.*?),(-?\d+),(-?\d+),([01]),(-?\d+),(-?\d+)(?:,(\d+),(\d+),(\d+))?$/.exec(line.trim());
    if (!match) throw new Error("无法识别雷电 list2 输出");
    const [, index, name, window, bindingWindow, started, pid, vmPid, width, height, dpi] = match;
    return { id: index, name, running: started === "1", pid: Number(pid), vmPid: Number(vmPid), window: Number(window), bindingWindow: Number(bindingWindow), ...(width ? { width: Number(width), height: Number(height), dpi: Number(dpi) } : {}) };
  });
}
function createEmulatorService({ paths, android, execute = run, launch = spawn }) {
  const queues = new Map(), owned = new Map(), errors = new Map();
  const custom=require("./emulator-registry.cjs").createEmulatorRegistry({paths,execute});
  const providers = {
    ldplayer: {
      setting: "ldconsole", label: "雷电模拟器",
      actions: ["list", "start", "stop", "restart", "create", "clone", "configure"],
      list: file => execute(file, ["list2"], { encoding: "buffer" }).then(value => parseLdInstances(Buffer.isBuffer(value) ? new TextDecoder("gb18030").decode(value) : value)),
      async perform(file, a) {
        const name = value => { if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\r\n\0]/.test(value)) throw new Error("需要有效实例名称（最多 80 字）"); return value; };
        if (a.action === "create") return execute(file, ["add", "--name", name(a.name)], { timeout: 180000 });
        if (typeof a.instance !== "string" || !/^\d+$/.test(a.instance)) throw new Error("需要 list 返回的实例 id");
        const instances = await this.list(file), current = instances.find(i => i.id === a.instance);
        if (!current) throw new Error("模拟器实例不存在");
        const target = ["--index", current.id];
        if (["start", "stop", "restart"].includes(a.action)) return execute(file, [{ start: "launch", stop: "quit", restart: "reboot" }[a.action], ...target]);
        if (current.running) throw new Error("克隆或调整参数前请先停止该实例");
        if (a.action === "clone") return execute(file, ["copy", "--name", name(a.name), "--from", current.id], { timeout: 180000 });
        const flags = [];
        if (a.cpu != null) { if (![1,2,3,4,6,8,12,16].includes(a.cpu)) throw new Error("CPU 核数无效"); flags.push("--cpu", String(a.cpu)); }
        if (a.memory != null) { if (!Number.isInteger(a.memory) || a.memory < 512 || a.memory > 65536) throw new Error("内存需为 512–65536 MB"); flags.push("--memory", String(a.memory)); }
        if (a.resolution != null) { if (!/^\d{3,4},\d{3,4},\d{2,3}$/.test(a.resolution)) throw new Error("分辨率格式：宽,高,DPI"); flags.push("--resolution", a.resolution); }
        if (!flags.length) throw new Error("至少指定一项实例参数");
        return execute(file, ["modify", ...target, ...flags]);
      },
    },
    androidsdk: {
      setting: "emulator", label: "Android SDK AVD", actions: ["list", "start", "stop"],
      async list(file) {
        const names = String(await execute(file, ["-list-avds"])).split(/\r?\n/).map(s => s.trim()).filter(s => /^[\w.-]+$/.test(s));
        const active = new Map();
        for (const device of await android.call({ action: "devices" })) {
          if (device.state !== "device" || !/^emulator-\d+$/.test(device.serial)) continue;
          const value = await android.emulatorCommand(device.serial, ["avd", "name"]).catch(() => "");
          const name = String(value).split(/\r?\n/)[0].trim();
          if (names.includes(name)) { const serials = active.get(name) || []; serials.push(device.serial); active.set(name, serials); }
        }
        return names.map(name => ({ id: name, name, running: active.has(name), serials: active.get(name) || [], starting: owned.has(name) && !active.has(name), error: errors.get(name) || null }));
      },
      async perform(file, a) {
        const current = (await this.list(file)).find(i => i.id === a.instance);
        if (!current) throw new Error("AVD 不存在；请先通过 Android Studio 创建");
        if (a.action === "stop") {
          if (!a.serial || !current.serials.includes(a.serial)) throw new Error("需要属于该 AVD 的明确 serial");
          return android.emulatorCommand(a.serial, ["kill"]);
        }
        if (current.running || current.starting) throw new Error("AVD 已启动或正在启动");
        errors.delete(a.instance);
        const child = launch(file, ["-avd", current.name], { windowsHide: true, stdio: "ignore" });
        owned.set(current.name, child);
        child.on("exit", code => { owned.delete(current.name); if (code) errors.set(current.name, `启动进程退出：${code}`); });
        child.on("error", error => { owned.delete(current.name); errors.set(current.name, error.message); });
        await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        child.unref(); return { state: "starting", pid: child.pid, instance: current.id };
      },
    },
  };
  async function perform(a) {
    const settings = readSettings(paths);
    if (a.action === "register") return custom.register(a.definition);
    if (a.action === "providers") return [...Object.entries(providers).map(([id, p]) => ({ id, label: p.label, configured: Boolean(settings[p.setting]), actions: p.actions })),...custom.list()];
    if (custom.has(a.provider)) return custom.call(a);
    const p = providers[a.provider]; if (!p) throw new Error("请选择支持的模拟器 provider");
    const file = settings[p.setting]; if (!file) throw new Error(`请先配置 ${p.setting} 可执行文件路径`);
    if (!p.actions.includes(a.action)) throw new Error("此 provider 尚不支持该操作");
    if (a.action === "list") return p.list(file);
    return p.perform(file, a);
  }
  async function call(a) {
    const key = a.provider || "providers", previous = queues.get(key) || Promise.resolve();
    const op = previous.catch(() => {}).then(() => perform(a)); queues.set(key, op);
    try { return await op; } finally { if (queues.get(key) === op) queues.delete(key); }
  }
  return { call };
}
module.exports = { createEmulatorService, parseLdInstances };
