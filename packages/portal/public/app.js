(function () {
  "use strict";

  const { useState, useEffect, useCallback, useRef } = React;
  const h = React.createElement;

  async function api(pathname, options) {
    const res = await fetch(pathname, options);
    return res.json();
  }

  const KIND_LABEL = { tool: "工具", command: "命令", mcp: "MCP", skill: "技能", ui: "界面", host: "宿主" };
  const SURFACE_LABEL = { shared: "共享库", client: "客户端 bundle", host: "宿主热挂载" };

  // ── Inline SVG icons (feather-style, stroke inherits color) ─────

  function Icon({ size = 14, children }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
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
      try { new Notification(title, { body, tag: "pdb-portal" }); return true; } catch (e) {}
    }
    return false;
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

  function ResourceWidget() {
    const [data, setData] = useState(null);
    useEffect(() => {
      let alive = true;
      const tick = async () => {
        try {
          const d = await api("/api/resources");
          if (alive && d && d.ok) setData(d);
        } catch (e) {}
      };
      tick();
      const timer = setInterval(tick, 2500);
      return () => { alive = false; clearInterval(timer); };
    }, []);
    if (!data) {
      return h("div", { className: "res-widget" }, h("span", { className: "res-w-loading" }, "资源监测中…"));
    }
    const memPct = data.memTotal ? Math.round((data.memUsed / data.memTotal) * 100) : 0;
    return h(
      "div",
      { className: "res-widget" },
      h(
        "div",
        { className: "res-w-item", title: "CPU：应用 " + data.cpuApp.toFixed(1) + "% / 系统 " + data.cpuTotal.toFixed(1) + "%" },
        h("span", { className: "res-w-label" }, "CPU"),
        h("span", { className: "res-w-val" }, data.cpuApp.toFixed(1) + "%"),
        h("span", { className: "res-w-sep" }, "/"),
        h("span", { className: "res-w-sys" }, data.cpuTotal.toFixed(0) + "%"),
      ),
      h(
        "div",
        { className: "res-w-item", title: "内存：应用 " + fmtMb(data.memApp) + " · 系统已用 " + memPct + "% (" + fmtGb(data.memUsed) + " / " + fmtGb(data.memTotal) + ")" },
        h("span", { className: "res-w-label" }, "内存"),
        h("span", { className: "res-w-val" }, fmtMb(data.memApp)),
        h("span", { className: "res-w-sep" }, "/"),
        h("span", { className: "res-w-sys" }, memPct + "%"),
      ),
    );
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
      const saved = localStorage.getItem("pdb-theme");
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
        localStorage.setItem("pdb-theme", theme);
      } catch (e) {}
    }, [theme]);
    return [theme, setTheme];
  }

  // ── Process cards ────────────────────────────────────────────────

  function ProcessCard({ agent, label, status, onStart, onStop, onRestart }) {
    const [showLog, setShowLog] = useState(false);
    const running = Boolean(status?.running);
    return h(
      "div",
      { className: "proc-wrap" },
      h(
        "div",
        { className: "proc-card" },
        h("span", { className: "proc-dot" + (running ? " on" : "") }),
        h("span", { className: "proc-name" }, label || agent),
        h(
          "div",
          { className: "proc-meta" },
          h("span", { className: "proc-state" + (running ? " ok" : "") }, running ? "运行中" : "已停止"),
          h(
            "span",
            { className: "proc-detail" },
            running ? `pid ${status.pid} · 127.0.0.1:${status.port}` : `端口 ${status.port} · 待启动`,
          ),
        ),
        h(
          "button",
          { className: "proc-btn", onClick: () => setShowLog(!showLog) },
          showLog ? "收起日志" : "日志",
        ),
        running
          ? [
              h("button", { className: "proc-btn", onClick: onRestart }, "重启"),
              h("button", { className: "proc-btn stop", onClick: onStop }, "停止"),
            ]
          : h("button", { className: "proc-btn primary", onClick: onStart }, "启动"),
      ),
      !running && status?.lastExit
        ? h(
            "div",
            { className: "proc-crash", title: (status.lastExit.logTail || []).join("\n") },
            `上次异常退出（code ${status.lastExit.code ?? "null"} · ${new Date(status.lastExit.at).toLocaleTimeString()}）——悬停看日志尾巴`,
          )
        : null,
      showLog && status?.log?.length
        ? h(
            "div",
            { className: "log-shell" },
            h("div", { className: "log-bar" }, h("span", { className: "log-title" }, `${label || agent} 日志`), h("span", { className: "log-hint" }, "最近 40 行")),
            h("pre", { className: "log-view" }, status.log.slice(-40).join("\n")),
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
        { className: "mg-title" },
        h("h2", null, "插件库"),
        h("span", { className: "count" }, `${plugins.length} 个`),
      ),
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
        { className: "mg-title" },
        h("h2", null, "MCP 服务器"),
        h("span", { className: "count" }, `${servers.length} 个`),
        h("span", { className: "spacer" }),
        h("button", { className: "proc-btn primary", onClick: () => setAdding(!adding) }, adding ? "取消" : "＋ 添加"),
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
      h(
        "div",
        { className: "mg-title" },
        h("h2", null, "技能库"),
        h("span", { className: "count" }, `${skills.length} 个`),
        h("span", { className: "sub", style: { fontSize: "11px", color: "var(--text-muted)" } }, "两侧共享 · 放入 skills/ 目录即生效"),
      ),
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

  const CANVAS_URL_KEY = "pdb-canvas-url";

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

  // ── App ──────────────────────────────────────────────────────────

  function App() {
    // Deep-linkable tabs: #/manage opens the manager directly.
    const initial =
      location.hash === "#/manage"
        ? "manage"
        : location.hash === "#/canvas"
          ? "canvas"
          : location.hash === "#/pi"
            ? "pi"
            : "dsh";
    const [tab, setTab] = useState(initial);
    const [theme, setTheme] = useTheme();
    const [status, setStatus] = useState({ dsh: {}, pi: {}, canvas: {} });
    const [plugins, setPlugins] = useState([]);
    const [mcp, setMcp] = useState([]);
    const [skills, setSkills] = useState([]);
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
            toast(state.permission === "denied" ? "通知权限已被拒绝，请在系统设置中允许 pdb 通知" : "未获得系统通知权限");
            return;
          }
        } else { setNativeNotif(state); }
        const sent = await sendNativeNotification("pdb portal", "原生通知工作正常 ✓");
        toast(sent ? "已发送原生通知" : "通知发送失败");
      } finally { setNotifBusy(false); }
    }

    function switchTab(next) {
      setTab(next);
      history.replaceState(null, "", next === "dsh" ? "#" : "#/" + next);
    }

    const toast = useCallback((text) => {
      setToastText(text);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToastText(""), 2200);
    }, []);

    const loadStatus = useCallback(async () => {
      const data = await api("/api/status");
      // Keyed by backend agent id (order-independent): the list now includes
      // the canvas (ComfyUI) instance, and future additions won't shift indexes.
      const byAgent = {};
      for (const a of data.agents || []) byAgent[a.agent] = a;
      setStatus({ dsh: byAgent.dsh, pi: byAgent["pi-web"], canvas: byAgent.canvas });
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
    const NOTIFY_CURSOR_KEY = "pdb.p…rsor";
    const storedCursor = Number(window.localStorage && window.localStorage.getItem(NOTIFY_CURSOR_KEY));
    const lastNotifyId = useRef(Number.isFinite(storedCursor) && storedCursor > 0 ? storedCursor : null);
    const notifPermissionTried = useRef(false);
    const loadNotifications = useCallback(async () => {
      let data;
      try {
        data = await api(`/api/notifications?since=${lastNotifyId.current == null ? 0 : lastNotifyId.current}`);
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
      if (lastNotifyId.current == null) {
        remember(latest); // 首次访问：对齐队尾，历史通知不重放
        return;
      }
      if (latest < lastNotifyId.current) {
        remember(latest); // portal 重启后序号归零：跟随新序列，否则永远取不到
        return;
      }
      const items = data.items || [];
      if (!items.length) return;
      remember(Math.max(lastNotifyId.current, latest));
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
      loadStatus();
      loadConfig();
      loadNotifications();
      const timer = setInterval(() => { loadStatus(); loadNotifications(); }, 2000);
      return () => clearInterval(timer);
    }, [loadStatus, loadConfig, loadNotifications]);

    // The process API is keyed by the backend agent id, which can differ
    // from the display label. Resolve the real key from the latest status
    // payload so label renames never break start/stop.
    function agentKey(agent) {
      const backend = { dsh: "dsh", pi: "pi-web", canvas: "canvas" }[agent] || agent;
      return status[agent]?.agent || backend;
    }

    async function start(agent) {
      const r = await api(`/api/process/${agentKey(agent)}/start`, { method: "POST" });
      toast(r.ok ? `${agent} 已启动` : r.error);
      if (r.ok) sendNativeNotification("pdb portal", `${agent} 已启动`);
      loadStatus();
    }
    async function stop(agent) {
      const r = await api(`/api/process/${agentKey(agent)}/stop`, { method: "POST" });
      toast(r.ok ? `${agent} 已停止` : r.error || "停止失败");
      if (r.ok) sendNativeNotification("pdb portal", `${agent} 已停止`);
      loadStatus();
    }
    async function restart(agent) {
      toast(`${agent} 重启中…`);
      const r = await api(`/api/process/${agentKey(agent)}/restart`, { method: "POST" });
      toast(r.ok ? `${agent} 已重启` : r.error || "重启失败");
      if (r.ok) sendNativeNotification("pdb portal", `${agent} 已重启`);
      loadStatus();
    }

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
        { key: "manage", className: "manage" + (tab !== "manage" ? " is-hidden" : "") },
        h(
          "div",
          { className: "mg-head" },
          h("h1", null, "共享资源管理"),
          h("span", { className: "sub" }, "一次配置，dsh 与 pi 同时生效"),
        ),
        h(
          "div",
          { className: "manage-main" },
        h(
          "div",
          { className: "mg-section" },
          h("div", { className: "mg-title" }, h("h2", null, "运行实例")),
          h(ProcessCard, { agent: "dsh", status: status.dsh, onStart: () => start("dsh"), onStop: () => stop("dsh"), onRestart: () => restart("dsh") }),
          h(ProcessCard, { agent: "pi", status: status.pi, onStart: () => start("pi"), onStop: () => stop("pi"), onRestart: () => restart("pi") }),
          h(ProcessCard, { agent: "canvas", label: "画布 (ComfyUI)", status: status.canvas, onStart: () => start("canvas"), onStop: () => stop("canvas"), onRestart: () => restart("canvas") }),
        ),
        h(NativeNotificationPanel, { state: nativeNotif, busy: notifBusy, onTrigger: triggerNativeNotif }),
        h(PluginManager, { plugins, onToggle: togglePlugin, toast }),
        h(McpManager, { servers: mcp, onToggle: toggleMcp, onDelete: deleteMcp, onAdd: addMcp, toast }),
        h(SkillManager, { skills, onDelete: deleteSkill }),
        ),
      ),
      h(CanvasFrame, { key: "canvas", hidden: tab !== "canvas", status: status.canvas, onStart: () => start("canvas"), onStop: () => stop("canvas") }),
    ];

    const tabs = [
      { id: "dsh", label: "dsh", icon: ICONS.terminal, running: Boolean(status.dsh?.running) },
      { id: "pi", label: "pi", icon: ICONS.chat, running: Boolean(status.pi?.running) },
      { id: "canvas", label: "画布", icon: ICONS.image, running: Boolean(status.canvas?.running) },
      { id: "manage", label: "管理", icon: ICONS.sliders },
    ];

    return h(
      "div",
      { className: "app" },
      h(
        "header",
        { className: "topbar", "data-tauri-drag-region": HAS_TAURI || undefined },
        h(
          "div",
          { className: "brand", "data-tauri-drag-region": HAS_TAURI || undefined },
          h("span", { className: "brand-mark", "aria-hidden": true }, "M"),
          h(
            "div",
            { className: "brand-text" },
            h("span", { className: "brand-name" }, "pdb-agent"),
            h("span", { className: "brand-sub" }, "portal"),
          ),
        ),
        h(
          "nav",
          { className: "tabbar", role: "tablist" },
          tabs.map((t) =>
            h(
              "button",
              {
                key: t.id,
                role: "tab",
                "aria-selected": String(tab === t.id),
                className: "tab" + (tab === t.id ? " is-active" : ""),
                onClick: () => switchTab(t.id),
              },
              h(Icon, { size: 13 }, t.icon),
              h("span", null, t.label),
              t.running ? h("i", { className: "run-dot", title: "运行中" }) : null,
            ),
          ),
        ),
        h(ResourceWidget),
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
              h("span", null, "深色"),
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
              h("span", null, "浅色"),
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
        { className: "content" + (tab === "manage" || tab === "canvas" ? " has-overlay" : "") },
        content,
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
    const port = status?.port || (agent === "pi" ? 3456 : 3081);
    const [starting, setStarting] = useState(false);
    const cls = "agent-frame" + (hidden ? " is-hidden" : "");
    // Hooks must run unconditionally (before any early return) — the reach
    // probe resets whenever the agent process identity changes.
    const key = `${status?.pid ?? "down"}-${status?.startedAt || ""}`;
    const ready = useAgentReachable(port, key);
    if (!status?.running) {
      return h(
        "div",
        { className: cls },
        h(
          "div",
          { className: "hero-empty" },
          h("div", { className: "hero-mark", "aria-hidden": true }, agent === "pi" ? "π" : ">_"),
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
      // Keep the starting hero visible until the agent's HTTP surface answers.
      return h("div", { className: cls }, h("div", { className: "hero-empty" }, h("div", { className: "hero-mark", "aria-hidden": true }, agent === "pi" ? "π" : ">_")));
    }
    return h("div", { className: cls }, h("iframe", { key, src: `http://127.0.0.1:${port}` }));
  }

  ReactDOM.createRoot(document.getElementById("root")).render(h(App));
})();
