"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function loopbackEndpoint(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Browser debugging endpoint must be on localhost");
  return url.href;
}
function webUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) pages are supported");
  return url.href;
}
function createBrowserService({ paths, launch, connect } = {}) {
  const sessions = new Map(); let managed, starting, opening = Promise.resolve();
  const profileRoot = path.join(paths.state, "browser");
  async function engine() {
    if (managed?.isConnected()) return managed;
    if (!starting) starting = (async () => {
      const { chromium } = require("playwright-core");
      const candidates = [process.env.MCCA_BROWSER, require("./settings.cjs").readSettings(paths).browser, path.join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"), path.join(process.env.ProgramFiles || "C:/Program Files", "Google/Chrome/Application/chrome.exe")];
      const executablePath = candidates.find(p => p && fs.existsSync(p));
      if (!executablePath && !launch) throw new Error("未找到 Edge/Chrome，请在设置中指定 MCCA_BROWSER");
      managed = await (launch || chromium.launch.bind(chromium))({ executablePath, headless: true });
      return managed;
    })().finally(() => { starting = null; });
    return starting;
  }
  function watchPage(session, page) {
    const id = randomUUID(); session.pages.set(id, page);
    page.on("close", () => { session.pages.delete(id); session.refs.clear(); });
    page.on("framenavigated", () => session.refs.clear());
    for (const event of ["requestfinished", "requestfailed"]) page.on(event, request => { if (session.capture) session.recorder.record(request,id); });
    if (session.mode === "ai") page.on("dialog", dialog => dialog.dismiss().catch(() => {}));
    return id;
  }
  async function open({ mode = "ai", endpoint, profile = "default" } = {}) {
    if (sessions.size >= 8) throw new Error("最多同时打开 8 个浏览器会话");
    if (!["ai", "personal"].includes(mode)) throw new Error("Invalid browser mode");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error("Invalid browser profile");
    if ([...sessions.values()].some(s => s.mode === mode && (mode === "ai" ? s.profile === profile : s.endpoint === endpoint))) throw new Error("该浏览器配置已有活动会话，请复用或先断开");
    fs.mkdirSync(profileRoot, { recursive: true });
    const storage = path.join(profileRoot, profile + ".json");
    let browser, context;
    if (mode === "personal") {
      const chromium = require("playwright-core").chromium;
      browser = await (connect || chromium.connectOverCDP.bind(chromium))(loopbackEndpoint(endpoint), { timeout: 10000 });
      context = browser.contexts()[0];
      if (!context) throw new Error("浏览器没有可用上下文");
    } else {
      browser = await engine();
      context = await browser.newContext({ storageState: fs.existsSync(storage) ? storage : undefined, acceptDownloads: true });
    }
    const s = { id: randomUUID(), mode, profile, endpoint, browser, context, storage, pages: new Map(), refs: new Map(), recorder: require("./browser-network.cjs").createNetworkRecorder(), capture: false, busy: Promise.resolve(), lastUsed: Date.now(), rules: new Map() };
    context.setDefaultTimeout(10000);
    for (const page of context.pages()) watchPage(s, page);
    context.on("page", page => { if (![...s.pages.values()].includes(page)) watchPage(s, page); });
    if (!s.pages.size) { const page = await context.newPage(); if (![...s.pages.values()].includes(page)) watchPage(s, page); }
    sessions.set(s.id, s);
    return info(s);
  }
  function info(s) { return { id: s.id, mode: s.mode, profile: s.profile, capture: s.capture, pages: [...s.pages].map(([id, page]) => ({ id, url: page.url() })) }; }
  async function close(s) {
    if (s.mode === "ai") {
      await s.context.storageState({ path: s.storage, indexedDB: true });
      await s.context.close();
    } else {
      // Over-CDP close disconnects Playwright's transport; it does not issue Browser.close.
      await s.browser.close();
    }
    sessions.delete(s.id);
    if (![...sessions.values()].some(x => x.mode === "ai") && managed) { await managed.close(); managed = null; }
    return { closed: true, mode: s.mode };
  }
  async function perform(s, args) {
    const { action } = args; s.lastUsed = Date.now();
    if (action === "close") return close(s);
    if (action === "tabs") return info(s);
    if (action === "new_tab") { const p = await s.context.newPage(); if (args.url) await p.goto(webUrl(args.url), { waitUntil: "domcontentloaded" }); return info(s); }
    if (action === "network") {
      if (typeof args.capture === "boolean") s.capture = args.capture;
      if (args.clear) s.recorder.clear();
      await s.recorder.settle();
      return {capture:s.capture,flows:s.recorder.list().slice(-100),limits:s.recorder.limits};
    }
    if (action === "network_detail") { await s.recorder.settle(); return s.recorder.detail(args.request); }
    if (action === "export_har") {
      await s.recorder.settle();
      const directory=path.join(paths.state,"downloads"); fs.mkdirSync(directory,{recursive:true});
      const file=path.join(directory,"network-"+randomUUID()+".har");
      fs.writeFileSync(file,JSON.stringify(s.recorder.har(),null,2));
      return {file,entries:s.recorder.list().length,responseBodiesIncluded:true,limits:s.recorder.limits};
    }
    // No shared 'current tab': actions must identify their page explicitly.
    const p = s.pages.get(args.page);
    if (!p || p.isClosed()) throw new Error("请选择当前会话里的 page；先调用 tabs");
    const frame = args.frame ? p.frames().find(f => f.url() === args.frame || f.name() === args.frame) : p.mainFrame();
    if (!frame) throw new Error("Frame not found");
    if (action === "navigate") { await p.goto(webUrl(args.url), { waitUntil: "domcontentloaded", timeout: 30000 }); return { url: p.url() }; }
    if (action === "frames") return p.frames().map(f => ({ name: f.name(), url: f.url() }));
    if (action === "snapshot") {
      s.refs.clear();
      const snapshot = await frame.locator("body").ariaSnapshot({ timeout: 10000 });
      const controls = await frame.locator('a,button,input,textarea,select,[role],[contenteditable="true"]').evaluateAll(elements => elements.filter(el => el.getClientRects().length).slice(0, 250).map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), name: (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || "").trim().slice(0, 120) })));
      return { page: args.page, url: frame.url(), tree: snapshot.slice(0, 50000), truncated: snapshot.length > 50000, controls, targeting: "Use role+name (exact), or selector; frame is an exact URL or frame name." };
    }
    if (action === "screenshot") return { mimeType: "image/png", data: (await p.screenshot({ fullPage: false })).toString("base64") };
    if (action === "eval") {
      if (typeof args.expression !== "string" || args.expression.length > 30000) throw new Error("Invalid expression");
      const result = await frame.evaluate(async source => {
        let timer;
        try { return await Promise.race([Promise.resolve().then(() => (0, eval)(source)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Evaluation timed out")), 15000); })]); }
        finally { clearTimeout(timer); }
      }, args.expression);
      const json = JSON.stringify(result ?? null); if (json.length > 200000) throw new Error("结果过大，请在表达式中缩小范围"); return result;
    }
    if (action === "cookies") {
      if (args.cookies) { if (!Array.isArray(args.cookies)) throw new Error("cookies must be an array"); await s.context.addCookies(args.cookies); }
      return s.context.cookies(args.url ? [webUrl(args.url)] : undefined);
    }
    if (action === "route") {
      if (typeof args.pattern !== "string" || args.pattern.length > 500) throw new Error("Invalid URL pattern");
      if (args.remove) { await p.unroute(args.pattern); return { removed: true }; }
      if (!["block", "mock"].includes(args.behavior)) throw new Error("behavior must be block or mock");
      await p.unroute(args.pattern);
      await p.route(args.pattern, route => args.behavior === "block" ? route.abort() : route.fulfill({ status: args.status || 200, contentType: args.contentType || "application/json", body: String(args.body || "").slice(0, 1000000) }));
      return { registered: true };
    }
    if (action === "close_tab") { await p.close(); return info(s); }
    if (action === "key") { await p.keyboard.press(String(args.key)); return { ok: true }; }
    const locator = args.role ? frame.getByRole(args.role, { name: args.name, exact: true }) : args.selector ? frame.locator(args.selector) : null;
    if (!locator) throw new Error("需要 role/name 或 selector");
    if (action === "click") await locator.click();
    else if (action === "fill") await locator.fill(String(args.text ?? ""));
    else if (action === "wait") await locator.waitFor({ state: args.state || "visible", timeout: Math.min(30000, Math.max(100, Number(args.timeoutMs) || 10000)) });
    else if (action === "upload") {
      if (!Array.isArray(args.files) || args.files.some(f => typeof f !== "string" || !path.isAbsolute(f))) throw new Error("files must be absolute paths");
      await locator.setInputFiles(args.files);
    } else if (action === "download") {
      const [download] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), locator.click()]);
      const dir = path.join(paths.state, "downloads"); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, randomUUID() + "-" + path.basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, "_"));
      await download.saveAs(file); return { file };
    } else throw new Error(`Unknown browser action: ${action}`);
    return { ok: true, page: args.page };
  }
  async function call(args) {
    if (args.action === "list") return [...sessions.values()].map(info);
    if (args.action === "open") { const result = opening.then(() => open(args)); opening = result.catch(() => {}); return result; }
    const s = sessions.get(args.session); if (!s) throw new Error("Browser session not found");
    const result = s.busy.then(() => perform(s, args)); s.busy = result.catch(() => {}); return result;
  }
  return { call, async dispose() { for (const s of sessions.values()) await s.busy.then(() => close(s)).catch(() => {}); } };
}
module.exports = { createBrowserService, loopbackEndpoint, webUrl };
