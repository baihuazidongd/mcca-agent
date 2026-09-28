import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = path.resolve(process.argv[2] || process.env.MCCA_SMOKE_ROOT || 'missing-portable-root');
const node = path.join(root, 'runtime/node.exe'); assert.ok(fs.existsSync(node), 'Specify a portable folder');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcca-portable-runtime-'));
const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
const env = { ...process.env, PATH: `${process.env.SystemRoot}/System32;${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0`, MCCA_HOME: root, MCCA_DATA_DIR: temp, MCCA_NODE: node, MCCA_AGENT_DIR: path.join(temp, 'pi'), MCCA_PI_MODELS: path.join(temp, 'pi/models.json'), PI_WEB_PORT: String(port) };
let child, logs = '';
try {
  const ptyScript = `const pty=require('node-pty');const p=pty.spawn(process.execPath,['-e','console.log(123456)'],{name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env});let output='';p.onData(s=>output+=s);setTimeout(()=>{p.kill();process.exit(2)},10000);p.onExit(e=>process.exit(output.includes('123456')&&e.exitCode===0?0:1));`;
  const pty = spawn(node, ['-e', ptyScript], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  assert.equal((await once(pty, 'exit'))[0], 0, 'Bundled PTY failed');
  child = spawn(node, ['packages/pi-web/server.cjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  let ready;
  for (let i=0;i<100;i++) {
    try { const res = await fetch(`http://127.0.0.1:${port}/api/models`, { signal: AbortSignal.timeout(2000) }); if (res.ok) { ready = await res.json(); break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(ready, logs);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`); assert.equal(res.status, 200); assert.ok(Array.isArray((await res.json()).sessions));
  console.log('PASS: bundled Node, native PTY, pi server models/session APIs with isolated data and no development PATH.');
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  fs.rmSync(temp, { recursive: true, force: true });
}
