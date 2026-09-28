"use strict";
const http=require("node:http");
const port=Number(process.env.PORT), target=Number(process.env.MCCA_DASHBOARD_PORT);
if(!Number.isInteger(port)||!Number.isInteger(target)||port<1||target<1||port>65535||target>65535)throw new Error("Invalid dashboard port");
http.createServer((req,res)=>{res.writeHead(302,{location:"http://127.0.0.1:"+target+"/","cache-control":"no-store"});res.end();}).listen(port,"127.0.0.1");
