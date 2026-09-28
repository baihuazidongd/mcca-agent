import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createExtensionFiles } = require('../packages/runtime-core/extension-files.cjs');
const { createExtensionBundles } = require('../packages/runtime-core/extension-bundles.cjs');
const { createNetworkCapture } = require('../packages/runtime-core/network-capture.cjs');
const { createAcpTasks } = require('../packages/runtime-core/acp-tasks.cjs');
const {createEmulatorService}=require('../packages/runtime-core/emulators.cjs');
const {createApkService}=require('../packages/runtime-core/apk.cjs');
function fixture(t) { const app=fs.mkdtempSync(path.join(os.tmpdir(),'mcca-tools-'));const paths={app,data:path.join(app,'config'),state:path.join(app,'state'),node:process.execPath};fs.mkdirSync(paths.state);t.after(()=>fs.rmSync(app,{recursive:true,force:true}));return paths; }
test('extension edits validate syntax and reject stale edits, traversal and linked directories',async t=>{
  const paths=fixture(t), svc=createExtensionFiles({paths});
  await assert.rejects(svc.call({action:'read',kind:'plugin',file:'../outside.js'}),/越界/);
  await assert.rejects(svc.call({action:'write',kind:'plugin',file:'sample/index.mjs',text:'export const = 1;'}));
  const first=await svc.call({action:'write',kind:'plugin',file:'sample/index.mjs',text:'export const x = 1;'});
  await assert.rejects(svc.call({action:'write',kind:'plugin',file:first.file,text:'export const x = 2;',expectedSha256:'old'}),/变化/);
  const second=await svc.call({action:'write',kind:'plugin',file:first.file,text:'export const x = 2;',expectedSha256:first.sha256});
  const undone=await svc.call({action:'rollback',revision:second.revision,expectedSha256:second.sha256});assert.equal(undone.text,first.text);
  const removed=await svc.call({action:'rollback',revision:first.revision,expectedSha256:undone.sha256});assert.equal(removed.exists,false);
  const restored=await svc.call({action:'rollback',revision:removed.revision,expectedSha256:''});assert.equal(restored.text,first.text);
  fs.mkdirSync(path.join(paths.app,'outside'));fs.symlinkSync(path.join(paths.app,'outside'),path.join(paths.app,'plugins','linked'),'junction');
  await assert.rejects(svc.call({action:'read',kind:'plugin',file:'linked/index.js'}),/链接/);
});
test('extension bundle install, update and rollback preserve source and detect local edits',async t=>{
  const paths=fixture(t), files=createExtensionFiles({paths}), svc=createExtensionBundles({paths,files});
  const source=path.join(paths.app,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify({name:'sample',entry:'index.mjs',targets:['pi','ds'],version:'1.0.0'}));fs.writeFileSync(path.join(source,'index.mjs'),'export default {};');
  const args={kind:'plugin',name:'sample',source};
  const preview=await svc.call({action:'inspect_bundle',...args});
  const installed=await svc.call({action:'import_bundle',...args,sourceSha256:preview.sourceSha256,expectedSha256:''});
  assert.equal(fs.readFileSync(path.join(paths.app,'plugins/sample/index.mjs'),'utf8'),'export default {};');
  fs.writeFileSync(path.join(source,'index.mjs'),'export default {v:2};');
  const next=await svc.call({action:'inspect_bundle',...args});
  const updated=await svc.call({action:'import_bundle',...args,sourceSha256:next.sourceSha256,expectedSha256:next.currentSha256});
  await assert.rejects(svc.call({action:'rollback_bundle',revision:updated.revision,expectedSha256:installed.afterSha256}),/变化/);
  const rolled=await svc.call({action:'rollback_bundle',revision:updated.revision,expectedSha256:updated.afterSha256});
  assert.equal(rolled.afterSha256,installed.afterSha256);
  await svc.call({action:'rollback_bundle',revision:installed.revision,expectedSha256:rolled.afterSha256});assert.equal(fs.existsSync(path.join(paths.app,'plugins/sample')),false);assert.equal(fs.existsSync(source),true);
});
test('capture persists HTTP bodies and restores only its own device proxy',async t=>{
  const paths=fixture(t);let proxy='old:8888';const reverse=[];
  const android={call:async a=>{if(a.action==='reverse'){reverse.push(a);return '';}const args=a.args;if(args[1]==='get')return proxy;if(args[1]==='put')proxy=args[4];if(args[1]==='delete')proxy='null';return '';}};
  const svc=createNetworkCapture({paths,android});t.after(()=>svc.dispose());
  const origin=http.createServer((req,res)=>{let text='';req.on('data',b=>text+=b);req.on('end',()=>{res.setHeader('content-type','text/plain');res.end('echo:'+text);});});origin.listen(0,'127.0.0.1');await once(origin,'listening');t.after(()=>new Promise(r=>origin.close(r)));
  const cap=await svc.call({action:'start',serial:'device-A',minutes:1});assert.equal(proxy,cap.proxy);
  const response=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:cap.port,path:'http://127.0.0.1:'+origin.address().port+'/test',method:'POST'},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve(text));});req.on('error',reject);req.end('payload');});assert.equal(response,'echo:payload');
  const flows=await svc.call({action:'flows',id:cap.id});assert.equal(flows.count,1);const detail=await svc.call({action:'detail',id:cap.id,flow:flows.flows[0].id});assert.equal(Buffer.from(detail.responseBody,'base64').toString(),'echo:payload');
  await Promise.all([svc.call({action:'stop',id:cap.id}),svc.call({action:'stop',id:cap.id})]);assert.equal(proxy,'old:8888');assert.equal(reverse.filter(x=>x.remove).length,1);
  const cap2=await svc.call({action:'start',serial:'device-A',minutes:1});proxy='user-changed:9000';await svc.call({action:'stop',id:cap2.id});assert.equal(proxy,'user-changed:9000');
});
test('capture tunnels CONNECT and recovers device settings after interrupted startup',async t=>{
  const paths=fixture(t);const echo=net.createServer(s=>s.pipe(s));echo.listen(0,'127.0.0.1');await once(echo,'listening');t.after(()=>new Promise(r=>echo.close(r)));
  const svc=createNetworkCapture({paths,android:{}});t.after(()=>svc.dispose());const cap=await svc.call({action:'start',minutes:1});
  await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:cap.port,method:'CONNECT',path:'127.0.0.1:'+echo.address().port});req.on('error',reject);req.on('connect',(_,socket)=>{socket.once('data',b=>{assert.equal(b.toString(),'tunnel');socket.destroy();resolve();});socket.write('tunnel');});req.end();});
  await svc.call({action:'stop',id:cap.id});await new Promise(r=>setTimeout(r,20));assert.equal((await svc.call({action:'flows',id:cap.id})).flows[0].kind,'tls-tunnel');
  const recoveryPaths={...paths,state:path.join(paths.app,'recovery')};const root=path.join(recoveryPaths.state,'captures');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'sessions.json'),JSON.stringify({sessions:[{id:'crashed',state:'starting',serial:'A',proxy:'127.0.0.1:9988',previousProxy:'null',port:9988,reverseOwned:true}]}));
  let cleared=false;const recovered=createNetworkCapture({paths:recoveryPaths,android:{call:async a=>{if(a.action==='reverse')return '';if(a.args[1]==='get')return '127.0.0.1:9988';cleared=true;return '';}}});assert.equal((await recovered.call({action:'list'}))[0].state,'stopped');assert.equal(cleared,true);await recovered.dispose();
});
test('ACP responds to explicit permission, captures completion and never marks lost transport complete',async t=>{
  const paths=fixture(t), launched=[];let sid=0;
  const launch=(_file,args)=>{assert.equal(args.at(-1),'acp');const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.emit('exit',1);return true;};launched.push(child);
    child.stdin.on('data',raw=>{const rpc=JSON.parse(raw.toString());let result;
      if(rpc.method==='initialize')result={agentCapabilities:{loadSession:true}};
      if(rpc.method==='session/new')result={sessionId:'session-'+(++sid)};
      if(rpc.method==='session/prompt'){child.promptId=rpc.id;setImmediate(()=>child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'permission-1',method:'session/request_permission',params:{toolCall:{title:'Read file'},options:[{optionId:'allow-once',name:'Allow once'}]}})+'\n'));return;}
      if(rpc.id==='permission-1'){assert.equal(rpc.result.outcome.optionId,'allow-once');setImmediate(()=>child.stdout.write(JSON.stringify({id:child.promptId,result:{stopReason:'end_turn'}})+'\n'));return;}
      if(result)setImmediate(()=>child.stdout.write(JSON.stringify({id:rpc.id,result})+'\n'));
    });return child;};
  const svc=createAcpTasks({paths,runtime:()=>({cmd:'openhands.exe',args:['web'],cwd:paths.app}),launch});t.after(()=>svc.dispose());const adapter=svc.adapter('openhands-web');const id=await adapter.create({});await adapter.prompt(id,'Read a file');await new Promise(r=>setTimeout(r,10));
  const permission=(await adapter.history(id)).permissions[0];assert.equal(permission.request,'permission-1');svc.permission(id,permission.request,'allow-once');await new Promise(r=>setTimeout(r,10));assert.ok((await adapter.history(id)).finishedAt);
  await adapter.prompt(id,'Another task');launched[0].kill();await new Promise(r=>setTimeout(r,10));const interrupted=await adapter.history(id);assert.equal(interrupted.offline,true);assert.equal(interrupted.finishedAt,null);
});
test('custom emulator adapters persist and target only discovered instances without shell expansion',async t=>{
  const paths=fixture(t),seen=[];const execute=async(command,args)=>{seen.push({command,args});return args[0]==='list'?JSON.stringify([{id:'two',name:'Second',running:false}]):'started';};
  const service=createEmulatorService({paths,android:{},execute});
  const definition=JSON.stringify({id:'another-brand',label:'Another brand',command:process.execPath,actions:{list:['list','--json'],start:['start','{instance}'],stop:['stop','{instance}']}});
  await service.call({action:'register',definition});
  const restored=createEmulatorService({paths,android:{},execute});assert.ok((await restored.call({action:'providers'})).some(p=>p.id==='another-brand'));
  await assert.rejects(restored.call({action:'stop',provider:'another-brand',instance:'absent'}),/不存在/);
  await restored.call({action:'start',provider:'another-brand',instance:'two'});assert.deepEqual(seen.at(-1).args,['start','two']);
});
test('APK inspector rejects corrupt archives without launching executables',async t=>{
  const paths=fixture(t),file=path.join(paths.app,'broken.apk');fs.writeFileSync(file,Buffer.from('not an APK'));
  const svc=createApkService({paths,jobs:{start:()=>assert.fail('must not execute APK')}});
  await assert.rejects(svc.call({action:'inspect',file}));
});
