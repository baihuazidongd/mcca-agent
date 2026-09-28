import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { createRegistry, validate } = require('../packages/runtime-core/registry.cjs');
const { createPaths } = require('../packages/runtime-core/paths.cjs');
const { createTasks } = require('../packages/runtime-core/tasks.cjs');
const { createAndroidService, parseDevices } = require('../packages/runtime-core/android.cjs');
const { loopbackEndpoint } = require('../packages/runtime-core/browser.cjs');
const { createWorkbench } = require('../packages/runtime-core/workbench.cjs');
const { createInstaller } = require('../packages/runtime-core/install.cjs');
const { createBackoff } = require('../packages/runtime-core/supervisor.cjs');
const { parseUi } = require('../packages/runtime-core/android.cjs');
const root = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcca-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createPaths({ MCCA_HOME: root, MCCA_DATA_DIR: dir });
}
const custom = { id: 'new-ide', label: 'New IDE', page: 'new-ide', group: 'ide', port: 3555, command: '${NODE}', args: ['${APP}/server.cjs'], cwd: '${DATA}', capabilities: [] };
const resolvers = { openhandsWeb() {}, hermesWorkspace() {}, hermesDashboard() {} };
test('registering a new IDE survives restart and resolves paths without editing source', t => {
  const paths = fixture(t), env = {};
  const registry = createRegistry({ paths, env }); registry.add(custom);
  const restored = createRegistry({ paths, env });
  assert.equal(restored.all().at(-1).id, 'new-ide');
  assert.equal(restored.resolve(resolvers)['new-ide'].cmd, process.execPath);
  assert.equal(restored.resolve(resolvers)['new-ide'].cwd, paths.data);
  assert.equal(restored.all().at(-1).defaultInstalled, false);
});
test('registry rejects invalid dependencies, cycles, ports and variables before saving', t => {
  const paths = fixture(t), registry = createRegistry({ paths, env: {} });
  assert.throws(() => registry.add({ ...custom, requires: ['missing'] }), /dependency/);
  assert.throws(() => registry.add({ ...custom, requires: ['new-ide'] }), /cycle/);
  assert.throws(() => registry.add({ ...custom, port: 3458 }), /Duplicate/);
  assert.throws(() => registry.add({ ...custom, command: '${TYPO}' }), /Unknown variable/);
  assert.throws(() => registry.add({ ...custom, reclaim: { signature: 'node' } }), /explicit executable/);
  assert.equal(fs.existsSync(path.join(paths.state, 'runtimes.json')), false);
  assert.throws(() => validate([{ ...custom, id: 'constructor' }]), /Invalid/);
});
test('environment argv JSON preserves paths with spaces', t => {
  const registry = createRegistry({ paths: fixture(t), env: { PI_WEB_ARGS: '["C:/my app/main.cjs","--flag"]', PI_PORT: '3581' } });
  const cfg = registry.resolve(resolvers)['pi-web'];
  assert.deepEqual(cfg.args, ['C:/my app/main.cjs', '--flag']);
  assert.equal(cfg.port, 3581); assert.equal(cfg.env.PI_WEB_PORT, '3581');
});
test('concurrent submissions use one idempotency key and a restart never resends', async t => {
  const paths = fixture(t); let prompts = 0;
  const opts = { paths, runtime: () => ({ port: 1, taskProtocol: 'sessions-v1' }), fetchRuntime: async (_, route) => route.endsWith('/prompt') ? (prompts++, { ok: true }) : { id: 'session-a' } };
  const tasks = createTasks(opts); t.after(() => tasks.dispose());
  const args = { key: 'same-key', runtime: 'pi-web', text: 'do work' };
  const [a,b] = await Promise.all([tasks.submit(args), tasks.submit(args)]);
  assert.equal(a.id, b.id); assert.equal(prompts, 1);
  const restored = createTasks(opts); t.after(() => restored.dispose());
  assert.equal((await restored.submit(args)).id, a.id); assert.equal(prompts, 1);
});
test('offline monitoring never calls a task complete and stop targets its exact session', async t => {
  const paths = fixture(t); let online = true, running = true; const calls = [];
  const tasks = createTasks({ paths, runtime: () => ({ port: 1, taskProtocol: 'sessions-v1' }), fetchRuntime: async (_, route, method) => {
    calls.push([route, method]);
    if (!online) throw new Error('connection refused');
    if (route === '/api/sessions' && method === 'POST') return { id: 'a/b' };
    if (route === '/api/sessions') return { sessions: [{ id: 'a/b', running }] };
    return { ok: true };
  } }); t.after(() => tasks.dispose());
  const row = await tasks.submit({ key: 'x', runtime: 'pi-web', text: 'task' });
  await tasks.tick(); assert.equal(tasks.list()[0].state, 'running');
  online = false; await tasks.tick(); assert.equal(tasks.list()[0].state, 'offline');
  online = true; running = false; await tasks.tick(); assert.equal(tasks.list()[0].state, 'idle');
  await tasks.stop(row.id); assert.equal(tasks.list()[0].state, 'stopped');
  assert.ok(calls.some(([route]) => route === '/api/sessions/a%2Fb/stop'));
});
test('ambiguous dispatch failure remains inspectable and is not retried', async t => {
  let calls = 0; const tasks = createTasks({ paths: fixture(t), runtime: () => ({ port: 1, taskProtocol: 'sessions-v1' }), fetchRuntime: async () => { calls++; throw new Error('timeout'); } }); t.after(() => tasks.dispose());
  const args = { key: 'x', runtime: 'pi-web', text: 'task' };
  assert.equal((await tasks.submit(args)).state, 'dispatch-unknown');
  await tasks.submit(args); await tasks.tick(); assert.equal(calls, 1);
});
test('Android targets exact devices and serializes per-device operations', async t => {
  const calls = []; let active = 0, maximum = 0;
  const android = createAndroidService({ paths: fixture(t), execute: async (_, args) => {
    calls.push(args);
    if (args[0] === 'devices') return 'List of devices attached\nemulator-5554 device model:Test\nphysical unauthorized\n';
    active++; maximum = Math.max(active, maximum); await new Promise(r => setTimeout(r, 5)); active--; return 'ok';
  } });
  await Promise.all([android.call({ action: 'tap', serial: 'emulator-5554', x: 5, y: 6 }), android.call({ action: 'key', serial: 'emulator-5554', code: 4 })]);
  assert.equal(maximum, 1);
  assert.deepEqual(calls.find(c => c[2] === 'shell'), ['-s', 'emulator-5554', 'shell', 'input', 'tap', '5', '6']);
  await assert.rejects(android.call({ action: 'tap', serial: 'physical', x: 1, y: 1 }), /unauthorized/);
  await assert.rejects(android.call({ action: 'tap', serial: 'not-there', x: 1, y: 1 }), /not found/);
});
test('Android screencap uses binary exec-out and rejects non-images', async t => {
  const android = createAndroidService({ paths: fixture(t), execute: async (_, args) => args[0] === 'devices' ? 'List of devices attached\nx device\n' : Buffer.from('error') });
  await assert.rejects(android.call({ action: 'screenshot', serial: 'x' }), /PNG/);
  assert.equal(parseDevices('List of devices attached\n127.0.0.1:5555 device model:Phone\n')[0].serial, '127.0.0.1:5555');
});
test('personal browser connection only accepts local HTTP debugging endpoints', () => {
  assert.equal(loopbackEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222/');
  assert.throws(() => loopbackEndpoint('http://evil.example:9222'), /localhost/);
  assert.throws(() => loopbackEndpoint('file:///etc/passwd'), /localhost/);
});
test('supervisor backs off repeated crashes and resets only after health', () => {
  let clock = 0; const b = createBackoff({ now: () => clock, baseMs: 10, maxMs: 40 });
  assert.equal(b.ready('pi'), true); b.failed('pi'); assert.equal(b.ready('pi'), false);
  clock = 10; assert.equal(b.ready('pi'), true); assert.equal(b.failed('pi').retryAt, 30);
  clock = 30; assert.equal(b.failed('pi').retryAt, 70); b.healthy('pi'); assert.equal(b.ready('pi'), true);
});
test('Android UI exposes meaningful controls and rejects stale element references', async t => {
  let label = 'Send';
  const xml = () => `<hierarchy><node text="${label}" resource-id="app:id/send" class="Button" clickable="true" enabled="true" bounds="[0,0][100,60]" /></hierarchy>`;
  assert.equal(parseUi(xml())[0].resourceId, 'app:id/send');
  const android = createAndroidService({ paths: fixture(t), execute: async (_, args) => args[0] === 'devices' ? 'List of devices attached\nx device\n' : args[2] === 'exec-out' ? xml() : 'ok' });
  const snap = await android.call({action:'ui',serial:'x'}); label = 'Delete';
  await assert.rejects(android.call({action:'tap_element',serial:'x',ref:snap.elements[0].ref}), /页面已变化/);
});
test('Hermes MCP config update preserves unrelated settings and creates a backup', t => {
  const paths = fixture(t); paths.app = paths.data;
  const home = path.join(paths.app, 'vendor/cli/hermes'); fs.mkdirSync(home,{recursive:true});
  fs.writeFileSync(path.join(home,'config.yaml'),'# keep comment\nmodel: example\nmcp_servers:\n  existing:\n    command: old\n');
  const { connectHermes } = require('../packages/runtime-core/assistant-config.cjs');
  const result = connectHermes(paths); const YAML = require('../packages/runtime-core/node_modules/yaml');
  const source = fs.readFileSync(result.file,'utf8'), data = YAML.parse(source);
  assert.equal(data.model,'example'); assert.equal(data.mcp_servers.existing.command,'old');
  assert.ok(data.mcp_servers['mcca-workbench'].command); assert.ok(source.includes('# keep comment')); assert.ok(fs.existsSync(result.backup));
  fs.writeFileSync(result.file, '# default Hermes configuration\nmcp_servers: null\n');
  connectHermes(paths);
  assert.ok(YAML.parse(fs.readFileSync(result.file, 'utf8')).mcp_servers['mcca-workbench']);
  fs.writeFileSync(result.file, 'mcp_servers: []\n');
  assert.throws(() => connectHermes(paths), /映射格式/);
  assert.equal(fs.readFileSync(result.file, 'utf8'), 'mcp_servers: []\n');
});
test('installer verifies checksum before replacing the existing installation', async t => {
  const paths = fixture(t), current = path.join(paths.runtimes, 'new-ide/current'); fs.mkdirSync(current, { recursive: true }); fs.writeFileSync(path.join(current, 'old.txt'), 'keep');
  const installer = createInstaller({ paths, fetchFile: async () => new Response('payload') });
  const row = { ...custom, artifacts: { [`${process.platform}-${process.arch}`]: { url: 'https://example.test/runtime', sha256: '0'.repeat(64), format: 'file', filename: 'app.exe' } } };
  assert.equal((await installer.install(row)).state, 'failed');
  assert.equal(fs.readFileSync(path.join(current, 'old.txt'), 'utf8'), 'keep');
  row.artifacts[`${process.platform}-${process.arch}`].sha256 = createHash('sha256').update('payload').digest('hex');
  const result = await installer.install(row); assert.equal(result.state, 'installed');
  assert.equal(fs.readFileSync(path.join(current, 'app.exe'), 'utf8'), 'payload');
  assert.equal(fs.readFileSync(path.join(result.previous, 'old.txt'), 'utf8'), 'keep');
});
test('MCP authenticates, discovers tools, rejects invalid tool calls and cross-site UI requests', async t => {
  const paths = fixture(t); let service;
  const server = http.createServer((req,res) => service.handle(req,res,new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  service = createWorkbench({ paths, registry: { all: () => [] }, runtime: () => null, status: () => ({}), control: () => ({}), extensions: async () => ({}), registerRuntime: () => ({}), port }); t.after(() => service.dispose());
  const token = JSON.parse(fs.readFileSync(path.join(paths.state, 'assistant-auth.json'), 'utf8')).token;
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/mcp', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/workbench/overview', { headers: { origin: 'https://evil.example' } })).status, 403);
  const rpc = async (method, params) => (await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const tools = await rpc('tools/list'); assert.ok(tools.result.tools.some(t => t.name === 'app_tasks'));
  const editor=tools.result.tools.find(t=>t.name==='app_extension_files');
  assert.ok(editor.inputSchema.properties.extensionType);assert.equal(editor.inputSchema.properties.kind,undefined);
  const listed=await rpc('tools/call',{name:'app_extension_files',arguments:{action:'list',extensionType:'config'}});
  assert.notEqual(listed.result.isError,true);
  const bad = await rpc('tools/call', { name: 'app_runtime', arguments: { id: 'x', action: 'destroy' } }); assert.equal(bad.result.isError, true);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' }); assert.equal(init.result.protocolVersion, '2025-06-18');
});
