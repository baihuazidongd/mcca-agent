(function () {
  "use strict";

  const { useState, useEffect, useCallback, useRef } = React;
  const h = React.createElement;

  async function api(pathname, options) {
    const res = await fetch(pathname, options);
    return res.json();
  }

  const KIND_LABEL = { tool: "工具", command: "命令", mcp: "MCP", skill: "技能", ui: "界面", host: "宿主" };
  const REMOVED_KEY = "mcca.instances.removed";
  function readRemoved() {
    try {
      const raw = JSON.parse(localStorage.getItem(REMOVED_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  function writeRemoved(list) {
    try {
      localStorage.setItem(REMOVED_KEY, JSON.stringify(list));
    } catch {
      // 旧门户没有安装接口时，至少这一页还记得移除了谁
    }
  }
  const SURFACE_LABEL = { shared: "共享库", client: "客户端 bundle", host: "宿主热挂载" };

  // ── Inline SVG icons (feather-style, stroke inherits color) ─────

  function Icon({ size = 14, strokeWidth = 2, children }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: strokeWidth,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      },
      children,
    );
  }

  const ICONS = {
    terminal: [
      h("polyline", { points: "4 17 10 11 4 5" }),
      h("line", { x1: 12, y1: 19, x2: 20, y2: 19 }),
    ],
    chat: [
      h("path", {
        d: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
      }),
    ],
    sliders: [
      h("line", { x1: 4, y1: 21, x2: 4, y2: 14 }),
      h("line", { x1: 4, y1: 10, x2: 4, y2: 3 }),
      h("line", { x1: 12, y1: 21, x2: 12, y2: 12 }),
      h("line", { x1: 12, y1: 8, x2: 12, y2: 3 }),
      h("line", { x1: 20, y1: 21, x2: 20, y2: 16 }),
      h("line", { x1: 20, y1: 12, x2: 20, y2: 3 }),
      h("line", { x1: 1, y1: 14, x2: 7, y2: 14 }),
      h("line", { x1: 9, y1: 8, x2: 15, y2: 8 }),
      h("line", { x1: 17, y1: 16, x2: 23, y2: 16 }),
    ],
    activity: [h("polyline", { points: "22 12 18 12 15 21 9 3 6 12 2 12" })],
    list: [
      h("line", { x1: 8, y1: 6, x2: 21, y2: 6 }),
      h("line", { x1: 8, y1: 12, x2: 21, y2: 12 }),
      h("line", { x1: 8, y1: 18, x2: 21, y2: 18 }),
      h("line", { x1: 3, y1: 6, x2: 3.01, y2: 6 }),
      h("line", { x1: 3, y1: 12, x2: 3.01, y2: 12 }),
      h("line", { x1: 3, y1: 18, x2: 3.01, y2: 18 }),
    ],
    code: [
      h("polyline", { points: "16 18 22 12 16 6" }),
      h("polyline", { points: "8 6 2 12 8 18" }),
    ],
    chart: [
      h("line", { x1: 6, y1: 20, x2: 6, y2: 10 }),
      h("line", { x1: 12, y1: 20, x2: 12, y2: 4 }),
      h("line", { x1: 18, y1: 20, x2: 18, y2: 14 }),
      h("line", { x1: 3, y1: 20, x2: 21, y2: 20 }),
    ],
    moon: [h("path", { d: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" })],
    sun: [
      h("circle", { cx: 12, cy: 12, r: 5 }),
      h("line", { x1: 12, y1: 1, x2: 12, y2: 3 }),
      h("line", { x1: 12, y1: 21, x2: 12, y2: 23 }),
      h("line", { x1: 4.22, y1: 4.22, x2: 5.64, y2: 5.64 }),
      h("line", { x1: 18.36, y1: 18.36, x2: 19.78, y2: 19.78 }),
      h("line", { x1: 1, y1: 12, x2: 3, y2: 12 }),
      h("line", { x1: 21, y1: 12, x2: 23, y2: 12 }),
      h("line", { x1: 4.22, y1: 19.78, x2: 5.64, y2: 18.36 }),
      h("line", { x1: 18.36, y1: 5.64, x2: 19.78, y2: 4.22 }),
    ],
    image: [
      h("rect", { x: 3, y: 3, width: 18, height: 18, rx: 2, ry: 2 }),
      h("circle", { cx: 8.5, cy: 8.5, r: 1.5 }),
      h("polyline", { points: "21 15 16 10 5 21" }),
    ],
    canvas: [
      h("rect", { x: 3.5, y: 4.5, width: 17, height: 14, rx: 1.75, strokeWidth: 1.6 }),
      h("circle", { cx: 8, cy: 8.3, r: 1, strokeWidth: 1.6 }),
      h("path", { d: "M6.2 15.5 9.6 11.7l2.7 2.3 3.5-3.8 2.8 2.6", strokeWidth: 1.6 }),
    ],
    manage: [
      h("path", { d: "M12 4.6L14.95 2.24L18.98 4.56L18.41 8.3L21.93 9.67L21.93 14.33L18.41 15.7L18.98 19.44L14.95 21.76L12 19.4L9.05 21.76L5.02 19.44L5.59 15.7L2.07 14.33L2.07 9.67L5.59 8.3L5.02 4.56L9.05 2.24Z", strokeWidth: 1.6 }),
      h("circle", { cx: 12, cy: 12, r: 2.6, strokeWidth: 1.6 }),
    ],
  };

  // ── Native window controls (only when running inside the Tauri shell) ─

  function desktopWindow() {
    try {
      return window.__TAURI__ ? window.__TAURI__.window.getCurrentWindow() : null;
    } catch (e) {
      return null;
    }
  }

  const HAS_TAURI = Boolean(desktopWindow());

  Object.assign(ICONS, {
    minus: [h("line", { x1: 5, y1: 12, x2: 19, y2: 12 })],
    square: [h("rect", { x: 5, y: 5, width: 14, height: 14, rx: 1 })],
    xmark: [h("line", { x1: 6, y1: 6, x2: 18, y2: 18 }), h("line", { x1: 18, y1: 6, x2: 6, y2: 18 })],
  });


  // ── Small building blocks ────────────────────────────────────────

  function Toggle({ on, onClick, disabled }) {
    return h("span", {
      className: "toggle" + (on ? " on" : ""),
      onClick: disabled ? undefined : onClick,
      role: "switch",
      "aria-checked": String(Boolean(on)),
    });
  }

  function AgentSwitch({ agent, label, on, disabled, onChange }) {
    return h(
      "span",
      { className: "agent-switch" + (disabled ? " disabled" : ""), title: `${label} 侧${on ? "已启用" : "已停用"}` },
      h("span", { className: "label" }, label),
      h(Toggle, { on, disabled, onClick: onChange }),
    );
  }

  function Chip({ active, children, onClick }) {
    return h("button", { className: "chip" + (active ? " is-active" : ""), onClick }, children);
  }

  function Toast({ text }) {
    if (!text) return null;
    return h("div", { className: "toast" }, text);
  }

  // ── Native notifications (system toast popups) ──────────────────
  // Priority: Tauri notification plugin (window.__TAURI__.notification),
  //   fallback: raw IPC invoke,   final fallback: ambient Web Notification API.

  function tauriNotificationApi() {
    try {
      const n = window.__TAURI__ && window.__TAURI__.notification;
      if (n && typeof n.isPermissionGranted === "function" && typeof n.sendNotification === "function") {
        return n;
      }
    } catch (e) {}
    return null;
  }

  async function tauriInvoke(cmd, args) {
    if (typeof window.__TAURI_INVOKE__ === "function") {
      return window.__TAURI_INVOKE__(cmd, args);
    }
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (core && typeof core.invoke === "function") return core.invoke(cmd, args);
    throw new Error("tauri ipc unavailable");
  }

  async function getNativeNotificationState() {
    const api = tauriNotificationApi();
    if (api) {
      try {
        return { supported: true, permission: (await api.isPermissionGranted()) ? "granted" : "default" };
      } catch (e) {}
    }
    if (window.__TAURI__ || typeof window.__TAURI_INVOKE__ === "function") {
      try {
        const ok = await tauriInvoke("plugin:notification|is_permission_granted");
        return { supported: true, permission: ok ? "granted" : "default" };
      } catch (e) {}
    }
    if (typeof Notification !== "undefined") {
      return { supported: true, permission: Notification.permission };
    }
    return { supported: false, permission: "unsupported" };
  }

  function nativeNotificationLabel(permission) {
    if (permission === "granted") return "已允许";
    if (permission === "denied") return "已拒绝";
    if (permission === "unsupported") return "不支持";
    return "待授权";
  }

  async function requestNativePermission() {
    const api = tauriNotificationApi();
    if (api) {
      try {
        const r = await api.requestPermission();
        return r === true || r === "granted";
      } catch (e) {}
    }
    if (window.__TAURI__ || typeof window.__TAURI_INVOKE__ === "function") {
      try { return (await tauriInvoke("plugin:notification|request_permission")) === true; }
      catch (e) {}
    }
    if (typeof Notification !== "undefined") {
      try { return (await Notification.requestPermission()) === "granted"; } catch (e) {}
    }
    return false;
  }

  async function sendNativeNotification(title, body) {
    const api = tauriNotificationApi();
    if (api) {
      try { await api.sendNotification({ title, body }); return true; } catch (e) {}
    }
    if (window.__TAURI__ || typeof window.__TAURI_INVOKE__ === "function") {
      try { await tauriInvoke("plugin:notification|notify", { title, body }); return true; } catch (e) {}
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification(title, { body, tag: "mcca-portal" }); return true; } catch (e) {}
    }
    return false;
  }

  // ── 事件板：pi / dsh 通过 POST /api/notify 推来的事件，最新的在上面 ──
  function eventSource(item) {
    const src = item && item.source && typeof item.source === "object" ? item.source : {};
    const cwd = String(src.cwd || "");
    const workspace = String(src.workspace || "") || (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "");
    const agent = src.agent === "pi" || src.agent === "dsh" || src.agent === "codex" || src.agent === "openhands" || src.agent === "grok" || src.agent === "hermes" ? src.agent : "";
    return {
      agent,
      cwd,
      workspace,
      session: String(src.session || "").trim(),
      sessionId: String(src.sessionId || "").trim(),
    };
  }

  function eventDayLabel(at) {
    const when = new Date(at || Date.now());
    const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((start(new Date()) - start(when)) / 86400000);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    const p = (n) => String(n).padStart(2, "0");
    return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
  }

  function eventClock(at) {
    const when = new Date(at || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return `${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())}`;
  }

  function eventHm(at) {
    const when = new Date(at || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    return `${p(when.getHours())}:${p(when.getMinutes())}`;
  }

  function eventAgo(at) {
    const sec = Math.max(0, (Date.now() - (at || Date.now())) / 1000);
    if (sec < 60) return "刚刚";
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
    return `${Math.floor(sec / 86400)} 天前`;
  }

  function eventHaystack(item) {
    const src = eventSource(item);
    return [item.title, item.body, src.workspace, src.cwd, src.session, src.sessionId, src.agent].join("\n").toLowerCase();
  }

  function EventBoard({ events, hidden, onClear, onRestore, onDelete }) {
    const [openId, setOpenId] = useState(null);
    const [query, setQuery] = useState("");
    const [workspace, setWorkspace] = useState("all");
    const [copiedId, setCopiedId] = useState(null);
    const needle = query.trim().toLowerCase();
    const workspaces = [];
    const seenWs = new Set();
    for (const item of events) {
      const name = eventSource(item).workspace || "未记录";
      if (!seenWs.has(name)) { seenWs.add(name); workspaces.push(name); }
    }
    const shown = events.filter((item) => {
      const src = eventSource(item);
      const ws = src.workspace || "未记录";
      if (workspace !== "all" && ws !== workspace) return false;
      if (needle && !eventHaystack(item).includes(needle)) return false;
      return true;
    });
    const copyItem = async (item, event) => {
      event.stopPropagation();
      const src = eventSource(item);
      const lines = [
        item.title || "mcca",
        src.agent ? `来源：${src.agent}` : "",
        src.workspace ? `工作区：${src.workspace}` : "",
        src.cwd ? `路径：${src.cwd}` : "",
        src.session ? `会话：${src.session}` : "",
        `时间：${eventClock(item.at)}`,
        "",
        String(item.body || ""),
      ].filter((line, i, arr) => line || arr[i - 1]);
      try {
        await navigator.clipboard.writeText(lines.join("\n").trim());
        setCopiedId(item.id);
        setTimeout(() => setCopiedId((cur) => (cur === item.id ? null : cur)), 1600);
      } catch {
        setCopiedId(null);
      }
    };
    const groups = [];
    for (const item of shown) {
      const label = eventDayLabel(item.at);
      const last = groups[groups.length - 1];
      if (!last || last.label !== label) groups.push({ label, items: [item] });
      else last.items.push(item);
    }
    const toolbar = h(
      "div",
      { className: "eb-toolbar" },
      h("input", {
        className: "eb-search",
        type: "search",
        placeholder: "搜索事件…",
        value: query,
        onChange: (e) => setQuery(e.target.value),
        "aria-label": "搜索事件",
      }),
      h("span", { className: "eb-count" }, shown.length === events.length ? `${events.length}` : `${shown.length}/${events.length}`),
      hidden > 0 ? h("button", { className: "btn-phys sm eb-toolbtn", onClick: onRestore, title: `存档里还有 ${hidden} 条` }, `恢复 ${hidden}`) : null,
      events.length ? h("button", { className: "btn-phys sm eb-toolbtn eb-clear", onClick: onClear, title: "清空本页，存档还在" }, "清空") : null,
    );
    const filters = workspaces.length > 1
      ? h(
          "div",
          { className: "chips eb-filters", role: "tablist", "aria-label": "按工作区筛选" },
          h("button", {
            className: "chip" + (workspace === "all" ? " is-active" : ""),
            onClick: () => setWorkspace("all"),
          }, "全部"),
          workspaces.map((name) => h("button", {
            key: name,
            className: "chip" + (workspace === name ? " is-active" : ""),
            onClick: () => setWorkspace(name),
            title: name,
          }, name)),
        )
      : null;
    let body;
    if (events.length === 0 && hidden > 0) {
      body = h(
        "div",
        { className: "eb-empty" },
        `本页已清空，存档里还有 ${hidden} 条。右上角可以恢复。`,
      );
    } else if (events.length === 0) {
      body = h(
        "div",
        { className: "eb-empty" },
        "还没有事件。在会话里明确要求后，pi / dsh 才会往这里推一条。推送会自动带上当时的工作区和会话。",
        h("code", null, `node D:\\dshpi\\packages\\portal\\notify.cjs "标题" "正文"`),
      );
    } else if (!shown.length) {
      body = h("div", { className: "eb-empty" }, "没有符合筛选的事件。换个工作区，或把搜索清掉。");
    } else {
      body = h("div", { className: "eb-list" }, groups.map((group) => h(
        "section",
        { className: "eb-group", key: group.label },
        h("div", { className: "eb-day" }, group.label),
        group.items.map((item) => {
          const open = openId === item.id;
          const src = eventSource(item);
          const text = String(item.body || "");
          const sessionLabel = src.session || (src.sessionId ? src.sessionId.slice(0, 8) : "");
          const bits = [];
          if (src.agent) bits.push(h("span", { key: "agent", className: "eb-agent " + src.agent }, src.agent));
          if (src.workspace) bits.push(h("span", { key: "ws", className: "eb-ws", title: src.cwd || src.workspace }, src.workspace));
          if (sessionLabel) bits.push(h("span", { key: "session", className: "eb-session", title: src.sessionId || sessionLabel }, sessionLabel));
          const meta = [];
          bits.forEach((bit, i) => {
            if (i) meta.push(h("span", { key: "dot" + i, className: "eb-dot" }, "·"));
            meta.push(bit);
          });
          return h(
            "article",
            { className: "eb-entry" + (open ? " open" : ""), key: String(item.id) },
            h(
              "div",
              { className: "eb-meta" },
              h("span", { className: "eb-time" }, eventHm(item.at), h("span", { className: "eb-rel" }, eventAgo(item.at))),
              meta.length ? h("span", { className: "eb-bits" }, meta) : null,
              h(
                "span",
                { className: "eb-actions" },
                h("button", { className: "btn-phys sm eb-action-btn", onClick: (e) => copyItem(item, e) }, copiedId === item.id ? "已复制" : "复制"),
                h("button", {
                  className: "btn-phys sm eb-action-btn eb-delete",
                  onClick: (e) => { e.stopPropagation(); if (onDelete) onDelete(item.id); },
                }, "删除"),
              ),
            ),
            h("h3", {
              className: "eb-title" + (text || src.cwd ? " is-toggle" : ""),
              onClick: text || src.cwd ? () => setOpenId(open ? null : item.id) : undefined,
            }, item.title || "mcca"),
            text && !open ? h("pre", { className: "eb-preview" }, text) : null,
            open ? h(
              "div",
              { className: "eb-full" },
              src.cwd ? h("div", { className: "eb-path" }, src.cwd) : null,
              text ? h("pre", null, text) : null,
            ) : null,
          );
        }),
      )));
    }
    return h("div", { className: "event-board" }, toolbar, filters, body);
  }

  function wsName(cwd) {
    const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function useDesk() {
    const [desk, setDesk] = useState({ running: [], recent: [], offline: [] });
    useEffect(() => {
      let alive = true;
      const tick = async () => {
        try {
          const data = await api("/api/desk");
          if (alive && data && data.ok) setDesk({ running: data.running || [], recent: data.recent || [], offline: data.offline || [] });
        } catch {
          // 门户自己没起来时面板保持上一帧
        }
      };
      tick();
      const timer = setInterval(tick, 4000);
      return () => { alive = false; clearInterval(timer); };
    }, []);
    return desk;
  }

  function TaskMonitor({ desk, completions, status, onOpen }) {
    const running = (desk && desk.running) || [];
    const offline = (desk && desk.offline) || [];
    const groups = [
      ["IDE", [
        ["dsh", status && status.dsh],
        ["pi", status && status.pi],
      ]],
      ["CLI", [
        ["codex", status && status.codex, "Codex"],
        ["openhands", status && status.openhands, "OpenHands"],
        ["grok", status && status.grok, "Grok Build"],
        ["hermes", status && status.hermes, "Hermes Agent"],
      ]],
    ];
    const live = (name, st) => Boolean(st && st.running) || (offline.indexOf(name) < 0 && running.some((row) => row.agent === name));
    return h(
      "div",
      { className: "desk-bd" },
      groups.map(([kind, procs]) => h(
        "div",
        { key: kind, className: "desk-proc-group" },
        h("span", { className: "desk-proc-k" }, kind),
        procs.map(([name, st, label]) => h(
          "button",
          { key: name, className: "btn-phys sm" + (live(name, st) ? " is-live" : ""), onClick: () => onOpen(name) },
          label || name,
          h("i", { className: "run-dot" + (live(name, st) ? "" : " is-off") }),
        )),
      )),
      offline.length
        ? h("p", { className: "desk-empty" }, offline.join("、") + " 没连上，它们的任务这里看不到。")
        : null,
      running.length
        ? running.map((row) => h(
            "button",
            { key: row.agent + row.id, className: "desk-row", onClick: () => onOpen(row.agent) },
            h("span", { className: "desk-agent" }, row.agent),
            h("span", { className: "desk-row-title" }, row.title || "未命名任务"),
            h("span", { className: "desk-row-meta" }, wsName(row.cwd) || "进行中"),
          ))
        : h("p", { className: "desk-empty" }, offline.length ? "连上的服务里现在没有在跑的会话。" : "现在没有在跑的会话。"),
      h("div", { className: "desk-sub" }, "最近完成"),
      (completions || []).length
        ? completions.slice(0, 8).map((item) => h(
            "div",
            { key: String(item.id), className: "desk-done" },
            h("strong", null, item.title || "任务"),
            h("span", null, eventAgo(item.at)),
            item.body ? h("p", null, String(item.body).replace(/\s+/g, " ")) : null,
          ))
        : h("p", { className: "desk-empty" }, "完成或失败时，会记在这里。"),
    );
  }

  function RecentTasks({ desk, onOpen }) {
    const rows = ((desk && desk.recent) || []).filter((row) => !row.running).slice(0, 10);
    return h(
      "div",
      { className: "desk-bd" },
      rows.length
        ? rows.map((row) => h(
            "button",
            { key: row.agent + row.id, className: "desk-row", onClick: () => onOpen(row.agent) },
            h("span", { className: "desk-agent" }, row.agent),
            h("b", { className: "desk-row-title" }, row.title || "未命名任务"),
            h("span", { className: "desk-row-meta" }, [wsName(row.cwd), row.updatedAt ? eventAgo(row.updatedAt) : ""].filter(Boolean).join(" · ")),
          ))
        : h("p", { className: "desk-empty" }, "还没读到 pi 的近期会话。"),
    );
  }

  function Notepad({ onText }) {
    const key = "mcca.board.notes";
    const [text, setText] = useState(() => {
      try { return window.localStorage.getItem(key) || ""; } catch { return ""; }
    });
    const reportText = useRef(onText);
    reportText.current = onText;
    useEffect(() => { if (reportText.current) reportText.current(text); }, [text]);
    useEffect(() => {
      const timer = setTimeout(() => {
        try { window.localStorage.setItem(key, text); } catch { /* 存不下就只留在这一页 */ }
      }, 250);
      return () => clearTimeout(timer);
    }, [text]);
    return h("textarea", {
      className: "desk-notes",
      value: text,
      placeholder: "记在这里。自动留在这台机器上。",
      onChange: (e) => setText(e.target.value),
    });
  }

  function agendaNote(item) {
    if (item.status === "handed") return item.note || "已交给Hermes Agent";
    if (item.status === "failed") return item.note || "没有送到";
    return item.at ? eventClock(item.at) : "待提交";
  }

  function Agenda({ onCount }) {
    const [items, setItems] = useState([]);
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [hint, setHint] = useState("");
    const sortRows = (rows) => rows.slice().sort((a, b) => Number(a.done) - Number(b.done) || (a.createdAt || 0) - (b.createdAt || 0));
    const load = useCallback(async () => {
      try {
        const data = await api("/api/agenda");
        if (data && Array.isArray(data.items)) setItems(sortRows(data.items));
      } catch { /* 门户还没起来时保持空列表 */ }
    }, []);
    useEffect(() => { load(); }, [load]);
    const reportCount = useRef(onCount);
    reportCount.current = onCount;
    useEffect(() => { if (reportCount.current) reportCount.current(items.filter((row) => !row.done).length); }, [items]);
    const add = async () => {
      const name = title.trim();
      if (!name || busy) return;
      setBusy(true);
      setHint("");
      try {
        const data = await api("/api/agenda", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: name }),
        });
        if (data && Array.isArray(data.items)) setItems(sortRows(data.items));
        else if (data && data.item) setItems((prev) => sortRows([data.item, ...prev.filter((row) => row.id !== data.item.id)]));
        if (data && data.ok !== false) setTitle("");
        setHint(data && data.ok === false ? (data.error || "没有送到Hermes Agent") : (data && data.note) || "已交给Hermes Agent");
      } catch (error) {
        setHint(error.message || "没有送到Hermes Agent");
      } finally {
        setBusy(false);
      }
    };
    const toggle = async (item) => {
      const done = !item.done;
      setItems((prev) => sortRows(prev.map((row) => row.id === item.id ? { ...row, done } : row)));
      try {
        await api(`/api/agenda/${encodeURIComponent(item.id)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ done }),
        });
      } catch { load(); }
    };
    const remove = async (item) => {
      setItems((prev) => prev.filter((row) => row.id !== item.id));
      try {
        await api(`/api/agenda/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      } catch { load(); }
    };
    return h(
      "div",
      { className: "desk-agenda" },
      h(
        "form",
        { className: "desk-agenda-form", onSubmit: (e) => { e.preventDefault(); add(); } },
        h("input", { value: title, placeholder: "写一件要Hermes Agent办的事", onChange: (e) => setTitle(e.target.value), "aria-label": "事项" }),
        h("button", { className: "btn-phys", type: "submit", disabled: busy }, busy ? "提交中" : "提交"),
      ),
      hint ? h("p", { className: "desk-agenda-hint" }, hint) : null,
      h(
        "div",
        { className: "desk-agenda-list" },
        items.length
          ? items.map((item) => h(
              "div",
              { key: String(item.id), className: "desk-agenda-item" + (item.done ? " is-done" : "") + (item.status === "failed" ? " is-failed" : "") },
              h("input", { type: "checkbox", checked: Boolean(item.done), onChange: () => toggle(item), "aria-label": "完成" }),
              h("span", { className: "desk-agenda-title", title: item.title }, item.title),
              h("span", { className: "desk-agenda-when", title: item.note || "" }, agendaNote(item)),
              h("button", { type: "button", className: "desk-agenda-drop", onClick: () => remove(item), "aria-label": "删掉这条安排" }, "×"),
            ))
          : h("p", { className: "desk-empty" }, "写下安排再提交。Hermes Agent会接到目前所有还没做完的事。"),
      ),
    );
  }

  const DESK_LAYOUT_KEY = "mcca.board.layout";
  const DESK_ORDER = ["monitor", "recent", "feed", "notes", "agenda"];
  const DESK_DEFAULT = {
    monitor: { x: 0, y: 0, w: 57.4, h: 31 },
    recent: { x: 58.6, y: 0, w: 41.4, h: 31 },
    feed: { x: 0, y: 32.2, w: 57.4, h: 36 },
    notes: { x: 58.6, y: 32.2, w: 41.4, h: 36 },
    agenda: { x: 0, y: 69.4, w: 100, h: 30.6 },
  };

  function loadDeskLayout() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(DESK_LAYOUT_KEY) || "null");
      const out = {};
      for (const id of Object.keys(DESK_DEFAULT)) {
        const box = saved && saved[id];
        out[id] = box && [box.x, box.y, box.w, box.h].every((n) => Number.isFinite(Number(n)))
          ? { x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h) }
          : { ...DESK_DEFAULT[id] };
      }
      return out;
    } catch {
      return Object.fromEntries(Object.entries(DESK_DEFAULT).map(([id, box]) => [id, { ...box }]));
    }
  }

  const DESK_GRID = 8;
  const DESK_GAP = 8;

  function deskMin(rect) {
    return {
      w: Math.min(rect.width, 220),
      h: Math.min(rect.height, 140),
    };
  }

  function fitDeskPx(box, rect, min) {
    const w = Math.min(rect.width, Math.max(min.w, box.w));
    const h = Math.min(rect.height, Math.max(min.h, box.h));
    return {
      x: Math.min(rect.width - w, Math.max(0, box.x)),
      y: Math.min(rect.height - h, Math.max(0, box.y)),
      w,
      h,
    };
  }

  function snapDeskPx(box, rect) {
    const min = deskMin(rect);
    const snapped = {
      x: Math.round(box.x / DESK_GRID) * DESK_GRID,
      y: Math.round(box.y / DESK_GRID) * DESK_GRID,
      w: Math.max(DESK_GRID * 4, Math.round(box.w / DESK_GRID) * DESK_GRID),
      h: Math.max(DESK_GRID * 4, Math.round(box.h / DESK_GRID) * DESK_GRID),
    };
    return fitDeskPx(snapped, rect, min);
  }

  function deskHits(a, b) {
    return a.x < b.x + b.w + DESK_GAP && b.x < a.x + a.w + DESK_GAP
      && a.y < b.y + b.h + DESK_GAP && b.y < a.y + a.h + DESK_GAP;
  }

  function deskFree(box, placed, selfId, rect) {
    if (box.x < -0.5 || box.y < -0.5 || box.x + box.w > rect.width + 0.5 || box.y + box.h > rect.height + 0.5) return false;
    for (const id of Object.keys(placed)) {
      if (id === selfId) continue;
      if (deskHits(box, placed[id])) return false;
    }
    return true;
  }

  function nearestFree(box, placed, selfId, rect) {
    if (deskFree(box, placed, selfId, rect)) return box;
    const maxR = Math.ceil(Math.max(rect.width, rect.height) / DESK_GRID);
    for (let radius = 1; radius <= maxR; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const ys = Math.abs(dx) === radius ? null : [-radius, radius];
        const dyStart = ys ? 0 : -radius;
        const dyEnd = ys ? 1 : radius;
        for (let k = dyStart; k <= dyEnd; k += 1) {
          const dy = ys ? ys[k] : k;
          const candidate = { ...box, x: box.x + dx * DESK_GRID, y: box.y + dy * DESK_GRID };
          if (candidate.x < -0.5 || candidate.y < -0.5 || candidate.x + candidate.w > rect.width + 0.5 || candidate.y + candidate.h > rect.height + 0.5) continue;
          if (deskFree(candidate, placed, selfId, rect)) return candidate;
        }
      }
    }
    return null;
  }

  function layoutToPx(layout, rect) {
    const out = {};
    for (const id of Object.keys(layout)) {
      const box = layout[id];
      out[id] = {
        x: box.x / 100 * rect.width,
        y: box.y / 100 * rect.height,
        w: box.w / 100 * rect.width,
        h: box.h / 100 * rect.height,
      };
    }
    return out;
  }

  /** 内容越多权重越高。空面板也留一块，避免被挤没。 */
  function deskContentWeights({ running, recent, events, completions, notes, agenda }) {
    const text = (events || []).reduce((sum, item) => sum + String(item.body || "").length + String(item.title || "").length, 0);
    return {
      monitor: 4 + running * 3 + Math.min(completions || 0, 8),
      recent: 3 + (recent || 0),
      feed: 4 + (events || []).length * 2 + Math.round(text / 160),
      notes: 3 + Math.round(String(notes || "").length / 100),
      agenda: 3 + (agenda || 0) * 2,
    };
  }

  /** 按权重分到两列，列内高度按内容比例分完。 */
  function autoDeskLayout(weights, rect) {
    const width = rect && rect.width > 40 ? rect.width : 1000;
    const height = rect && rect.height > 40 ? rect.height : 700;
    const gap = 8;
    const minH = Math.min(120, Math.floor((height - gap * 2) / 3));
    const cols = [{ ids: [], weight: 0 }, { ids: [], weight: 0 }];
    const ranked = DESK_ORDER.slice().sort((a, b) => (weights[b] || 1) - (weights[a] || 1));
    for (const id of ranked) {
      const col = cols[0].weight <= cols[1].weight ? cols[0] : cols[1];
      col.ids.push(id);
      col.weight += weights[id] || 1;
    }
    const px = {};
    const colW = (width - gap) / 2;
    cols.forEach((col, index) => {
      col.ids.sort((a, b) => DESK_ORDER.indexOf(a) - DESK_ORDER.indexOf(b));
      const n = col.ids.length;
      if (!n) return;
      const room = height - gap * (n - 1);
      const total = col.ids.reduce((sum, id) => sum + (weights[id] || 1), 0);
      let heights = col.ids.map((id) => Math.max(minH, ((weights[id] || 1) / total) * room));
      const sum = heights.reduce((a, b) => a + b, 0);
      if (sum > room) {
        const over = sum - room;
        const flex = heights.map((h) => Math.max(0, h - minH));
        const flexSum = flex.reduce((a, b) => a + b, 0);
        heights = flexSum > 0
          ? heights.map((h, i) => h - over * (flex[i] / flexSum))
          : heights.map(() => room / n);
      } else if (sum < room) {
        const extra = room - sum;
        heights = heights.map((h, i) => h + extra * ((weights[col.ids[i]] || 1) / total));
      }
      heights[n - 1] += room - heights.reduce((a, b) => a + b, 0);
      let y = 0;
      col.ids.forEach((id, i) => {
        px[id] = { x: index === 0 ? 0 : colW + gap, y, w: colW, h: Math.max(1, heights[i]) };
        y += heights[i] + gap;
      });
    });
    return layoutToPct(px, { width, height });
  }

  function layoutToPct(px, rect) {
    const out = {};
    for (const id of Object.keys(px)) {
      const box = px[id];
      out[id] = {
        x: Math.round((box.x / rect.width) * 1000) / 10,
        y: Math.round((box.y / rect.height) * 1000) / 10,
        w: Math.round((box.w / rect.width) * 1000) / 10,
        h: Math.round((box.h / rect.height) * 1000) / 10,
      };
    }
    return out;
  }

  /** 把正在拖的模块吸到细网格上，并把它碰到的模块推开，直到没有重叠。 */
  function settleDesk(layout, focusId, rect, mode) {
    if (!rect || rect.width < 40 || rect.height < 40) return layout;
    const px = layoutToPx(layout, rect);
    const ids = Object.keys(px);
    const placed = {};
    ids.forEach((id) => { placed[id] = snapDeskPx(px[id], rect); });
    const parked = {};
    ids.forEach((id) => { parked[id] = placed[id]; });
    if (focusId && placed[focusId]) {
      const others = { ...parked };
      delete others[focusId];
      const desired = snapDeskPx(px[focusId], rect);
      if (mode === "resize") {
        let box = desired;
        for (const id of Object.keys(others)) {
          if (!deskHits(box, others[id])) continue;
          const other = others[id];
          if (box.x < other.x) box = { ...box, w: Math.max(deskMin(rect).w, other.x - DESK_GAP - box.x) };
          if (box.y < other.y) box = { ...box, h: Math.max(deskMin(rect).h, other.y - DESK_GAP - box.y) };
        }
        placed[focusId] = snapDeskPx(fitDeskPx(box, rect, deskMin(rect)), rect);
      } else {
        placed[focusId] = desired;
      }
    }
    for (let pass = 0; pass < ids.length + 2; pass += 1) {
      let pending = false;
      for (const id of ids) {
        if (focusId && id === focusId) continue;
        if (deskFree(placed[id], placed, id, rect)) continue;
        pending = true;
        const spot = nearestFree(placed[id], placed, id, rect);
        if (spot) placed[id] = spot;
      }
      if (!pending) break;
    }
    if (focusId && !deskFree(placed[focusId], placed, focusId, rect)) {
      ids.forEach((id) => { if (id !== focusId) placed[id] = parked[id]; });
      const others = { ...placed };
      delete others[focusId];
      placed[focusId] = nearestFree(placed[focusId], others, focusId, rect) || parked[focusId];
    }
    return layoutToPct(placed, rect);
  }

  function DeskFrame({ id, box, title, count, active, onMove, onResize, children }) {
    return h(
      "section",
      {
        className: "desk-panel" + (id === "feed" ? " desk-feed" : "") + (active ? " is-active" : ""),
        style: { left: box.x + "%", top: box.y + "%", width: box.w + "%", height: box.h + "%" },
      },
      h(
        "header",
        { className: "desk-hd", onPointerDown: (event) => onMove(id, event), title: "拖动标题栏。会对齐细网格，并推开挡住的模块" },
        h("h2", null, title),
        count != null ? h("span", null, String(count)) : null,
      ),
      children,
      h("button", {
        className: "desk-resize",
        type: "button",
        "aria-label": "调整大小",
        title: "拖动这里改大小",
        onPointerDown: (event) => onResize(id, event),
      }),
    );
  }

  function DeskHome({ events, hidden, completions, status, onClear, onRestore, onDelete, onOpen }) {
    const desk = useDesk();
    const boardRef = useRef(null);
    const [layout, setLayout] = useState(loadDeskLayout);
    const [agendaCount, setAgendaCount] = useState(0);
    const [noteText, setNoteText] = useState(() => {
      try { return window.localStorage.getItem("mcca.board.notes") || ""; } catch { return ""; }
    });
    const [activeId, setActiveId] = useState("");
    useEffect(() => {
      try { window.localStorage.setItem(DESK_LAYOUT_KEY, JSON.stringify(layout)); } catch { /* 记不住就只在这一次里有效 */ }
    }, [layout]);
    const begin = (id, mode, event) => {
      if (event.button != null && event.button !== 0) return;
      const board = boardRef.current;
      if (!board) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = board.getBoundingClientRect();
      const origin = { ...layout[id] };
      const startX = event.clientX;
      const startY = event.clientY;
      setActiveId(id);
      const target = event.currentTarget;
      if (target.setPointerCapture) target.setPointerCapture(event.pointerId);
      const move = (ev) => {
        const dx = ((ev.clientX - startX) / rect.width) * 100;
        const dy = ((ev.clientY - startY) / rect.height) * 100;
        const next = mode === "move"
          ? { ...origin, x: origin.x + dx, y: origin.y + dy }
          : { ...origin, w: origin.w + dx, h: origin.h + dy };
        setLayout((prev) => settleDesk({ ...prev, [id]: next }, id, rect, mode));
      };
      const end = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", end);
        target.removeEventListener("pointercancel", end);
        setActiveId("");
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", end);
      target.addEventListener("pointercancel", end);
    };
    const runningCount = ((desk && desk.running) || []).length;
    const recentCount = ((desk && desk.recent) || []).filter((row) => !row.running).length;
    const arrange = () => {
      const rect = boardRef.current ? boardRef.current.getBoundingClientRect() : null;
      setLayout(autoDeskLayout(deskContentWeights({
        running: runningCount,
        recent: recentCount,
        events,
        completions: (completions || []).length,
        notes: noteText,
        agenda: agendaCount,
      }), rect));
    };
    return h(
      "div",
      { className: "board-desk", ref: boardRef },
      h(DeskFrame, { id: "monitor", box: layout.monitor, title: "任务完成监控", count: runningCount, active: activeId === "monitor", onMove: (id, event) => begin(id, "move", event), onResize: (id, event) => begin(id, "resize", event) },
        h(TaskMonitor, { desk, completions, status, onOpen })),
      h(DeskFrame, { id: "recent", box: layout.recent, title: "最近任务", count: recentCount, active: activeId === "recent", onMove: (id, event) => begin(id, "move", event), onResize: (id, event) => begin(id, "resize", event) },
        h(RecentTasks, { desk, onOpen })),
      h(DeskFrame, { id: "feed", box: layout.feed, title: "信息推送", count: events.length, active: activeId === "feed", onMove: (id, event) => begin(id, "move", event), onResize: (id, event) => begin(id, "resize", event) },
        h("div", { className: "desk-bd" }, h(EventBoard, { events, hidden, onClear, onRestore, onDelete }))),
      h(DeskFrame, { id: "notes", box: layout.notes, title: "记事本", count: noteText.trim() ? noteText.trim().length : null, active: activeId === "notes", onMove: (id, event) => begin(id, "move", event), onResize: (id, event) => begin(id, "resize", event) },
        h("div", { className: "desk-bd" }, h(Notepad, { onText: setNoteText }))),
      h(DeskFrame, { id: "agenda", box: layout.agenda, title: "事件安排", count: agendaCount || null, active: activeId === "agenda", onMove: (id, event) => begin(id, "move", event), onResize: (id, event) => begin(id, "resize", event) },
        h("div", { className: "desk-bd" }, h(Agenda, { onCount: setAgendaCount }))),
      h("button", {
        className: "desk-layout-reset",
        type: "button",
        title: "按现在的内容量重新排：内容多的模块占更大",
        onClick: arrange,
      }, "自动布局"),
    );
  }

  // ── 消耗面板：pi / dsh 的 token 用量（按 服务商 · 模型） ──────────
  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(Math.round(v));
  }

  function UsageSection({ title, hint, data, loading }) {
    const models = (data && data.models) || [];
    const totals = (data && data.totals) || {};
    const shown = (n) => fmtTok((Number(n) || 0));
    return h(
      "div",
      { className: "mg-section usage-card" },
      h("div", { className: "mg-title" },
        h("h2", null, title),
        hint ? h("span", { className: "count" }, hint) : null),
      models.length === 0
        ? h("div", { className: "usage-empty" }, loading ? "读取中…" : "暂无数据")
        : h(
            "table",
            { className: "usage-table" },
            h("thead", null, h("tr", null,
              h("th", null, "服务商"),
              h("th", null, "模型"),
              h("th", { className: "num" }, "调用"),
              h("th", { className: "num" }, "输入"),
              h("th", { className: "num" }, "输出"),
              h("th", { className: "num" }, "缓存"),
              h("th", { className: "num" }, "合计"))),
            h("tbody", null,
              models.map((m) => h("tr", { key: `${m.provider || ""}/${m.modelId || ""}` },
                h("td", { className: "prov" }, m.provider || "-"),
                h("td", { className: "model", title: m.modelId || "" }, m.modelId || "-"),
                h("td", { className: "num" }, String(m.calls || 0)),
                h("td", { className: "num" }, shown((m.input || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0))),
                h("td", { className: "num" }, shown(m.output)),
                h("td", { className: "num" }, shown(m.cacheRead)),
                h("td", { className: "num strong" }, shown(m.total)))),
              h("tr", { className: "total-row" },
                h("td", null, "合计"),
                h("td", null, `${models.length} 个模型`),
                h("td", { className: "num" }, String(totals.calls || 0)),
                h("td", { className: "num" }, shown((totals.input || 0) + (totals.cacheRead || 0) + (totals.cacheWrite || 0))),
                h("td", { className: "num" }, shown(totals.output)),
                h("td", { className: "num" }, shown(totals.cacheRead)),
                h("td", { className: "num strong" }, shown(totals.total)))),
          ),
    );
  }

  function UsagePanel({ data, loading, onRefresh }) {
    const pi = (data && data.pi) || null;
    const dsh = (data && data.dsh) || null;
    const short = (ts) => (ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }).slice(5, 16) : "-");
    return h(
      "div",
      { className: "usage-wrap" },
      h(UsageSection, {
        title: "pi",
        hint: pi ? `${pi.sessions} 个会话 · 最近 ${short(pi.lastAt)}` : "",
        data: pi,
        loading,
      }),
      h(UsageSection, {
        title: "dsh",
        hint: dsh ? `${dsh.sessions} 个会话目录 · 统计更新 ${short(dsh.updatedAt)}` : "",
        data: dsh,
        loading,
      }),
      data && data.error ? h("div", { className: "usage-note" }, `用量读取失败：${data.error}`) : null,
      h("div", { className: "usage-note" }, "pi 的用量扫自会话文件里 provider 回报的 usage；dsh 的用量来自它自己的 token 统计（tok-heatmap.json）。「输入」列含缓存读写。"),
    );
  }

  function NativeNotificationPanel({ state, busy, onTrigger }) {
    return h(
      "div",
      { className: "mg-section" },
      h(
        "div",
        { className: "mg-title" },
        h("h2", null, "原生通知"),
        h("span", { className: "count" }, nativeNotificationLabel(state.permission)),
        h("span", { className: "spacer" }),
        h(
          "button",
          { className: "proc-btn primary", disabled: busy || !state.supported, onClick: onTrigger },
          busy ? "发送中…" : state.permission === "granted" ? "发送测试" : "启用并测试",
        ),
      ),
      h(
        "div",
        { className: "card-desc", style: { whiteSpace: "normal" } },
        state.supported
          ? "点击后请求系统通知权限并发送一条原生通知弹窗；dsh / pi 启停成功时也会推送。"
          : "当前环境不支持原生通知。",
      ),
    );
  }

  const MEMORY_TYPE_LABEL = {
    user: "用户偏好",
    feedback: "反馈",
    feature: "功能",
    project: "项目",
    reference: "参考",
  };

  function MemoryPanel() {
    const [data, setData] = useState(null);
    const [scope, setScope] = useState("feature");
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
      setLoading(true);
      try {
        const result = await api("/api/memory");
        if (!result || !result.ok) throw new Error(result?.error || "读取记忆失败");
        setData(result);
        setError("");
      } catch (e) {
        setError(e.message || "读取记忆失败");
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      load();
      const timer = setInterval(load, 30000);
      return () => clearInterval(timer);
    }, [load]);

    const feature = data?.feature || [];
    const project = data?.project || [];
    const active = scope === "feature" ? feature : project;
    const needle = query.trim().toLowerCase();
    const visible = active.filter((item) => !needle || `${item.title} ${item.description} ${item.body}`.toLowerCase().includes(needle));
    const maxItems = data?.maxItems || 100;
    const countWidth = (items) => `${Math.min(100, Math.round((items.length / maxItems) * 100))}%`;
    const typeCounts = active.reduce((counts, item) => {
      counts[item.type] = (counts[item.type] || 0) + 1;
      return counts;
    }, {});

    return h(
      "div",
      { className: "mg-section memory-panel" },
      h(
        "div",
        { className: "memory-panel-head" },
        h(
          "div",
          null,
          h("p", null, data?.enabled === false ? "记忆功能已关闭" : "长期记忆按功能与当前项目分开保存"),
        ),
        h("button", { className: "proc-btn", onClick: load, disabled: loading }, loading ? "刷新中…" : "刷新"),
      ),
      error
        ? h("div", { className: "memory-error" }, error)
        : data?.enabled === false
          ? h("div", { className: "memory-empty" }, "请在 config/memory.json 中开启记忆功能")
          : h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "memory-stats" },
                h("div", { className: "memory-stat is-feature" }, h("span", null, "功能记忆"), h("strong", null, String(feature.length)), h("small", null, "跨项目")),
                h("div", { className: "memory-stat is-project" }, h("span", null, "项目记忆"), h("strong", null, String(project.length)), h("small", null, "当前工作区")),
                h("div", { className: "memory-stat" }, h("span", null, "总容量"), h("strong", null, `${feature.length + project.length}`), h("small", null, `每区最多 ${maxItems} 条`)),
              ),
              h(
                "div",
                { className: "memory-viz" },
                h("div", { className: "memory-viz-row" }, h("span", null, "功能记忆"), h("div", { className: "memory-meter" }, h("i", { style: { width: countWidth(feature) } })), h("b", null, String(feature.length))),
                h("div", { className: "memory-viz-row" }, h("span", null, "项目记忆"), h("div", { className: "memory-meter project" }, h("i", { style: { width: countWidth(project) } })), h("b", null, String(project.length))),
              ),
              h(
                "div",
                { className: "memory-toolbar" },
                h(
                  "div",
                  { className: "memory-tabs", role: "tablist", "aria-label": "记忆范围" },
                  h("button", { role: "tab", "aria-selected": String(scope === "feature"), className: scope === "feature" ? "is-active" : "", onClick: () => { setScope("feature"); setOpen(null); } }, `功能记忆 ${feature.length}`),
                  h("button", { role: "tab", "aria-selected": String(scope === "project"), className: scope === "project" ? "is-active" : "", onClick: () => { setScope("project"); setOpen(null); } }, `项目记忆 ${project.length}`),
                ),
                h("input", { className: "memory-search", placeholder: "搜索标题、描述或正文…", value: query, onChange: (e) => setQuery(e.target.value) }),
              ),
              h(
                "div",
                { className: "memory-types" },
                Object.entries(typeCounts).map(([type, count]) => h("span", { key: type }, h("i", null), MEMORY_TYPE_LABEL[type] || type, " ", count)),
              ),
              h(
                "div",
                { className: "memory-list" },
                visible.length
                  ? visible.map((item) => {
                      const isOpen = open === `${scope}:${item.name}`;
                      return h(
                        "article",
                        { className: "memory-item" + (isOpen ? " is-open" : ""), key: item.name },
                        h(
                          "button",
                          { className: "memory-item-head", onClick: () => setOpen(isOpen ? null : `${scope}:${item.name}`) },
                          h("span", { className: "memory-item-title" }, item.title),
                          h("span", { className: "badge memory-type" }, MEMORY_TYPE_LABEL[item.type] || item.type),
                          h("span", { className: "memory-item-date" }, item.created ? new Date(item.created).toLocaleDateString("zh-CN") : ""),
                          h("span", { className: "memory-chevron" }, isOpen ? "⌃" : "⌄"),
                        ),
                        h("div", { className: "memory-item-desc" }, item.description),
                        isOpen ? h("div", { className: "memory-item-body" }, item.body || "（没有正文）") : null,
                      );
                    })
                  : h("div", { className: "memory-empty" }, needle ? "没有匹配的记忆" : `暂无${scope === "feature" ? "功能" : "项目"}记忆`),
              ),
            ),
    );
  }

  function fmtMb(bytes) { return (bytes / 1048576).toFixed(0) + " MB"; }
  function fmtGb(bytes) { return (bytes / 1073741824).toFixed(1) + " GB"; }
  function fmtRate(bps) {
    if (!bps || bps < 1024) return Math.round(bps || 0) + " B/s";
    if (bps < 1048576) return (bps / 1024).toFixed(1) + " KB/s";
    return (bps / 1048576).toFixed(1) + " MB/s";
  }

  function ResRow({ label, appText, sysText, appPct, sysPct }) {
    return h(
      "div",
      { className: "res-row" },
      h(
        "div",
        { className: "res-head" },
        h("span", { className: "res-label" }, label),
        h("span", { className: "res-vals" }, "应用 " + appText + " · 系统 " + sysText),
      ),
      h(
        "div",
        { className: "res-bar" },
        h("i", { className: "res-fill sys", style: { width: Math.max(0, Math.min(100, sysPct)) + "%" } }),
        h("i", { className: "res-fill app", style: { width: Math.max(0, Math.min(100, appPct)) + "%" } }),
      ),
    );
  }

  function ProcessExplorer({ active, sort, onSort }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [filter, setFilter] = useState("");
    const [pending, setPending] = useState(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const load = useCallback(async () => {
      const next = await api("/api/resources");
      if (!next.ok) throw new Error(next.error || "读取失败");
      setData(next); setError("");
    }, []);
    useEffect(() => {
      if (!active) return;
      let alive = true, timer;
      const tick = async () => {
        try { if (alive) await load(); } catch (e) { if (alive) setError(e.message); }
        if (alive) timer = setTimeout(tick, 2500);
      };
      tick();
      return () => { alive = false; clearTimeout(timer); };
    }, [active, load]);
    const groups = { "pi-web": "pi / 工具", "codex-cli": "Codex", "openhands-web": "OpenHands", "grok-web": "Grok Build", "hermes-web": "Hermes Agent", mobile: "手机桥接", canvas: "画布", dsh: "dsh", desktop: "桌面界面", portal: "门户" };
    const visible = (data?.processes || []).filter((p) => !/^conhost(\.exe)?$/i.test(p.name || "") && !/^conhost(\.exe)?$/i.test(p.label || ""));
    const rows = visible.filter((p) => `${p.name} ${p.label} ${p.detail || ""} ${p.pid} ${groups[p.group] || p.group}`.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => (b[sort] || 0) - (a[sort] || 0) || a.pid - b.pid);
    function confirmText(item) {
      const row = item.row;
      if (item.action === "reload") return "会重新加载所有界面，请先保存未发送的输入；后台任务继续运行。";
      if (item.action === "restart") return "将重启" + (groups[row.group] || row.group) + "整个服务及其工具，进行中的任务会中断。";
      if (["gpu", "network", "storage", "crashpad", "utility"].includes(row.kind)) return "只结束这个界面子进程。WebView 一般会自己再拉起；页面如果卡住，再用「重新加载界面」。";
      if (row.service && row.pid === row.rootPid) return "将结束该服务及其子进程，进行中的任务会中断。";
      return "只结束这个进程及其子进程，所属服务继续运行。";
    }
    async function execute() {
      const action = pending.action;
      setBusy(true); setNotice("");
      try {
        if (action === "reload") { location.reload(); return; }
        const r = await api("/api/resource-process", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pid: pending.row.pid, started: pending.row.started, action }) });
        if (!r.ok) throw new Error(r.error || "操作失败");
        setNotice(action === "restart" ? "所属服务已重新启动" : "已结束进程");
        setPending(null);
        await load();
      } catch (e) { setError(e.message); } finally { setBusy(false); }
    }
    return h("div", { className: "process-explorer" },
      h("div", { className: "mg-head" }, h("h1", null, "资源明细"),
        h("span", { className: "sub" }, "应用进程 · 每 2.5 秒更新"),
        h("button", { className: "usage-refresh", onClick: () => load().catch(e => setError(e.message)) }, "刷新")),
      h("div", { className: "process-summary" },
        h("div", null, h("small", null, "应用内存"), h("strong", null, data ? fmtMb(data.memApp) : "—")),
        h("div", null, h("small", null, "应用 CPU"), h("strong", null, data ? data.cpuApp.toFixed(1) + "%" : "—")),
        h("div", null, h("small", null, "系统内存"), h("strong", null, data ? Math.round(data.memUsed / data.memTotal * 100) + "%" : "—")),
        h("div", null, h("small", null, "应用进程"), h("strong", null, data ? visible.length : "—"))),
      h("div", { className: "process-toolbar" },
        h("input", { value: filter, onChange: e => setFilter(e.target.value), placeholder: "筛选名称、所属服务或 PID", "aria-label": "筛选进程" }),
        h("span", null, "结束只作用于这一行；重启会重开整个所属服务。内存为工作集，CPU 按整机总算力计。")),
      error ? h("p", { className: "process-error", role: "alert" }, error) : null,
      notice ? h("p", { role: "status" }, notice) : null,
      data && !data.processes ? h("p", { role: "alert" }, "门户服务需要重启后才能提供进程明细。") : null,
      h("div", { className: "process-table-wrap" }, h("table", { className: "process-table" },
        h("thead", null, h("tr", null,
          h("th", null, "进程 / 用途"), h("th", null, "所属服务"), h("th", null, "PID / 父 PID"),
          h("th", { "aria-sort": sort === "cpu" ? "descending" : "none" }, h("button", { onClick: () => onSort("cpu") }, "CPU" + (sort === "cpu" ? " ↓" : ""))),
          h("th", { "aria-sort": sort === "memory" ? "descending" : "none" }, h("button", { onClick: () => onSort("memory") }, "内存" + (sort === "memory" ? " ↓" : ""))),
          h("th", null, "操作"))),
        h("tbody", null, rows.map(row => h("tr", { key: `${row.pid}:${row.started}` },
          h("td", null, h("strong", null, row.label), h("small", { title: row.detail || row.name }, row.detail || row.name)),
          h("td", null, groups[row.group] || row.group), h("td", { className: "numeric" }, row.pid + " / " + (row.parentPid || "—")),
          h("td", { className: "numeric" }, row.cpu.toFixed(1) + "%"),
          h("td", { className: "numeric", title: "私有提交内存 " + fmtMb(row.privateMemory) }, fmtMb(row.memory)),
          h("td", { className: "process-actions" },
            row.canStop ? h("button", { className: "danger", disabled: busy, onClick: () => setPending({ row, action: "stop" }) }, "结束") : null,
            row.canRestart ? h("button", { disabled: busy, onClick: () => setPending({ row, action: "restart" }) }, "重启") : null,
            row.canReload ? h("button", { disabled: busy, onClick: () => setPending({ row, action: "reload" }) }, "重新加载界面") : null,
            !row.canStop && !row.canReload && !row.canRestart ? h("small", null, "结束会退出整个应用") : null))))),
        data?.processes && !rows.length ? h("p", null, "没有匹配的进程") : null),
      pending ? h("div", { className: "process-confirm", role: "dialog", "aria-modal": "true", "aria-label": "确认进程操作" },
        h("div", null, h("h2", null, pending.action === "restart" ? "重启所属服务？" : pending.action === "reload" ? "重新加载界面？" : "结束进程？"),
          h("p", null, `${pending.row.label} · PID ${pending.row.pid}`),
          h("p", null, confirmText(pending)),
          h("button", { disabled: busy, onClick: () => setPending(null) }, "取消"),
          h("button", { className: pending.action === "stop" ? "danger" : "", disabled: busy, onClick: execute }, busy ? "处理中…" : "确认"))) : null);
  }

  function ResourcePanel({ active }) {
    const [data, setData] = useState(null);
    const [failed, setFailed] = useState("");
    const [open, setOpen] = useState(true);
    useEffect(() => {
      if (!active) return undefined;
      let alive = true;
      const tick = async () => {
        try {
          const d = await api("/api/resources");
          if (!alive) return;
          setData(d);
          setFailed(d.ok ? "" : d.error || "探测失败");
        } catch (e) {
          if (alive) setFailed(String(e.message || e));
        }
      };
      tick();
      const timer = setInterval(tick, 2500);
      return () => { alive = false; clearInterval(timer); };
    }, [active]);
    const d = data && data.ok ? data : null;
    return h(
      "div",
      { className: "mg-section res-panel" },
      h(
        "div",
        { className: "mg-title" },
        h("h2", null, "资源监控"),
        h("span", { className: "count" }, d ? d.procCount + " 进程" : "…"),
        h("span", { className: "spacer" }),
        h("button", { className: "proc-btn", onClick: () => setOpen(!open) }, open ? "收起" : "展开"),
      ),
      open
        ? d
          ? h(
              "div",
              { className: "res-body" },
              h(ResRow, {
                label: "CPU",
                appText: d.cpuApp.toFixed(1) + "%",
                sysText: d.cpuTotal.toFixed(1) + "%",
                appPct: d.cpuApp,
                sysPct: d.cpuTotal,
              }),
              h(ResRow, {
                label: "内存",
                appText: fmtMb(d.memApp),
                sysText: fmtGb(d.memUsed) + " / " + fmtGb(d.memTotal),
                appPct: d.memTotal ? (d.memApp / d.memTotal) * 100 : 0,
                sysPct: d.memTotal ? (d.memUsed / d.memTotal) * 100 : 0,
              }),
              h(
                "div",
                { className: "res-row" },
                h(
                  "div",
                  { className: "res-head" },
                  h("span", { className: "res-label" }, "网络"),
                  h("span", { className: "res-vals" }, "↓ " + fmtRate(d.netDown) + " · ↑ " + fmtRate(d.netUp)),
                ),
                h("div", { className: "res-sub" }, "应用活动连接 " + d.netConns + " 个（含 dsh / pi）"),
              ),
            )
          : h("div", { className: "res-body" }, h("div", { className: "res-sub" }, failed || "正在读取系统资源…"))
        : null,
    );
  }
  // ── Theme (dark default · persisted · FOUC-safe via index.html) ─

  function readTheme() {
    try {
      const saved = localStorage.getItem("mcca-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {}
    try {
      return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch (e) {}
    return "dark";
  }

  function useTheme() {
    const [theme, setTheme] = useState(readTheme);
    useEffect(() => {
      document.documentElement.dataset.theme = theme;
      try {
        localStorage.setItem("mcca-theme", theme);
      } catch (e) {}
    }, [theme]);
    return [theme, setTheme];
  }

  // ── Process cards ────────────────────────────────────────────────

  function ProcessCard({ agent, label, status, installed, cliCount, update, updateBusy, onStart, onStop, onRestart, onInstall, onUninstall, onCheckUpdate, onResident }) {
    const [showLog, setShowLog] = useState(false);
    const [armed, setArmed] = useState(false);
    useEffect(() => {
      if (!armed) return undefined;
      const timer = setTimeout(() => setArmed(false), 5000);
      return () => clearTimeout(timer);
    }, [armed]);
    // 容错：某个进程还没出现在 /api/status 里（例如服务端进程是旧版）时，
    // 不能让整页崩掉——之前 `status.port` 直接抛错 = 整个壳白屏。
    const info = status || {};
    const present = installed !== false;
    const running = Boolean(info.running) || (Boolean(info.cli) && cliCount > 0);
    const actions = [];
    if (armed && present) {
      actions.push(h("button", {
        className: "proc-btn remove is-armed",
        title: "再确认一次。只移出列表，不删程序，之后可以安装回来",
        onClick: () => { setArmed(false); onUninstall(); },
      }, "确认卸载"));
      actions.push(h("button", { className: "proc-btn", onClick: () => setArmed(false) }, "取消"));
    } else if (!present) {
      actions.push(h("button", { className: "proc-btn primary", onClick: onInstall }, "安装"));
      if (running) actions.push(h("button", { className: "proc-btn stop", onClick: onStop }, "停止"));
    } else {
      actions.push(h("button", { className: "proc-btn", onClick: () => setShowLog(!showLog) }, showLog ? "收起日志" : "运行日志"));
      if (info.cli) actions.push(h("button", { className: "proc-btn primary", onClick: onStart }, "打开终端"));
      else if (!running) actions.push(h("button", { className: "proc-btn primary", onClick: onStart }, "启动"));
      actions.push(h("button", { className: "proc-btn", onClick: onRestart }, "重启"));
      actions.push(h("button", { className: "proc-btn stop", onClick: onStop }, "停止"));
      if (onResident && !info.cli) {
        const on = Boolean(info.resident);
        actions.push(h("button", {
          className: "proc-btn" + (on ? " primary" : ""),
          title: on
            ? (info.residentPaused ? "常驻中，但这一轮被手动停掉了：下次门户启动会再拉起" : "常驻中：门户启动自动拉起，进程死了自动重启")
            : "常驻：门户启动时自动拉起，异常退出自动重启；关掉窗口不影响它",
          onClick: () => onResident(!on),
        }, on ? "常驻中" : "常驻"));
      }
      if (update) {
        actions.push(h("button", {
          className: "proc-btn",
          disabled: updateBusy,
          title: update.line || "",
          onClick: () => onCheckUpdate(update),
        }, update.canUpdate ? "更新" : (updateBusy ? "检查中" : "检查更新")));
      }
      actions.push(h("button", {
        className: "proc-btn remove",
        title: "移出列表，不删除程序文件",
        onClick: () => setArmed(true),
      }, "卸载"));
    }
    return h(
      "div",
      { className: "proc-wrap" + (present ? "" : " is-off") },
      h(
        "div",
        { className: "proc-card" },
        h("span", { className: "proc-dot" + (running ? " on" : "") }),
        h("span", { className: "proc-name" }, label || agent),
        h(
          "div",
          { className: "proc-meta" },
          h(
            "span",
            { className: "proc-state" + (running ? " ok" : "") },
            !present && !running ? "未安装" : info.cli ? "命令行" : running ? "运行中" : "已停止",
          ),
          h(
            "span",
            { className: "proc-detail" },
            armed
              ? "再确认一次。只移出列表，不删程序，之后可以安装回来"
              : info.cli
              ? (cliCount > 0 ? `本页已有 ${cliCount} 个终端` : "在本页终端里运行")
              : !present
              ? "已移出列表。点安装加回来"
              : running
                ? `pid ${info.pid} · 127.0.0.1:${info.port}`
                : `端口 ${info.port ?? "—"} · 待启动`,
          ),
        ),
        h("div", { className: "proc-actions" }, actions),
      ),
      present && !running && status?.lastExit
        ? h(
            "div",
            { className: "proc-crash", title: (status.lastExit.logTail || []).join("\n") },
            `上次异常退出（code ${status.lastExit.code ?? "null"} · ${new Date(status.lastExit.at).toLocaleTimeString()}）——悬停看日志尾巴`,
          )
        : null,
      present && showLog
        ? h(
            "div",
            { className: "log-shell" },
            h("div", { className: "log-bar" }, h("span", { className: "log-title" }, `${label || agent} 运行日志`), h("span", { className: "log-hint" }, "最近 40 行")),
            h("pre", { className: "log-view" }, status?.log?.length ? status.log.slice(-40).join("\n") : "还没有运行记录"),
          )
        : null,
    );
  }

  // ── Plugin manager ───────────────────────────────────────────────

  function PluginManager({ plugins, onToggle, toast }) {
    const [filter, setFilter] = useState("all");
    const [query, setQuery] = useState("");

    const kinds = ["all", "tool", "command", "mcp", "skill", "ui", "host"];
    const filtered = plugins.filter((p) => {
      if (filter === "on" && !(p.enabled.ds || p.enabled.pi)) return false;
      if (filter === "off" && p.enabled.ds && p.enabled.pi) return false;
      if (filter !== "all" && filter !== "on" && filter !== "off" && p.kind !== filter) return false;
      if (query && !(p.name + " " + p.description).toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });

    return h(
      "div",
      { className: "mg-section" },
      h(
        "div",
        { className: "chips" },
        h(Chip, { active: filter === "all", onClick: () => setFilter("all") }, "全部"),
        h(Chip, { active: filter === "on", onClick: () => setFilter("on") }, "启用中"),
        h(Chip, { active: filter === "off", onClick: () => setFilter("off") }, "已停用"),
        ["tool", "command", "mcp", "skill", "ui", "host"].map((k) =>
          h(Chip, { key: k, active: filter === k, onClick: () => setFilter(k) }, KIND_LABEL[k]),
        ),
      ),
      h("input", {
        className: "mg-search",
        placeholder: "搜索插件名或描述…",
        value: query,
        onChange: (e) => setQuery(e.target.value),
      }),
      h(
        "div",
        { className: "card-list" },
        filtered.length === 0
          ? h("div", { className: "empty-hint" }, "没有匹配的插件")
          : filtered.map((p) =>
              h(
                "div",
                { className: "card" + (p.enabled.ds || p.enabled.pi ? "" : " is-off"), key: p.name },
                h(
                  "div",
                  { className: "card-main" },
                  h(
                    "div",
                    { className: "card-name" },
                    p.name,
                    h("span", { className: "badge kind-" + p.kind }, KIND_LABEL[p.kind] || p.kind),
                    p.surface && p.surface !== "shared"
                      ? h("span", { className: "badge", title: "挂载面" }, SURFACE_LABEL[p.surface] || p.surface)
                      : null,
                    h("span", { className: "badge" }, "v" + p.version),
                  ),
                  p.description ? h("div", { className: "card-desc", title: p.description }, p.description) : null,
                ),
                h(
                  "div",
                  { className: "switches" },
                  h(AgentSwitch, {
                    agent: "ds",
                    label: "dsh",
                    on: p.enabled.ds,
                    disabled: !p.targets.includes("ds"),
                    onChange: () => onToggle(p, "ds", !p.enabled.ds, toast),
                  }),
                  h(AgentSwitch, {
                    agent: "pi",
                    label: "pi",
                    on: p.enabled.pi,
                    disabled: !p.targets.includes("pi"),
                    onChange: () => onToggle(p, "pi", !p.enabled.pi, toast),
                  }),
                ),
              ),
            ),
      ),
    );
  }

  // ── MCP manager ──────────────────────────────────────────────────

  function McpManager({ servers, onToggle, onDelete, onAdd, toast }) {
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState({ serverName: "", transport: "stdio", command: "", args: "", url: "" });

    async function submit() {
      if (!form.serverName.trim()) return toast("需要 serverName");
      const payload = {
        serverName: form.serverName.trim(),
        transport: form.transport,
        dsh: true,
      };
      if (form.transport === "stdio") {
        payload.command = form.command.trim();
        payload.args = form.args.split(/\s+/).filter(Boolean);
        if (!payload.command) return toast("stdio 需要命令");
      } else {
        payload.url = form.url.trim();
        if (!payload.url) return toast("SSE 需要 URL");
      }
      const r = await onAdd(payload);
      if (r.ok) {
        toast(`MCP ${payload.serverName} 已保存`);
        setForm({ serverName: "", transport: "stdio", command: "", args: "", url: "" });
        setAdding(false);
      } else {
        toast(r.error || "保存失败");
      }
    }

    return h(
      "div",
      { className: "mg-section" },
      h(
        "div",
        { className: "lib-tools" },
        h("button", { className: "proc-btn", onClick: () => setAdding(!adding) }, adding ? "取消" : "添加"),
      ),
      adding
        ? h(
            "div",
            { className: "add-form" },
            h("input", { placeholder: "名称（如 github）", value: form.serverName, onChange: (e) => setForm({ ...form, serverName: e.target.value }) }),
            h(
              "select",
              { value: form.transport, onChange: (e) => setForm({ ...form, transport: e.target.value }) },
              h("option", { value: "stdio" }, "stdio"),
              h("option", { value: "sse" }, "SSE / HTTP"),
            ),
            form.transport === "stdio"
              ? [
                  h("input", { key: "cmd", placeholder: "命令（如 npx）", value: form.command, onChange: (e) => setForm({ ...form, command: e.target.value }) }),
                  h("input", { key: "args", placeholder: "参数（空格分隔）", value: form.args, onChange: (e) => setForm({ ...form, args: e.target.value }) }),
                ]
              : h("input", { key: "url", placeholder: "https://…/mcp", value: form.url, onChange: (e) => setForm({ ...form, url: e.target.value }) }),
            h("button", { className: "go", onClick: submit }, "保存"),
          )
        : null,
      h(
        "div",
        { className: "card-list" },
        servers.length === 0
          ? h("div", { className: "empty-hint" }, "还没有 MCP 服务器 — 点「添加」注册一个")
          : servers.map((s) => {
              const dsOff = Boolean(s.disabledDs);
              const piOff = Boolean(s.disabledPi);
              return h(
                "div",
                { className: "card" + (dsOff && piOff ? " is-off" : ""), key: s.serverName },
                h(
                  "div",
                  { className: "card-main" },
                  h(
                    "div",
                    { className: "card-name" },
                    s.serverName,
                    h("span", { className: "badge kind-mcp" }, s.transport),
                  ),
                  h(
                    "div",
                    { className: "card-desc" },
                    s.transport === "stdio" ? [s.command, ...(s.args || [])].join(" ") : s.url,
                  ),
                ),
                h(
                  "div",
                  { className: "switches" },
                  h(AgentSwitch, { agent: "ds", label: "dsh", on: !dsOff, onChange: () => onToggle(s, "ds", dsOff, toast) }),
                  h(AgentSwitch, { agent: "pi", label: "pi", on: !piOff, onChange: () => onToggle(s, "pi", piOff, toast) }),
                ),
                h(
                  "button",
                  {
                    className: "icon-btn",
                    title: "删除",
                    onClick: () => {
                      if (window.confirm(`删除 MCP 服务器 ${s.serverName}？`)) onDelete(s.serverName, toast);
                    },
                  },
                  "✕",
                ),
              );
            }),
      ),
    );
  }

  // ── Skill manager ────────────────────────────────────────────────

  function SkillManager({ skills, onDelete }) {
    return h(
      "div",
      { className: "mg-section" },
      h("p", { className: "lib-note" }, "两侧共享，放入 skills/ 即生效"),
      h(
        "div",
        { className: "card-list" },
        skills.length === 0
          ? h("div", { className: "empty-hint" }, "暂无技能")
          : skills.map((s) =>
              h(
                "div",
                { className: "card", key: s.name },
                h(
                  "div",
                  { className: "card-main" },
                  h(
                    "div",
                    { className: "card-name" },
                    s.name,
                    h("span", { className: "badge kind-skill" }, "技能"),
                  ),
                  s.description ? h("div", { className: "card-desc", title: s.description }, s.description) : null,
                ),
                h(
                  "button",
                  {
                    className: "icon-btn",
                    title: "删除",
                    onClick: () => {
                      if (window.confirm(`删除技能 ${s.name}？两侧都会失效。`)) onDelete(s.name);
                    },
                  },
                  "✕",
                ),
              ),
            ),
      ),
    );
  }

  // ── Canvas (image-generation service) ────────────────────────────

  const CANVAS_URL_KEY = "mcca-canvas-url";

  // Researched open-source projects backing this tab, ranked for this setup:
  // the agent (dsh/pi) must be able to call them too — HTTP API or MCP first,
  // install kept simple. `port` is the service's default local port.
  const CANVAS_PROJECTS = [
    {
      name: "stable-diffusion.cpp",
      desc: "单文件 + GGUF 模型，不装 Python/torch；OpenAI 兼容 /v1 API 一行 curl 生图，自带 WebUI",
      url: "https://github.com/leejet/stable-diffusion.cpp",
      port: 1234,
      api: "OpenAI 兼容 API",
    },
    {
      name: "ComfyUI + Comfy MCP",
      desc: "官方 MCP（本地连接全开源），dsh/pi 经 mcp.json 挂上即得生图工具；节点 UI 可嵌入画布",
      url: "https://docs.comfy.org/agent-tools/mcp",
      port: 8188,
      api: "官方 MCP",
    },
    {
      name: "SwarmUI",
      desc: "表单式界面 + ComfyUI 后端，带 REST API；新手友好，需要时可切节点视图",
      url: "https://github.com/mcmonkeyprojects/SwarmUI",
      port: 7801,
      api: "REST API",
    },
    {
      name: "SD WebUI Forge",
      desc: "经典 A1111 界面低显存优化版，--api 启用 /sdapi/v1 接口，插件生态最全",
      url: "https://github.com/lllyasviel/stable-diffusion-webui-forge",
      port: 7860,
      api: "A1111 兼容 API",
    },
  ];

  // ComfyUI's default port — the canvas auto-connects here when the user has
  // not pinned an explicit service URL yet.
  const CANVAS_DEFAULT_URL = "http://127.0.0.1:8188";

  function readCanvasUrl() {
    try {
      return localStorage.getItem(CANVAS_URL_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  /** Reachability probe: a no-cors fetch resolves (opaque) when something is listening. */
  function probeCanvas(url) {
    return fetch(url + "/system_stats", { mode: "no-cors", cache: "no-store" })
      .then(() => true)
      .catch(() => false);
  }

  function CanvasFrame({ hidden, status, onStart, onStop }) {
    // `saved` is the user's pinned URL; `auto` probes the ComfyUI default when
    // nothing is pinned (undefined = probing, true = default reachable).
    const [saved, setSaved] = useState(readCanvasUrl);
    const [auto, setAuto] = useState(undefined);
    const [formOpen, setFormOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const [reloadKey, setReloadKey] = useState(0);

    // The panel stays mounted across tab switches. While the tab is visible and
    // nothing is connected, re-probe the default service every 10s — so a
    // ComfyUI started (or restarted) later reconnects on its own, no reload.
    useEffect(() => {
      if (saved || hidden) return;
      let live = true;
      const probe = () => {
        probeCanvas(CANVAS_DEFAULT_URL).then((ok) => {
          if (live) setAuto(ok ? CANVAS_DEFAULT_URL : "");
        });
      };
      probe();
      const t = setInterval(probe, 10000);
      return () => {
        live = false;
        clearInterval(t);
      };
    }, [saved, hidden]);

    const url = saved || auto || "";
    const checking = !saved && auto === undefined;
    const running = Boolean(status?.running);

    function connect(next) {
      const clean = String(next || "").trim().replace(/\/+$/, "");
      try {
        localStorage.setItem(CANVAS_URL_KEY, clean);
      } catch (e) {}
      setSaved(clean);
      setDraft(clean);
      setFormOpen(false);
      setReloadKey((k) => k + 1);
    }

    function openForm() {
      setDraft(url);
      setFormOpen(true);
    }

    const formView = h(
      "div",
      { className: "hero-empty canvas-empty" },
      h("div", { className: "hero-mark", "aria-hidden": true }, "画"),
      h("div", { className: "hero-title" }, checking ? "正在探测本地生图服务…" : "画布未连接"),
      checking
        ? h("div", { className: "hero-desc" }, `正在探测 ${CANVAS_DEFAULT_URL} …`)
        : h(
            "div",
            { className: "hero-desc" },
            running
              ? "本地画布服务运行中，正在等待就绪…"
              : "填入本地生图服务的地址即可内嵌到这里；本机画布服务（ComfyUI）也可以直接一键启动：",
          ),
      checking
        ? null
        : h(
            "div",
            { className: "canvas-connect" },
            running
              ? h("button", { className: "primary", onClick: onStart }, "重试连接本机画布服务")
              : h("button", { className: "primary", onClick: onStart }, "启动本机画布服务（ComfyUI :8188）"),
          ),
      checking
        ? null
        : h(
            "div",
            { className: "canvas-connect" },
            h("input", {
              className: "canvas-input",
              placeholder: CANVAS_DEFAULT_URL,
              value: draft,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter") connect(draft);
              },
            }),
            h("button", { className: "primary", onClick: () => connect(draft) }, "连接"),
            url ? h("button", { className: "proc-btn", onClick: () => setFormOpen(false) }, "取消") : null,
          ),
      checking
        ? null
        : h(
            "div",
            { className: "canvas-recs" },
            CANVAS_PROJECTS.map((p) =>
              h(
                "div",
                { className: "canvas-rec", key: p.name },
                h(
                  "div",
                  { className: "canvas-rec-main" },
                  h(
                    "div",
                    { className: "canvas-rec-name" },
                    h("a", { href: p.url, target: "_blank", rel: "noreferrer" }, p.name),
                    p.api ? h("span", { className: "badge kind-mcp" }, p.api) : null,
                    h("span", { className: "badge kind-tool" }, `默认端口 ${p.port}`),
                  ),
                  h("div", { className: "canvas-rec-desc" }, p.desc),
                ),
                h("button", { className: "proc-btn", title: "连接到该默认端口", onClick: () => connect(`http://127.0.0.1:${p.port}`) }, "用这个"),
              ),
            ),
          ),
    );

    // Persistent wrapper: the panel stays mounted for the whole portal session
    // (same keep-alive contract as AgentFrame), so the embedded ComfyUI iframe
    // and its loaded workflow survive tab switches — `hidden` only toggles CSS.
    const cls = "canvas-root" + (hidden ? " is-hidden" : "");
    if (formOpen || checking || !url) return h("div", { className: cls }, formView);

    return h(
      "div",
      { className: cls },
      h(
        "div",
        { className: "canvas-shell" },
      h(
        "div",
        { className: "canvas-bar" },
        h("span", { className: "canvas-url", title: url }, url),
        h("span", { className: "spacer" }),
        h("button", { className: "proc-btn", onClick: () => setReloadKey((k) => k + 1) }, "刷新"),
        h("button", { className: "proc-btn", onClick: () => window.open(url, "_blank") }, "新窗口打开"),
        h("button", { className: "proc-btn", onClick: openForm }, "改地址"),
        running
          ? h("button", { className: "proc-btn stop", title: "停止本机 ComfyUI 进程（正在生成的任务会中断）", onClick: onStop }, "停止服务")
          : h("button", { className: "proc-btn primary", onClick: onStart }, "启动服务"),
      ),
      h("div", { className: "canvas-body" }, h("iframe", { key: reloadKey, src: url + "/", title: "画布" })),
      ),
    );
  }

  const IDE_IDS = ["dsh", "pi"];
  const CLI_IDS = ["codex", "openhands", "grok", "hermes"];
  const CLI_NAME = { codex: "Codex", openhands: "OpenHands", grok: "Grok Build", hermes: "Hermes Agent" };

  function pageFromHash(hash) {
    const id = String(hash || "").replace(/^#\//, "");
    if (["board", "resources", "manage", "usage", "canvas"].concat(IDE_IDS, CLI_IDS).includes(id)) return id;
    return "board";
  }

  function readLastPage(key, fallback, allowed) {
    try {
      const value = localStorage.getItem(key);
      if (allowed.includes(value)) return value;
    } catch { /* ignore */ }
    return fallback;
  }

  function rollPage(list, current, delta) {
    if (!list.length) return current;
    const at = list.indexOf(current);
    const step = delta > 0 ? 1 : -1;
    return list[(Math.max(0, at) + step + list.length) % list.length];
  }

  function sidePages(list, current) {
    if (list.length < 2) return { above: null, below: null };
    const at = Math.max(0, list.indexOf(current));
    return {
      above: list[(at - 1 + list.length) % list.length],
      below: list[(at + 1) % list.length],
    };
  }

  function workspaceName(cwd) {
    const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || "";
  }

  function cliLabel(session, sessions) {
    const folder = workspaceName(session.cwd);
    const base = folder ? `${session.title} · ${folder}` : session.title;
    const same = sessions.filter((item) => item.title === session.title && item.cwd === session.cwd);
    if (same.length < 2) return base;
    return `${base} ${same.findIndex((item) => item.id === session.id) + 1}`;
  }

  function CliPane({ id, active, onExit }) {
    const hostRef = useRef(null);
    const termRef = useRef(null);
    const fitRef = useRef(null);
    const activeRef = useRef(active);
    activeRef.current = active;

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return undefined;
      let dead = false;
      let term = null;
      let fit = null;
      let source = null;
      let observer = null;

      function paintTheme() {
        if (!term) return;
        const cs = getComputedStyle(document.documentElement);
        term.options.theme = {
          background: cs.getPropertyValue("--code-bg").trim(),
          foreground: cs.getPropertyValue("--code-fg").trim(),
          cursor: cs.getPropertyValue("--accent").trim(),
          selectionBackground: cs.getPropertyValue("--accent-soft").trim() || undefined,
        };
      }

      (async () => {
        try {
          const xtermMod = await import("/vendor/xterm.js");
          const fitMod = await import("/vendor/addon-fit.js");
          if (dead) return;
          term = new xtermMod.Terminal({
            cursorBlink: false,
            fontFamily: 'Cascadia Mono, Consolas, "Microsoft YaHei UI", monospace',
            fontSize: 13,
            lineHeight: 1.15,
            scrollback: 5000,
          });
          fit = new fitMod.FitAddon();
          term.loadAddon(fit);
          term.open(host);
          paintTheme();
          termRef.current = term;
          fitRef.current = fit;
          const pushSize = () => {
            if (dead || !fit) return;
            try { fit.fit(); } catch { /* host not measurable yet */ }
          };
          term.onResize(({ cols, rows }) => {
            fetch(`/api/pty/${id}/resize`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ cols, rows }),
            }).catch(() => {});
          });
          term.onData((data) => {
            fetch(`/api/pty/${id}/input`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ data }),
            }).catch(() => {});
          });
          requestAnimationFrame(() => requestAnimationFrame(pushSize));
          observer = new ResizeObserver(() => pushSize());
          observer.observe(host);
          source = new EventSource(`/api/pty/${id}/stream`);
          source.onmessage = (ev) => {
            try { term.write(JSON.parse(ev.data)); } catch { /* malformed frame */ }
          };
          source.addEventListener("exit", () => {
            term.write("\r\n\x1b[90m[进程已退出]\x1b[0m\r\n");
            if (onExit) onExit(id);
          });
          if (activeRef.current) term.focus();
        } catch (error) {
          if (!dead) host.textContent = error.message || "终端组件没加载出来";
        }
      })();

      const themeObs = new MutationObserver(paintTheme);
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => {
        dead = true;
        themeObs.disconnect();
        if (observer) observer.disconnect();
        if (source) source.close();
        if (term) term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, [id]);

    useEffect(() => {
      if (!active) return undefined;
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return undefined;
      try { fit.fit(); } catch { /* still opening */ }
      term.focus();
      return undefined;
    }, [active]);

    return h("div", { ref: hostRef, className: "cli-host" + (active ? " is-active" : "") });
  }

  function cliWhen(ms) {
    const n = Number(ms);
    if (!n) return "";
    const diff = Date.now() - n;
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
    const date = new Date(n);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function CliHistory({ tool, onOpen }) {
    const [rows, setRows] = useState([]);
    const [filter, setFilter] = useState("");
    const [err, setErr] = useState("");
    const [busyId, setBusyId] = useState("");
    const agent = { openhands: "openhands-web", grok: "grok-web", hermes: "hermes-web" }[tool];

    useEffect(() => {
      let alive = true;
      setRows([]);
      setErr("");
      setFilter("");
      if (!agent) return undefined;
      (async () => {
        try {
          const data = await api(`/api/cli-history/${agent}`);
          if (!alive) return;
          if (!data || data.ok === false) setErr((data && data.error) || "读不到对话列表");
          else setRows(Array.isArray(data.sessions) ? data.sessions : []);
        } catch (error) {
          if (alive) setErr(error.message || "读不到对话列表");
        }
      })();
      return () => { alive = false; };
    }, [agent]);

    async function remove(row) {
      const title = row.title || row.id;
      if (!window.confirm(`删除「${title}」？删掉后找不回来。`)) return;
      setBusyId(row.id);
      setErr("");
      try {
        const data = await api(`/api/cli-history/${agent}/${encodeURIComponent(row.id)}`, { method: "DELETE" });
        if (!data || data.ok === false) setErr((data && data.error) || "删除失败");
        else setRows((prev) => prev.filter((item) => item.id !== row.id));
      } catch (error) {
        setErr(error.message || "删除失败");
      } finally {
        setBusyId("");
      }
    }

    const needle = filter.trim().toLowerCase();
    const shown = needle
      ? rows.filter((row) => `${row.title} ${row.workspace} ${row.cwd}`.toLowerCase().includes(needle))
      : rows;

    return h(
      "aside",
      { className: "cli-history", "aria-label": "对话列表" },
      h(
        "div",
        { className: "cli-history-head" },
        h("span", null, "对话列表"),
        h("input", {
          type: "search",
          value: filter,
          placeholder: "搜索",
          "aria-label": "搜索对话列表",
          onChange: (event) => setFilter(event.target.value),
        }),
      ),
      err
        ? h("div", { className: "cli-history-empty" }, err)
        : h(
            "ul",
            null,
            shown.length
              ? shown.map((row) => h(
                  "li",
                  { key: row.id },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "cli-history-open",
                      title: row.cwd || row.title,
                      onClick: () => onOpen(row),
                    },
                    h("span", { className: "cli-history-title" }, row.title || row.id),
                    h(
                      "span",
                      { className: "cli-history-meta" },
                      [row.workspace, cliWhen(row.updatedAt)].filter(Boolean).join(" · "),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "cli-history-del",
                      title: "删除这条对话",
                      disabled: busyId === row.id,
                      onClick: () => remove(row),
                    },
                    "×",
                  ),
                ))
              : h("li", { className: "cli-history-empty" }, needle ? "没有匹配的对话" : "还没有对话"),
          ),
    );
  }

  const PROVIDER_APIS = [
    ["openai-completions", "OpenAI 对话"],
    ["openai-responses", "OpenAI Responses"],
    ["anthropic-messages", "Anthropic"],
    ["google-generative-ai", "Google"],
  ];

  function blankProvider() {
    return { id: "", api: "openai-completions", baseUrl: "", apiKey: "", modelsText: "", renameFrom: "" };
  }

  function CliProvider({ tool }) {
    const [providers, setProviders] = useState([]);
    const [choice, setChoice] = useState(null);
    const [open, setOpen] = useState(false);
    const [manage, setManage] = useState(false);
    const [draft, setDraft] = useState(blankProvider);
    const [note, setNote] = useState("");
    const boxRef = useRef(null);
    const load = useCallback(async () => {
      try {
        const data = await api("/api/cli-providers");
        if (!data || data.ok === false) return;
        setProviders(Array.isArray(data.providers) ? data.providers : []);
        setChoice((data.selection && data.selection[tool]) || null);
      } catch { /* 门户还没起来时面板先空着 */ }
    }, [tool]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
      if (!open) return undefined;
      const onDown = (event) => {
        if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
      };
      const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onDown);
        document.removeEventListener("keydown", onKey);
      };
    }, [open]);
    const current = choice && providers.find((row) => row.id === choice.provider);
    const modelName = current && (current.models.find((row) => row.id === choice.modelId) || {}).name;
    const label = current ? `${current.id} · ${modelName || choice.modelId}` : "选择服务商";
    const pick = async (provider, modelId) => {
      setNote("");
      try {
        const data = await api(`/api/cli-providers/${encodeURIComponent(tool)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, modelId }),
        });
        if (!data || data.ok === false) {
          setNote((data && data.error) || "没有保存");
          return;
        }
        setChoice((data.selection && data.selection[tool]) || null);
        setOpen(false);
        setManage(false);
      } catch (error) {
        setNote(error.message || "没有保存");
      }
    };
    const editOf = (row) => ({
      id: row ? row.id : "",
      api: (row && row.api) || "openai-completions",
      baseUrl: (row && row.baseUrl) || "",
      apiKey: "",
      modelsText: row ? row.models.map((model) => model.id).join("\n") : "",
      renameFrom: row ? row.id : "",
    });
    const saveDraft = async () => {
      setNote("");
      const id = draft.id.trim();
      const models = draft.modelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map((modelId) => ({ id: modelId, name: modelId }));
      try {
        const data = await api(`/api/cli-providers/catalog/${encodeURIComponent(id || "draft")}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            renameFrom: draft.renameFrom && draft.renameFrom !== id ? draft.renameFrom : undefined,
            api: draft.api,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey,
            models,
          }),
        });
        if (!data || data.ok === false) {
          setNote((data && data.error) || "没有保存");
          return;
        }
        if (Array.isArray(data.providers)) setProviders(data.providers);
        setDraft(editOf((data.providers || []).find((row) => row.id === id)));
        setNote("已保存");
      } catch (error) {
        setNote(error.message || "没有保存");
      }
    };
    const removeDraft = async () => {
      const id = draft.renameFrom || draft.id.trim();
      if (!id) return;
      setNote("");
      try {
        const data = await api(`/api/cli-providers/catalog/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!data || data.ok === false) {
          setNote((data && data.error) || "没有删掉");
          return;
        }
        if (Array.isArray(data.providers)) setProviders(data.providers);
        setDraft(blankProvider());
        if (choice && choice.provider === id) setChoice(null);
        setNote("已删除");
      } catch (error) {
        setNote(error.message || "没有删掉");
      }
    };
    const pullModels = async () => {
      setNote("");
      try {
        const data = await api("/api/cli-providers/discover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: draft.renameFrom || draft.id, baseUrl: draft.baseUrl, apiKey: draft.apiKey }),
        });
        const models = (data && data.models) || [];
        if (!data || data.ok === false || !models.length) {
          setNote((data && data.error) || "没有取到模型");
          return;
        }
        const had = new Set(draft.modelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
        for (const model of models) if (model.id) had.add(model.id);
        setDraft((prev) => ({ ...prev, modelsText: [...had].join("\n") }));
        setNote(`取到 ${models.length} 个模型`);
      } catch (error) {
        setNote(error.message || "没有取到模型");
      }
    };
    return h(
      "div",
      { className: "cli-provider" + (open ? " is-open" : ""), ref: boxRef },
      h("button", {
        type: "button",
        className: "cli-provider-btn",
        title: "选择这个命令行用的服务商和模型",
        "aria-expanded": String(open),
        onClick: () => setOpen((value) => !value),
      }, label),
      open
        ? h(
            "div",
            { className: "cli-provider-menu", role: "menu" },
            manage
              ? h(
                  "div",
                  { className: "cli-provider-manage" },
                  h("div", { className: "cli-provider-manage-hd" },
                    h("button", { type: "button", className: "proc-btn", onClick: () => { setManage(false); setNote(""); } }, "返回选择"),
                    h("button", { type: "button", className: "proc-btn", onClick: () => { setDraft(blankProvider()); setNote(""); } }, "新建"),
                  ),
                  h("div", { className: "cli-provider-picks" },
                    providers.map((row) => h(
                      "button",
                      {
                        key: row.id,
                        type: "button",
                        className: "cli-provider-model" + (draft.renameFrom === row.id ? " is-on" : ""),
                        onClick: () => { setDraft(editOf(row)); setNote(""); },
                      },
                      row.id,
                    )),
                  ),
                  h("label", { className: "cli-provider-field" }, "名称",
                    h("input", { value: draft.id, onChange: (event) => setDraft((prev) => ({ ...prev, id: event.target.value })) }),
                  ),
                  h("label", { className: "cli-provider-field" }, "协议",
                    h("select", { value: draft.api, onChange: (event) => setDraft((prev) => ({ ...prev, api: event.target.value })) },
                      PROVIDER_APIS.map(([value, text]) => h("option", { key: value, value }, text)),
                    ),
                  ),
                  h("label", { className: "cli-provider-field" }, "API 地址",
                    h("input", { value: draft.baseUrl, placeholder: "https://example/v1", onChange: (event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value })) }),
                  ),
                  h("label", { className: "cli-provider-field" }, "密钥",
                    h("input", { type: "password", value: draft.apiKey, placeholder: draft.renameFrom ? "留空保持原密钥" : "", onChange: (event) => setDraft((prev) => ({ ...prev, apiKey: event.target.value })) }),
                  ),
                  h("label", { className: "cli-provider-field" }, "模型，一行一个",
                    h("textarea", { value: draft.modelsText, rows: 4, onChange: (event) => setDraft((prev) => ({ ...prev, modelsText: event.target.value })) }),
                  ),
                  h("div", { className: "cli-provider-manage-hd" },
                    h("button", { type: "button", className: "proc-btn", onClick: pullModels }, "获取模型"),
                    draft.renameFrom ? h("button", { type: "button", className: "proc-btn stop", onClick: removeDraft }, "删除") : null,
                    h("button", { type: "button", className: "proc-btn primary", onClick: saveDraft }, "保存"),
                  ),
                  note ? h("p", { className: "cli-provider-note" }, note) : null,
                )
              : h(
                  "div",
                  { className: "cli-provider-list" },
                  h("button", { type: "button", className: "cli-provider-manage-btn", onClick: () => { setManage(true); setNote(""); setDraft(current ? editOf(current) : blankProvider()); } }, "管理"),
                  providers.length
                    ? providers.map((row) => h(
                        "div",
                        { key: row.id, className: "cli-provider-group" },
                        h("div", { className: "cli-provider-name" }, row.id),
                        row.models.length
                          ? row.models.map((model) => h(
                              "button",
                              {
                                key: model.id,
                                type: "button",
                                className: "cli-provider-model" + (choice && choice.provider === row.id && choice.modelId === model.id ? " is-on" : ""),
                                onClick: () => pick(row.id, model.id),
                              },
                              model.name || model.id,
                            ))
                          : h("p", { className: "cli-provider-note" }, "还没有模型"),
                      ))
                    : h("p", { className: "cli-provider-note" }, "还没有服务商"),
                  note ? h("p", { className: "cli-provider-note" }, note) : null,
                ),
          )
        : null,
    );
  }

  function CliScreen({ tool, sessions, activeId, onSelect, onClose, onExited, onNewSession, onNewWorkspace, onResume }) {
    const mine = sessions.filter((item) => item.agent === tool);
    const name = CLI_NAME[tool] || tool;
    return h(
      "div",
      { className: "cli-screen is-open" },
      h(CliHistory, { tool, onOpen: onResume }),
      h(
        "div",
        { className: "cli-bar" },
        h(
          "div",
          { className: "cli-tabs", role: "tablist" },
          mine.map((session) => h(
            "span",
            {
              key: session.id,
              role: "tab",
              title: session.cwd || session.title,
              "aria-selected": String(session.id === activeId),
              className: "cli-tab" + (session.id === activeId ? " is-active" : "") + (session.exited ? " is-exited" : ""),
            },
            h("button", { type: "button", className: "cli-tab-name", onClick: () => onSelect(session.id) }, cliLabel(session, mine)),
            h("button", {
              type: "button",
              className: "cli-tab-x",
              title: "删除这个标签",
              "aria-label": "删除",
              onClick: (event) => { event.stopPropagation(); onClose(session.id); },
            }, "×"),
          )),
        ),
        h(
          "div",
          { className: "cli-actions" },
          h("button", { type: "button", className: "proc-btn", title: tool === "hermes" ? "在Hermes Agent的应用内工作区再开一个会话" : "在当前工作区再开一个会话", onClick: onNewSession }, "新窗口"),
          tool === "hermes" ? null : h("button", { type: "button", className: "proc-btn", title: "选一个文件夹，在那里开一个新会话", onClick: onNewWorkspace }, "新工作区"),
          mine.length ? h("button", { type: "button", className: "proc-btn stop", onClick: () => onClose(activeId) }, "结束") : null,
          h(CliProvider, { tool }),
        ),
      ),
      h(
        "div",
        { className: "cli-body" },
        mine.length
          ? h(
              "div",
              { className: "cli-stage" },
              mine.map((session) => h(CliPane, { key: session.id, id: session.id, active: session.id === activeId, onExit: onExited })),
            )
          : h(
              "div",
              { className: "cli-empty" },
              h("div", { className: "hero-title" }, `${name} 还没有会话`),
              h("div", { className: "hero-desc" }, tool === "hermes" ? "会话开在应用内的Hermes Agent工作区" : "新窗口沿用当前工作区，新工作区另选一个文件夹"),
            ),
      ),
    );
  }

  // ── App ──────────────────────────────────────────────────────────

  function App() {
    // Deep-linkable tabs: #/board opens the event board, #/manage the manager.
    const initial = pageFromHash(location.hash);
    const [tab, setTab] = useState(initial);
    const [ide, setIde] = useState(IDE_IDS.includes(initial) ? initial : readLastPage("mcca.lastAgent", "pi", IDE_IDS));
    const [stackOpen, setStackOpen] = useState("");
    const [stackLift, setStackLift] = useState(0);
    const [stackTear, setStackTear] = useState(null);
    const tearTimer = useRef(0);
    const [cliTool, setCliTool] = useState(CLI_IDS.includes(initial) ? initial : readLastPage("mcca.lastCli", "grok", CLI_IDS));
    const wheelAcc = useRef({ ide: 0, cli: 0 });
    const cliCwd = useRef({ codex: "", openhands: "", grok: "", hermes: "" });
    const [resourceSort, setResourceSort] = useState("memory");
    const [resPulse, setResPulse] = useState(null);
    const [resFace, setResFace] = useState(0);
    const [resRoll, setResRoll] = useState(true);
    useEffect(() => {
      let alive = true;
      const tick = async () => {
        try {
          const d = await api("/api/resources");
          if (alive && d && d.ok) setResPulse(d);
        } catch (e) {}
      };
      tick();
      const timer = setInterval(tick, 3000);
      return () => { alive = false; clearInterval(timer); };
    }, []);
    useEffect(() => {
      if (!resPulse) return undefined;
      const timer = setInterval(() => {
        setResRoll(true);
        requestAnimationFrame(() => setResFace((n) => n + 1));
      }, 3000);
      return () => clearInterval(timer);
    }, [Boolean(resPulse)]);
    useEffect(() => {
      if (resFace < 3) return undefined;
      const timer = setTimeout(() => {
        setResRoll(false);
        setResFace(0);
      }, 420);
      return () => clearTimeout(timer);
    }, [resFace]);
    const [theme, setTheme] = useTheme();
    const [status, setStatus] = useState({ dsh: {}, pi: {}, codex: {}, openhands: {}, grok: {}, hermes: {}, canvas: {}, mobile: {} });
    const [plugins, setPlugins] = useState([]);
    const [mcp, setMcp] = useState([]);
    const [skills, setSkills] = useState([]);
    const [libTab, setLibTab] = useState("plugins");
    const [removed, setRemoved] = useState(readRemoved);
    const [forced, setForced] = useState({});
    const [updates, setUpdates] = useState(null);
    const [updateBusy, setUpdateBusy] = useState(false);
    const pushedRemoves = useRef(false);
    const [boardEvents, setBoardEvents] = useState([]); // 信息推送：人工推来的消息
    const [taskEvents, setTaskEvents] = useState([]); // 任务完成/失败的自动播报
    const [boardHidden, setBoardHidden] = useState(0); // 被「清空」挡住、但存档里还在的条数
    const [usage, setUsage] = useState(null); // 「消耗」面板：pi / dsh 用量报表
    const [usageLoading, setUsageLoading] = useState(false);
    const [cli, setCli] = useState({ open: false, active: "", sessions: [] });
    const [toastText, setToastText] = useState("");
    const toastTimer = useRef(null);
    const [nativeNotif, setNativeNotif] = useState({ supported: Boolean(tauriNotificationApi()) || typeof Notification !== "undefined" || Boolean(window.__TAURI__), permission: "default" });
    const [notifBusy, setNotifBusy] = useState(false);

    const syncNativeNotif = useCallback(async () => {
      const s = await getNativeNotificationState().catch(() => ({ supported: false, permission: "unsupported" }));
      setNativeNotif(s);
    }, []);

    useEffect(() => { syncNativeNotif(); }, [syncNativeNotif]);

    async function triggerNativeNotif() {
      setNotifBusy(true);
      try {
        let state = await getNativeNotificationState();
        if (!state.supported) { toast("当前环境不支持原生通知"); return; }
        if (state.permission !== "granted") {
          const granted = await requestNativePermission();
          state = await getNativeNotificationState();
          setNativeNotif(state);
          if (!granted && state.permission !== "granted") {
            toast(state.permission === "denied" ? "通知权限已被拒绝，请在系统设置中允许 mcca 通知" : "未获得系统通知权限");
            return;
          }
        } else { setNativeNotif(state); }
        const sent = await sendNativeNotification("mcca portal", "原生通知工作正常 ✓");
        toast(sent ? "已发送原生通知" : "通知发送失败");
      } finally { setNotifBusy(false); }
    }

    function switchTab(next) {
      setTab(next);
      if (IDE_IDS.includes(next)) {
        setIde(next);
        try { window.localStorage.setItem("mcca.lastAgent", next); } catch { /* 记不住就下次仍进事件板 */ }
      }
      if (CLI_IDS.includes(next)) {
        setCliTool(next);
        try { window.localStorage.setItem("mcca.lastCli", next); } catch { /* ignore */ }
      }
      history.replaceState(null, "", "#/" + next);
    }

    function tearTo(group, keep, place) {
      window.clearTimeout(tearTimer.current);
      setStackTear({ group, keep, place });
      tearTimer.current = window.setTimeout(() => {
        setStackTear(null);
        setStackOpen("");
        setStackLift(0);
        switchTab(keep);
      }, 420);
    }

    function onGroupWheel(event, group, list, current) {
      event.preventDefault();
      wheelAcc.current[group] += event.deltaY || 0;
      if (Math.abs(wheelAcc.current[group]) < 40) return;
      const dir = wheelAcc.current[group];
      wheelAcc.current[group] = 0;
      const next = rollPage(list, current, dir);
      if (next && next !== current) switchTab(next);
    }

    function onTabbarWheel(event) {
      const nav = event.currentTarget;
      if (nav.scrollWidth <= nav.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      nav.scrollLeft += delta;
    }

    const toast = useCallback((text) => {
      setToastText(text);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastText(""), 2200);
    }, []);

    const usageWait = useRef(null);

    /** 「消耗」面板：只在这一页拉取。扫描在独立进程里跑，没算完就隔几秒再问，失败写在面板上。 */
    const loadUsage = useCallback(async () => {
      setUsageLoading(true);
      setUsage((prev) => (prev && prev.error ? { ...prev, error: "" } : prev));
      try {
        const data = await api("/api/usage");
        setUsage(data);
        if (data && data.pending) {
          clearTimeout(usageWait.current);
          usageWait.current = setTimeout(() => { void loadUsage(); }, 2500);
        }
      } catch (e) {
        setUsage((prev) => ({ ...(prev || {}), error: e.message || "读取失败" }));
      } finally {
        setUsageLoading(false);
      }
    }, []);

    useEffect(() => {
      if (tab !== "usage") return undefined;
      void loadUsage();
      return () => clearTimeout(usageWait.current);
    }, [tab, loadUsage]);

    const loadStatus = useCallback(async () => {
      const data = await api("/api/status");
      // Keyed by backend agent id (order-independent): the list now includes
      // the canvas (ComfyUI) instance, and future additions won't shift indexes.
      const byAgent = {};
      for (const a of data.agents || []) byAgent[a.agent] = a;
      setStatus({ dsh: byAgent.dsh, pi: byAgent["pi-web"], codex: byAgent["codex-cli"], openhands: byAgent["openhands-web"], grok: byAgent["grok-web"], hermes: byAgent["hermes-web"], canvas: byAgent.canvas, mobile: byAgent.mobile });
    }, []);

    const loadConfig = useCallback(async () => {
      const [p, m, s] = await Promise.all([api("/api/plugins"), api("/api/mcp"), api("/api/skills")]);
      setPlugins(p.plugins || []);
      setMcp(m.servers || []);
      setSkills(s.skills || []);
    }, []);

    // 任务通知：宿主（dsh / pi）在目标完成或受阻时 POST /api/notify 入队，
    // 这里随状态轮询取走并经 Tauri 发系统通知。首次遇到未授权时申请一次权限
    // 再重试；仍失败则静默（不打断使用）。
    //
    // 游标必须跨刷新存活。只放在内存里时，刷新 portal 会让 since 归零，服务端
    // 积压的历史通知（最多 50 条）就被当成新事件逐条重弹——表现为“一刷新就弹
    // 任务失败”。这里落 localStorage，且首次访问（无游标）静默对齐到队尾。
    const NOTIFY_CURSOR_KEY = "mcca.p…rsor";
    const storedCursor = Number(window.localStorage && window.localStorage.getItem(NOTIFY_CURSOR_KEY));
    const lastNotifyId = useRef(Number.isFinite(storedCursor) && storedCursor > 0 ? storedCursor : null);
    const notifPermissionTried = useRef(false);
    // 事件板「清空」也要跨刷新记住：否则一刷新历史又会从队列里回填上来
    const BOARD_CLEARED_KEY = "mcca.eventboard.cleared";
    const storedCleared = Number(window.localStorage && window.localStorage.getItem(BOARD_CLEARED_KEY));
    const boardClearedUpTo = useRef(Number.isFinite(storedCleared) && storedCleared > 0 ? storedCleared : 0);
    const BOARD_DELETED_KEY = "mcca.eventboard.deleted";
    const deletedIds = useRef(new Set());
    try {
      const storedDeleted = JSON.parse(window.localStorage && window.localStorage.getItem(BOARD_DELETED_KEY) || "[]");
      if (Array.isArray(storedDeleted)) deletedIds.current = new Set(storedDeleted.map(Number).filter((n) => Number.isFinite(n)));
    } catch {
      deletedIds.current = new Set();
    }
    const deleteBoardItem = useCallback((id) => {
      const num = Number(id);
      if (!Number.isFinite(num)) return;
      deletedIds.current.add(num);
      try {
        if (window.localStorage) window.localStorage.setItem(BOARD_DELETED_KEY, JSON.stringify([...deletedIds.current].slice(-2000)));
      } catch {
        // 记不住时至少这一页先消失
      }
      setBoardEvents((prev) => prev.filter((item) => item.id !== num));
      api(`/api/notifications/${num}`, { method: "DELETE" }).catch(() => {});
    }, []);
    const boardSeeded = useRef(false); // 本次会话是否已用落盘存档铺过事件板
    const loadNotificationsRef = useRef(() => {}); // 「恢复显示」要用最新的轮询函数
    const clearBoard = useCallback(() => {
      const newest = boardEvents.length ? Math.max(...boardEvents.map((e) => Number(e.id) || 0)) : 0;
      boardClearedUpTo.current = Math.max(boardClearedUpTo.current, newest, lastNotifyId.current || 0);
      try {
        if (window.localStorage) window.localStorage.setItem(BOARD_CLEARED_KEY, String(boardClearedUpTo.current));
      } catch {
        // 存储被禁用时退化为仅本次会话内清空
      }
      setBoardHidden((prev) => prev + boardEvents.length);
      setBoardEvents([]);
    }, [boardEvents]);
    /** 「恢复显示」：清掉清空游标，重新从存档铺一遍（清空只是本页视图，不是删档）。 */
    const restoreBoard = useCallback(() => {
      boardClearedUpTo.current = 0;
      try {
        if (window.localStorage) window.localStorage.removeItem(BOARD_CLEARED_KEY);
      } catch {
        // 存储不可用：至少本次会话内恢复
      }
      boardSeeded.current = false;
      setBoardHidden(0);
      void loadNotificationsRef.current();
    }, []);
    const loadNotifications = useCallback(async () => {
      const firstLoad = lastNotifyId.current == null;
      let data;
      try {
        // 首次（或刷新后无游标）：从头取，把队列里最近的历史铺到事件板上（但不补弹系统通知）
        data = await api(`/api/notifications?since=${firstLoad ? 0 : lastNotifyId.current}`);
      } catch {
        return; // portal 短暂不可达：下一轮轮询再试，绝不因通知旁路打断界面
      }
      const latest = Number(data.latest) || 0;
      const remember = (value) => {
        lastNotifyId.current = value;
        try {
          if (window.localStorage) window.localStorage.setItem(NOTIFY_CURSOR_KEY, String(value));
        } catch {
          // 存储被禁用（隐私模式等）时退化为本次会话内不重放，不影响功能
        }
      };
      const pushTasks = (items) => {
        const fresh = items.filter((it) => it.kind === "auto");
        if (!fresh.length) return;
        setTaskEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const add = fresh.filter((it) => !seen.has(it.id));
          if (!add.length) return prev;
          return add.reverse().concat(prev).slice(0, 40);
        });
      };
      const pushBoard = (items) => {
        // 事件板只放人工推的（kind !== auto）。宿主自动播报的「任务完成/失败」
        // 照样弹系统通知，但不进板——板子只应出现我要求推的东西。
        const fresh = items.filter((it) => it.id > boardClearedUpTo.current && it.kind !== "auto" && !deletedIds.current.has(it.id));
        if (!fresh.length) return;
        setBoardEvents((prev) => {
          // 存档回放 + 轮询增量可能撞车，按 id 去重，避免同一条出现两次
          const seen = new Set(prev.map((e) => e.id));
          const add = fresh.filter((it) => !seen.has(it.id));
          if (!add.length) return prev;
          return add.reverse().concat(prev).slice(0, 1000);
        });
      };
      if (firstLoad) {
        pushBoard(data.items || []);
        pushTasks(data.items || []);
        remember(latest); // 首次访问：对齐队尾，历史通知不重弹
        return;
      }
      // 存档回放：每次打开事件板都用服务端的落盘归档铺一遍历史（清空游标照旧生效），
      // 否则 portal 一重启，板上就只剩“重启之后”的新事件了
      if (!boardSeeded.current) {
        boardSeeded.current = true;
        try {
          const hist = await api("/api/notifications?since=0");
          const all = hist.items || [];
          // 被「清空」挡住的条数：告诉用户存档还在、可以恢复显示
          setBoardHidden(all.filter((it) => it.kind !== "auto" && it.id <= boardClearedUpTo.current).length);
          pushBoard(all);
          pushTasks(all);
        } catch {
          boardSeeded.current = false; // 失败下次轮询再试
        }
      }
      if (latest < lastNotifyId.current) {
        remember(latest); // portal 重启后序号归零：跟随新序列，否则永远取不到
        return;
      }
      const items = data.items || [];
      if (!items.length) return;
      remember(Math.max(lastNotifyId.current, latest));
      pushBoard(items);
      pushTasks(items);
      for (const item of items) {
        let sent = await sendNativeNotification(item.title, item.body);
        if (!sent && !notifPermissionTried.current) {
          notifPermissionTried.current = true;
          const granted = await requestNativePermission();
          setNativeNotif(await getNativeNotificationState().catch(() => ({ supported: false, permission: "unsupported" })));
          if (granted) sent = await sendNativeNotification(item.title, item.body);
        }
        if (sent) toast(`已推送系统通知：${item.title}`);
      }
    }, [toast]);
    useEffect(() => {
      loadNotificationsRef.current = loadNotifications;
    }, [loadNotifications]);

    useEffect(() => {
      loadStatus();
      loadConfig();
      loadNotifications();
      const timer = setInterval(() => { loadStatus(); loadNotifications(); }, 2000);
      return () => clearInterval(timer);
    }, [loadStatus, loadConfig, loadNotifications]);

    // The process API is keyed by the backend agent id, which can differ
    // from the display label. Resolve the real key from the latest status
    // payload so label renames never break start/stop.
    function updateFor(id) {
      const found = updates && Array.isArray(updates.items) && updates.items.find((row) => row.id === id);
      return found || { id, name: CLI_NAME[id] || id, line: "" };
    }

    function agentKey(agent) {
      const backend = { dsh: "dsh", pi: "pi-web", codex: "codex-cli", openhands: "openhands-web", grok: "grok-web", hermes: "hermes-web", canvas: "canvas" }[agent] || agent;
      return status[agent]?.agent || backend;
    }

    function dropCli(id) {
      setCli((prev) => {
        const sessions = prev.sessions.filter((item) => item.id !== id);
        const active = prev.active === id ? (sessions[sessions.length - 1]?.id || "") : prev.active;
        return { open: sessions.length ? prev.open : false, active, sessions };
      });
    }

    async function closeCli(id) {
      if (!id) return;
      let r;
      try {
        r = await api(`/api/pty/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (error) {
        toast(error.message || "结束失败");
        return;
      }
      if (r && r.ok === false && r.error && !String(r.error).includes("没有这个终端")) {
        toast(r.error);
        return;
      }
      dropCli(id);
    }

    function markCliExited(id) {
      setCli((prev) => ({
        ...prev,
        sessions: prev.sessions.map((item) => item.id === id ? { ...item, exited: true } : item),
      }));
    }

    async function start(agent, cwd, resume) {
      const body = {};
      // grok / openhands 的网页服务可以一直开着。这里开的是旁边的命令行，
      // 不带这个标记会被当成再启一遍网页，弹出 already running。
      if (CLI_IDS.includes(agent)) body.terminal = true;
      if (typeof cwd === "string" && cwd) body.cwd = cwd;
      if (resume) body.resume = resume;
      const hasBody = Object.keys(body).length > 0;
      const r = await api(`/api/process/${agentKey(agent)}/start`, {
        method: "POST",
        headers: hasBody ? { "content-type": "application/json" } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      if (r && r.ptyId) {
        if (r.cwd) cliCwd.current[agent] = r.cwd;
        setCli((prev) => ({
          open: true,
          active: r.ptyId,
          sessions: prev.sessions.concat({ id: r.ptyId, title: r.title || agent, agent, cwd: r.cwd || cwd || "" }),
        }));
        if (CLI_IDS.includes(agent)) switchTab(agent);
        return;
      }
      const note = r.ok ? `${agent} 已启动` : r.error;
      toast(note);
      if (r.ok) sendNativeNotification("mcca portal", note);
      loadStatus();
    }

    function cwdFor(agent) {
      if (agent === "hermes") return "";
      const mine = cli.sessions.filter((item) => item.agent === agent);
      const active = mine.find((item) => item.id === cli.active) || mine[mine.length - 1];
      return active?.cwd || cliCwd.current[agent] || "";
    }

    function newCliWindow(agent) {
      const cwd = cwdFor(agent);
      return start(agent, cwd);
    }

    async function newCliWorkspace(agent) {
      let picked;
      try {
        picked = await api("/api/pick-dir", { method: "POST" });
      } catch (error) {
        toast(error.message || "选不了文件夹");
        return;
      }
      if (!picked || picked.cancelled) return;
      if (!picked.ok || !picked.path) {
        toast((picked && picked.error) || "选不了文件夹");
        return;
      }
      await start(agent, picked.path);
    }

    function resumeCli(agent, row) {
      if (!row || !row.id) return;
      return start(agent, row.cwd || cwdFor(agent), row.id);
    }

    async function stop(agent) {
      const r = await api(`/api/process/${agentKey(agent)}/stop`, { method: "POST" });
      toast(r.ok ? `${agent} 已停止` : r.error || "停止失败");
      if (r.ok) sendNativeNotification("mcca portal", `${agent} 已停止`);
      loadStatus();
    }
    async function restart(agent) {
      toast(`${agent} 重启中…`);
      const r = await api(`/api/process/${agentKey(agent)}/restart`, { method: "POST" });
      toast(r.ok ? `${agent} 已重启` : r.error || "重启失败");
      if (r.ok) sendNativeNotification("mcca portal", `${agent} 已重启`);
      loadStatus();
    }

    async function resident(agent, name, on) {
      const r = await api(`/api/process/${agentKey(agent)}/resident`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      toast(r.ok ? `${name} ${on ? "已常驻：门户启动会自动拉起" : "已取消常驻"}` : r.error || "操作失败");
      loadStatus();
    }

    function instanceOn(agent) {
      if (Object.prototype.hasOwnProperty.call(forced, agent)) return forced[agent];
      const flag = status[agent] && status[agent].installed;
      if (typeof flag === "boolean") return flag;
      return !removed.includes(agent);
    }

    function forceInstall(agent, value) {
      setForced((prev) => ({ ...prev, [agent]: value }));
    }

    function forgetForce(agent) {
      setForced((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, agent)) return prev;
        const next = { ...prev };
        delete next[agent];
        return next;
      });
    }

    function rememberRemoved(agent) {
      setRemoved((prev) => {
        const next = prev.includes(agent) ? prev : prev.concat(agent);
        writeRemoved(next);
        return next;
      });
    }

    function forgetRemoved(agent) {
      setRemoved((prev) => {
        const next = prev.filter((id) => id !== agent);
        writeRemoved(next);
        return next;
      });
    }

    async function install(agent, label) {
      const name = label || agent;
      forceInstall(agent, true);
      forgetRemoved(agent);
      try {
        const r = await api(`/api/process/${agentKey(agent)}/install`, { method: "POST" });
        if (r && r.ok) {
          toast(`${name} 已安装`);
          loadStatus();
          return;
        }
        if (!r || String(r.error || "").includes("unknown action")) {
          toast(`${name} 已装回本页。重启门户后才会记住`);
          return;
        }
        forgetForce(agent);
        toast(r.error || "安装失败");
      } catch (error) {
        forgetForce(agent);
        toast(error.message || "安装失败");
      }
    }

    async function removeInstance(agent, label) {
      const name = label || agent;
      forceInstall(agent, false);
      try {
        const r = await api(`/api/process/${agentKey(agent)}/delete`, { method: "POST" });
        if (r && r.ok) {
          forgetRemoved(agent);
          setCli((prev) => {
            const sessions = prev.sessions.filter((item) => item.agent !== agent);
            const active = sessions.some((item) => item.id === prev.active) ? prev.active : (sessions[sessions.length - 1]?.id || "");
            return { open: sessions.length ? prev.open : false, active, sessions };
          });
          toast(`${name} 已移除`);
          loadStatus();
          return;
        }
        if (r && !String(r.error || "").includes("unknown action")) {
          forgetForce(agent);
          toast(r.error || "移除失败");
          return;
        }
        if (status[agent] && status[agent].running) {
          await api(`/api/process/${agentKey(agent)}/stop`, { method: "POST" });
        }
        rememberRemoved(agent);
        toast(`${name} 已从本页移除。重启门户后才会记住`);
        loadStatus();
      } catch (error) {
        forgetForce(agent);
        toast(error.message || "移除失败");
      }
    }

    async function checkUpdates(quiet) {
      setUpdateBusy(true);
      try {
        const result = await api("/api/updates");
        setUpdates(result);
        if (!quiet && (!result || result.ok === false)) toast((result && result.error) || "检查更新失败");
        return result;
      } catch (error) {
        if (!quiet) toast(error.message || "检查更新失败");
        return null;
      } finally {
        setUpdateBusy(false);
      }
    }

    async function checkOne(item) {
      if (!item) return;
      if (item.canUpdate) {
        await applyUpdate(item);
        return;
      }
      const result = await checkUpdates(true);
      const fresh = result && Array.isArray(result.items) && result.items.find((row) => row.id === item.id);
      if (fresh && fresh.canUpdate) toast(`${fresh.name} 有新版本 ${fresh.latest}`);
      else toast((fresh && fresh.line) || "已是最新");
    }

    async function applyUpdate(item) {
      if (!item || item.id !== "hermes") {
        toast(item && item.line ? item.line : "这个还不能在这里更新");
        return;
      }
      setUpdateBusy(true);
      toast("Hermes Agent安装中，第一次要几分钟");
      try {
        const result = await api("/api/updates/hermes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: item.latest || "" }),
        });
        if (!result || result.ok === false) {
          toast((result && result.error) || "Hermes Agent更新失败");
          return;
        }
        toast(`Hermes Agent已装到 ${result.version || item.latest}`);
        await checkUpdates();
      } catch (error) {
        toast(error.message || "Hermes Agent更新失败");
      } finally {
        setUpdateBusy(false);
      }
    }

    useEffect(() => {
      setForced((prev) => {
        const keys = Object.keys(prev);
        if (!keys.length) return prev;
        let changed = false;
        const next = { ...prev };
        for (const agent of keys) {
          const flag = status[agent] && status[agent].installed;
          if (typeof flag === "boolean" && flag === prev[agent]) {
            delete next[agent];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, [status]);

    useEffect(() => {
      if (pushedRemoves.current) return;
      if (typeof (status.dsh && status.dsh.installed) !== "boolean") return;
      const pending = readRemoved();
      pushedRemoves.current = true;
      if (!pending.length) return;
      (async () => {
        for (const agent of pending) {
          if (status[agent] && status[agent].installed === false) continue;
          const key = { dsh: "dsh", pi: "pi-web", codex: "codex-cli", openhands: "openhands-web", grok: "grok-web", hermes: "hermes-web", canvas: "canvas" }[agent] || agent;
          const r = await api(`/api/process/${status[agent]?.agent || key}/delete`, { method: "POST" });
          if (!r || !r.ok) {
            pushedRemoves.current = false;
            toast((r && r.error) || "没能同步已移除的实例");
            return;
          }
        }
        writeRemoved([]);
        setRemoved([]);
        loadStatus();
      })();
    }, [status.dsh && status.dsh.installed, loadStatus, toast]);

    useEffect(() => {
      if ((tab === "dsh" || tab === "pi" || tab === "canvas") && !instanceOn(tab)) {
        switchTab("board");
      }
    }, [tab, status, removed, forced]);

    async function togglePlugin(p, agent, enabled) {
      // optimistic update, then write through
      setPlugins((prev) =>
        prev.map((x) => (x.name === p.name ? { ...x, enabled: { ...x.enabled, [agent]: enabled } } : x)),
      );
      const r = await api(`/api/plugins/${p.name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, enabled, surface: p.surface || "shared" }),
      });
      if (r.ok) toast(`${p.name} 已在 ${agent === "ds" ? "dsh" : "pi"} 侧${enabled ? "启用" : "停用"}（运行中实例热生效）`);
      else {
        toast(r.error || "操作失败");
        loadConfig();
      }
    }

    async function toggleMcp(s, agent, enabled) {
      const r = await api(`/api/mcp/${s.serverName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, enabled }),
      });
      if (r.ok) {
        toast(`${s.serverName} 已在 ${agent === "ds" ? "dsh" : "pi"} 侧${enabled ? "启用" : "停用"}`);
        loadConfig();
      } else toast(r.error || "操作失败");
    }

    async function deleteMcp(name) {
      const r = await api(`/api/mcp/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete" }),
      });
      if (r.ok) {
        toast(`${name} 已删除`);
        loadConfig();
      } else toast(r.error || "删除失败");
    }

    async function addMcp(payload) {
      return api("/api/mcp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    }

    async function deleteSkill(name) {
      const r = await api(`/api/skills/${name}`, { method: "DELETE" });
      if (r.ok) {
        toast(`${name} 已删除`);
        loadConfig();
      } else toast(r.error || "删除失败");
    }

    // Both agent iframes stay mounted for the whole portal session; switching
    // tabs only toggles their visibility (see AgentFrame / .agent-frames CSS).
    // NOTE: this is a child list — the App return below owns the .content div.
    const content = [
      h(
        "div",
        { key: "frames", className: "agent-frames" },
        h(AgentFrame, { key: "dsh", agent: "dsh", status: status.dsh, onStart: () => start("dsh"), hidden: tab !== "dsh" }),
        h(AgentFrame, { key: "pi", agent: "pi", status: status.pi, onStart: () => start("pi"), hidden: tab !== "pi" }),
      ),
      h(
        "div",
        { key: "manage", className: "manage manage-page" + (tab !== "manage" ? " is-hidden" : "") },
        h(
          "div",
          { className: "mg-head" },
          h("h1", null, "共享资源管理"),
          h("span", { className: "sub" }, "一次配置，dsh 与 pi 同时生效"),
        ),
        h(
          "div",
          { className: "manage-zones" },
          h(
            "section",
            { className: "mg-zone" },
            h("div", { className: "mg-zone-hd" }, h("h2", null, "运行实例")),
            h("div", { className: "mg-instance-layout" },
            h(
              "div",
              { className: "mg-group" },
              h("div", { className: "mg-group-hd" }, h("h3", null, "IDE")),
              h(ProcessCard, { agent: "dsh", label: "dsh", status: status.dsh, installed: instanceOn("dsh"), onStart: () => start("dsh"), onStop: () => stop("dsh"), onRestart: () => restart("dsh"), onInstall: () => install("dsh", "dsh"), onUninstall: () => removeInstance("dsh", "dsh"), onResident: (on) => resident("dsh", "dsh", on) }),
              h(ProcessCard, { agent: "pi", label: "pi", status: status.pi, installed: instanceOn("pi"), onStart: () => start("pi"), onStop: () => stop("pi"), onRestart: () => restart("pi"), onInstall: () => install("pi", "pi"), onUninstall: () => removeInstance("pi", "pi"), onResident: (on) => resident("pi", "pi", on) }),
            ),
            h(
              "div",
              { className: "mg-group" },
              h("div", { className: "mg-group-hd" }, h("h3", null, "CLI")),
              h(ProcessCard, { agent: "codex", label: "Codex", status: status.codex, cliCount: cli.sessions.filter((item) => item.agent === "codex").length, installed: instanceOn("codex"), update: updateFor("codex"), updateBusy, onStart: () => start("codex"), onStop: () => stop("codex"), onRestart: () => restart("codex"), onInstall: () => install("codex", "Codex"), onUninstall: () => removeInstance("codex", "Codex"), onCheckUpdate: checkOne }),
              h(ProcessCard, { agent: "openhands", label: "OpenHands", status: status.openhands, cliCount: cli.sessions.filter((item) => item.agent === "openhands").length, installed: instanceOn("openhands"), update: updateFor("openhands"), updateBusy, onStart: () => start("openhands"), onStop: () => stop("openhands"), onRestart: () => restart("openhands"), onInstall: () => install("openhands", "OpenHands"), onUninstall: () => removeInstance("openhands", "OpenHands"), onCheckUpdate: checkOne }),
              h(ProcessCard, { agent: "grok", label: "Grok Build", status: status.grok, cliCount: cli.sessions.filter((item) => item.agent === "grok").length, installed: instanceOn("grok"), update: updateFor("grok"), updateBusy, onStart: () => start("grok"), onStop: () => stop("grok"), onRestart: () => restart("grok"), onInstall: () => install("grok", "Grok Build"), onUninstall: () => removeInstance("grok", "Grok Build"), onCheckUpdate: checkOne }),
              h(ProcessCard, { agent: "hermes", label: "Hermes Agent", status: status.hermes, cliCount: cli.sessions.filter((item) => item.agent === "hermes").length, installed: instanceOn("hermes"), update: updateFor("hermes"), updateBusy, onStart: () => start("hermes"), onStop: () => stop("hermes"), onRestart: () => restart("hermes"), onInstall: () => install("hermes", "Hermes Agent"), onUninstall: () => removeInstance("hermes", "Hermes Agent"), onCheckUpdate: checkOne }),
            ),
            h(
              "div",
              { className: "mg-group" },
              h("div", { className: "mg-group-hd" }, h("h3", null, "扩展")),
              h(ProcessCard, { agent: "canvas", label: "画布", status: status.canvas, installed: instanceOn("canvas"), onStart: () => start("canvas"), onStop: () => stop("canvas"), onRestart: () => restart("canvas"), onInstall: () => install("canvas", "画布"), onDelete: () => removeInstance("canvas", "画布"), onResident: (on) => resident("canvas", "画布", on) }),
              h(ProcessCard, { agent: "mobile", label: "手机接入", status: status.mobile, installed: instanceOn("mobile"), onStart: () => start("mobile"), onStop: () => stop("mobile"), onRestart: () => restart("mobile"), onInstall: () => install("mobile", "手机接入"), onDelete: () => removeInstance("mobile", "手机接入"), onResident: (on) => resident("mobile", "手机接入", on) }),
            ),
            ),
          ),
          h(
            "section",
            { className: "mg-zone" },
            h("div", { className: "mg-zone-hd" }, h("h2", null, "通知")),
            h(NativeNotificationPanel, { state: nativeNotif, busy: notifBusy, onTrigger: triggerNativeNotif }),
          ),
          h(
            "section",
            { className: "mg-zone" },
            h(
              "div",
              { className: "mg-zone-hd" },
              h(
                "div",
                { className: "lib-tabs", role: "tablist", "aria-label": "插件、MCP、技能" },
                h("button", { role: "tab", "aria-selected": String(libTab === "plugins"), className: "lib-tab" + (libTab === "plugins" ? " is-active" : ""), onClick: () => setLibTab("plugins") }, "插件", h("span", null, String(plugins.length))),
                h("button", { role: "tab", "aria-selected": String(libTab === "mcp"), className: "lib-tab" + (libTab === "mcp" ? " is-active" : ""), onClick: () => setLibTab("mcp") }, "MCP", h("span", null, String(mcp.length))),
                h("button", { role: "tab", "aria-selected": String(libTab === "skills"), className: "lib-tab" + (libTab === "skills" ? " is-active" : ""), onClick: () => setLibTab("skills") }, "技能", h("span", null, String(skills.length))),
              ),
            ),
            libTab === "plugins" ? h(PluginManager, { plugins, onToggle: togglePlugin, toast }) : null,
            libTab === "mcp" ? h(McpManager, { servers: mcp, onToggle: toggleMcp, onDelete: deleteMcp, onAdd: addMcp, toast }) : null,
            libTab === "skills" ? h(SkillManager, { skills, onDelete: deleteSkill }) : null,
          ),
          h(
            "section",
            { className: "mg-zone memory-zone" },
            h("div", { className: "mg-zone-hd" }, h("h2", null, "记忆")),
            h(MemoryPanel),
          ),
        ),
      ),
      h(
        "div",
        { key: "board", className: "manage board-page" + (tab !== "board" ? " is-hidden" : "") },
        h(DeskHome, {
          events: boardEvents,
          hidden: boardHidden,
          completions: taskEvents,
          status,
          onClear: clearBoard,
          onRestore: restoreBoard,
          onDelete: deleteBoardItem,
          onOpen: switchTab,
        }),
      ),
      h(
        "div",
        { key: "usage", className: "manage usage-page" + (tab !== "usage" ? " is-hidden" : "") },
        h(
          "div",
          { className: "mg-head" },
          h("h1", null, "消耗"),
          h("span", { className: "sub" }, "pi / dsh 的 token 用量（服务商 · 模型）"),
          h("span", { className: "usage-when" }, usage && usage.at
            ? `更新于 ${new Date(usage.at).toLocaleTimeString("zh-CN", { hour12: false })}（60 秒缓存）`
            : "还没读取"),
          h("button", { className: "usage-refresh", onClick: () => loadUsage(true), disabled: usageLoading }, usageLoading ? "读取中…" : "刷新"),
        ),
        h(UsagePanel, { data: usage, loading: usageLoading, onRefresh: () => loadUsage(true) }),
      ),
      h("div", { key: "resources", className: "manage resources-page" + (tab !== "resources" ? " is-hidden" : "") },
        h(ProcessExplorer, { active: tab === "resources", sort: resourceSort, onSort: setResourceSort })),
      h(CanvasFrame, { key: "canvas", hidden: tab !== "canvas", status: status.canvas, onStart: () => start("canvas"), onStop: () => stop("canvas") }),
    ];

    const ideList = IDE_IDS.filter((id) => instanceOn(id));
    const cliList = CLI_IDS.filter((id) => instanceOn(id));
    const tabs = [
      { id: "board", label: "事件板", icon: ICONS.list },
      ...ideList.map((id) => ({ id, label: id, icon: ICONS.terminal, running: Boolean(status[id]?.running) })),
      ...cliList.map((id) => ({ id, label: CLI_NAME[id] || id, icon: ICONS.code, running: cli.sessions.some((item) => item.agent === id) })),
      instanceOn("canvas") ? { id: "canvas", label: "画布", icon: ICONS.canvas, running: Boolean(status.canvas?.running) } : null,
      { id: "manage", label: "管理", icon: ICONS.manage },
      { id: "usage", label: "消耗", icon: ICONS.chart },
      { id: "resources", label: "资源", icon: ICONS.activity },
    ].filter(Boolean);

    // Keep the live resource readout pinned to the right edge. The rest of
    // the navigation can scroll when the desktop window is narrower than the
    // combined labels, so the readout never gets cut off.
    const resourceTab = tabs.find((item) => item.id === "resources");
    const resourceRolling = Boolean(resPulse);
    const resourceMemPct = resourceRolling && resPulse.memTotal ? Math.round((resPulse.memUsed / resPulse.memTotal) * 100) : 0;
    const resourceCpuText = resourceRolling ? "CPU " + resPulse.cpuApp.toFixed(1) + "%" : "";
    const resourceMemText = resourceRolling ? "内存 " + fmtMb(resPulse.memApp) : "";
    const resourceButton = resourceTab ? h(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": String(tab === "resources"),
        "aria-label": "资源",
        className: "tab tab-resources" + (tab === "resources" ? " is-active" : ""),
        title: resourceRolling
          ? "CPU 应用 " + resPulse.cpuApp.toFixed(1) + "% / 系统 " + resPulse.cpuTotal.toFixed(0) + "% · 内存 应用 " + fmtMb(resPulse.memApp) + " / 系统 " + resourceMemPct + "%"
          : "资源",
        onClick: () => {
          if (resourceRolling && resFace % 3 === 1) setResourceSort("cpu");
          else if (resourceRolling && resFace % 3 === 2) setResourceSort("memory");
          switchTab("resources");
        },
      },
      resourceRolling
        ? h("span", { className: "tab-roll" }, h("span", {
            className: "tab-roll-track" + (resRoll ? " is-roll" : ""),
            style: { transform: "translateY(calc(" + resFace + " * -1.15em))" },
          }, h("span", null, "资源"), h("span", null, resourceCpuText), h("span", null, resourceMemText), h("span", null, "资源")))
        : h("span", null, "资源"),
    ) : null;

    return h(
      "div",
      { className: "app" },
      h(
        "header",
        { className: "topbar", "data-tauri-drag-region": HAS_TAURI || undefined },
        h(
          "nav",
          { className: "tabbar", role: "tablist", onWheel: onTabbarWheel, "aria-label": "主导航（可滚轮横向浏览）" },
          tabs.filter((item) => item.id !== "resources").map((t) => {
            const rolling = t.id === "resources" && resPulse;
            const memPct = rolling && resPulse.memTotal ? Math.round((resPulse.memUsed / resPulse.memTotal) * 100) : 0;
            const cpuText = rolling ? "CPU " + resPulse.cpuApp.toFixed(1) + "%" : "";
            const memText = rolling ? "内存 " + fmtMb(resPulse.memApp) : "";
            const tearing = Boolean(t.roll && stackTear && stackTear.group === t.roll);
            const button = h(
              "button",
              {
                key: t.roll ? undefined : t.id,
                role: "tab",
                "aria-selected": String(tab === t.id),
                "data-tab-id": t.id,
                "aria-label": t.id === "resources" ? "资源" : undefined,
                className: "tab tab-" + t.id + ((t.roll ? t.list.includes(tab) : tab === t.id) ? " is-active" : "") + (tearing && stackTear.place === "center" ? " is-chosen" : "") + (tearing && stackTear.place !== "center" ? " is-torn" : ""),
                title: rolling
                  ? "CPU 应用 " + resPulse.cpuApp.toFixed(1) + "% / 系统 " + resPulse.cpuTotal.toFixed(0) + "% · 内存 应用 " + fmtMb(resPulse.memApp) + " / 系统 " + memPct + "%"
                  : t.roll ? "悬停点上下，或滚轮切换" : undefined,
                onClick: () => {
                  if (rolling && resFace % 3 === 1) setResourceSort("cpu");
                  else if (rolling && resFace % 3 === 2) setResourceSort("memory");
                  if (t.roll && (stackOpen === t.roll || tearing)) {
                    if (!tearing) tearTo(t.roll, t.current, "center");
                    return;
                  }
                  switchTab(t.roll ? t.current : t.id);
                },
              },
              rolling
                ? h("span", { className: "tab-roll" }, h("span", {
                    className: "tab-roll-track" + (resRoll ? " is-roll" : ""),
                    style: { transform: "translateY(calc(" + resFace + " * -1.15em))" },
                  }, h("span", null, "资源"), h("span", null, cpuText), h("span", null, memText), h("span", null, "资源")))
                : h("span", null, t.label),
              t.running ? h("i", { className: "run-dot", title: "运行中" }) : null,
            );
            if (!t.roll) return button;
            const sides = sidePages(t.list, t.current);
            const open = stackOpen === t.roll || tearing;
            const peer = (id, place) => id ? h("button", {
              type: "button",
              className: "tab tab-peer is-" + place + (tearing && stackTear.place === place ? " is-chosen" : "") + (tearing && stackTear.place !== place ? " is-torn" : ""),
              onClick: (event) => {
                event.stopPropagation();
                if (tearing) return;
                tearTo(t.roll, id, place);
              },
            }, h("span", null, CLI_NAME[id] || id), (CLI_IDS.includes(id) ? cli.sessions.some((item) => item.agent === id) : Boolean(status[id]?.running)) ? h("i", { className: "run-dot", title: "运行中" }) : null) : null;
            return h(
              "span",
              {
                key: t.id,
                className: "tab-stack" + (open ? " is-open" : ""),
                style: open && stackLift ? { transform: "translateY(" + stackLift + "px)" } : undefined,
                onMouseEnter: (event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const aboveTop = rect.top - 32;
                  setStackLift(aboveTop < 4 ? 4 - aboveTop : 0);
                  setStackOpen(t.roll);
                },
                onMouseLeave: () => {
                  if (stackTear && stackTear.group === t.roll) return;
                  setStackOpen("");
                  setStackLift(0);
                },
                onWheel: (event) => onGroupWheel(event, t.roll, t.list, t.current),
              },
              open ? peer(sides.above, "above") : null,
              button,
              open ? peer(sides.below, "below") : null,
            );
          }),
        ),
        resourceButton ? h("div", { className: "resource-dock" }, resourceButton) : null,
        h(
          "div",
          { className: "topbar-right" },
          h(
            "div",
            { className: "theme-switch", role: "group", "aria-label": "主题切换" },
            h(
              "button",
              {
                className: "theme-opt" + (theme === "dark" ? " is-active" : ""),
                onClick: () => setTheme("dark"),
                title: "深色主题",
                "aria-pressed": String(theme === "dark"),
              },
              h(Icon, { size: 15 }, ICONS.moon),
            ),
            h(
              "button",
              {
                className: "theme-opt" + (theme === "light" ? " is-active" : ""),
                onClick: () => setTheme("light"),
                title: "浅色主题",
                "aria-pressed": String(theme === "light"),
              },
              h(Icon, { size: 15 }, ICONS.sun),
            ),
          ),
          HAS_TAURI
            ? h(
                "div",
                { className: "win-controls" },
                h(
                  "button",
                  { className: "win-btn", title: "最小化", onClick: () => desktopWindow()?.minimize() },
                  h(Icon, { size: 14 }, ICONS.minus),
                ),
                h(
                  "button",
                  { className: "win-btn", title: "最大化 / 还原", onClick: () => desktopWindow()?.toggleMaximize() },
                  h(Icon, { size: 12 }, ICONS.square),
                ),
                h(
                  "button",
                  { className: "win-btn close", title: "关闭窗口", onClick: () => desktopWindow()?.close() },
                  h(Icon, { size: 14 }, ICONS.xmark),
                ),
              )
            : null,
        ),
      ),
      h(
        "div",
        { className: "content" + (["manage", "canvas", "board", "usage", "resources"].concat(CLI_IDS).includes(tab) ? " has-overlay" : "") },
        content,
        CLI_IDS.includes(tab)
          ? h(CliScreen, {
              tool: tab,
              sessions: cli.sessions,
              activeId: cli.sessions.some((item) => item.id === cli.active && item.agent === tab)
                ? cli.active
                : (cli.sessions.filter((item) => item.agent === tab).slice(-1)[0]?.id || ""),
              onSelect: (id) => setCli((prev) => ({ ...prev, open: true, active: id })),
              onClose: closeCli,
              onExited: markCliExited,
              onNewSession: () => newCliWindow(tab),
              onNewWorkspace: () => newCliWorkspace(tab),
              onResume: (row) => resumeCli(tab, row),
            })
          : null,
      ),
      h(Toast, { text: toastText }),
    );
  }

  // Agents take tens of seconds to actually listen (dsh runs pnpm install
  // checks first), but the portal marks them "running" as soon as the pid is
  // spawned — an iframe mounted in that window lands on a WebView2 error page
  // and never retries. Gate the iframe on a reachable probe instead.
  function useAgentReachable(port, resetKey) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      let alive = true;
      setReady(false);
      const url = `http://127.0.0.1:${port}/`;
      (async () => {
        while (alive) {
          try {
            await fetch(url, { mode: "no-cors", cache: "no-store" });
            if (alive) setReady(true);
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      })();
      return () => {
        alive = false;
      };
    }, [port, resetKey]);
    return ready;
  }

  function AgentFrame({ agent, status, onStart, hidden }) {
    // Persistent wrapper: both agent frames stay mounted for the whole portal
    // session; `hidden` only toggles CSS so the embedded app's WebSocket and
    // state survive tab switches (no reload, no wait).
    // Fallback ports mirror the portal server's AGENTS defaults (3081 for dsh).
    // Never point at :3080 — that's the user's separate dsh instance from the
    // external workspace, not the one this portal supervises.
    const port = status?.port || ({ pi: 3458, openhands: 3460, grok: 3461, hermes: 3462, dsh: 3081 }[agent] || 3081);
    const [starting, setStarting] = useState(false);
    const cls = "agent-frame" + (hidden ? " is-hidden" : "");
    const shell = { className: cls, inert: hidden ? "" : undefined, "aria-hidden": hidden ? "true" : undefined };
    // Hooks must run unconditionally (before any early return) — the reach
    // probe resets whenever the agent process identity changes.
    const key = `${status?.pid ?? "down"}-${status?.startedAt || ""}`;
    const ready = useAgentReachable(port, key);
    // 进程还没起来时也先挂上页面。端口一通，iframe 已经在后台载完。
    const frame = h("iframe", { key, src: `http://127.0.0.1:${port}`, title: agent });
    if (!status?.running) {
      return h(
        "div",
        shell,
        h(
          "div",
          { className: "hero-empty" },
          h("div", { className: "hero-mark", "aria-hidden": true }, agent === "pi" ? "π" : agent === "openhands" ? "OH" : agent === "grok" ? "Gk" : agent === "hermes" ? "爱" : ">_"),
          h("div", { className: "hero-title" }, `${agent} 未运行`),
          h("div", { className: "hero-desc" }, "点击下方按钮直接启动"),
          h(
            "button",
            {
              className: "primary",
              style: { padding: "8px 22px" },
              disabled: starting,
              onClick: async () => {
                setStarting(true);
                try {
                  await onStart();
                } finally {
                  setStarting(false);
                }
              },
            },
            starting ? "正在启动…" : "启动",
          ),
        ),
      );
    }
    if (!ready) {
      return h(
        "div",
        shell,
        h("div", { className: "hero-empty" }, h("div", { className: "hero-mark", "aria-hidden": true }, agent === "pi" ? "π" : agent === "openhands" ? "OH" : agent === "grok" ? "Gk" : agent === "hermes" ? "爱" : ">_")),
        h("div", { className: "agent-preload", "aria-hidden": "true" }, frame),
      );
    }
    return h("div", shell, frame);
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
