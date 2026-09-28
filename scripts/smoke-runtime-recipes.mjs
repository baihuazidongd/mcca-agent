import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPaths}=require('../packages/runtime-core/paths.cjs');
const {createRuntimeRecipes,runtimeEntry}=require('../packages/runtime-core/runtime-recipes.cjs');
const paths=createPaths({MCCA_HOME:path.resolve('.'),MCCA_DATA_DIR:path.resolve('.playwright-mcp/runtime-install-smoke')});
const service=createRuntimeRecipes({paths});
for(const id of process.argv.slice(2)){
  const result=await service.install(id);
  assert.equal(result.state,'installed',result.error);assert.ok(fs.existsSync(runtimeEntry(paths,id)));
  console.log(JSON.stringify({id,state:result.state,entry:result.entry,version:result.version}));
}
