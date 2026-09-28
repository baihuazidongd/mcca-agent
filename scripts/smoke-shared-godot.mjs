import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {McpClient,createPiMcpExtension,closeSharedMcpClients}=require('../packages/pi-mcp/src/index.cjs');
const {workbenchMcp,acpMcp}=require('../packages/runtime-core/mcp-config.cjs');
const {createPaths}=require('../packages/runtime-core/paths.cjs');
const paths=createPaths(), config=workbenchMcp(paths);
const client=new McpClient(config);
try {
  await client.start();
  const tools=(await client.listTools()).filter(t=>t.name.startsWith('shared__godot__'));
  assert.equal(tools.length,14);
  const version=await client.callTool('shared__godot__get_godot_version',{});
  assert.notEqual(version.isError,true);
  assert.match(version.content[0].text,/4\.6/);
  const registered=[];
  await createPiMcpExtension({servers:[config]})({registerTool:t=>registered.push(t)});
  const pi=registered.find(t=>t.name==='mcp__mcca-workbench__shared__godot__get_godot_version');
  assert.ok(pi);
  const piVersion=await pi.execute('verify',{},undefined);
  assert.match(piVersion.content[0].text,/4\.6/);
  const acp=acpMcp(paths);
  assert.equal(acp.command,config.command);assert.deepEqual(acp.args,config.args);
  console.log(JSON.stringify({workbenchStdio:'PASS',piRegistrationAndCall:'PASS',acpEntry:'PASS',godotTools:tools.length,godotVersion:version.content[0].text}));
} finally {client.close();await closeSharedMcpClients();}
