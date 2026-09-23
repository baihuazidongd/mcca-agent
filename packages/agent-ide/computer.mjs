/**
 * Windows computer control for the local desktop.
 *
 * Coordinates passed to click and scroll are pixels of the last screenshot,
 * not raw screen pixels. The host maps them. There is no background recorder:
 * every action is one tool call.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "computer-host.ps1");
const LAUNCH_FORBIDDEN = /[\r\n&|;<>`$]/;

export const KEY_CODES = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  space: 0x20,
  win: 0x5b,
  meta: 0x5b,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  shift: 0x10,
};

for (let i = 1; i <= 12; i += 1) KEY_CODES[`f${i}`] = 0x6f + i;

const MODS = new Set(["ctrl", "control", "alt", "shift", "win", "meta"]);

let lastFrame = null;

export function resetComputerState() {
  lastFrame = null;
}

export function lastComputerFrame() {
  return lastFrame;
}

export function mapToScreen(frame, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("坐标必须是有限数字");
  if (x < -100000 || y < -100000 || x > 100000 || y > 100000) throw new Error("坐标超出范围");
  if (!frame?.screen || !frame?.image?.width || !frame?.image?.height) {
    return { x: Math.round(x), y: Math.round(y), mapped: false };
  }
  const sx = frame.screen.x + (x * frame.screen.width) / frame.image.width;
  const sy = frame.screen.y + (y * frame.screen.height) / frame.image.height;
  return {
    x: clamp(Math.round(sx), frame.screen.x, frame.screen.x + frame.screen.width - 1),
    y: clamp(Math.round(sy), frame.screen.y, frame.screen.y + frame.screen.height - 1),
    mapped: true,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parseKey(input) {
  const parts = String(input || "")
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("key 不能为空，例如 enter 或 ctrl+s");
  const mods = [];
  let key = null;
  for (const part of parts) {
    const code = KEY_CODES[part] ?? (part.length === 1 ? part.toUpperCase().charCodeAt(0) : undefined);
    if (!code || code < 1 || code > 254) throw new Error(`不认识的按键: ${part}`);
    if (MODS.has(part)) mods.push(code);
    else if (key != null) throw new Error("一次只能有一个主键");
    else key = code;
  }
  if (key == null) throw new Error("缺少主键，例如 ctrl+s 里的 s");
  return { mods, key };
}

export function validateLaunch(target) {
  if (typeof target !== "string") throw new Error("target 必须是字符串");
  const value = target.trim();
  if (!value || value.length > 260) throw new Error("target 为空或过长");
  if (LAUNCH_FORBIDDEN.test(value)) throw new Error("target 不能包含 shell 元字符");
  if (/[\u0000-\u001f]/.test(value)) throw new Error("target 含有控制字符");
  if (/^https?:\/\//i.test(value)) {
    if (/\s/.test(value)) throw new Error("网址不能含空白");
    return value;
  }
  // An existing path may contain spaces. Anything else is a program name and
  // must not carry arguments: ShellExecute would treat "cmd /c ..." as a command.
  if (fs.existsSync(value)) return value;
  if (/\s/.test(value)) throw new Error("程序名不能带参数");
  return value;
}

function powershellExe() {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function runComputer(payload, timeoutMs = 20_000) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("电脑控制目前只实现了 Windows"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HOST],
      {
        windowsHide: true,
        env: { ...process.env, MCCA_CUA_JSON: JSON.stringify(payload) },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`电脑控制超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).pop();
      if (!line) {
        reject(new Error(stderr.trim() || `电脑控制没有输出（exit ${code}）`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(line.slice(0, 500)));
      }
    });
  });
}

function shotPath() {
  const dir = path.join(os.tmpdir(), "mcca-computer");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > 15 * 60 * 1000) fs.rmSync(file, { force: true });
    } catch {
      // a file disappearing mid-cleanup is fine
    }
  }
  return path.join(dir, `shot-${now}.png`);
}

function textResult(text, extra) {
  const content = [{ type: "text", text }];
  if (extra?.image && extra.agent === "pi") {
    content.push({ type: "image", data: extra.image, mimeType: "image/png" });
  }
  return { content };
}

function asError(error) {
  return textResult(error instanceof Error ? error.message : String(error));
}

export function registerComputerTools(api) {
  api.registerTool({
    name: "computer_screenshot",
    description: "截取主显示器，返回缩小后的 PNG。之后的 computer_click / computer_scroll 坐标用这张图的像素，不是屏幕原始像素。只在需要看桌面时调用，不要连续空截。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      try {
        const file = shotPath();
        const result = await runComputer({ op: "screenshot", path: file });
        if (!result?.ok) return textResult(result?.error || "截图失败");
        const png = fs.readFileSync(file);
        lastFrame = { screen: result.screen, image: result.image, path: file };
        const note = `主屏 ${result.screen.width}x${result.screen.height}，图 ${result.image.width}x${result.image.height}。点击坐标用图上的像素。文件 ${file}`;
        return textResult(note, { image: png.toString("base64"), agent: ctx?.agent });
      } catch (error) {
        return asError(error);
      }
    },
  });

  api.registerTool({
    name: "computer_click",
    description: "在上次截图的像素坐标上点击。button 为 left、right 或 middle，clicks 为 1 到 3。先截图再点。",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        clicks: { type: "number" },
      },
      required: ["x", "y"],
    },
    async execute(args) {
      try {
        const point = mapToScreen(lastFrame, Number(args?.x), Number(args?.y));
        const button = args?.button || "left";
        const clicks = Math.min(3, Math.max(1, Math.round(Number(args?.clicks) || 1)));
        const result = await runComputer({ op: "click", x: point.x, y: point.y, button, clicks });
        if (!result?.ok) return textResult(result?.error || "点击失败");
        return textResult(`已${button}键点击屏幕 (${point.x}, ${point.y})${point.mapped ? "（由图坐标换算）" : "（没有上一张截图，按屏幕坐标）"}`);
      } catch (error) {
        return asError(error);
      }
    },
  });

  api.registerTool({
    name: "computer_scroll",
    description: "在上次截图的像素坐标上滚动。dy 为正向下，为负向上，单位是滚轮格，最多 10 格。",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        dy: { type: "number" },
      },
      required: ["x", "y", "dy"],
    },
    async execute(args) {
      try {
        const point = mapToScreen(lastFrame, Number(args?.x), Number(args?.y));
        const dy = Math.max(-10, Math.min(10, Math.round(Number(args?.dy) || 0)));
        if (!dy) return textResult("dy 不能为 0");
        const result = await runComputer({ op: "scroll", x: point.x, y: point.y, dy });
        if (!result?.ok) return textResult(result?.error || "滚动失败");
        return textResult(`已在屏幕 (${point.x}, ${point.y}) 滚动 ${dy}`);
      } catch (error) {
        return asError(error);
      }
    },
  });

  api.registerTool({
    name: "computer_type",
    description: "向当前焦点窗口输入文本，走 Unicode 键盘事件，不经过剪贴板。一次最多 2000 字。不会在后台记录按键。",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(args) {
      try {
        const value = String(args?.text ?? "");
        if (!value) return textResult("text 不能为空");
        if (value.length > 2000) return textResult("一次最多输入 2000 字");
        const result = await runComputer({ op: "type", text: value });
        if (!result?.ok) return textResult(result?.error || "输入失败");
        return textResult(`已输入 ${value.length} 个字符`);
      } catch (error) {
        return asError(error);
      }
    },
  });

  api.registerTool({
    name: "computer_key",
    description: "按下一次组合键。示例：enter、escape、ctrl+s、alt+tab、ctrl+shift+t。修饰键只能是 ctrl、alt、shift、win。",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    async execute(args) {
      try {
        const chord = parseKey(args?.key);
        const result = await runComputer({ op: "key", mods: chord.mods, key: chord.key });
        if (!result?.ok) return textResult(result?.error || "按键失败");
        return textResult(`已按下 ${args.key}`);
      } catch (error) {
        return asError(error);
      }
    },
  });

  api.registerTool({
    name: "computer_windows",
    description: "列出可见顶层窗口的标题和位置，最多 40 个。用来决定下一步点哪或聚焦哪个窗口。",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        const result = await runComputer({ op: "windows" });
        if (!result?.ok) return textResult(result?.error || "列举窗口失败");
        const rows = Array.isArray(result.windows) ? result.windows : [];
        if (!rows.length) return textResult("没有可见窗口");
        return textResult(rows.map((row) => `- ${row.title} @ ${row.x},${row.y} ${row.width}x${row.height}`).join("\n"));
      } catch (error) {
        return asError(error);
      }
    },
  });

  api.registerTool({
    name: "computer_focus",
    description: "按标题子串把一个可见窗口拉到前台。匹配到多个时不切换，返回候选，换更具体的标题再调。",
    parameters: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    async execute(args) {
      try {
        const title = String(args?.title || "").trim();
        if (!title || title.length > 120) return textResult("title 为空或过长");
        const result = await runComputer({ op: "focus", title });
        if (!result?.ok) {
          const extra = Array.isArray(result?.matches) ? `\n${result.matches.map((item) => `- ${item}`).join("\n")}` : "";
          const message = result?.error === "no-match"
            ? "没有标题匹配的窗口"
            : result?.error === "many-matches"
              ? "匹配到多个窗口，请用更具体的标题"
              : (result?.error || "聚焦失败");
          return textResult(`${message}${extra}`);
        }
        return textResult(`已聚焦 ${result.title}`);
      } catch (error) {
        return asError(error);
      }
    },
  });

  api.registerTool({
    name: "computer_launch",
    description: "启动一个程序或用系统默认方式打开 http(s) 链接。target 是程序名（notepad）、已存在的路径，或网址。不能带 shell 命令。",
    parameters: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    },
    async execute(args) {
      try {
        const target = validateLaunch(args?.target);
        const result = await runComputer({ op: "launch", target });
        if (!result?.ok) return textResult(result?.error || "启动失败");
        return textResult(`已启动 ${target}`);
      } catch (error) {
        return asError(error);
      }
    },
  });
}
