"use strict";
async function readResponse(response) {
  let length = 0; const chunks = [];
  for await (const chunk of response.body) { length += chunk.length; if (length > 2 * 1024 * 1024) throw new Error("Hermes response too large"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
function createAssistantJobs({ runtime, fetchImpl = fetch }) {
  async function request(route, method = "GET", data) {
    const config = runtime("hermes-dashboard");
    if (!config || !Number.isInteger(config.port)) throw new Error("请先启用 Hermes Dashboard");
    const base = `http://127.0.0.1:${config.port}`;
    const home = await fetchImpl(base + "/", { signal: AbortSignal.timeout(10000), redirect: "error" });
    const html = await readResponse(home);
    const token = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([a-zA-Z0-9_-]+)"/.exec(html)?.[1];
    if (!home.ok || !token) throw new Error("Hermes Dashboard 未提供本机会话连接；请在 Hermes 原生界面登录或检查版本");
    const response = await fetchImpl(base + route, { method, headers: { "content-type": "application/json", "X-Hermes-Session-Token": token }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000), redirect: "error" });
    const text = await readResponse(response); let value;
    try { value = JSON.parse(text); } catch { throw new Error(`Hermes 返回无效数据（HTTP ${response.status}）`); }
    if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : `Hermes HTTP ${response.status}`);
    return value;
  }
  async function call(a) {
    if (a.action === "list") return request("/api/cron/jobs");
    if (a.action === "create") {
      if (!a.text?.trim() || a.text.length > 100000 || !a.scope?.trim() || a.scope.length > 10000) throw new Error("需要委托内容和明确操作范围");
      if (!Number.isInteger(a.minutes) || a.minutes < 1 || a.minutes > 10080) throw new Error("周期需要 1–10080 分钟");
      const prompt = `工作台长期委托。\n委托内容：${a.text}\n操作范围：${a.scope}\n使用 mcca-workbench MCP 的 app_overview 了解现状；严格限制在上述范围内。提交任务使用稳定唯一 key，结果未知时先检查，禁止自动重复发布。会话 idle 不等于目标完成，读取结果再判断。只有状态发生有意义变化、完成、失败或需要用户介入才汇报；无变化保持安静。不要自行扩大范围或停止其他任务。结果仅保存在本机。`;
      // Never retry a create: the server may have persisted it before transport failed.
      try { return await request("/api/cron/jobs", "POST", { name: String(a.title || "工作台委托").slice(0, 120), prompt, schedule: `every ${a.minutes}m`, deliver: "local", ...(a.cwd ? { workdir: a.cwd } : {}) }); }
      catch (error) { throw new Error(`${error.message}；创建结果可能未知，请先刷新 Hermes 委托列表，不要直接重复提交`); }
    }
    if (typeof a.id !== "string" || !/^[\w.-]{1,200}$/.test(a.id)) throw new Error("需要 Hermes 返回的委托 id");
    const route = `/api/cron/jobs/${encodeURIComponent(a.id)}`;
    if (a.action === "inspect") return { job: await request(route), runs: await request(route + "/runs?limit=20") };
    if (["pause", "resume"].includes(a.action)) return request(`${route}/${a.action}`, "POST", {});
    throw new Error("Unknown assistant job action");
  }
  return { call };
}
module.exports = { createAssistantJobs };
