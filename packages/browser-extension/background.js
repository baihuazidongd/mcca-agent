"use strict";
let socket, heartbeat, connecting, lastError = "";
const allowed = new Set();
const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
const web = url => { if (!/^https?:\/\//.test(url)) throw new Error("只支持 HTTP/HTTPS 网页"); return url; };
async function pages() {
  const rows = [];
  for (const id of allowed) { try { const tab = await chrome.tabs.get(id); rows.push({ id, title: tab.title, url: tab.url }); } catch { allowed.delete(id); } }
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: "pages", pages: rows }));
  return rows;
}
async function release() { for (const tabId of allowed) await chrome.debugger.detach({ tabId }).catch(() => {}); allowed.clear(); }
async function evaluate(tabId, expression) {
  const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 10000 });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function command(a) {
  const tab = Number(a.page); if (!allowed.has(tab)) throw new Error("标签页未授权");
  web((await chrome.tabs.get(tab)).url);
  if (a.action === "snapshot") {
    const result = await cdp(tab, "Accessibility.getFullAXTree");
    return { nodes: result.nodes.filter(n => !n.ignored).slice(0, 1500).map(n => ({ id: n.nodeId, role: n.role?.value, name: n.name?.value, value: n.value?.value, children: n.childIds })), limit: 1500 };
  }
  if (a.action === "screenshot") return { mimeType: "image/png", data: (await cdp(tab, "Page.captureScreenshot", { format: "png" })).data };
  if (a.action === "navigate") { const result = await cdp(tab, "Page.navigate", { url: web(a.url) }); if (result.errorText) throw new Error(result.errorText); return { navigating: a.url }; }
  if (a.action === "eval") { if (typeof a.expression !== "string" || a.expression.length > 50000) throw new Error("无效表达式"); return evaluate(tab, a.expression); }
  if (["click", "fill"].includes(a.action)) {
    if (typeof a.selector !== "string" || !a.selector || a.selector.length > 2000) throw new Error("需要唯一 CSS selector");
    const expression = `(() => { const nodes = document.querySelectorAll(${JSON.stringify(a.selector)}); if(nodes.length !== 1) throw new Error('元素不存在或不唯一'); const el = nodes[0]; if(!el.getClientRects().length || el.disabled) throw new Error('元素不可操作'); el.scrollIntoView({block:'center'}); const rect = el.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`;
    if (a.action === "click") {
      const point = await evaluate(tab, expression);
      for (const type of ["mousePressed", "mouseReleased"]) await cdp(tab, "Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    } else {
      if (typeof a.text !== "string" || a.text.length > 100000) throw new Error("无效输入内容");
      await evaluate(tab, expression);
      await evaluate(tab, `(() => { const el=document.querySelector(${JSON.stringify(a.selector)}); if(!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.readOnly) throw new Error('元素不可填写'); el.focus(); el.select(); })()`);
      await cdp(tab, "Input.insertText", { text: a.text });
    }
    return { ok: true };
  }
  if (a.action === "release") { await chrome.debugger.detach({ tabId: tab }); allowed.delete(tab); await pages(); return { released: a.page }; }
  throw new Error("不支持的浏览器操作");
}
async function connect(code, explicitPort) {
  if (connecting) return connecting;
  connecting = (async () => {
    const { connection } = await chrome.storage.local.get("connection");
    const port = explicitPort || connection?.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("无效工作台端口");
    if (!code && !connection?.token) throw new Error("请先从工作台生成配对码");
    if (socket?.readyState === 1) return { connected: true };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/workbench/browser-extension`); socket = ws;
      const timer = setTimeout(() => { ws.close(); reject(new Error("连接超时")); }, 6000);
      ws.onopen = () => ws.send(JSON.stringify(code ? { code } : { token: connection.token }));
      ws.onmessage = async event => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "paired") await chrome.storage.local.set({ connection: { port, token: data.token } });
          if (data.type === "ready") { clearTimeout(timer); lastError = ""; clearInterval(heartbeat); heartbeat = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, 25000); await pages(); resolve({ connected: true }); }
          if (data.type === "command") {
            let response; try { response = { result: await command(data.args) }; } catch (error) { response = { error: error.message }; }
            if (ws.readyState === 1) ws.send(JSON.stringify({ id: data.id, ...response }));
            await pages();
          }
        } catch (error) { lastError = error.message; }
      };
      ws.onerror = () => { lastError = "无法连接工作台"; };
      ws.onclose = () => { clearTimeout(timer); if (socket === ws) { socket = null; clearInterval(heartbeat); void release(); } reject(new Error(lastError || "连接已关闭，请重新配对或连接")); };
    });
  })().finally(() => { connecting = null; });
  return connecting;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  (async () => {
    if (message.action === "pair") return connect(message.code, message.port);
    if (message.action === "status") return { connected: socket?.readyState === 1, allowedTabs: allowed.size, error: lastError || undefined };
    if (message.action === "disconnect") { await chrome.storage.local.remove("connection"); socket?.close(); await release(); return { disconnected: true }; }
    if (message.action === "allow") {
      if (socket?.readyState !== 1) throw new Error("请先连接工作台");
      const tab = await chrome.tabs.get(message.tab); web(tab.url);
      if (!allowed.has(tab.id)) { if (allowed.size >= 50) throw new Error("最多允许 50 个标签页"); await chrome.debugger.attach({ tabId: tab.id }, "1.3"); allowed.add(tab.id); }
      await pages(); return { allowed: tab.id };
    }
    if (message.action === "deny") { if (allowed.has(message.tab)) await chrome.debugger.detach({ tabId: message.tab }); allowed.delete(message.tab); await pages(); return { released: message.tab }; }
    throw new Error("未知操作");
  })().then(respond, error => respond({ error: error.message })); return true;
});
chrome.debugger.onDetach.addListener(source => { allowed.delete(source.tabId); void pages(); });
chrome.tabs.onRemoved.addListener(id => { allowed.delete(id); void pages(); });
chrome.tabs.onUpdated.addListener(id => { if (allowed.has(id)) void pages(); });
chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => { if (!socket && (await chrome.storage.local.get("connection")).connection) await connect().catch(() => {}); });
void chrome.storage.local.get("connection").then(({ connection }) => { if (connection) return connect(); }).catch(() => {});
