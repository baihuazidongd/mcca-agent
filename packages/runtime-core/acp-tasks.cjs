"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const { writeJson } = require("./paths.cjs");
const { acpMcp } = require("./mcp-config.cjs");
const { randomUUID } = require("node:crypto");
function createAcpTasks({ paths, runtime, launch = spawn }) {
  const file = path.join(paths.state, "acp-tasks.json"), active = new Map(), clients = new Set();
  let disposed = false;
  const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).sessions : [];
  for (const row of rows) { row.offline = true; row.running = false; row.permissions = []; }
  const save = () => { if (!disposed) writeJson(file, { schemaVersion: 1, sessions: rows }); };
  const find = id => { const row = rows.find(r => r.id === id); if (!row) throw new Error("ACP 会话不存在"); return row; };
  function spawnClient(cfg, cwd, home) {
    if (disposed || clients.size >= 4) throw new Error("服务关闭或已达四个 OpenHands 任务会话上限");
    const spec = cfg.resolve ? cfg.resolve() : cfg; if (spec.error) throw new Error(spec.error);
    const webAt = spec.args.indexOf("web"); if (webAt < 0) throw new Error("OpenHands 启动清单不含原生 web 命令，无法推导 ACP 入口");
    let command=spec.cmd, args=[...spec.args.slice(0,webAt),"acp"];
    const env={...process.env,LITELLM_LOCAL_MODEL_COST_MAP:"True",...spec.env};
    const python=path.join(path.dirname(spec.cmd),"python.exe");
    if(spec.env?.LLM_MODEL && fs.existsSync(python)) {
      home ||= path.join(paths.state,"openhands",randomUUID());
      env.OPENHANDS_PERSISTENCE_DIR=home;
      command=python;args=[path.join(__dirname,"openhands-acp.py")];
    }
    const child = launch(command,args,{cwd,env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const client = { child, next: 1, pending: new Map(), row: null, buffer: "", idleTimer: null };
    client.log="";
    clients.add(client);
    client.home=home;
    const send = value => { if (child.stdin.destroyed) throw new Error("ACP 已断开"); child.stdin.write(JSON.stringify(value) + "\n"); };
    client.send = send;
    client.request = (method, params, timeout = 30000) => new Promise((resolve, reject) => {
      const id = client.next++, timer = timeout ? setTimeout(() => { client.pending.delete(id); reject(new Error(method + " 超时；结果未知\n" + client.log.slice(-3500))); }, timeout) : null;
      timer?.unref();
      client.pending.set(id, { resolve, reject, timer }); try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { clearTimeout(timer); client.pending.delete(id); reject(error); }
    });
    const close = error => {
      if (client.closed) return; client.closed = true; clients.delete(client);
      clearTimeout(client.idleTimer);
      for (const pending of client.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } client.pending.clear();
      if (client.row) { client.row.offline = true; client.row.running = false; client.row.permissions = []; active.delete(client.row.id); save(); }
    };
    child.on("error", close); child.on("exit", code => close(new Error("OpenHands ACP 退出：" + code)));
    child.stdin.on("error",close);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      let text=chunk.toString();
      for(const [key,value] of Object.entries(env)) if(/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&typeof value==="string"&&value.length>3)text=text.replaceAll(value,"[redacted]");
      client.log=(client.log+text).slice(-5000);if(client.row)client.row.log=client.log;
    });
    child.stdout.on("data", chunk => {
      client.buffer += chunk; if (client.buffer.length > 2 * 1024 * 1024) { child.kill(); close(new Error("ACP frame too large")); return; }
      let at; while ((at = client.buffer.indexOf("\n")) >= 0) {
        const line = client.buffer.slice(0, at); client.buffer = client.buffer.slice(at + 1); let rpc; try { rpc = JSON.parse(line); } catch { continue; }
        if (rpc.method && rpc.id !== undefined) {
          if (rpc.method === "session/request_permission" && client.row) { client.row.permissions.push({ request: String(rpc.id), rpcId: rpc.id, title: rpc.params?.toolCall?.title || "工具操作需要确认", options: rpc.params?.options || [] }); save(); }
          else send({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unsupported client operation" } });
        } else if (rpc.method === "session/update" && client.row) {
          client.row.events.push({ at: Date.now(), update: rpc.params?.update }); client.row.events = client.row.events.slice(-500);
          if (JSON.stringify(client.row.events).length > 1000000) client.row.events = client.row.events.slice(-100);
        } else if (rpc.id !== undefined) { const pending = client.pending.get(rpc.id); if (pending) { clearTimeout(pending.timer); client.pending.delete(rpc.id); if (rpc.error) pending.reject(new Error(rpc.error.message || "ACP error")); else pending.resolve(rpc.result); } }
      }
    });
    return client;
  }
  async function initialize(client) { return client.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "mcca-workbench", version: "0.1.0" } }); }
  function idle(client) { if (disposed || client.closed) return; clearTimeout(client.idleTimer); client.idleTimer = setTimeout(() => { if (!client.row.running) client.child.kill(); }, 60000); client.idleTimer.unref(); }
  async function loaded(id) {
    const existing = active.get(id); if (existing) { clearTimeout(existing.idleTimer); return existing; }
    const row = find(id), client = spawnClient(runtime(row.runtime), row.cwd, row.home);
    try { const init = await initialize(client); if (!init.agentCapabilities?.loadSession) throw new Error("此 OpenHands 版本不支持加载既有会话"); await client.request("session/load", { sessionId: row.id, cwd: row.cwd, mcpServers: [acpMcp(paths)] }, 90000); client.row = row; row.offline = false; active.set(id, client); return client; }
    catch (error) { client.child.kill(); throw error; }
  }
  function adapter(runtimeId) { return {
    async create(args) {
      if (args.provider || args.modelId) throw new Error("OpenHands 使用应用已配置的服务商，请先在模型设置选择");
      const cfg = runtime(runtimeId), cwd = args.cwd || cfg.cwd || paths.app;
      if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("需要有效工作目录");
      const client = spawnClient(cfg, cwd);
      try { await initialize(client); const result = await client.request("session/new", { cwd, mcpServers: [acpMcp(paths)] }, 90000); if (!result?.sessionId) throw new Error("OpenHands 未返回 sessionId");
        const row = { id: result.sessionId, runtime: runtimeId, cwd, home:client.home, running: false, offline: false, permissions: [], events: [], log: "", at: Date.now() }; client.row = row; rows.push(row); active.set(row.id, client); save(); idle(client); return row.id;
      } catch (error) { client.child.kill(); throw error; }
    },
    async prompt(id, text) {
      const client = await loaded(id), row = find(id); if (row.running) throw new Error("ACP 会话正在运行");
      row.running = true; row.offline = false; row.lastResult = null; row.lastError = null; row.finishedAt = null; save();
      client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] }, 24 * 3600000).then(result => { row.lastResult = result; row.running = false; row.finishedAt = Date.now(); row.permissions = []; save(); idle(client); }, error => { row.running = false; row.offline = true; row.lastError = error.message; row.permissions = []; save(); idle(client); });
      return { accepted: true };
    },
    async stop(id) { const client = active.get(id); if (!client) throw new Error("ACP 离线，无法确认停止；请在原生界面核对"); client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } }); return { requested: true }; },
    async list() { return { sessions: rows.filter(r => r.runtime === runtimeId).map(({ events, log, ...r }) => r) }; },
    async history(id) { return { ...find(id) }; },
  }; }
  function permission(id, request, option) {
    const row = find(id), client = active.get(id), pending = row.permissions.find(p => p.request === request);
    if (!client || !pending || !pending.options.some(o => o.optionId === option)) throw new Error("授权请求已失效或选项不存在");
    client.send({ jsonrpc: "2.0", id: pending.rpcId, result: { outcome: { outcome: "selected", optionId: option } } }); row.permissions = row.permissions.filter(p => p !== pending); save(); return { ok: true };
  }
  return { adapter, permission, dispose() { for (const client of clients) { clearTimeout(client.idleTimer); client.child.kill(); } disposed = true; } };
}
module.exports = { createAcpTasks };
