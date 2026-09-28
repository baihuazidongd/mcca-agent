import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPaths}=require('../packages/runtime-core/paths.cjs');
const {runtimeEntry}=require('../packages/runtime-core/runtime-recipes.cjs');
const {taskAdapter}=require('../packages/runtime-core/task-adapters.cjs');
const {request}=require('../packages/runtime-core/tasks.cjs');
const auth=require('../packages/runtime-core/dsh-auth.cjs');
const root=path.resolve('.playwright-mcp/runtime-install-smoke');
const paths=createPaths({MCCA_HOME:path.resolve('.'),MCCA_DATA_DIR:root});
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const child=spawn(process.execPath,[runtimeEntry(paths,'dsh'),'--profile','web','--no-open','--port',String(port)],{cwd:paths.app,env:{...process.env,DSH_HOME:path.join(root,'dsh-clean-home')},windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';
child.stdout.on('data',b=>{auth.capture(port,b.toString(),paths);logs=(logs+b.toString().replace(/token=[A-Za-z0-9_-]+/g,'token=[redacted]')).slice(-8000);});child.stderr.on('data',b=>logs=(logs+b).slice(-8000));
try{
  const adapter=taskAdapter({port,paths,taskProtocol:'dsh-remote-v1'},request);
  let ready=false;
  for(let i=0;i<180;i++){
    try {
      const headers=await auth.headers(port,paths);
      if(headers.cookie){
        const probe=await fetch(`http://127.0.0.1:${port}/api/session/list`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({type:'client-request',rpcId:'probe-'+i,method:'session/list',payload:{args:{request:{}}}}),signal:AbortSignal.timeout(2000)});
        if(probe.ok){ready=true;break;}
      }
    }catch{}
    if(child.exitCode!==null)break;
    await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(ready,logs);
  const id=await adapter.create({cwd:root});assert.ok(id);assert.ok((await adapter.list()).sessions.some(s=>s.id===id));
  const history=await adapter.history(id);assert.ok(Array.isArray(history.events));
  console.log(JSON.stringify({installedDsh:'PASS',version:'0.1.5-rc.3',sessionCreateAndList:'PASS',session:id}));
}finally{if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}}
