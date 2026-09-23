/**
 * Light in-app browser. The page is shown in the pi-web panel; this process
 * drives the system Edge (or Chrome) over the DevTools protocol and keeps it
 * headless unless MCCA_BROWSER_HEADLESS=0. A normal web page cannot embed
 * another site's live document, so the panel is this browser's viewport.
 *
 * The profile is a private directory under the temp folder, not the user's
 * daily browser. Snapshots stay short: a handful of named controls, not the
 * whole accessibility tree. Session state sits on globalThis so the plugin
 * and the HTTP panel share one browser.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const INTERESTING = /^(button|link|textbox|searchbox|combobox|checkbox|radio|tab|heading|menuitem|switch)$/i;
const SNAPSHOT_LIMIT = 40;
const NAME_LIMIT = 80;

function shared() {
  if (!globalThis.__mccaBrowser) globalThis.__mccaBrowser = { session: null };
  return globalThis.__mccaBrowser;
}

export function findBrowser() {
  const candidates = [
    process.env.MCCA_BROWSER,
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((file) => typeof file === "string" && file.trim());
  return candidates.find((file) => fs.existsSync(file)) || "";
}

export function assertWebUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input || ""));
  } catch {
    throw new Error("url 不是合法地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("只打开 http 或 https");
  }
  return parsed.href;
}

export function compactTree(nodes, limit = SNAPSHOT_LIMIT) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((node) => [node.nodeId, node]));
  const childIds = new Set();
  for (const node of list) {
    for (const id of node.childIds || []) childIds.add(id);
  }
  const roots = list.map((node) => node.nodeId).filter((id) => !childIds.has(id));
  const lines = [];
  const refs = new Map();
  let seq = 0;

  function walk(id, depth) {
    if (lines.length >= limit || depth > 8) return;
    const node = byId.get(id);
    if (!node) return;
    const role = String(node.role?.value || "");
    const name = String(node.name?.value || "").replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT);
    const show = !node.ignored && INTERESTING.test(role) && name && node.backendDOMNodeId;
    if (show) {
      seq += 1;
      const ref = `e${seq}`;
      refs.set(ref, node.backendDOMNodeId);
      lines.push(`${ref} ${role} ${JSON.stringify(name)}`);
    }
    for (const child of node.childIds || []) walk(child, show ? depth + 1 : depth);
  }

  for (const id of roots) walk(id, 0);
  return { text: lines.join("\n"), refs };
}

function profileDir() {
  return path.join(os.tmpdir(), "mcca-browser");
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error("调试端口超时"));
    });
    req.on("error", reject);
  });
}

async function readPort(dir) {
  const file = path.join(dir, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (fs.existsSync(file)) {
      const port = Number(String(fs.readFileSync(file, "utf8")).split(/\r?\n/)[0]);
      if (port > 0) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("浏览器没有打开调试端口");
}

function send(browser, method, params) {
  const id = ++browser.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 15_000);
    browser.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    browser.ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function connectPage(browser, prefer) {
  const targets = await getJson(`http://127.0.0.1:${browser.port}/json/list`);
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!pages.length) throw new Error("没有页面标签");
  const needle = String(prefer || "").trim().toLowerCase();
  const page = needle
    ? pages.find((item) => item.id === prefer || String(item.url || "").toLowerCase().includes(needle) || String(item.title || "").toLowerCase().includes(needle))
    : pages.find((item) => item.id === browser.pageId) || pages[0];
  if (!page) throw new Error("没有匹配的标签");
  if (browser.ws && browser.ws.readyState === WebSocket.OPEN && browser.pageId === page.id) {
    browser.url = page.url || browser.url;
    browser.title = page.title || browser.title;
    return;
  }
  if (browser.ws) {
    try { browser.ws.close(); } catch { /* the page socket is already gone */ }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接页面超时")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("页面连接失败"));
    });
  });
  browser.ws = ws;
  browser.pending = new Map();
  browser.nextId = 0;
  browser.pageId = page.id;
  browser.url = page.url || "";
  browser.title = page.title || "";
  browser.refs = new Map();
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const waiter = browser.pending.get(message.id);
    if (!waiter) return;
    browser.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "浏览器命令失败"));
    else waiter.resolve(message.result || {});
  });
  await send(browser, "Page.enable");
  await send(browser, "Runtime.enable");
  await send(browser, "DOM.getDocument", { depth: 0 });
}

