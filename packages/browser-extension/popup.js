"use strict";
const status = document.querySelector("#status");
async function send(action) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.runtime.sendMessage({ action, tab: tab?.id, port: Number(document.querySelector("#port").value), code: document.querySelector("#code").value.trim() });
  status.textContent = result.error || JSON.stringify(result, null, 2);
}
for (const action of ["pair", "allow", "deny", "disconnect"]) document.querySelector("#" + action).onclick = () => send(action).catch(e => { status.textContent = e.message; });
chrome.storage.local.get("connection").then(({ connection }) => { if (connection) document.querySelector("#port").value = connection.port; return send("status"); }).catch(e => { status.textContent = e.message; });
