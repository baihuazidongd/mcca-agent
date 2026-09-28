"use strict";
const fs=require("node:fs"),path=require("node:path");
const {createPaths,writeJson}=require("./paths.cjs");
const inFlight=new Map();
function location(port,paths=createPaths()){
  if(!Number.isInteger(Number(port))||Number(port)<1||Number(port)>65535)throw new Error("Invalid dsh port");
  return path.join(paths.state,"dsh-auth-"+port+".json");
}
function read(port,paths){const file=location(port,paths);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};}
function capture(port,text,paths){
  const match=/dsh web:\s+http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]{16,200})/.exec(text);
  if(!match||Number(match[1])!==Number(port))return false;
  const old=read(port,paths);if(old.token!==match[2])writeJson(location(port,paths),{token:match[2],at:Date.now()});return true;
}
async function headers(port,paths){
  const auth=read(port,paths);if(auth.cookie)return {cookie:auth.cookie};if(!auth.token)return {};
  const key=location(port,paths);if(inFlight.has(key))return inFlight.get(key);
  const op=(async()=>{
    const res=await fetch("http://127.0.0.1:"+port+"/?token="+encodeURIComponent(auth.token),{redirect:"manual",signal:AbortSignal.timeout(5000)});
    const cookie=res.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    await res.body?.cancel();
    if(res.status!==303||!cookie)throw new Error("dsh 登录凭据已失效，请从门户重启该 IDE");
    if(read(port,paths).token===auth.token)writeJson(key,{...auth,cookie});
    return {cookie};
  })().finally(()=>inFlight.delete(key));inFlight.set(key,op);return op;
}
function launchUrl(port,paths){const auth=read(port,paths);return "http://127.0.0.1:"+port+(auth.token?"/?token="+encodeURIComponent(auth.token):"/");}
function clear(port,paths){fs.rmSync(location(port,paths),{force:true});}
module.exports={capture,headers,launchUrl,clear};
