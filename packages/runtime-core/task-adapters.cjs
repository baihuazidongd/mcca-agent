"use strict";
const { randomUUID } = require("node:crypto");
function taskAdapter(config, request) {
  const rpc = async (method, payload = {}) => {
    const headers = await require("./dsh-auth.cjs").headers(config.port,config.paths);
    const remote=config.taskProtocol==="dsh-remote-v1";
    if(remote&&method==="session.history")return require("./dsh-remote.cjs").history("http://127.0.0.1:"+config.port,headers,payload.sessionId,payload.maxMessages);
    const wire=remote?require("./dsh-remote.cjs").wire(method,payload):{route:`/api/${method}`,body:{ type: "client-request", rpcId: `workbench-${randomUUID()}`, method, payload }};
    const response = await request(config.port,wire.route,"POST",wire.body,headers);
    if (!response.result || response.result.ok !== true) throw new Error(response.result?.error?.message || "Invalid dsh RPC result");
    return response.result.value;
  };
  if (["dsh-rpc-v1","dsh-remote-v1"].includes(config.taskProtocol)) return {
    async create(args) {
      if (args.provider || args.modelId) throw new Error("dsh 模型请在原生界面选择");
      return (await rpc("session.create", args.cwd ? { cwd: args.cwd } : {}))?.sessionId;
    },
    prompt: (id, text) => rpc("session.prompt", { sessionId: id, mode: "queue", content: [{ type: "text", text }] }),
    async stop(id) { const result = await rpc("session.cancel", { sessionId: id }); if (result?.accepted === false) throw new Error("dsh 未接受停止请求"); return result; },
    async list() { const result = await rpc("session.list"); if (!Array.isArray(result?.items)) throw new Error("Invalid dsh session list"); return { sessions: result.items.map(s => ({ ...s, id: s.sessionId })) }; },
    history: id => rpc("session.history", { sessionId: id, maxMessages: 200 }),
  };
  if (config.taskProtocol === "sessions-v1") {
    const route = id => `/api/sessions/${encodeURIComponent(id)}`;
    return {
      async create(args) { const result = await request(config.port, "/api/sessions", "POST", { cwd: args.cwd, title: args.title, provider: args.provider, modelId: args.modelId }); return result.id || result.session?.id; },
      prompt: (id, text) => request(config.port, `${route(id)}/prompt`, "POST", { text }),
      stop: id => request(config.port, `${route(id)}/stop`, "POST", {}),
      list: () => request(config.port, "/api/sessions"),
      history: id => request(config.port, `${route(id)}/history`),
    };
  }
  throw new Error("该 IDE 尚未提供任务适配器；可以使用它的原生界面");
}
module.exports = { taskAdapter };
