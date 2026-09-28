import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPaths,writeJson}=require('../packages/runtime-core/paths.cjs');
const {createWorkbench}=require('../packages/runtime-core/workbench.cjs');
const {createPiMcpExtension,closeSharedMcpClients}=require('../packages/pi-mcp/src/index.cjs');
const {generateMcpPatch}=await import('../scripts/gen-dsh-mcp-patch.mjs');

test('workbench shares one MCP process, preserves results and revokes disabled tools', async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcca-shared-mcp-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const paths=createPaths({MCCA_DATA_DIR:dir});
  const config={serverName:'godot',transport:'stdio',shared:true,command:process.execPath,args:['-e',String.raw`
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line);if(q.id===undefined)return;
      const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
        q.method==='tools/list'?{tools:[{name:'probe',description:'Probe',inputSchema:{type:'object',properties:{}}}]}:
        {isError:true,content:[{type:'text',text:String(process.pid)},{type:'image',mimeType:'image/png',data:'aGk='}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
    });
  `]};
  const save=rows=>writeJson(path.join(dir,'mcp.json'),rows);
  save([config,{...config,serverName:'private',shared:false}]);
  let service;
  const server=http.createServer((req,res)=>service.handle(req,res,new URL(req.url,'http://localhost')));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const port=server.address().port;
  service=createWorkbench({paths,registry:{all:()=>[]},runtime:()=>null,status:()=>({}),control:()=>({}),extensions:()=>({}),port});
  t.after(()=>service.dispose());
  const token=JSON.parse(fs.readFileSync(path.join(paths.state,'assistant-auth.json'),'utf8')).token;
  const rpc=async(method,params)=>(await (await fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json()).result;
  const lists=await Promise.all([rpc('tools/list'),rpc('tools/list')]);
  for(const list of lists){assert.ok(list.tools.some(x=>x.name==='shared__godot__probe'));assert.ok(!list.tools.some(x=>x.name.includes('private')));}
  const results=await Promise.all([rpc('tools/call',{name:'shared__godot__probe',arguments:{}}),rpc('tools/call',{name:'shared__godot__probe',arguments:{}})]);
  assert.deepEqual(results[0],results[1]);assert.equal(results[0].isError,true);assert.equal(results[0].content[1].type,'image');
  save([{...config,disabled:true}]);
  assert.ok(!(await rpc('tools/list')).tools.some(x=>x.name==='shared__godot__probe'));
  assert.equal((await rpc('tools/call',{name:'shared__godot__probe',arguments:{}})).isError,true);
});

test('pi and dsh skip direct copies of workbench-hosted MCP servers',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcca-mcp-routing-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  t.after(()=>closeSharedMcpClients());
  const rows=[{serverName:'godot',transport:'stdio',shared:true,command:'must-not-launch'}];
  const registered=[];
  await createPiMcpExtension({servers:rows})({registerTool:tool=>registered.push(tool)});
  assert.deepEqual(registered,[]);
  writeJson(path.join(dir,'mcp.json'),rows);
  assert.deepEqual(generateMcpPatch(path.join(dir,'mcp.json'),path.join(dir,'patch.yml')),[]);
});