async function launch() {
  const exe = findBrowser();
  if (!exe) throw new Error("没有找到 Edge 或 Chrome。可以设置 MCCA_BROWSER 指向浏览器程序");
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--window-size=1100,760",
    "about:blank",
  ];
  const headless = process.env.MCCA_BROWSER_HEADLESS !== "0";
  if (headless) args.unshift("--headless=new");
  const proc = spawn(exe, args, { stdio: "ignore", windowsHide: headless });
  const browser = { proc, port: 0, ws: null, pending: new Map(), nextId: 0, refs: new Map(), pageId: "", url: "", title: "" };
  proc.once("exit", () => {
    if (shared().session?.proc === proc) shared().session = null;
  });
  try {
    browser.port = await readPort(dir);
    await connectPage(browser);
  } catch (error) {
    try { proc.kill(); } catch { /* already gone */ }
    throw error;
  }
  shared().session = browser;
  return browser;
}

async function browser() {
  const live = shared().session;
  if (live?.ws && live.ws.readyState === WebSocket.OPEN) return live;
  return launch();
}

async function currentPage(prefer) {
  const live = await browser();
  await connectPage(live, prefer);
  return live;
}

export async function closeBrowser() {
  const live = shared().session;
  shared().session = null;
  if (!live) return;
  try { live.ws?.close(); } catch { /* already closed */ }
  try { live.proc?.kill(); } catch { /* already exited */ }
}

export function browserStatus() {
  const live = shared().session;
  const open = !!(live?.ws && live.ws.readyState === WebSocket.OPEN);
  return { open, title: open ? live.title || "" : "", url: open ? live.url || "" : "" };
}

export async function captureFrame() {
  const live = shared().session;
  if (!live?.ws || live.ws.readyState !== WebSocket.OPEN) return null;
  const shot = await send(live, "Page.captureScreenshot", { format: "jpeg", quality: 45 });
  if (typeof shot.data !== "string" || !shot.data) return null;
  return Buffer.from(shot.data, "base64");
}

