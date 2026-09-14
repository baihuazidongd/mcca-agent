/**
 * @pi-dsh-bridge/task-notify — 任务终态通知（dsh 侧）。
 *
 * 监听 goal 域的 `goal/changed`（durable 变更提交后的实时通知），在目标进入
 * 终态时把事件推给本机 portal（`POST /api/notify`），由 portal 前端经 Tauri
 * 发系统通知。同时兜住 agent 运行期错误（provider 失败等）作为“任务失败”。
 *
 * 与 pi 侧的对称实现：packages/pi-dsh-web/pi-bridge.cjs 的 notifyPortal /
 * notifyGoalSettled（桥内 goal 状态机自己持有终态）。
 *
 * 尽力而为：portal 未运行 / 不可达时静默丢弃；监听器抛错由 cordis 隔离，
 * 绝不影响目标本身。错误通知按 agent 节流，避免重试风暴刷屏。
 *
 * 挂载：`config/hot-plugins.json` 清单（由 pdb-hot-mount 运行期挂载），
 * 所以改这个文件本身就会热重挂，不需要重启宿主。
 */

/** Cordis function plugin name. */
export const name = "pdb-task-notify";

/** Services required before the listeners may mount. */
export const inject = [];

/** portal 通知端点（PORTAL_PORT 覆盖，默认与 portal 同值）。 */
function notifyEndpoint() {
  const port = Number(process.env.PORTAL_PORT) || 3470;
  return `http://127.0.0.1:${port}/api/notify`;
}

/**
 * 推一条系统通知到 portal；任何失败都吞掉（通知是旁路，不是业务）。
 * @param {string} title - 通知标题。
 * @param {string} body - 通知正文。
 */
function notifyPortal(title, body) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 4000) : null;
  fetch(notifyEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body, source: "dsh" }),
    signal: controller ? controller.signal : undefined,
  })
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); })
    .catch(() => {})
    .finally(() => { if (timer) clearTimeout(timer); });
}

/** 截断目标文本，保持通知一行可读。 */
function brief(text, max = 60) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** agent 错误通知节流：同一 agent 每 15s 最多一条。 */
const ERROR_THROTTLE_MS = 15000;
const lastErrorNoticeAt = new Map();

/**
 * 瞬时错误的观察窗口。
 *
 * `agent/error` 在**每一步**失败时都会抛（provider 503 很常见），而 agent-loop
 * 会自己重试：会话日志里能看到报错之后仍在 `step/start`。所以它不等于“任务失
 * 败”——直接播报就是误报。这里把错误挂起观察：agent 重新 running 即判为已恢复
 * 并丢弃；确认落到 idle（没有下一次尝试）才算终态并通知。
 */
const ERROR_GRACE_MS = 6000;

/**
 * 订阅 goal 终态与 agent 错误。
 * @param {object} ctx - dsh Context（duck-typed：只用 ctx.on）。
 */
export function apply(ctx) {
  /** agentId -> { message, timer } 等待观察的失败。 */
  const pending = new Map();

  /** 确认终态后发通知（带节流）。 */
  function announce(id, message) {
    const now = Date.now();
    if (now - (lastErrorNoticeAt.get(id) || 0) < ERROR_THROTTLE_MS) return;
    lastErrorNoticeAt.set(id, now);
    notifyPortal("dsh 任务失败 ✗", brief(`会话 ${id} 运行出错：${message}`, 160));
  }

  ctx.effect(() => ctx.on("goal/changed", ({ change }) => {
    const operation = change?.operation;
    if (operation !== "complete" && operation !== "block") return;
    const goal = change.goal;
    const objective = brief(goal?.objective ?? change?.ref?.objective);
    // 目标终态自带结论，挂起的步骤错误不再单独播报，避免同一件事两条通知。
    for (const [id, record] of pending) {
      clearTimeout(record.timer);
      pending.delete(id);
    }
    if (operation === "complete") {
      notifyPortal("dsh 任务完成 ✓", objective || "目标已完成");
      return;
    }
    const reason = goal?.blockedReason?.message ? brief(goal.blockedReason.message, 120) : "目标已受阻";
    notifyPortal("dsh 任务失败 ✗", objective ? `${objective}：${reason}` : reason);
  }), "pdb-task-notify: goal terminal states");

  ctx.effect(() => ctx.on("agent/error", ({ agent, error }) => {
    const id = String(agent?.id ?? agent?.session?.id ?? "unknown");
    const message = error instanceof Error ? error.message : String(error ?? "未知错误");
    const existing = pending.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      pending.delete(id);
      announce(id, message);
    }, ERROR_GRACE_MS);
    pending.set(id, { message, timer });
  }), "pdb-task-notify: agent errors");

  ctx.effect(() => ctx.on("agent/status", ({ agent, status }) => {
    const id = String(agent?.id ?? agent?.session?.id ?? "unknown");
    const record = pending.get(id);
    if (!record) return;
    if (status === "running") {
      // 循环自己重试上了：那次错误是瞬时抖动，撤销播报。
      clearTimeout(record.timer);
      pending.delete(id);
      return;
    }
    // 落到 idle 且没有下一次尝试：这一轮确实死了，立刻播报。
    clearTimeout(record.timer);
    pending.delete(id);
    announce(id, record.message);
  }), "pdb-task-notify: recover detection");

  // 卸载时收掉未决的观察定时器。注册与清理都必须是 effect：apply 的返回值
  // 被 cordis 忽略，返回 disposer 不会随 fiber 卸载。
  ctx.effect(() => () => {
    for (const record of pending.values()) clearTimeout(record.timer);
    pending.clear();
  }, "pdb-task-notify: pending timers");
}
