"use strict";

/**
 * @mcca/mobile-bridge — portal 数据源。
 *
 * portal（:3470）是桌面应用的管理进程：进程启停、资源占用、任务通知队列。
 * 手机端的「管理」页与通知列表都走这里，桥本身不做二次存储。
 */

class PortalSource {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - portal 基址（默认 http://127.0.0.1:3470）
   * @param {(line:string)=>void} [opts.log]
   */
  constructor({ baseUrl, log }) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:3470").replace(/\/+$/, "");
    this.log = log || (() => {});
    this.online = false;
    this.lastError = "";
    this.lastNotifyId = 0;
  }

  async httpJson(method, pathname, body, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
      this.online = true;
      this.lastError = "";
      return { status: res.status, json };
    } catch (error) {
      this.online = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async status() {
    const { status, json } = await this.httpJson("GET", "/api/status", undefined, 5000);
    if (status !== 200 || !json) throw new Error(`portal /api/status → ${status}`);
    return json.agents || [];
  }

  async resources() {
    const { status, json } = await this.httpJson("GET", "/api/resources", undefined, 8000);
    if (status !== 200 || !json) throw new Error(`portal /api/resources → ${status}`);
    return json;
  }

  async action(agent, action) {
    if (!["start", "stop", "restart"].includes(action)) return { ok: false, error: `未知操作 ${action}` };
    const { status, json } = await this.httpJson("POST", `/api/process/${encodeURIComponent(agent)}/${action}`, {}, 40000);
    if (status === 200 && json) return { ok: json.ok !== false, error: json.error };
    return { ok: false, error: (json && json.error) || `process → ${status}` };
  }

  /** 拉取比 since 新的通知；返回 {items, latest}。 */
  async notifications(since) {
    const { status, json } = await this.httpJson("GET", `/api/notifications?since=${Number(since) || 0}`, undefined, 5000);
    if (status !== 200 || !json) throw new Error(`portal /api/notifications → ${status}`);
    return { items: json.items || [], latest: json.latest || 0 };
  }

  /** 删掉一条事件板记录（portal DELETE /api/notifications/:id）。 */
  async deleteNotification(id) {
    const { status, json } = await this.httpJson("DELETE", `/api/notifications/${encodeURIComponent(id)}`, undefined, 8000);
    if (status === 200 && json && json.ok !== false) return { ok: true, id };
    return { ok: false, error: (json && json.error) || `delete → ${status}` };
  }
}

module.exports = { PortalSource };