async function deviceScale(live) {
  const result = await send(live, "Runtime.evaluate", {
    expression: "window.devicePixelRatio || 1",
    returnByValue: true,
  });
  const ratio = Number(result.result?.value);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export async function clickViewport(imageX, imageY) {
  const live = await browser();
  const ratio = await deviceScale(live);
  const x = Math.round(Number(imageX) / ratio);
  const y = Math.round(Number(imageY) / ratio);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("坐标无效");
  await send(live, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send(live, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function scrollViewport(dy) {
  const live = await browser();
  const amount = Math.max(-2000, Math.min(2000, Math.round(Number(dy) || 0)));
  if (!amount) return;
  await send(live, "Runtime.evaluate", { expression: `window.scrollBy(0, ${amount})` });
}

export async function goBack() {
  const live = await browser();
  const history = await send(live, "Page.getNavigationHistory");
  const index = history.currentIndex;
  const entry = Array.isArray(history.entries) ? history.entries[index - 1] : null;
  if (!entry || index <= 0) return false;
  await send(live, "Page.navigateToHistoryEntry", { entryId: entry.id });
  return true;
}

async function snapshot(live) {
  const tree = await send(live, "Accessibility.getFullAXTree");
  const compact = compactTree(tree.nodes);
  live.refs = compact.refs;
  let title = live.title;
  let url = live.url;
  try {
    const info = await send(live, "Runtime.evaluate", {
      expression: "({ title: document.title, url: location.href })",
      returnByValue: true,
    });
    title = info.result?.value?.title || title;
    url = info.result?.value?.url || url;
  } catch {
    // the tree is still usable without the title line
  }
  const body = compact.text || "（页面上没有可点的命名控件）";
  return `${title || ""}\n${url || ""}\n\n${body}`.trim();
}

function text(value) {
  return { content: [{ type: "text", text: String(value) }] };
}

function fail(error) {
  return text(error instanceof Error ? error.message : String(error));
}

export async function openPage(url) {
  const href = assertWebUrl(url);
  const live = await browser();
  await send(live, "Page.navigate", { url: href });
  const started = Date.now();
  while (Date.now() - started < 12_000) {
    const state = await send(live, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (state.result?.value === "interactive" || state.result?.value === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  live.url = href;
  return snapshot(live);
}

export function registerBrowserTools(api) {
  api.registerTool({
    name: "browser_open",
    description: "在内置浏览器里打开一个 http(s) 页面。页面出现在 pi 界面右侧，不另开系统窗口。独立配置，不是日常浏览器的登录态。第一次调用才启动。",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(args) {
      try {
        return text(await openPage(args?.url));
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "browser_snapshot",
    description: "列出当前页最多 40 个可操作控件，每行一个 ref（e1、e2）。点击和填写都用这个 ref，不要猜选择器。",
    parameters: {
      type: "object",
      properties: { tab: { type: "string", description: "可选。标题或网址的一部分，用来换标签。" } },
    },
    async execute(args) {
      try {
        const live = await currentPage(args?.tab);
        return text(await snapshot(live));
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "browser_click",
    description: "点击快照里的 ref。ref 过期就重新 browser_snapshot，不要重复点同一个失败的 ref。",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
    async execute(args) {
      try {
        const live = await browser();
        const backendNodeId = live.refs.get(String(args?.ref || ""));
        if (!backendNodeId) return text("没有这个 ref。先 browser_snapshot。");
        const model = await send(live, "DOM.getBoxModel", { backendNodeId });
        const quad = model.model?.content || model.model?.border;
        if (!quad || quad.length < 8) return text("这个元素没有位置。重新 snapshot。");
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        const x = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
        const y = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
        await send(live, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await send(live, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        return text(await snapshot(live));
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "browser_fill",
    description: "把文本写入快照里的输入框 ref，会替换原内容。一次最多 2000 字。",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
      },
      required: ["ref", "text"],
    },
    async execute(args) {
      try {
        const value = String(args?.text ?? "");
        if (value.length > 2000) return text("一次最多填写 2000 字");
        const live = await browser();
        const backendNodeId = live.refs.get(String(args?.ref || ""));
        if (!backendNodeId) return text("没有这个 ref。先 browser_snapshot。");
        const resolved = await send(live, "DOM.resolveNode", { backendNodeId });
        const objectId = resolved.object?.objectId;
        if (!objectId) return text("这个元素不能输入");
        await send(live, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(value){this.focus(); if('value' in this){this.value=value; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));} return true;}",
          arguments: [{ value }],
          returnByValue: true,
        });
        return text(`已写入 ${args.ref}`);
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "browser_key",
    description: "向当前焦点按一个键。可用 enter、tab、escape、backspace、arrowdown、arrowup，或一个字符。",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    async execute(args) {
      try {
        const raw = String(args?.key || "").trim();
        if (!raw || raw.length > 20) return text("key 为空或过长");
        const live = await browser();
        const named = {
          enter: "Enter",
          tab: "Tab",
          escape: "Escape",
          esc: "Escape",
          backspace: "Backspace",
          arrowdown: "ArrowDown",
          arrowup: "ArrowUp",
          arrowleft: "ArrowLeft",
          arrowright: "ArrowRight",
        }[raw.toLowerCase()];
        if (!named && raw.length === 1) {
          await send(live, "Input.insertText", { text: raw });
        } else {
          const key = named || raw;
          await send(live, "Input.dispatchKeyEvent", { type: "keyDown", key });
          await send(live, "Input.dispatchKeyEvent", { type: "keyUp", key });
        }
        return text(`已按下 ${raw}`);
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "browser_scroll",
    description: "滚动当前页。dy 为正向下，为负向上，单位是像素，范围 -2000 到 2000。",
    parameters: {
      type: "object",
      properties: { dy: { type: "number" } },
      required: ["dy"],
    },
    async execute(args) {
      try {
        const dy = Math.max(-2000, Math.min(2000, Math.round(Number(args?.dy) || 0)));
        if (!dy) return text("dy 不能为 0");
        const live = await browser();
        await send(live, "Runtime.evaluate", { expression: `window.scrollBy(0, ${dy})` });
        return text(`已滚动 ${dy}`);
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "browser_screenshot",
    description: "截一张当前页的小图。只有快照不够判断布局时才用。",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      try {
        const live = await browser();
        const shot = await send(live, "Page.captureScreenshot", { format: "jpeg", quality: 40 });
        const note = `截图 ${live.title || ""} ${live.url || ""}`.trim();
        const content = [{ type: "text", text: note || "截图" }];
        if (ctx?.agent === "pi" && typeof shot.data === "string") {
          content.push({ type: "image", data: shot.data, mimeType: "image/jpeg" });
        }
        return { content };
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "browser_tabs",
    description: "列出这个自动化浏览器自己打开的标签。select 填标题或网址的一部分就切过去。不要按顺序猜。",
    parameters: {
      type: "object",
      properties: { select: { type: "string" } },
    },
    async execute(args) {
      try {
        const live = await browser();
        if (args?.select) await connectPage(live, args.select);
        const targets = await getJson(`http://127.0.0.1:${live.port}/json/list`);
        const pages = (Array.isArray(targets) ? targets : []).filter((target) => target.type === "page");
        if (!pages.length) return text("没有标签");
        return text(pages.map((page) => `${page.id === live.pageId ? "*" : "-"} ${page.title || ""} ${page.url || ""}`.trim()).join("\n"));
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "browser_close",
    description: "关掉这次自动化打开的浏览器。不会关用户自己正在用的 Edge 或 Chrome。",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        await closeBrowser();
        return text("已关闭自动化浏览器");
      } catch (error) {
        return fail(error);
      }
    },
  });
}
