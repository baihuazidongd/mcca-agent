"use strict";
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { run } = require("./android.cjs"), { writeJson } = require("./paths.cjs");
const { createComponents, componentPath } = require("./components.cjs");
const RECIPES = {
  dsh: {version:"0.1.5-rc.3",source:"https://www.npmjs.com/package/@deepseek-ai/dsh",license:"MIT",integrity:"sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg=="},
  "openhands-web": {version:"1.16.0",source:"https://pypi.org/project/openhands/1.16.0/",license:"MIT"}
};
function runtimeEntry(paths,id) {
  const root=path.join(paths.runtimes,id,"current");
  if(id==="dsh") {const file=path.join(root,"node_modules/@deepseek-ai/dsh/lib/bin.js");return fs.existsSync(file)?file:null;}
  if(id==="openhands-web") {
    const pointer=path.join(root,"mcca-install.json");
    if(!fs.existsSync(pointer))return null;
    const record=JSON.parse(fs.readFileSync(pointer,"utf8"));
    if(!/^env-[a-f0-9-]{36}$/.test(record.environment||""))return null;
    const file=path.join(paths.runtimes,id,record.environment,"Scripts/openhands.exe");return fs.existsSync(file)?file:null;
  }
  return null;
}
function createRuntimeRecipes({paths,execute=run,components=createComponents({paths})}) {
  const jobs=new Map(), pending=new Map();
  async function install(id) {
    if(pending.has(id))return {...jobs.get(id)};
    const recipe=RECIPES[id];if(!recipe)throw new Error("没有此 IDE 的安装配方");
    if(process.platform!=="win32")throw new Error("此安装配方需要 Windows");
    const job={id,state:"installing",phase:"准备依赖",at:Date.now(),...recipe};jobs.set(id,job);
    const operation=(async()=>{
      const base=path.join(paths.runtimes,id), stage=path.join(base,"stage-"+randomUUID());fs.mkdirSync(stage,{recursive:true});
      try {
        if(id==="dsh") {
          const npm=[path.join(paths.app,"runtime/npm/bin/npm-cli.js"),path.join(path.dirname(paths.node),"node_modules/npm/bin/npm-cli.js")].find(f=>fs.existsSync(f));
          if(!npm)throw new Error("缺少 npm 运行文件，请使用完整分发包");
          job.phase="下载 dsh 及依赖";
          await execute(paths.node,[npm,"install","--prefix",stage,"--omit=dev","--ignore-scripts","--no-audit","--no-fund","--save-exact","--registry=https://registry.npmjs.org","@deepseek-ai/dsh@"+recipe.version],{timeout:1800000});
          const lock=JSON.parse(fs.readFileSync(path.join(stage,"package-lock.json"),"utf8"));
          if(lock.packages?.["node_modules/@deepseek-ai/dsh"]?.integrity!==recipe.integrity)throw new Error("dsh 官方包完整性与固定配方不匹配");
          await execute(paths.node,[npm,"rebuild","--prefix",stage],{timeout:900000});
          await execute(paths.node,[path.join(stage,"node_modules/@deepseek-ai/dsh/lib/bin.js"),"--help"],{timeout:60000});
        } else {
          let uv=componentPath(paths,"uv");if(!uv){const result=await components.call({action:"install",id:"uv"});if(result.state!=="installed")throw new Error(result.error);uv=componentPath(paths,"uv");}
          // Python entrypoints embed their environment path: never rename a venv.
          const environment="env-"+randomUUID(), dir=path.join(base,environment);job.phase="安装独立 Python 和 OpenHands";
          await execute(uv,["venv","--python","3.12","--managed-python",dir],{timeout:900000});
          await execute(uv,["pip","install","--python",path.join(dir,"Scripts/python.exe"),"openhands=="+recipe.version],{timeout:1800000});
          await execute(path.join(dir,"Scripts/openhands.exe"),["--help"],{timeout:180000,env:{...process.env,LITELLM_LOCAL_MODEL_COST_MAP:"True",OPENHANDS_SUPPRESS_BANNER:"1"}});
          job.environment=environment;
        }
        writeJson(path.join(stage,"mcca-install.json"),{schemaVersion:1,...recipe,environment:job.environment,at:Date.now()});
        const current=path.join(base,"current"),previous=path.join(base,"previous-"+Date.now()),had=fs.existsSync(current);
        if(had)fs.renameSync(current,previous);
        try{fs.renameSync(stage,current);}catch(error){if(had)fs.renameSync(previous,current);throw error;}
        Object.assign(job,{state:"installed",phase:"可用",entry:runtimeEntry(paths,id),previous:had?previous:null});
      }catch(error){Object.assign(job,{state:"failed",error:error.message});}
      finally{if(path.resolve(stage).startsWith(path.resolve(base)+path.sep))fs.rmSync(stage,{recursive:true,force:true});}
      return {...job};
    })().finally(()=>pending.delete(id));pending.set(id,operation);return operation;
  }
  return {install,jobs:()=>[...jobs.values()].map(j=>({...j})),supports:id=>Boolean(RECIPES[id])};
}
module.exports={RECIPES,runtimeEntry,createRuntimeRecipes};
