"use strict";
const {randomUUID}=require("node:crypto");
const WebSocket=require("ws");
function wire(method,payload={}) {
  const name=method==="session.models"?"session.modelCatalog":method;
  const endpoint=name.replace(".","/");
  const request=method==="session.prompt"?{...payload,requestId:payload.requestId||randomUUID()}:payload;
  const field=method==="session.list"?"_request":"request";
  return {route:"/api/"+endpoint,body:{type:"client-request",rpcId:randomUUID(),method:endpoint,payload:{args:{[field]:request}}}};
}
// Read a bounded opening snapshot then release the native stream immediately.
function history(baseUrl,headers,sessionId,maxMessages=200) {
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(baseUrl.replace(/^http/,"ws")+"/api/remote.mux",{headers,maxPayload:2_000_000});
    let done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.terminate();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error("dsh history timed out")),15000);
    socket.on("open",()=>socket.send(JSON.stringify({type:"open",streamId:"history",endpoint:"session/follow",payload:{args:{request:{address:{kind:"session",sessionId},maxMessages}}}})));
    socket.on("message",data=>{
      try {
        const frame=JSON.parse(data);
        if(frame.type==="error")return finish(new Error(frame.error?.message||"dsh history failed"));
        if(frame.type==="item"&&frame.value?.type==="snapshot")finish(null,{...frame.value,events:frame.value.records});
      }catch(error){finish(error);}
    });
    socket.on("error",error=>finish(error));
    socket.on("close",()=>finish(new Error("dsh history stream closed before snapshot")));
  });
}
module.exports={wire,history};
