"use strict";
// Each PTY owns a short-lived Node process. On Windows node-pty's console
// workers otherwise keep a completed tool's handles alive in the portal.
if(process.argv.includes("--pty-worker")) {
  let terminal, ended=false;
  const end=exitCode=>{if(ended)return;ended=true;process.send?.({type:"exit",exitCode},()=>process.exit(exitCode||0));};
  process.on("message",message=>{
    try {
      if(message.action==="start") {
        terminal=require("node-pty").spawn(message.file,message.args,message.options);
        terminal.onData(data=>process.send?.({type:"data",data}));
        terminal.onExit(event=>end(event.exitCode));
        process.send?.({type:"ready",pid:terminal.pid});
      } else if(message.action==="write")terminal?.write(message.data);
      else if(message.action==="kill")terminal?.kill();
    } catch(error) {process.send?.({type:"error",message:error.message},()=>process.exit(1));}
  });
  process.on("disconnect",()=>{try{terminal?.kill();}catch{}process.exit(0);});
} else {
  const {fork}=require("node:child_process");
  function launchOwnedPty(file,args,options) {
    return new Promise((resolve,reject)=>{
      const child=fork(__filename,["--pty-worker"],{windowsHide:true,stdio:["ignore","ignore","pipe","ipc"]});
      let dataHandler,exitHandler,exitEvent,resolved=false,log="";
      const handle={pid:null,onData(fn){dataHandler=fn;if(log)fn(log);log="";},onExit(fn){exitHandler=fn;if(exitEvent)fn(exitEvent);},write(data){if(child.connected)child.send({action:"write",data});},kill(){if(child.connected)child.send({action:"kill"});},destroy(){if(child.connected)child.disconnect();}};
      const finish=event=>{if(exitEvent)return;exitEvent=event;if(exitHandler)exitHandler(event);};
      const timer=setTimeout(()=>{child.kill();reject(new Error("工具进程启动超时"));},15000);timer.unref();
      child.on("message",message=>{
        if(message.type==="ready"){clearTimeout(timer);handle.pid=message.pid;resolved=true;resolve(handle);}
        else if(message.type==="data"){if(dataHandler)dataHandler(message.data);else log=(log+message.data).slice(-30000);}
        else if(message.type==="exit")finish({exitCode:message.exitCode});
        else if(message.type==="error"){if(!resolved){clearTimeout(timer);reject(new Error(message.message));}else if(dataHandler)dataHandler(message.message);}
      });
      child.stderr.on("data",chunk=>{if(dataHandler)dataHandler(chunk.toString());else log=(log+chunk).slice(-30000);});
      child.on("error",error=>{clearTimeout(timer);if(!resolved)reject(error);else finish({exitCode:1});});
      child.on("exit",code=>{clearTimeout(timer);if(!resolved)reject(new Error("工具进程未启动："+code));finish({exitCode:code??1});});
      child.send({action:"start",file,args,options});
    });
  }
  module.exports={launchOwnedPty};
}
