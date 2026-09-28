"use strict";
const $ = selector => document.querySelector(selector);
let overview, browserSessions = [], refreshing = false;
const capabilityLabel = { tools: "工具", skills: "技能", mcp: "MCP", customization: "可定制", tasks: "任务管理", assistant: "助理" };
function message(text, error = false) { $("#message").textContent = text; $("#message").classList.toggle("error", error); }
async function api(route, data) {
  const res = await fetch("/api/workbench/" + route, data === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const value = await res.json(); if (!res.ok || value?.error || value?.ok === false) throw new Error(value.error || "操作失败"); return value;
}
const call = (name, args = {}) => api("call", { name, arguments: args });
function output(value) {
  $("#result-panel").hidden = false;
  $("#preview").hidden = !value?.mimeType?.startsWith("image/");
  if (!$("#preview").hidden) $("#preview").src = `data:${value.mimeType};base64,${value.data}`;
  else $("#preview").removeAttribute("src");
  $("#result").textContent = value?.data ? "截图已返回" : JSON.stringify(value, null, 2);
}
async function act(fn, button) {
  if (button) button.disabled = true;
  message("处理中…");
  try { const value = await fn(); if (value !== undefined) output(value); if(value?.ok===false||value?.state==="failed")message(value.error||"操作失败，请查看结果",true);else if(value?.state==="partial")message("已生成部分结果，请查看日志",true);else message(value?.state==="installing"?"安装正在进行，可刷新查看进度":"操作完成"); return value; }
  catch (error) { message(error.message, true); }
  finally { if (button) button.disabled = false; }
}
function node(tag, text) { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; }
function button(text, action) { const b = node("button", text); b.addEventListener("click", () => act(action, b)); return b; }
function options(select, rows, label, id = row => row.id) {
  const current = select.value; select.replaceChildren();
  for (const row of rows) { const o = node("option", label(row)); o.value = id(row); select.append(o); }
  if ([...select.options].some(o => o.value === current)) select.value = current;
}
const taskLabel = { submitted: "已提交", running: "执行中", idle: "会话空闲，待核对结果", offline: "暂时无法连接", stopped: "已请求停止", "dispatch-unknown": "提交状态待核对", dispatching: "正在提交" };
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    overview = await api("overview");
    $("#runtime-list").replaceChildren();
    for (const row of overview.runtimes) {
      const card = node("article"); card.className = "card"; card.append(node("h3", row.label), node("p", row.status.running ? "运行中" : row.status.installed ? "已停止" : "未启用"), node("p", row.capabilities.length ? "能力：" + row.capabilities.map(c => capabilityLabel[c] || c).join(" · ") : "原生界面与服务管理"));
      const actions = node("div"); actions.className = "actions";
      const install=overview.installs.find(j=>j.id===row.id);
      if(install)card.append(node("p",install.state==="installing"?"正在安装："+(install.phase||Math.round((install.bytes||0)/1024/1024)+" MB"):install.error||"安装完成"));
      for (const [action, text] of [[row.status.running ? "stop" : row.status.installed ? "start" : "enable", row.status.running ? "停止" : row.status.installed ? "启动" : "启用"], ...(row.downloadable ? [["install", "下载安装"]] : [])]) actions.append(button(text, async () => { const result = await call("app_runtime", { id: row.id, action }); await refresh(); return result; }));
      card.append(actions); $("#runtime-list").append(card);
    }
    options($("#task-runtime"), overview.runtimes.filter(r => r.taskProtocol), r => r.label);
    $("#task-list").replaceChildren();
    for (const task of overview.tasks) {
      const card = node("article"); card.className = "card";
      card.append(node("h3", task.title), node("p", `${task.runtime} · ${taskLabel[task.state] || task.state}`), node("p", task.detail || ""));
      const actions = node("div"); actions.className = "actions";
      actions.append(button("查看结果", () => call("app_tasks", { action: "inspect", id: task.id })));
      if (task.session && task.state !== "stopped") actions.append(button("停止任务", async () => { const result = await call("app_tasks", { action: "stop", id: task.id }); await refresh(); return result; }));
      card.append(actions); $("#task-list").append(card);
      for (const pending of task.permissions || []) {
        const prompt = node("div"); prompt.append(node("p", pending.title));
        for (const option of pending.options) prompt.append(button(option.name || option.optionId, async () => { const result = await call("app_tasks", { action: "permission", id: task.id, request: pending.request, option: option.optionId }); await refresh(); return result; }));
        card.append(prompt);
      }
    }
    $("#events").replaceChildren(...overview.events.slice(-20).reverse().map(e => node("p", `${new Date(e.at).toLocaleString()} · ${taskLabel[e.state] || e.state} · ${e.detail || e.task}`)));
  } finally { refreshing = false; }
}
const delegationTab = node("button", "长期委托"); delegationTab.dataset.panel = "delegation"; $("nav").append(delegationTab);
for (const b of document.querySelectorAll("nav button")) b.onclick = () => { document.querySelectorAll(".panel").forEach(p => { p.hidden = p.id !== b.dataset.panel; }); document.querySelectorAll("nav button").forEach(n => n.classList.toggle("selected", n === b)); };
$("#refresh").onclick = event => act(refresh, event.target);
$("#runtime-form").onsubmit = event => {
  event.preventDefault(); const form = event.currentTarget; const f = Object.fromEntries(new FormData(form));
  act(async () => { const row = { id: f.id, label: f.label, page: f.id, group: "ide", port: Number(f.port), command: f.command, args: JSON.parse(f.args), cwd: f.cwd || "${APP}", capabilities: [] }; if (f.artifacts.trim()) row.artifacts = JSON.parse(f.artifacts); const result = await api("register", row); await refresh(); message("已添加，刷新主窗口即可显示新页签"); return result; }, event.submitter);
};
$("#task-form").onsubmit = event => {
  event.preventDefault(); const f = Object.fromEntries(new FormData(event.currentTarget));
  const args = { action: "submit", key: crypto.randomUUID(), runtime: f.runtime, text: f.text }; if (f.cwd) args.cwd = f.cwd; if (f.minutes) args.stopAfterMs = Number(f.minutes) * 60000;
  act(async () => { const result = await call("app_tasks", args); await refresh(); return result; }, event.submitter);
};
async function browsers() { browserSessions = await call("browser_control", { action: "list" }); options($("#browser-session"), browserSessions, r => `${r.mode} / ${r.profile} / ${r.id.slice(0, 8)}`); pages(); }
function pages() { options($("#browser-page"), browserSessions.find(s => s.id === $("#browser-session").value)?.pages || [], p => p.url || p.id); }
$("#browser-session").onchange = pages;
const browserArgs = action => ({ action, session: $("#browser-session").value, page: $("#browser-page").value });
$("#browser-form").onsubmit = event => { event.preventDefault(); const f = Object.fromEntries(new FormData(event.currentTarget)); act(async () => { const args = { action: "open", mode: f.mode, profile: f.profile }; if (f.mode === "personal") args.endpoint = f.endpoint; const result = await call("browser_control", args); await browsers(); $("#browser-session").value = result.id; pages(); return result; }, event.submitter); };
$("#navigate-form").onsubmit = event => { event.preventDefault(); act(async () => { const result = await call("browser_control", { ...browserArgs("navigate"), url: new FormData(event.currentTarget).get("url") }); await browsers(); return result; }, event.submitter); };
for (const [id, action] of [["browser-snapshot", "snapshot"], ["browser-shot", "screenshot"], ["browser-network", "network"], ["browser-close", "close"]]) $("#" + id).onclick = event => act(async () => { const result = await call("browser_control", browserArgs(action)); await browsers(); return result; }, event.target);
$("#browser-capture").onclick = event => act(() => call("browser_control", { ...browserArgs("network"), capture: true }), event.target);
let personalBrowsers = [];
function personalPages() { options($("#personal-page"), personalBrowsers.find(b => b.id === $("#personal-browser").value)?.pages || [], p => p.title || p.url); }
async function personalList() { personalBrowsers = await call("personal_browser", { action: "list" }); options($("#personal-browser"), personalBrowsers, b => `${b.id.slice(0,8)} · ${b.connected ? "已连接" : "已断开"}`); personalPages(); return personalBrowsers; }
$("#personal-browser").onchange = personalPages;
$("#browser-pair").onclick = event => act(() => api("browser-pair", {}), event.target);
$("#personal-refresh").onclick = event => act(personalList, event.target);
for (const action of ["snapshot", "screenshot", "release", "revoke"]) $("#personal-" + action).onclick = event => act(async () => {
  const result = await call("personal_browser", { action, browser: $("#personal-browser").value, page: $("#personal-page").value }); await personalList(); return result;
}, event.target);
$("#android-refresh").onclick = event => act(async () => { const devices = await call("android_control", { action: "devices" }); options($("#android-device"), devices, d => `${d.model || d.serial} · ${d.state}`, d => d.serial); return devices; }, event.target);
for (const [id, action] of [["android-shot", "screenshot"], ["android-ui", "ui"], ["android-log", "logcat"], ["android-packages", "packages"]]) $("#" + id).onclick = event => act(() => call("android_control", { action, serial: $("#android-device").value }), event.target);
$("#apk-form").onsubmit = event => { event.preventDefault(); const file = new FormData(event.currentTarget).get("file"); act(() => call("android_control", { action: "install", serial: $("#android-device").value, file }), event.submitter); };
$("#connection").onclick = event => act(() => api("connection"), event.target);
$("#connect-hermes").onclick = event => act(() => api("connect-hermes", {}), event.target);
async function delegationList() {
  const data = await call("assistant_jobs", { action: "list" }); const rows = Array.isArray(data) ? data : data.jobs;
  if (!Array.isArray(rows)) throw new Error("Hermes 委托列表格式不兼容");
  $("#delegation-list").replaceChildren();
  for (const row of rows) {
    const card = node("article"); card.className = "card"; card.append(node("h3", row.name || row.id), node("p", row.schedule_display || JSON.stringify(row.schedule)), node("p", row.enabled === false ? "已暂停" : "已启用"));
    card.append(button("查看委托与执行记录", () => call("assistant_jobs", { action: "inspect", id: row.id })), button(row.enabled === false ? "恢复后续执行" : "暂停后续执行", async () => { const result = await call("assistant_jobs", { action: row.enabled === false ? "resume" : "pause", id: row.id }); await delegationList(); return result; })); $("#delegation-list").append(card);
  }
  return data;
}
$("#delegation-refresh").onclick = event => act(delegationList, event.target);
$("#delegation-form").onsubmit = event => { event.preventDefault(); const f = Object.fromEntries(new FormData(event.currentTarget)); act(async () => { const result = await call("assistant_jobs", { action: "create", ...f, minutes: Number(f.minutes) }); await delegationList(); return result; }, event.submitter); };
$("#settings-form").onsubmit = event => { event.preventDefault(); const input = Object.fromEntries(new FormData(event.currentTarget)); act(() => api("settings", input), event.submitter); };
api("settings").then(values => { for (const key of ["adb", "browser", "fridaPython", "ldconsole", "emulator"]) $("#settings-form").elements[key].value = values[key] || ""; }).catch(error => message(error.message, true));
const emulatorArgs = action => ({ action, provider: $("#emulator-provider").value, instance: $("#emulator-instance").value });
async function emulatorList() {
  const rows = await call("android_emulator", { action: "list", provider: $("#emulator-provider").value });
  options($("#emulator-instance"), rows, r => `${r.name} · ${r.running ? "运行中" : r.starting ? "启动中" : "已停止"}${r.serials?.length ? " · " + r.serials.join(", ") : ""}`);
  return rows;
}
$("#emulator-refresh").onclick = event => act(emulatorList, event.target);
$("#emulator-provider").onchange = () => { $("#emulator-instance").replaceChildren(); $("#emulator-serial").value = ""; };
for (const action of ["start", "stop", "restart"]) $("#emulator-" + action).onclick = event => act(async () => {
  const args = emulatorArgs(action); if (args.provider === "androidsdk" && action === "stop") args.serial = $("#emulator-serial").value;
  const result = await call("android_emulator", args); await emulatorList(); return result;
}, event.target);
$("#emulator-create").onsubmit = event => { event.preventDefault(); const args = { ...emulatorArgs(event.submitter.value), name: new FormData(event.currentTarget).get("name") }; act(async () => { const result = await call("android_emulator", args); await emulatorList(); return result; }, event.submitter); };
$("#emulator-configure").onsubmit = event => { event.preventDefault(); const args = emulatorArgs("configure"); for (const [key, value] of new FormData(event.currentTarget)) if (value) args[key] = key === "resolution" ? value : Number(value); act(() => call("android_emulator", args), event.submitter); };
refresh().catch(error => message(error.message, true)); browsers().catch(() => {});
setInterval(() => { if (!document.hidden) refresh().catch(error => message(error.message, true)); }, 15000);
