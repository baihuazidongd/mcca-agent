"use strict";

/** 事件板任务监控要问的网页会话服务。命令行终端另计。 */
const CLI_AGENT = {
  "codex-web": "codex",
  "openhands-web": "openhands",
  "grok-web": "grok",
  "hermes-web": "hermes",
};

function mapDeskSessions(agent, payload) {
  const sessions = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
  return sessions.map((row) => ({
    agent,
    id: String(row.id || "").slice(0, 80),
    title: String(row.title || "").replace(/\s+/g, " ").trim().slice(0, 80),
    cwd: String(row.cwd || "").slice(0, 400),
    running: Boolean(row.running),
    updatedAt: Number(row.updatedAt) || 0,
  })).filter((row) => row.id);
}

function terminalRows(terminals) {
  const rows = [];
  for (const row of terminals || []) {
    if (!row || row.exited != null || !row.id) continue;
    const agent = CLI_AGENT[row.agent] || String(row.agent || "");
    if (!agent) continue;
    rows.push({
      agent,
      id: String(row.id).slice(0, 80),
      title: String(row.title || "命令行").replace(/\s+/g, " ").trim().slice(0, 80),
      cwd: String(row.cwd || "").slice(0, 400),
      running: true,
      updatedAt: Number(row.updatedAt) || 0,
    });
  }
  return rows;
}

function createDesk() {
  let recentRows = [];
  let recentAt = 0;
  return {
    /**
     * 每个网页服务都问一遍正在跑的会话。连不上记进 offline，不当成「没有任务」。
     * 近期列表按服务替换；某个服务这次没连上时，留着它上一份列表。
     */
    async snapshot({ sides, getJson, terminals, recentEveryMs = 45000, now = Date.now() } = {}) {
      const running = [];
      const offline = [];
      const freshRecent = [];
      const onlineAgents = new Set();
      const wantRecent = now - recentAt > recentEveryMs;
      await Promise.all((sides || []).map(async (side) => {
        const live = await getJson(side.port, "/api/sessions/running", 800);
        if (!live || !Array.isArray(live.sessions)) {
          offline.push(side.agent);
          return;
        }
        onlineAgents.add(side.agent);
        running.push(...mapDeskSessions(side.agent, live).filter((row) => row.running));
        if (!wantRecent) return;
        const all = await getJson(side.port, "/api/sessions", 2500);
        if (all && Array.isArray(all.sessions)) freshRecent.push(...mapDeskSessions(side.agent, all));
      }));
      if (wantRecent) {
        const kept = recentRows.filter((row) => !onlineAgents.has(row.agent));
        const merged = [...freshRecent, ...kept].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24);
        if (merged.length || onlineAgents.size) recentRows = merged;
        recentAt = now;
      }
      running.push(...terminalRows(terminals));
      running.sort((a, b) => b.updatedAt - a.updatedAt);
      return { running: running.slice(0, 12), recent: recentRows, offline };
    },
  };
}

module.exports = { createDesk, mapDeskSessions, CLI_AGENT };
