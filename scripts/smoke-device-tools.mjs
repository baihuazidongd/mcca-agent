import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPaths } = require('../packages/runtime-core/paths.cjs');
const { createToolJobs } = require('../packages/runtime-core/tool-jobs.cjs');
const { createAndroidService } = require('../packages/runtime-core/android.cjs');
const { createDeviceTools } = require('../packages/runtime-core/device-tools.cjs');
const { createApkService } = require('../packages/runtime-core/apk.cjs');
const paths = createPaths(), jobs = createToolJobs({ paths });
async function finished(id) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { const row = jobs.list().find(j => j.id === id); if (!['running','starting','stopping'].includes(row.state)) return row; await new Promise(r => setTimeout(r,500)); }
  await jobs.stop(id); throw new Error('Tool timed out');
}
try {
  const android = createAndroidService({ paths });
  const serial = process.argv[2], devices = await android.call({action:'devices'});
  const device = devices.find(d => d.serial === serial && d.state === 'device');
  assert.ok(device, 'Explicit serial ' + serial + ' unavailable; devices: ' + JSON.stringify(devices));
  const screen = createDeviceTools({ paths, android, jobs });
  const recording = await finished((await screen.call({ action:'record', serial:device.serial, seconds:3 })).id);
  assert.equal(recording.state,'finished',recording.log); assert.ok(fs.statSync(recording.output).size > 1000);
  console.log(JSON.stringify({screen:'PASS',bytes:fs.statSync(recording.output).size,output:recording.output}));
  const apk = createApkService({ paths, jobs });
  const file = path.resolve('packages/mobile-app/app/build/outputs/apk/debug/app-debug.apk');
  const metadata = await apk.call({action:'inspect',file}); assert.equal(metadata.manifest.package,'com.mcca.mobile');
  const analysis = await finished((await apk.call({action:'decompile',file})).id);
  // jadx may report individual obfuscated classes while still exporting sources.
  assert.ok(fs.existsSync(path.join(analysis.output,'sources','com','mcca','mobile')), analysis.log);
  assert.ok(fs.existsSync(path.join(analysis.output,'resources','AndroidManifest.xml')), analysis.log);
  console.log(JSON.stringify({apk:'PASS',state:analysis.state,exitCode:analysis.exitCode,output:analysis.output,partialErrors:analysis.state !== 'finished'}));
} finally { await jobs.dispose(); }
