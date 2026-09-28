import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPaths}=require('../packages/runtime-core/paths.cjs');
const {createAcpTasks}=require('../packages/runtime-core/acp-tasks.cjs');
const {createCliProviders}=require('../packages/portal/cli-provider.cjs');
const paths={...createPaths(),state:path.resolve('.playwright-mcp/acp-smoke')};
const providers=createCliProviders({root:paths.app});
let requests=0;
const llm=http.createServer((req,res)=>{req.resume();req.on('end',()=>{requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'chatcmpl-smoke',object:'chat.completion',created:Math.floor(Date.now()/1000),model:'gpt-4o',choices:[{index:0,message:{role:'assistant',content:'MCCA_ACP_SMOKE_OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));});});
await new Promise(r=>llm.listen(0,'127.0.0.1',r));
const service=createAcpTasks({paths,runtime:()=>({cmd:path.join(paths.app,'vendor/cli/openhands/.venv/Scripts/openhands.exe'),args:['web'],env:{OPENHANDS_SUPPRESS_BANNER:'1',LLM_MODEL:'openai/gpt-4o',LLM_API_KEY:'local-test-placeholder',LLM_BASE_URL:'http://127.0.0.1:'+llm.address().port+'/v1'},cwd:paths.app})});
try{
  const adapter=service.adapter('openhands-web'),id=await adapter.create({});assert.ok(id);
  await adapter.prompt(id,'Reply MCCA_ACP_SMOKE_OK without tools.');
  const deadline=Date.now()+45000;let history;
  while(Date.now()<deadline){history=await adapter.history(id);if(!history.running)break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(history.running,false);assert.ok(history.finishedAt,history.lastError);
  assert.ok(requests>0);assert.match(JSON.stringify(history.events),/MCCA_ACP_SMOKE_OK/);
  console.log(JSON.stringify({protocol:'OpenHands ACP',initialize:'PASS',newSession:'PASS',promptAndResult:'PASS',localModelRequests:requests,session:id}));
}finally{service.dispose();llm.closeAllConnections();await new Promise(r=>llm.close(r));}
