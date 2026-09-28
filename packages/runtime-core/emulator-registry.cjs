"use strict";
const fs=require("node:fs"), path=require("node:path"), {writeJson}=require("./paths.cjs");
function createEmulatorRegistry({paths,execute}) {
  const file=path.join(paths.state,"emulator-providers.json");
  let rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")).providers:[];
  function validate(row) {
    if(!/^[a-z][a-z0-9-]{1,40}$/.test(row.id||"")||["ldplayer","androidsdk"].includes(row.id)||typeof row.label!=="string"||row.label.length>100)throw new Error("无效或保留的模拟器类型 ID");
    if(!path.isAbsolute(row.command)||!fs.statSync(row.command).isFile())throw new Error("需要模拟器控制台或适配程序的完整可执行文件路径");
    if(!row.actions||!Array.isArray(row.actions.list))throw new Error("需要 list 参数数组；命令应输出标准 JSON 实例列表");
    for(const [action,args] of Object.entries(row.actions)){
      if(!["list","start","stop","restart","create","clone","configure"].includes(action)||!Array.isArray(args)||args.length>40||args.some(a=>typeof a!=="string"||a.length>500||/[\r\n\0]/.test(a)))throw new Error("无效命令模板");
      for(const arg of args)for(const match of arg.matchAll(/\{([a-zA-Z]+)\}/g))if(!["instance","name","cpu","memory","resolution"].includes(match[1]))throw new Error("未知参数占位符");
      if(["stop","restart","start","clone","configure"].includes(action)&&!args.some(a=>a.includes("{instance}")))throw new Error("实例操作必须使用明确的 {instance}");
    }return row;
  }
  function list(){return rows.map(r=>({id:r.id,label:r.label,configured:fs.existsSync(r.command),actions:Object.keys(r.actions),custom:true}));}
  function register(text){const row=validate(JSON.parse(text));const next=[...rows.filter(r=>r.id!==row.id),row];if(next.length>30)throw new Error("最多 30 个扩展类型");writeJson(file,{schemaVersion:1,providers:next});rows=next;return list();}
  async function instances(row){
    const parsed=JSON.parse(await execute(row.command,row.actions.list,{timeout:30000}));
    if(!Array.isArray(parsed)||parsed.length>256)throw new Error("list 必须输出 JSON 数组，最多 256 实例");
    const ids=new Set();
    for(const item of parsed){if(typeof item.id!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/.test(item.id)||typeof item.name!=="string"||typeof item.running!=="boolean"||ids.has(item.id))throw new Error("实例需要唯一 id、name 和布尔 running");ids.add(item.id);}
    return parsed;
  }
  async function call(a){
    const row=rows.find(r=>r.id===a.provider);if(!row)throw new Error("未知模拟器类型");validate(row);
    if(a.action==="list")return instances(row);
    const template=row.actions[a.action];if(!template)throw new Error("此模拟器类型不支持该操作");
    if(a.action!=="create"){const item=(await instances(row)).find(r=>r.id===a.instance);if(!item)throw new Error("实例不存在");if(["configure","clone"].includes(a.action)&&item.running)throw new Error("请先停止该实例");}
    const args=template.map(arg=>arg.replace(/\{([a-zA-Z]+)\}/g,(_,key)=>{const value=a[key];if(!["string","number"].includes(typeof value)||String(value).length>160||/[\r\n\0]/.test(String(value)))throw new Error("缺少或无效的参数："+key);return String(value);}));
    return execute(row.command,args,{timeout:180000});
  }
  return {list,register,call,has:id=>rows.some(r=>r.id===id)};
}
module.exports={createEmulatorRegistry};
