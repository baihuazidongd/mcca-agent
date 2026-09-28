import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = process.env.MCCA_SMOKE_ROOT || path.resolve(import.meta.dirname, '..');
const { chromium } = require(require.resolve('playwright-core', { paths: [path.join(root, 'packages/runtime-core')] }));
const { createExtensionBridge } = require(path.join(root, 'packages/runtime-core/browser-extension.cjs'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcca-extension-smoke-'));
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Extension fixture</title><label>Name<input id="name"></label><button id="send" onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Send</button><output></output>'); });
let context, bridge;
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  bridge = createExtensionBridge({ paths: { app: root, state: temp }, port }); bridge.attach(server);
  const extension = path.join(root, 'packages/browser-extension');
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    executablePath: process.env.MCCA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}`);
  const pair = bridge.pair();
  await worker.evaluate(({ code, port }) => connect(code, port), pair);
  const tabId = await worker.evaluate(async port => {
    const tab = (await chrome.tabs.query({})).find(t => t.url === `http://127.0.0.1:${port}/`);
    await chrome.debugger.attach({ tabId: tab.id }, '1.3'); allowed.add(tab.id); await pages(); return tab.id;
  }, port);
  for(let i=0; i<100 && !bridge.list()[0]?.pages.length; i++) await new Promise(r => setTimeout(r, 20));
  const browser = bridge.list()[0].id, args = { browser, page: String(tabId) };
  assert.ok((await bridge.call({ ...args, action: 'snapshot' })).nodes.some(n => n.name === 'Send'));
  await bridge.call({ ...args, action: 'fill', selector: '#name', text: 'Extension passed' });
  await bridge.call({ ...args, action: 'click', selector: '#send' });
  assert.equal(await page.locator('output').textContent(), 'Extension passed');
  assert.equal((await bridge.call({ ...args, action: 'screenshot' })).mimeType, 'image/png');
  await assert.rejects(bridge.call({ ...args, page: String(tabId + 100), action: 'snapshot' }), /允许/);
  await bridge.call({ ...args, action: 'release' });
  assert.equal(await page.title(), 'Extension fixture');
  const popup = await context.newPage(); await popup.goto(worker.url().replace(/background\.js$/, 'popup.html'));
  await popup.getByRole('button', { name: '配对 / 重新连接' }).waitFor();
  console.log('PASS: real Edge MV3 pairing, explicit tab attachment, AX snapshot, fill/click, screenshot, page isolation, release keeps tab alive, popup UI.');
} finally {
  await context?.close(); bridge?.dispose(); await new Promise(r => server.close(r)); fs.rmSync(temp, { recursive: true, force: true });
}
