import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTasks } = require('../packages/runtime-core/tasks.cjs');
const { createEmulatorService, parseLdInstances } = require('../packages/runtime-core/emulators.cjs');
const { createExtensionBridge } = require('../packages/runtime-core/browser-extension.cjs');
const { createAssistantJobs } = require('../packages/runtime-core/assistant-jobs.cjs');
const { WebSocket } = require(require.resolve('ws', { paths: [path.resolve('packages/runtime-core')] }));
function fixture(t) { const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mcca-adapters-')); t.after(() => fs.rmSync(state, { recursive: true, force: true })); return { state, app: path.resolve('.') }; }
test('Hermes delegation uses dashboard authentication and local delivery without replay on errors', async () => {
  const calls = []; let fail = false;
  const jobs = createAssistantJobs({ runtime: () => ({ port: 3462 }), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/')) return new Response('window.__HERMES_SESSION_TOKEN__="local-token";');
    assert.equal(options.headers['X-Hermes-Session-Token'], 'local-token');
    if (fail) throw new Error('timeout');
    return Response.json({ id: 'job-1' });
  } });
  await assert.rejects(jobs.call({ action: 'create', text: 'monitor', minutes: 2 }), /范围/);
  assert.deepEqual(await jobs.call({ action: 'create', text: 'monitor', scope: 'only task 1', minutes: 2 }), { id: 'job-1' });
  const body = JSON.parse(calls.at(-1).options.body); assert.equal(body.deliver, 'local'); assert.equal(body.schedule, 'every 2m'); assert.match(body.prompt, /only task 1/);
  fail = true; const before = calls.length;
  await assert.rejects(jobs.call({ action: 'create', text: 'monitor', scope: 'only task 1', minutes: 2 }), /不要直接重复/);
  assert.equal(calls.length - before, 2);
});
test('dsh task lifecycle uses its RPC contract and rejects refused cancellation', async t => {
  let running = true, accepted = false; const calls = [];
  const tasks = createTasks({ paths: fixture(t), runtime: () => ({ port: 3081, taskProtocol: 'dsh-rpc-v1' }), fetchRuntime: async (_, route, method, body) => {
    calls.push(body); assert.equal(route, '/api/' + body.method); assert.equal(method, 'POST'); assert.equal(body.type, 'client-request');
    const value = { 'session.create': { sessionId: 'test-session' }, 'session.prompt': {}, 'session.list': { items: [{ sessionId: 'test-session', running }] }, 'session.history': { events: ['response'] }, 'session.cancel': { accepted } }[body.method];
    return { result: { ok: true, value } };
  } }); t.after(() => tasks.dispose());
  const args = { runtime: 'dsh', key: 'test', text: 'work', cwd: 'D:/test' };
  const row = await tasks.submit(args); assert.equal(row.state, 'submitted');
  assert.deepEqual(calls[1].payload, { sessionId: 'test-session', mode: 'queue', content: [{ type: 'text', text: 'work' }] });
  await tasks.tick(); assert.equal(tasks.list()[0].state, 'running'); running = false;
  await tasks.tick(); assert.equal(tasks.list()[0].state, 'idle');
  assert.deepEqual((await tasks.inspect(row.id)).history.events, ['response']);
  await assert.rejects(tasks.stop(row.id), /未接受/); assert.equal(tasks.list()[0].state, 'idle');
  accepted = true; await tasks.stop(row.id); assert.equal(tasks.list()[0].state, 'stopped');
  await assert.rejects(tasks.submit({ ...args, text: 'different' }), /不同任务/);
  assert.equal((await tasks.submit(args)).id, row.id);
});
test('LDPlayer correctly parses handles versus PIDs and prevents modifying running instances', async t => {
  const paths = fixture(t); fs.writeFileSync(path.join(paths.state, 'settings.json'), JSON.stringify({ ldconsole: 'ldconsole.exe' }));
  const calls = []; const rows = '0,游戏,主实例,66882,99871,1,3456,7890\n1,副实例,0,0,0,-1,-1\n';
  assert.equal(parseLdInstances(rows)[0].pid, 3456); assert.equal(parseLdInstances(rows)[0].name, '游戏,主实例');
  const extended = parseLdInstances('0,雷电模拟器,619390454,135669454,1,17576,67228,1920,1080,280')[0];
  assert.equal(extended.pid, 17576); assert.equal(extended.width, 1920); assert.equal(extended.name, '雷电模拟器');
  const service = createEmulatorService({ paths, android: {}, execute: async (_, args) => { calls.push(args); return args[0] === 'list2' ? rows : 'ok'; } });
  await assert.rejects(service.call({ action: 'configure', provider: 'ldplayer', instance: '0', cpu: 4 }), /先停止/);
  await assert.rejects(service.call({ action: 'stop', provider: 'ldplayer', instance: '99' }), /不存在/);
  await service.call({ action: 'clone', provider: 'ldplayer', instance: '1', name: '任务 二' });
  assert.deepEqual(calls.at(-1), ['copy', '--name', '任务 二', '--from', '1']);
  await service.call({ action: 'configure', provider: 'ldplayer', instance: '1', cpu: 4, memory: 2048 });
  assert.deepEqual(calls.at(-1), ['modify', '--index', '1', '--cpu', '4', '--memory', '2048']);
});
test('SDK stop uses discovered AVD identity and an explicit matching device', async t => {
  const paths = fixture(t); fs.writeFileSync(path.join(paths.state, 'settings.json'), JSON.stringify({ emulator: 'emulator.exe' })); const commands = [];
  const service = createEmulatorService({ paths, execute: async () => 'Pixel\nTablet\n', android: {
    call: async () => [{ serial: 'emulator-5554', state: 'device' }, { serial: 'physical', state: 'device' }],
    emulatorCommand: async (serial, args) => { commands.push([serial, args]); return args[0] === 'avd' ? 'Pixel\nOK\n' : 'OK'; },
  } });
  await assert.rejects(service.call({ action: 'stop', provider: 'androidsdk', instance: 'Tablet', serial: 'emulator-5554' }), /明确 serial/);
  await service.call({ action: 'stop', provider: 'androidsdk', instance: 'Pixel', serial: 'emulator-5554' });
  assert.deepEqual(commands.at(-1), ['emulator-5554', ['kill']]);
});
test('extension pairing, tab boundaries, token scope and revocation over real WebSockets', async t => {
  const paths = fixture(t), server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, bridge = createExtensionBridge({ paths, port }); bridge.attach(server);
  const sockets = []; t.after(async () => { for (const s of sockets) s.terminate(); bridge.dispose(); await new Promise(resolve => server.close(resolve)); });
  const connect = async (auth, origin = 'chrome-extension://' + 'a'.repeat(32)) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/workbench/browser-extension`, { origin }); sockets.push(ws); const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw))); await once(ws, 'open'); ws.send(JSON.stringify(auth)); return { ws, messages };
  };
  const until = async fn => { for (let i=0; i<100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('timed out'); };
  const pair = bridge.pair(), first = await connect({ code: pair.code }); await until(() => first.messages.some(m => m.type === 'ready'));
  const credential = first.messages.find(m => m.type === 'paired'); assert.ok(credential.token);
  first.ws.send(JSON.stringify({ type: 'pages', pages: [{ id: 7, title: 'User tab', url: 'https://example.com' }] })); await until(() => bridge.list()[0].pages.length === 1);
  await assert.rejects(bridge.call({ action: 'snapshot', browser: credential.id, page: '8' }), /允许/);
  const result = bridge.call({ action: 'snapshot', browser: credential.id, page: '7' }); await until(() => first.messages.some(m => m.type === 'command'));
  const command = first.messages.find(m => m.type === 'command'); first.ws.send(JSON.stringify({ id: command.id, result: { nodes: ['ok'] } })); assert.deepEqual(await result, { nodes: ['ok'] });
  const wrongOrigin = await connect({ token: credential.token }, 'chrome-extension://' + 'b'.repeat(32)); await until(() => wrongOrigin.ws.readyState === WebSocket.CLOSED);
  const reuse = await connect({ code: pair.code }); await until(() => reuse.ws.readyState === WebSocket.CLOSED);
  await bridge.call({ action: 'revoke', browser: credential.id }); await until(() => first.ws.readyState === WebSocket.CLOSED); assert.deepEqual(bridge.list(), []);
});
