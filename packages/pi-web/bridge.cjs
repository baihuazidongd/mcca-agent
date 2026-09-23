"use strict";

/**
 * @mcca/pi-web — pi 会话桥（2026-09 重写版）。
 *
 * 与已归档的 pi-dsh-web（dsh 壳兼容层）不同，这里直接面向本仓库自带的原生
 * Web UI：REST + SSE，事件词表是本包私有的轻量形态（user/assistant/tool/
 * turn），不再翻译成 dsh 协议。pi 集成的既有经验全部内建：
 *   - runtime 按 models.json mtime 重建；会话复用时按 mtime 换新 runtime
 *     （旧 runtime 看不到新增服务商，setModel 的 checkAuth 会报 No API key）
 *   - 内置目录路由只写覆盖（绝不用「api+空 models」空壳遮蔽内置目录）
 *   - 模型 id / 名称去首尾空白
 *   - 思考强度走 pi 的 thinkingLevelMap（canonical 级别 → wire 拼写；未声明
 *     级别显式置 null，off 缺席 = 支持、发空）
 *   - 模型发现：注册表直答 → OpenAI 兼容 GET {base}/models（带容量字段）
 *   - 插件/技能/共享 MCP 经 extensionFactories 接线，会话落盘可恢复
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
// 凭据/模型目录：默认 pi 全局 agent 目录（pi CLI 的 models/auth 落点）。
const AGENT_DIR = process.env.MCCA_AGENT_DIR || path.join(process.env.USERPROFILE || "", ".pi", "agent");
// 会话目录：本包私有（旧 pi-dsh-web 的 config/.pi-agent 已随其归档删除）。
const SESSION_DIR = process.env.MCCA_PI_WEB_SESSIONS || path.join(ROOT, "config", ".pi-web", "sessions");
// 事件缓冲上限：溢出时优先淘汰「增量」事件（思考/正文流），保住结构事件（用户消息、
// 回复、工具、轮次）。否则几千个 delta 会把用户消息挤出缓冲，回放缺消息、「对话定位」消失。
const EVENTS_MAX = 4000;
const EVENTS_LOW = 3000;
const MODELS_FILE = path.join(AGENT_DIR, "models.json");
const ENV_KEYS = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  google: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY,
  groq: process.env.GROQ_API_KEY,
  xai: process.env.XAI_API_KEY,
  mistral: process.env.MISTRAL_API_KEY,
  cerebras: process.env.CEREBRAS_API_KEY,
};

/** 思考强度：canonical 级别与展示名（composer 下拉顺序即此序）。 */
const THINKING_LEVELS = [
  ["off", "关闭"],
  ["minimal", "极简"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "超高"],
  ["max", "最大"],
];

const loadSdk = () => import("@earendil-works/pi-coding-agent");
const Diff = require("diff");
const { PresetContextStore, normalizePresetConfig, createPresetContextExtension } = require("./preset-context.cjs");
const { createImagePruneExtension } = require("./image-prune.cjs");
const subagents = require("./subagents.cjs");
const { SubagentRuns, idFromSessionFile, conversationEvents, isChildSessionInfo } = require("./subagent-runs.cjs");
const { createNativeSubagents, createObserver, requestRpc } = require("./subagent-extension.cjs");

// ——————————————————————————————————————————————————————————————————————————————
// Content-Exists-Risk sanitizer: DeepSeek upstream flags emoji + country/region
// names (e.g. 🇭🇰Hong Kong 🇹🇼Taiwan).  Strip emoji and replace flagged names
// with pinyin equivalents so content passes moderation.
// ——————————————————————————————————————————————————————————————————————————————
const COUNTRY_PINYIN = [
  ["Hong Kong", "Xianggang"], ["Taiwan", "Taiwan"], ["Japan", "Riben"],
  ["Korea", "Hanguo"], ["Singapore", "Xinjiapo"], ["Thailand", "Taiguo"],
  ["Malaysia", "Malaixiya"], ["Vietnam", "Yuenan"], ["Philippines", "Feilvbin"],
  ["Indonesia", "Yinni"], ["India", "Yindu"], ["Nepal", "Niboer"],
  ["Sri Lanka", "Srilanka"], ["Bangladesh", "Mengjialaguo"], ["Pakistan", "Bajisitan"],
  ["Russia", "Eluosi"], ["Ukraine", "Wukelan"], ["Germany", "Deguo"],
  ["France", "Faguo"], ["United Kingdom", "Yingguo"], ["UK", "Yingguo"],
  ["England", "Yingge"], ["Spain", "Xibanya"], ["Italy", "Yidali"],
  ["Netherlands", "Helan"], ["Belgium", "Bilishi"], ["Sweden", "Ruidian"],
  ["Norway", "Nuowei"], ["Denmark", "Danmai"], ["Finland", "Fenlan"],
  ["Switzerland", "Ruishi"], ["Austria", "Aodili"], ["Poland", "Bolan"],
  ["Czech", "Jieke"], ["Romania", "Luomaniya"], ["Greece", "Xila"],
  ["Turkey", "Tu'erqi"], ["Israel", "Yiselie"], ["Egypt", "Aiji"],
  ["Brazil", "Baxi"], ["Mexico", "Moxige"], ["Argentina", "Agenting"],
  ["Chile", "Zhili"], ["Peru", "Bolu"], ["Colombia", "Gelunbiya"],
  ["Canada", "Jianada"], ["Australia", "Aodaliya"], ["New Zealand", "Xinxilan"],
  ["South Africa", "Nanfei"], ["Nigeria", "Niriliya"], ["Kenya", "Kenya"],
  ["UAE", "Alianqiu"], ["Saudi Arabia", "Shate"], ["Qatar", "Ka'ter"],
];
function sanitizeContent(text) {
  if (!text || typeof text !== "string") return text;
  // strip all emoji (full BMP minus CJK/ASCII range)
  let out = text.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, ""); // flag sequences
  out = out.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1FFFF}\u{200D}\u{20E3}\u{2640}\u{2642}\u{2695}\u{2696}\u{2708}\u{2764}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}]/gu, "");
  // replace country names with pinyin
  for (const [en, py] of COUNTRY_PINYIN) {
    const re = new RegExp(en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, py);
  }
  return out;
}
function sanitizeMessages(body) {
  if (!body || !Array.isArray(body.messages)) return;
  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      msg.content = sanitizeContent(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) part.text = sanitizeContent(part.text);
        if (part.type === "toolResult" && part.text) part.text = sanitizeContent(part.text);
        if (part.type === "thinking" && part.thinking) part.thinking = sanitizeContent(part.thinking);
      }
    }
  }
}
// Wrap fetch to sanitize outgoing API calls for "Content Exists Risk"
const _origFetch = global.fetch;
global.fetch = async function(...args) {
  const [url, init] = args;
  const u = typeof url === "string" ? url : String(url);
  const goBase = "https://opencode.ai/zen/go";
  if (u.startsWith(goBase) && init?.method === "POST" && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      sanitizeMessages(body);
      init.body = JSON.stringify(body);
    } catch {}
  }
  return _origFetch.apply(this, args);
};

/**
 * 子代理回执文本：一行标题 + 结果摘要 + 产物路径。与 pi-subagents 自带通知的
 * 信息量对齐，但压得更短（直接进主对话，太长只会污染上下文）。
 */
const SUBAGENT_RECEIPT_TTL_MS = 10 * 60 * 1000;
const SUBAGENT_RECEIPT_PREVIEW = 240;

function receiptStatus(data) {
  if (data.stopped === true || data.state === "stopped") return "已停止";
  if (data.success === true) return "完成";
  if (data.state === "paused") return "已暂停";
  return "失败";
}
function receiptPreview(data) {
  const raw = typeof data.summary === "string" && data.summary.trim()
    ? data.summary
    : Array.isArray(data.results)
      ? data.results.map((child) => (child && typeof child.summary === "string" ? child.summary : "")).filter(Boolean).join("\n")
      : "";
  const lines = String(raw).replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  // 子代理的输出常带一段验收 JSON（"noStagedFiles": true 之类）：挑像人话的行，
  // 实在没有才退回原文，别把 JSON 片段塞进回执给人和父代理看
  const human = lines.filter((line) => !/^["{}[\],]/.test(line));
  const picked = (human.length ? human : lines).slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
  return picked.length > SUBAGENT_RECEIPT_PREVIEW ? `${picked.slice(0, SUBAGENT_RECEIPT_PREVIEW - 1)}…` : picked;
}
function receiptArtifactPath(data) {
  const candidates = [data.handoffPath, data.artifactPath];
  if (Array.isArray(data.results)) {
    for (const child of data.results) if (child && child.artifactPath) candidates.push(child.artifactPath);
  }
  return candidates.find((p) => typeof p === "string" && p.trim()) || "";
}
function fmtElapsedShort(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
function formatSubagentReceipt(data) {
  const lines = [`【子代理回执】${data.agent || "子代理"} ${receiptStatus(data)}${Number(data.durationMs) > 0 ? ` · ${fmtElapsedShort(Number(data.durationMs))}` : ""}`];
  lines.push(receiptPreview(data) || "（无输出摘要）");
  const artifact = receiptArtifactPath(data);
  if (artifact) lines.push(`产物：${artifact}`);
  if (data.triggerTurn === false) lines.push("（结果已就绪，需要时读产物或在界面上向用户汇报）");
  return lines.join("\n");
}
function formatSubagentReceiptGroup(items) {
  const lines = [`【子代理回执】${items.length} 个任务结束`];
  items.forEach((data, index) => {
    const preview = receiptPreview(data) || "（无输出摘要）";
    const secs = Number(data.durationMs) > 0 ? ` · ${fmtElapsedShort(Number(data.durationMs))}` : "";
    lines.push(`${index + 1}. ${data.agent || "子代理"} ${receiptStatus(data)}${secs}：${preview}`);
  });
  const artifact = items.map(receiptArtifactPath).find(Boolean);
  if (artifact) lines.push(`产物：${artifact}`);
  return lines.join("\n");
}

class PiWebBridge {
  constructor() {
    this.sdk = null;
    this.runtimePromise = null;
    this._runtimeModelsMtime = 0;
    this._nativeCatalogPromise = null;
    // 事件帧的唯一前缀：浏览器端 SSE 去重键是「boot:seq」。服务器重启后 seq
    // 从头计数，裸 seq 会撞上旧进程的已见集合，实时事件被整段静默丢弃。
    this.bootId = Date.now().toString(36);
    /** @type {Map<string, sessionState>} sessionId → 会话态 */
    this.sessions = new Map();
    this.sessionPaths = new Map();
    this.subagentObservers = new Map();
    // 每会话待发队列（服务端持有）：切走会话/关掉页面后依然会在回合结束时按序发出
    this.promptQueues = new Map();
    this.attachPending = new Map();
    this.agentCatalogCache = new Map();
    // 预设上下文存储（预设=命名规则组 + AGENTS/CLAUDE 上下文文件注入），
    // 配置落 pi 全局 agent 目录，跨工作区共用。
    this.presetStore = new PresetContextStore({
      settingsPath: path.join(AGENT_DIR, "dsh-web-settings.json"),
      legacyPath: this.settingsFile(),
      log: (message) => console.log("[pi-web]", message),
    });
    this.startSubagentReceiptSweeper();
  }

  /**
   * 后台对账：子代理的完成状态只落在 asyncDir/status.json 和 subagents/*.json 里，
   * 会话没开在界面上时没人去读——回执也就永远发不出来。每 10s 扫一遍快照文件
   * （只在有 working run 的会话上真干活），把「刚完成」的 run 变成回执。
   */
  startSubagentReceiptSweeper() {
    if (this.subagentReceiptTimer) return;
    const tick = () => {
      try {
      try {
        this.sweepRunningTools();
      } catch (error) {
        console.log(`[pi-web] slow-tool sweep failed: ${error && error.message}`);
      }
        void this.sweepSubagentReceipts();
      } catch (error) {
        console.log(`[pi-web] subagent receipt sweep failed: ${error && error.message}`);
      }
    };
    this.subagentReceiptTimer = setInterval(tick, 10_000);
    if (this.subagentReceiptTimer.unref) this.subagentReceiptTimer.unref();
    const first = setTimeout(tick, 4000);
    if (first.unref) first.unref();
  }

  async sweepSubagentReceipts() {
    // 忙态看门狗先跑（纯内存，便宜）
    try {
      this.sweepStuckBusySessions();
    } catch {
      // 单次失败不影响回执扫描
    }
    const dir = path.join(SESSION_DIR, "..", "subagents");
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    for (const file of files) {
      const sessionId = file.replace(/\.json$/, "");
      // 先只读快照小 JSON：没有终态 run、或终态 run 都已投递过的会话直接跳过。
      // 这一步很关键——以前对每个快照都 new SubagentRuns（连带读 async 状态文件），
      // 几十个历史会话就是秒级阻塞，整个进程（含 SSE）都会卡住。
      let cheap = null;
      try {
        cheap = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      } catch {
        continue;
      }
      const runs = Array.isArray(cheap.runs) ? cheap.runs : [];
      const now = Date.now();
      const pending = runs.some((run) => {
        const st = String((run && run.status) || "");
        if (st !== "completed" && st !== "failed" && st !== "stopped") return false;
        const base = run.runId || String(run.id || "").split(":")[0];
        const index = Number.isFinite(run.index) ? run.index : 0;
        const key = `run:${sessionId}:${base}:${index}`;
        const seenAt = this.subagentReceiptSeen && this.subagentReceiptSeen.get(key);
        return !(seenAt !== undefined && now - seenAt < SUBAGENT_RECEIPT_TTL_MS);
      });
      if (!pending) continue; // 全部投递过：不读盘
      await new Promise((r) => setImmediate(r)); // 让出事件循环，别让一次扫描堵住 SSE
      const attached = this.subagentObservers.get(sessionId);
      let registry = (attached && attached.registry) || null;
      if (!registry) {
        try {
          registry = new SubagentRuns({ dir, sessionId });
        } catch {
          continue;
        }
      }
      try {
        registry.refreshFiles(false);
      } catch {
        // 单个快照损坏不影响其它会话
      }
      this.receiptsFromSnapshot(sessionId, registry.snapshot());
    }
  }

  async sdkReady() {
    if (!this.sdk) this.sdk = await loadSdk();
    return this.sdk;
  }

  modelsMtime() {
    try {
      return fs.statSync(MODELS_FILE).mtimeMs;
    } catch {
      return 0;
    }
  }

  async runtime() {
    const mtime = this.modelsMtime();
    if (this.runtimePromise && this._runtimeModelsMtime === mtime) return this.runtimePromise;
    this._runtimeModelsMtime = mtime;
    this.runtimePromise = (async () => {
      const sdk = await this.sdkReady();
      const runtime = await sdk.ModelRuntime.create({
        authPath: path.join(AGENT_DIR, "auth.json"),
        modelsPath: MODELS_FILE,
        allowModelNetwork: false,
      });
      for (const [provider, key] of Object.entries(ENV_KEYS)) {
        if (key) await runtime.setRuntimeApiKey(provider, key);
      }
      return runtime;
    })();
    this.runtimePromise.catch(() => {
      this.runtimePromise = null;
    });
    return this.runtimePromise;
  }

  /** pi 内置目录（SDK 自带，不含 models.json 声明），进程内缓存一次。 */
  nativeCatalog() {
    if (!this._nativeCatalogPromise) {
      this._nativeCatalogPromise = (async () => {
        const sdk = await this.sdkReady();
        const probe = await sdk.ModelRuntime.create({
          modelsPath: path.join(AGENT_DIR, "models.json.native-catalog-probe-absent"),
          allowModelNetwork: false,
        });
        return (probe.getProviders() || []).map((p) => ({ id: p.id, name: p.name || p.id }));
      })();
      this._nativeCatalogPromise.catch(() => {
        this._nativeCatalogPromise = null;
      });
    }
    return this._nativeCatalogPromise;
  }

  async nativeCatalogIds() {
    return new Set((await this.nativeCatalog()).map((p) => p.id));
  }

  curatedExtensionPaths() {
    const base = path.join(AGENT_DIR, "npm", "node_modules");
    const wanted = ["pi-web-access", "@vigolium/piolium"];
    const paths = [];
    for (const name of wanted) {
      const dir = path.join(base, ...name.split("/"));
      if (fs.existsSync(dir)) paths.push(dir);
    }
    return paths;
  }

  // ── 会话构建与事件 ───────────────────────────────────────────────

  async buildSession(cwd, sessionManager) {
    const sdk = await this.sdkReady();
    sessionManager ||= sdk.SessionManager.create(cwd, SESSION_DIR);
    const ownerSessionId = String(sessionManager.getSessionId());
    let observer = this.subagentObservers.get(ownerSessionId);
    if (!observer) {
      observer = { registry: null, bus: null, state: null };
      observer.registry = new SubagentRuns({
        dir: path.join(SESSION_DIR, "..", "subagents"),
        sessionId: ownerSessionId,
        onChange: () => {
          if (!observer.state) return;
          const snap = observer.registry.snapshot();
          this.receiptsFromSnapshot(ownerSessionId, snap);
          this.childSessions(ownerSessionId).then((children) => {
            this.push(observer.state, { type: "subagents", ...this.mergeSubagentQueue(snap, children) });
          }).catch(() => {
            this.push(observer.state, { type: "subagents", ...snap });
          });
        },
      });
      this.subagentObservers.set(ownerSessionId, observer);
    }
    observer.registry.refreshFiles();
    const runtime = await this.runtime();
    const { createPiAdapter } = await import("@mcca/pi-adapter");
    const { createPiMcpExtension, readMcpServers } = await import("@mcca/pi-mcp");
    const mcpServers = readMcpServers(path.join(ROOT, "config", "mcp.json"));
    const piAdapter = createPiAdapter({
      pluginsDir: path.join(ROOT, "plugins"),
      configPath: path.join(ROOT, "config", "plugins.json"),
      cwd: ROOT,
      onMcpServer: (cfg) => mcpServers.push(cfg),
    });
    const ideAdapter = createPiAdapter({
      pluginsDir: path.join(ROOT, "packages", "agent-ide", "plugins"),
      configPath: path.join(ROOT, "config", "plugins.json"),
      cwd,
    });
    const { createMemoryContextExtension } = await import("../agent-ide/memory-prompt.mjs");
    const piMcp = createPiMcpExtension({ servers: mcpServers, cwd: ROOT });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: AGENT_DIR,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: this.curatedExtensionPaths(),
      additionalSkillPaths: [path.join(ROOT, "skills"), path.join(ROOT, "packages", "agent-ide", "skills")].filter((p) => fs.existsSync(p)),
      extensionFactories: [
        { name: "pi-web-native-subagents", factory: createNativeSubagents(AGENT_DIR) },
        { name: "pi-web-subagents-observer", factory: createObserver(observer.registry, (bus) => { observer.bus = bus; }, () => { if (observer.state) this.push(observer.state, { type: "subagents-config" }); }, (name, event) => this.queueSubagentReceipt(ownerSessionId, name, event)) },
        { name: "mcca-pi-adapter", factory: piAdapter },
        { name: "mcca-agent-ide", factory: ideAdapter },
        { name: "mcca-pi-mcp", factory: piMcp },
        // 预设上下文注入：每条用户消息把启用的预设规则/上下文文件追加进系统提示词
        { name: "mcca-preset-context", factory: createPresetContextExtension({ store: this.presetStore }) },
        // 功能记忆 / 项目记忆索引。空库返回 undefined，系统提示词保持原样。
        { name: "mcca-memory", factory: createMemoryContextExtension() },
        // 历史图片裁剪：老截图的 base64 不随每次请求重发（否则请求体几十 MB，网关直接 413）
        { name: "mcca-image-prune", factory: createImagePruneExtension() },
      ],
    });
    await resourceLoader.reload();
      // SettingsManager 包装：a) 强制开启自动压缩（宁愿压缩也不能撑爆上下文窗口）；
      // b) 按当前服务商覆盖重试设置（models.json 条目的 retryCount/retryWaitMs，默认 5 次/15s）。
      // 当前服务商记在 retryRef（会话对象携带，setModel 时更新）。
      const defaultModel = this.resolveDefaultModel(runtime);
      const retryRef = { provider: defaultModel?.provider ?? null };
      let settingsManager;
      try {
        const base = await sdk.SettingsManager.create(cwd, AGENT_DIR);
        settingsManager = new Proxy(base, {
          get: (target, prop) => {
            if (prop === "getCompactionSettings") {
              return () => ({ ...target.getCompactionSettings(), enabled: true });
            }
          if (prop === "getRetrySettings") {
            return () => {
              const b = target.getRetrySettings();
              const entry = (retryRef.provider && this.readProviders().providers[retryRef.provider]) || null;
              return {
                ...b,
                maxRetries: retryCountOf(entry?.retryCount),
                baseDelayMs: retryDelayMsOf(entry?.retryWaitMs),
              };
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } catch (error) {
      console.error("[pi-web] SettingsManager wrap failed:", error instanceof Error ? error.message : String(error));
    }
    // 0.85 起 createAgentSession 返回 { session, extensionsResult } 包装。
    const result = await sdk.createAgentSession({
      sessionManager: sessionManager ?? sdk.SessionManager.create(cwd, SESSION_DIR),
      modelRuntime: runtime,
      model: defaultModel,
      cwd,
      resourceLoader,
      ...(settingsManager ? { settingsManager } : {}),
    });
    result.session.__retryRef = retryRef;
    this.installCompactionModelRoute(result.session);
    return result.session;
  }

  /** Route both manual and automatic summaries through the optional cheap model. */
  installCompactionModelRoute(session) {
    if (!session || session.__compactionRouteInstalled || typeof session._runDefaultCompaction !== "function") return;
    session.__compactionRouteInstalled = true;
    const original = session._runDefaultCompaction.bind(session);
    session._runDefaultCompaction = async (...args) => {
      const route = this.readSettings().compactionModel;
      if (!route?.provider || !route?.model || typeof session.setModel !== "function") return original(...args);
      const runtime = await this.runtime();
      const target = runtime.getModel(String(route.provider), String(route.model));
      if (!target) throw new Error(`压缩模型不存在: ${route.provider}/${route.model}`);
      const current = session.model;
      const previous = current ? { provider: current.provider, model: current.id } : null;
      await session.setModel(target, { persist: false });
      try { return await original(...args); }
      finally {
        if (previous) {
          const restored = runtime.getModel(previous.provider, previous.model);
          if (restored) await session.setModel(restored, { persist: false });
        }
      }
    };
  }

  /** PI_MODEL=provider/model 显式指定；否则不猜（pi 依自身配置选）。 */
  resolveDefaultModel(runtime) {
    const raw = process.env.PI_MODEL || "";
    if (!raw) return undefined;
    const [provider, modelId] = raw.split("/", 2);
    if (!provider || !modelId) return undefined;
    return runtime.getModel(provider.trim(), modelId.trim()) || undefined;
  }

  /**
   * models.json 变过 → 整体重建会话。AgentSession 构造时把 runtime 烤进了
   * 多处（_modelRuntime 的鉴权/目录、agent.streamFunction 的流式调用），只换
   * _modelRuntime 会出现「选模型成功、一流式就 Unknown provider」的裂缝；
   * 会话本体落盘（SessionManager 可复用），重建无损，流式中则推迟到下一回合。
   */
  async refreshSessionRuntime(state) {
    const mtime = this.modelsMtime();
    if (state.modelsMtime === mtime) return;
    state.modelsMtime = mtime;
    if (!state.session || state.session.isStreaming) return; // 流式中：下次 attach 再重建
    await this.rebuildSession(state);
  }

  async rebuildSession(state) {
    const old = state.session;
    const manager = state.manager || old.sessionManager;
    const oldModel = old.model ? { provider: old.model.provider, modelId: old.model.id } : null;
    const oldThinking = old.thinkingLevel ?? null;
    const oldTitle = state.title;
    if (state.unsubscribe) state.unsubscribe();
    try {
      old.dispose();
    } catch {
      // dispose 失败不阻断重建（引用释放即可）
    }
    state.session = null;
    const session = await this.buildSession(state.cwd, manager);
    state.session = session;
    state.unsubscribe = session.subscribe((ev) => this.translateLive(state, ev));
    this.bindSubagentObserver(state);
    // 恢复原模型与思考强度（重建后的会话回落全局默认）
    try {
      if (oldModel) {
        const runtime = await this.runtime();
        const model = runtime.getModel(oldModel.provider, oldModel.modelId);
        if (model) {
          await session.setModel(model);
          if (session.__retryRef) session.__retryRef.provider = model.provider;
        }
      }
      if (oldThinking && typeof session.setThinkingLevel === "function") {
        session.setThinkingLevel(oldThinking);
      }
    } catch (error) {
      console.warn("[pi-web] rebuild restore failed:", error instanceof Error ? error.message : error);
    }
    state.title = oldTitle;
    console.log("[pi-web] session rebuilt (models.json changed)");
  }

  /** pi 流事件 → 本包轻量事件词表。 */
  bindSubagentObserver(state) {
    const observer = this.subagentObservers.get(state.id);
    if (!observer) return;
    observer.state = state;
    state.subagentObserver = observer;
  }

  adaptModelRegistry(runtime) {
    return {
      getAvailable: () => {
        if (typeof runtime.getAvailableSnapshot === "function") return [...(runtime.getAvailableSnapshot() || [])];
        const providers = runtime.getProviders?.() || [];
        return providers.flatMap((provider) => (runtime.getModels?.(provider.id) || []).map((model) => ({ ...model, provider: model.provider || provider.id })));
      },
    };
  }

  notifySubagentConfig() {
    this.agentCatalogCache.clear();
    for (const session of this.sessions.values()) this.push(session, { type: "subagents-config" });
  }

  translateLive(state, ev) {
    const observer = this.subagentObservers.get(state.id);
    if (observer && ev.toolName === "subagent") {
      if (ev.type === "tool_execution_start") observer.registry.begin(ev.toolCallId, ev.args);
      if (ev.type === "tool_execution_update") observer.registry.tool(ev.toolCallId, ev.partialResult, false);
      if (ev.type === "tool_execution_end") {
        observer.registry.tool(ev.toolCallId, ev.result, true, ev.isError);
        if (ev.result?.details?.mode === "management") this.push(state, { type: "subagents-config" });
      }
    }
    switch (ev.type) {
      case "agent_start":
        state.turn += 1;
        state.hasStreamed = false;
        state.turnStartedAt = Date.now(); // 任务计时起点（回放/刷新后据此还原「任务中」）
        this.push(state, { type: "turn-start", turn: state.turn });
        // agent_start 后进入「请求中」阶段（等待 LLM 响应首个 token）
        this.pushStatus(state, "requesting");
        break;
      case "message_update": {
        const ame = ev.assistantMessageEvent;
        if (!ame) break;
        if (ame.type === "thinking_end") {
          if (state.streaming) this.push(state, { type: "thinking-end" });
          break;
        }
        const delta = typeof ame.delta === "string" ? ame.delta : "";
        if (!delta || (ame.type !== "text_delta" && ame.type !== "thinking_delta")) break;
        if (!state.streaming) {
          state.streaming = true;
          state.hasStreamed = true;
          this.push(state, { type: "assistant-start" });
          // 收到首个 delta → 进入「处理中」阶段
          this.pushStatus(state, "processing");
          state.msgStartedAt = Date.now(); // 流式起始：真实生成时长计时
        }
        // 思考流单独走 thinking-delta，前端与正文分开展示
        if (ame.type === "thinking_delta") {
          this.push(state, { type: "thinking-delta", text: delta });
          break;
        }
        // 部分消息的 usage.output 随流式累计（tok 速度显示用），缺失就带上 undefined
        const tokens = partialOutputTokens(ev.message);
        this.push(state, {
          type: "assistant-delta",
          text: delta,
          ...(tokens !== undefined ? { tokens } : {}),
        });
        break;
      }
      case "message_end": {
        const msg = ev.message;
        if (msg?.role === "custom") {
          if (msg.customType !== "async-tool-result") break;
          this.finishBackgroundTool(state, msg.details?.taskId);
          const text = Array.isArray(msg.content)
            ? msg.content.map((part) => typeof part === "string" ? part : (part && part.type === "text" ? part.text : "")).join("\n")
            : String(msg.content || "");
          const images = toolResultImages({ content: msg.content });
          if (msg.display !== false && (text.trim() || images.length)) {
            this.push(state, { type: "notice", text: text.trim(), asyncTool: true, images });
          }
          break;
        }
        if (!msg || msg.role !== "assistant") break;
        const text = Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "text").map((c) => c.text).join("") : "";
        const thinking = Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("") : "";
        state.streaming = false;
        const output = partialOutputTokens(msg);
        // 真实生成速度：首个 delta → 收尾的实测时长（不含排队与工具执行）
        const durSec = state.msgStartedAt > 0 ? (Date.now() - state.msgStartedAt) / 1000 : 0;
        state.msgStartedAt = 0;
        const tokPerSec = output > 0 && durSec >= 0.5 && output / durSec <= 500 ? output / durSec : 0;
        // 落盘实测指标：跨重启/回放按 (turn, 序位) 还原 tok 速度与任务时长
        if ((text || thinking) && state.msgStatsByTurn) {
          const bucket = state.msgStatsByTurn[state.turn] || (state.msgStatsByTurn[state.turn] = []);
          bucket.push({ output: output || 0, tokPerSec, durSec });
          if (bucket.length > 500) bucket.splice(0, bucket.length - 500);
          this.saveMetrics(state);
        }
        this.push(state, {
          type: "assistant-end",
          // 正文随终态一起发：增量事件会被缓冲裁剪掉，晚订阅/回放要靠它拿到完整回复
          text,
          ...(thinking ? { thinking } : {}),
          stopReason: msg.stopReason,
          ...(output ? { usage: { output } } : {}),
          ...(tokPerSec > 0 ? { tokPerSec } : {}),
          ...(msg.stopReason === "error" ? { error: msg.errorMessage || "unknown provider error" } : {}),
        });
        break;
      }
      case "tool_execution_start": {
        const callId = ev.toolCallId || `call_${state.seq}`;
        state.calls.set(callId, ev.toolName || "tool");
        this.noteToolStart(state, callId, ev.toolName || "tool", typeof ev.args === "string" ? ev.args : safeJson(ev.args ?? {}));
        this.push(state, {
          type: "tool",
          callId,
          phase: "start",
          name: ev.toolName || "tool",
          args: capText(typeof ev.args === "string" ? ev.args : safeJson(ev.args ?? {}), TOOL_ARGS_MAX_CHARS),
        });
        break;
      }
      case "tool_execution_end": {
        const callId = ev.toolCallId || "";
        const name = state.calls.get(callId) || ev.toolName || "tool";
        state.calls.delete(callId);
        if (ev.result?.details?.background === true) {
          this.detachBackgroundTool(state, callId, name, ev.result.details);
        } else {
          this.noteToolEnd(state, callId);
        }
        const images = toolResultImages(ev.result); // 大图在此缩略，避免单帧几 MB
        this.push(state, {
          type: "tool",
          callId,
          phase: "end",
          name,
          output: capText(extractToolOutput(ev.result)),
          isError: Boolean(ev.isError),
          ...(images.length ? { images } : {}),
        });
        break;
      }
      case "agent_end": {
        state.streaming = false;
        state.calls.clear();
        if (state.turnStartedAt > 0 && state.turnStats) {
          state.turnStats[state.turn] = Date.now() - state.turnStartedAt;
          state.turnStartedAt = 0;
          this.saveMetrics(state);
        }
        // 如果 agent_end 时从未收到 message_update delta，说明本轮无文本输出（可能触发了重试）
        const wasRetry = !state.hasStreamed && state.turn > 0;
        const durationMs = state.turnStats && state.turnStats[state.turn] ? state.turnStats[state.turn] : 0;
        this.push(state, { type: "turn-end", turn: state.turn, retry: wasRetry, ...(durationMs ? { durationMs } : {}) });
        if (wasRetry) {
          // 这轮没输出，多半还要自动重试：保持"忙"锁（暂停按钮/服务端队列都靠它）
          this.pushStatus(state, "retry");
        } else {
          state.promptPending = false; // 真正结束：解锁发送
          this.pushStatus(state, "idle");
          // 服务端队列：本轮结束后自动发下一条（前端不在线也会发）
          setTimeout(() => void this.drainPromptQueue(state.id), 0);
        }
        break;
      }
      case "compaction_start":
        this.push(state, { type: "compact", phase: "start", reason: ev.reason || "manual" });
        break;
      case "compaction_end": {
        this.push(state, {
          type: "compact",
          phase: "end",
          aborted: Boolean(ev.aborted),
          failed: !ev.result || Boolean(ev.errorMessage),
          ...(ev.errorMessage ? { error: String(ev.errorMessage) } : {}),
        });
        break;
      }
      case "auto_retry_start":
        this.push(state, {
          type: "retry",
          phase: "start",
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          error: typeof ev.errorMessage === "string" ? ev.errorMessage : "",
        });
        break;
      case "auto_retry_end":
        this.push(state, {
          type: "retry",
          phase: "end",
          success: Boolean(ev.success),
          attempt: ev.attempt,
          ...(ev.finalError ? { error: String(ev.finalError) } : {}),
        });
        if (ev.success === false) {
          // 重试彻底失败：解锁并放行队列，避免会话永久卡在"忙"
          state.promptPending = false;
          this.pushStatus(state, "idle");
          setTimeout(() => void this.drainPromptQueue(state.id), 0);
        }
        break;
      default:
        break;
    }
  }

  /** 推送 agent 状态事件（去重：相同状态不重复推送）。 */
  pushStatus(state, status) {
    if (state.agentStatus === status) return;
    state.agentStatus = status;
    this.push(state, { type: "status", status });
  }

  /** 磁盘分支 → 同一词表的历史回放。 */
  translateBranch(branch, state = null) {
    const events = [];
    let turn = 0;
    let prevTs = 0; // 上一条消息的时间戳：assistant 用量 ÷ 与前一条的时间差 ≈ tok 速度
    let turnStartTs = 0; // 本轮用户消息时间戳：轮末时间 = 轮首 + 实测时长
    const perTurnIndex = {}; // turn → 已回放的「有正文/思考」条数：对齐实时落盘的指标
    const msgStats = (state && state.msgStatsByTurn) || null;
    const turnStats = (state && state.turnStats) || null;
    for (const entry of branch) {
      // 子代理回执（我们兜底发的）+ pi-subagents 自带通知：都当可见提示回放，
      // 否则回放历史时「子代理干完了」这件事在对话里凭空消失
      if (entry.type === "custom_message" && (entry.customType === "subagent-receipt" || entry.customType === "subagent-notify" || entry.customType === "slow-tool" || entry.customType === "async-tool-result")) {
        const text = Array.isArray(entry.content)
          ? entry.content.map((c) => (typeof c === "string" ? c : (c && c.text) || "")).join("")
          : String(entry.content || "");
        const at = entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0;
        const images = entry.customType === "async-tool-result" ? toolResultImages({ content: entry.content }) : [];
        if ((text.trim() || images.length) && entry.display !== false) events.push({ type: "notice", text: text.trim(), ...(entry.customType === "async-tool-result" ? { asyncTool: true, images } : {}), ...(at ? { at } : {}) });
        continue;
      }
      if (entry.type !== "message") continue;
      const m = entry.message;
      if (!m || !Array.isArray(m.content)) continue;
      const ts = entryTimestamp(m);
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (m.role === "user") {
        if (!text && !m.content.some((c) => c.type !== "toolResult")) continue;
        turn += 1;
        turnStartTs = ts || 0;
        events.push({ type: "turn-start", turn, ...(ts ? { at: ts } : {}) });
        // 带上条目 id：前端据此支持「双击编辑并重发」
        // 只有图片没有文字的消息也要显示（用占位文案），否则对话里凭空少一条用户消息
        const hasImages = m.content.some((c) => c.type === "image" || c.type === "image_url");
        if (text || hasImages) events.push({ type: "user", text: text || "[图片]", id: entry.id, ...this.userImageMeta(m.content), ...(ts ? { at: ts } : {}) });
      } else if (m.role === "assistant") {
        const thinking = m.content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("");
        if (text || thinking) {
          const output = partialOutputTokens(m) || 0;
          // 回放速度：优先用实时落盘的实测速度（跨重启可靠、不受时间戳抖动影响）；
          // 缺失才退回用消息时间戳估算（含排队/工具间隙，差值>$500 tok/s 视为噪声）。
          const index = perTurnIndex[turn] || 0;
          perTurnIndex[turn] = index + 1;
          const recorded = msgStats && Array.isArray(msgStats[turn]) ? msgStats[turn][index] : null;
          const seconds = output > 0 && ts > 0 && prevTs > 0 && ts > prevTs ? (ts - prevTs) / 1000 : 0;
          const plausible = seconds >= 1 && output / seconds <= 500;
          const rate = recorded && Number.isFinite(recorded.tokPerSec) && recorded.tokPerSec > 0
            ? recorded.tokPerSec
            : (plausible ? output / seconds : 0);
          events.push({
            type: "assistant-end",
            text,
            ...(thinking ? { thinking } : {}),
            stopReason: m.stopReason,
            ...(output > 0 ? { usage: { output } } : {}),
            ...(rate > 0 ? { tokPerSec: rate } : {}),
            ...(ts ? { at: ts } : {}),
          });
        }
        // 工具调用块：回放成 tool start+end 对
        for (const c of m.content) {
          if (c.type !== "toolCall") continue;
          events.push({ type: "tool", callId: c.id || `call_${events.length}`, phase: "start", name: c.name || "tool", args: capText(typeof c.arguments === "string" ? c.arguments : safeJson(c.arguments ?? {}), TOOL_ARGS_MAX_CHARS), ...(ts ? { at: ts } : {}) });
          events.push({ type: "tool", callId: c.id || `call_${events.length}`, phase: "end", name: c.name || "tool", output: "", isError: false, ...(ts ? { at: ts } : {}) });
        }
      } else if (m.role === "toolResult") {
        events.push({
          type: "tool",
          callId: m.toolCallId || `call_replay_${turn}`,
          phase: "end",
          name: m.toolName || "tool",
          output: capText(text || "[tool]"), // 回放也截断：前端只渲染前 4000 字符
          isError: Boolean(m.isError),
          ...(ts ? { at: ts } : {}),
        });
      }
      if (ts) prevTs = ts;
    }
    if (turn) {
      const durationMs = turnStats && Number.isFinite(turnStats[turn]) && turnStats[turn] > 0 ? turnStats[turn] : 0;
      // 轮末时间：优先「轮首 + 实测时长」，退回落盘的最后一条消息时间
      const at = turnStartTs && durationMs ? turnStartTs + durationMs : (prevTs || turnStartTs || 0);
      events.push({ type: "turn-end", turn, ...(durationMs ? { durationMs } : {}), ...(at ? { at } : {}) });
    }
    return events;
  }

  /** 会话指标旁车文件：实时实测的任务时长与 tok 速度，供回放/重启后还原。 */
  metricsPath(sessionId) {
    return path.join(SESSION_DIR, "..", "metrics", String(sessionId) + ".json");
  }
  loadMetrics(sessionId) {
    try {
      const data = JSON.parse(fs.readFileSync(this.metricsPath(sessionId), "utf8"));
      return {
        msgStatsByTurn: data && data.msgStatsByTurn && typeof data.msgStatsByTurn === "object" ? data.msgStatsByTurn : {},
        turnStats: data && data.turnStats && typeof data.turnStats === "object" ? data.turnStats : {},
      };
    } catch {
      return { msgStatsByTurn: {}, turnStats: {} };
    }
  }
  saveMetrics(state) {
    try {
      if (!state || !state.msgStatsByTurn || !state.turnStats) return;
      const file = this.metricsPath(state.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessionId: state.id, msgStatsByTurn: state.msgStatsByTurn, turnStats: state.turnStats }), "utf8");
      fs.renameSync(tmp, file);
    } catch (error) {
      console.error("[pi-web] metrics save failed:", error instanceof Error ? error.message : String(error));
    }
  }

  removeMetrics(sessionId) {
    try {
      fs.rmSync(this.metricsPath(sessionId), { force: true });
    } catch {
      // 指标文件残留无害，不阻断会话删除
    }
  }

  /** 事件 → SSE 帧（seq 自增；id = boot:seq，前端按 id 去重，重启不串号）。 */
  frame(state, event) {
    state.seq += 1;
    // 每个事件盖发生时间：前端渲染「几点几分」要用真实时间，不能拿渲染时刻凑
    // （历史回放时全部显示成“刷新时间”就是这么来的）
    const stamped = event && typeof event === "object" && !Number.isFinite(event.at) ? { ...event, at: Date.now() } : event;
    return { seq: state.seq, id: `${this.bootId}:${state.seq}`, event: stamped };
  }

  push(state, event, bufferEvent = null) {
    const frame = this.frame(state, event);
    // 缓冲里可以存"轻量版"（如 transcript-reset 不带整份回放），实时线仍发完整帧
    state.events.push(bufferEvent ? { ...frame, event: bufferEvent } : frame);
    if (state.events.length > EVENTS_MAX) this.trimEvents(state);
    const wire = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of state.subscribers) {
      try {
        res.write(wire);
      } catch {
        state.subscribers.delete(res);
      }
    }
  }

  /**
   * 事件缓冲溢出时的裁剪：先淘汰增量（thinking-delta/assistant-delta），
   * 结构事件不够丢时才丢最老的，并标记 truncated 供 history() 从会话文件重建。
   */
  trimEvents(state) {
    const target = state.events.length - EVENTS_LOW;
    const keep = [];
    let dropped = 0;
    for (const frame of state.events) {
      const type = frame.event && frame.event.type;
      if (dropped < target && (type === "thinking-delta" || type === "assistant-delta")) {
        dropped += 1;
        continue;
      }
      keep.push(frame);
    }
    while (keep.length > EVENTS_MAX) {
      keep.shift();
      state.eventsTruncated = true;
    }
    state.events = keep;
  }

  /** 结构事件也被挤出缓冲时，用会话文件重建回放（保证用户消息/轮次不丢）。 */
  rebuildHistoryIfTruncated(state) {
    if (!state.eventsTruncated || !state.manager) return;
    try {
      const replay = this.translateBranch(state.manager.getBranch(), state);
      state.events = replay.map((event) => this.frame(state, event));
      state.eventsTruncated = false;
    } catch (error) {
      console.error("[pi-web] history rebuild failed:", error instanceof Error ? error.message : String(error));
    }
  }

  // ── 会话生命周期 ─────────────────────────────────────────────────

  async attach(id, runtime = true) {
    if (!runtime && this.sessions.has(id)) return this.sessions.get(id);
    if (this.attachPending.has(id)) {
      await this.attachPending.get(id);
      return this.attach(id, runtime);
    }
    const pending = this.attachOnce(id, runtime);
    this.attachPending.set(id, pending);
    try { return await pending; }
    finally { this.attachPending.delete(id); }
  }

  async attachOnce(id, runtime = true) {
    const existing = this.sessions.get(id);
    if (existing) {
      if (!runtime) return existing;
      if (!existing.session && existing.manager) {
        existing.session = await this.buildSession(existing.cwd, existing.manager);
        existing.unsubscribe = existing.session.subscribe((ev) => this.translateLive(existing, ev));
        this.bindSubagentObserver(existing);
      }
      await this.refreshSessionRuntime(existing);
      return existing;
    }
    const file = await this.resolveSessionFile(id);
    if (!file) return null;
    const sdk = await this.sdkReady();
    const manager = sdk.SessionManager.open(file, SESSION_DIR);
    const metrics = this.loadMetrics(id);
    const state = {
      id,
      session: null,
      manager,
      unsubscribe: null,
      seq: 0,
      turn: 0,
      streaming: false,
      hasStreamed: false,
      agentStatus: "idle",
      calls: new Map(),
      subscribers: new Set(),
      events: [],
      eventsTruncated: false,
      subagentRuns: [],
      cwd: manager.getCwd(),
      modelsMtime: this.modelsMtime(),
      thinkingChosen: false,
      msgStartedAt: 0,
      promptPending: false,
      turnStartedAt: 0,
      msgStatsByTurn: metrics.msgStatsByTurn,
      turnStats: metrics.turnStats,
    };
    const replay = this.translateBranch(manager.getBranch(), state);
    for (const event of replay) state.events.push(this.frame(state, event));
    state.turn = replay.filter((e) => e.type === "turn-start").length;
    this.sessions.set(id, state);
    if (runtime) {
      state.session = await this.buildSession(state.cwd, manager);
      // 冷启动会话的实际模型来自会话文件：同步给重试设置用
      try {
        const stored = manager.buildSessionContext();
        if (stored.model && state.session.__retryRef) state.session.__retryRef.provider = stored.model.provider;
      } catch {
        // 读不到就不猜，维持 buildSession 时的默认
      }
      state.unsubscribe = state.session.subscribe((ev) => this.translateLive(state, ev));
      this.bindSubagentObserver(state);
    }
    return state;
  }

  async create({ cwd, warmup } = {}) {
    this.diskCacheUntil = 0; // 会话集合变了：让磁盘列表缓存立刻过期
    const dir = cwd ? path.resolve(String(cwd)) : ROOT;
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, status: 400, error: `工作区目录不存在：${dir}` };
    }
    const session = await this.buildSession(dir);
    const id = String(session.sessionId);
    if (warmup) return { id };
    const state = {
      id,
      session,
      manager: null,
      unsubscribe: null,
      seq: 0,
      turn: 0,
      streaming: false,
      hasStreamed: false,
      agentStatus: "idle",
      calls: new Map(),
      subscribers: new Set(),
      events: [],
      eventsTruncated: false,
      subagentRuns: [],
      cwd: dir,
      modelsMtime: this.modelsMtime(),
      thinkingChosen: false,
      msgStartedAt: 0,
      promptPending: false,
      turnStartedAt: 0,
      msgStatsByTurn: {},
      turnStats: {},
    };
    state.unsubscribe = session.subscribe((ev) => this.translateLive(state, ev));
    this.bindSubagentObserver(state);
    this.sessions.set(id, state);
    return { id };
  }

  agentFromChildName(name) {
    const match = String(name || "").match(/^subagent-([a-zA-Z0-9._-]+)-[0-9a-f]{6,}-\d+$/i);
    return match ? match[1] : "";
  }

  /**
   * 轻量会话状态（给前端 3s 轮询的旗帜用）：只报 id/标题/是否在跑/更新时间。
   * 关键是**不读会话文件**——完整列表的 listAll 要解析几十 MB JSON（~2s），
   * 轮询它会把事件循环周期性堵死（SSE 一起停，表现就是“一发消息就卡”）。
   */
  async runningSessions() {
    const out = new Map();
    for (const [id, state] of this.sessions) {
      const key = String(id);
      out.set(key, {
        id: key,
        title: this.titleOf(state) || "",
        cwd: state.cwd || "",
        running: Boolean((state.session && state.session.isStreaming) || state.promptPending),
        updatedAt: (state.session && state.session.turnStartedAt) || (state.manager && state.manager.getHeader && 0) || 0,
      });
    }
    try {
      for (const name of fs.readdirSync(SESSION_DIR)) {
        if (!name.endsWith(".jsonl")) continue;
        const m = name.match(/_([0-9a-f-]{36})\.jsonl$/i) || name.match(/^([0-9a-f-]{36})\.jsonl$/i);
        if (!m) continue;
        const id = m[1];
        if (out.has(id)) continue;
        let updatedAt = 0;
        try { updatedAt = fs.statSync(path.join(SESSION_DIR, name)).mtimeMs; } catch { updatedAt = 0; }
        out.set(id, { id, title: "", running: false, updatedAt });
      }
    } catch {
      // 目录读不到就只返回内存里的
    }
    return [...out.values()];
  }

  async diskSessions() {
    if (this.diskCache && Date.now() < this.diskCacheUntil) return this.diskCache;
    if (this.diskPending) return this.diskPending;
    this.diskPending = this.scanDiskSessions();
    try {
      this.diskCache = await this.diskPending;
      // 冷扫要全量读会话文件（几十 MB）；TTL 太短会让事件循环周期性卡住（SSE 一起停）
      this.diskCacheUntil = Date.now() + 60000;
      return this.diskCache;
    } finally { this.diskPending = null; }
  }

  /**
   * 列会话只取文件开头 8KB 里的第一行。那一行是会话头，带工作区和父会话。
   * 后面的消息行能到几十 MB，解析它们会把「加载工作区」堵住。
   */
  outlineSession(file) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8", 0, read);
      const end = text.indexOf("\n");
      const line = (end === -1 ? text : text.slice(0, end)).replace(/^\uFEFF/, "").trim();
      const stamp = fs.fstatSync(fd).mtime;
      const idFromName = (path.basename(file).match(/_([0-9a-f-]{36})\.jsonl$/i) || [])[1] || "";
      let entry = null;
      if (line && end !== -1) {
        try { entry = JSON.parse(line); } catch { entry = null; }
      }
      if (!entry || entry.type !== "session") {
        if (!idFromName) return null;
        return { path: file, id: idFromName, cwd: "", name: "", parentSessionPath: "", created: stamp, modified: stamp, messageCount: 0, firstMessage: "" };
      }
      const created = new Date(entry.timestamp || 0);
      return {
        path: file,
        id: String(entry.id || idFromName),
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        name: "",
        parentSessionPath: entry.parentSession || "",
        created: Number.isNaN(created.getTime()) ? stamp : created,
        modified: stamp,
        messageCount: 0,
        firstMessage: "",
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  async scanDiskSessions() {
    let names = [];
    try { names = fs.readdirSync(SESSION_DIR).filter((name) => name.endsWith(".jsonl")); }
    catch { return []; }
    const disk = [];
    for (const name of names) {
      try {
        const info = this.outlineSession(path.join(SESSION_DIR, name));
        if (info) disk.push(info);
      } catch { /* 一个坏文件不影响列表 */ }
    }
    for (const item of disk) {
      if (item.id && item.path) this.sessionPaths.set(String(item.id), String(item.path));
    }
    return disk;
  }

  async childSessions(parentId) {
    const parentPath = this.sessionPaths.get(String(parentId)) || "";
    const disk = await this.diskSessions();
    return disk.filter((item) => {
      const parentFile = item.parentSessionPath || item.parentSession;
      if (!parentFile) return false;
      const normalized = path.normalize(String(parentFile));
      return (parentPath && path.normalize(parentPath) === normalized) || normalized.includes(String(parentId));
    }).map((item) => ({
      id: String(item.id),
      name: item.name || "",
      agent: this.agentFromChildName(item.name),
      updatedAt: item.modified?.getTime?.() ?? item.created?.getTime?.() ?? 0,
    })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  mergeSubagentQueue(snapshot, children) {
    const agents = new Map((snapshot.agents || []).map((agent) => [agent.agent || agent.name, { ...agent, conversations: [...(agent.conversations || [])] }]));
    const add = (name, conv) => {
      if (!name || !conv.sessionId) return;
      if (!agents.has(name)) {
        agents.set(name, { agent: name, name, status: conv.status || "completed", activeCount: 0, runId: conv.sessionId, conversations: [] });
      }
      const row = agents.get(name);
      if (!row.conversations.some((item) => item.sessionId === conv.sessionId)) {
        row.conversations.push({ sessionId: conv.sessionId, name: conv.name || name, updatedAt: conv.updatedAt || 0 });
      }
      if (!row.sessionId) row.sessionId = conv.sessionId;
    };
    for (const run of snapshot.runs || []) {
      const sessionId = run.childSessionId || idFromSessionFile(run.sessionFile);
      if (sessionId) add(run.agent, { sessionId, name: run.agent, updatedAt: run.endedAt || run.startedAt || 0, status: run.status });
    }
    for (const child of children || []) add(child.agent || "subagent", { sessionId: child.id, name: child.name, updatedAt: child.updatedAt });
    return { ...snapshot, agents: [...agents.values()] };
  }

  readArtifactTranscript(file) {
    if (!file || !fs.existsSync(file)) return [];
    const events = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const text = row.text || "";
        if (row.role === "user" && text) events.push({ type: "user", text });
        if ((row.role === "assistant" || row.sourceEventType === "message_end" && row.role === "assistant") && text) {
          events.push({ type: "assistant-end", text });
        }
      } catch {}
    }
    return conversationEvents(events);
  }

  async childTranscript(parentId, childId) {
    const wanted = String(childId);
    const snapDir = path.join(SESSION_DIR, "..", "subagents");
    const observer = this.subagentObservers.get(parentId);
    const registry = observer?.registry || (fs.existsSync(path.join(snapDir, parentId + ".json")) ? new SubagentRuns({ dir: snapDir, sessionId: parentId }) : null);
    if (registry) registry.refreshFiles();
    const run = registry ? [...registry.runs.values()].find((item) => item.childSessionId === wanted || item.id === wanted || String(item.runId) === wanted) : null;
    if (run?.transcriptPath) {
      const events = this.readArtifactTranscript(run.transcriptPath);
      if (events.length) return { sessionId: run.childSessionId || wanted, agent: run.agent, name: run.agent, events };
    }
    const children = await this.childSessions(parentId);
    const child = children.find((item) => item.id === wanted) || (run?.childSessionId && { id: run.childSessionId, agent: run.agent, name: run.agent });
    const file = child ? await this.resolveSessionFile(child.id) : null;
    if (file) {
      const sdk = await this.sdkReady();
      const manager = sdk.SessionManager.open(file, SESSION_DIR);
      const events = conversationEvents(this.translateBranch(manager.getBranch()));
      if (events.length) return { sessionId: child.id, agent: child.agent, name: child.name, events };
    }
    if (run && (run.task || run.result || run.error)) {
      return {
        sessionId: run.childSessionId || wanted,
        agent: run.agent,
        name: run.agent,
        events: [
          run.task ? { type: "user", text: run.task } : null,
          (run.result || run.error) ? { type: "assistant-end", text: run.result || "", error: run.error || undefined } : null,
        ].filter(Boolean),
      };
    }
    return null;
  }

  isChildSession(info = {}, state = null) {
    const name = info.name || state?.session?.sessionName || (typeof state?.manager?.getSessionName === "function" && state.manager.getSessionName()) || "";
    let header = null;
    try {
      header = state?.manager?.getHeader?.() || state?.session?.sessionManager?.getHeader?.() || null;
    } catch {}
    if (isChildSessionInfo(info, name, header)) return true;
    // SDK discovery already parsed the header; avoid rereading every full log.
    if (info.path) return false;
    const file = info.id && this.sessionPaths.get(String(info.id));
    if (!file) return false;
    try {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(8192);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        const text = buf.toString("utf8", 0, read);
        const end = text.indexOf("\n");
        if (end <= 0) return false;
        return isChildSessionInfo({}, "", JSON.parse(text.slice(0, end)));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  async list() {
    const disk = await this.diskSessions();
    const hidden = new Set();
    const items = [];
    for (const s of disk.slice(0, 400)) {
      const id = String(s.id || "");
      if (s.id && s.path) this.sessionPaths.set(id, String(s.path));
      if (this.isChildSession(s, this.sessions.get(id))) {
        hidden.add(id);
        continue;
      }
      const mem = this.sessions.get(id);
      items.push({
        id,
        title: (mem && this.titleOf(mem)) || s.name || String(s.firstMessage || "").slice(0, 40),
        updatedAt: s.modified?.getTime?.() ?? s.created?.getTime?.() ?? 0,
        messageCount: s.messageCount ?? 0,
        running: Boolean(mem?.session?.isStreaming || mem?.promptPending), // 重试等待期也算「任务中」
        cwd: s.cwd ?? ROOT,
      });
    }
    for (const [id, state] of this.sessions) {
      if (hidden.has(id) || this.isChildSession({}, state) || items.some((i) => i.id === id)) continue;
      items.push({
        id,
        title: this.titleOf(state),
        updatedAt: Date.now(),
        messageCount: state.turn,
        running: Boolean(state.session?.isStreaming || state.promptPending), // 重试等待期也算「任务中」
        cwd: state.cwd,
      });
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  }

  titleOf(state) {
    if (state.title) return state.title;
    const firstUser = state.events.find((f) => f.event.type === "user");
    if (firstUser) return firstUser.event.text.slice(0, 40);
    return "新会话";
  }

  /**
   * 用户消息所带图片的展示元信息：永远给张数（前端显示「🖼 图片×N」），
   * 体积小才附带缩略数据（大图的 base64 走 SSE/事件缓冲会把内存撑爆）。
   */
  userImageMeta(blocks) {
    const imgs = (Array.isArray(blocks) ? blocks : []).filter((c) => c && (c.type === "image" || c.type === "image_url"));
    if (!imgs.length) return {};
    const datas = imgs.map((c) => {
      const raw = c.type === "image_url" ? String((c.image_url && c.image_url.url) || "") : String(c.data || "");
      const comma = raw.indexOf(",");
      return raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw;
    });
    const mimes = imgs.map((c) => String(c.mimeType || c.mime_type || "image/png"));
    const total = datas.reduce((n, d) => n + d.length, 0);
    const meta = { imageCount: imgs.length };
    if (total > 0 && total <= 600_000) {
      meta.images = datas;
      meta.imageMimes = mimes;
    }
    return meta;
  }

  async resolveSessionFile(id) {
    await this.diskSessions();
    return this.sessionPaths.get(String(id)) || null;
  }

  sessionView(state) {
    const model = state.session?.model;
    const stored = !state.session ? state.manager?.buildSessionContext() : null;
    return {
      id: state.id,
      title: this.titleOf(state),
      cwd: state.cwd,
      turn: state.turn,
      running: Boolean(state.session?.isStreaming || state.promptPending), // 重试等待期也算「任务中」
      model: model ? { provider: model.provider, modelId: model.id } : stored?.model || null,
      thinkingLevel: state.session?.thinkingLevel ?? stored?.thinkingLevel ?? null,
      // false = pi 按全局/模型默认自选的（UI 显示「默认·X」），true = 用户主动选过
      thinkingExplicit: Boolean(state.thinkingChosen),
      // 运行中：任务计时起点（毫秒），前端据此还原「任务中」已耗时
      turnStartedAt: state.turnStartedAt || 0,
      // 服务端待发队列（切走再回来也要能看见）
      promptQueue: this.queueView(state.id),
      seq: state.seq,
    };
  }

  async history(id, options = {}) {
    const state = await this.attach(id, false);
    if (!state) return null;
    // 缓冲里结构事件被挤掉过 → 用会话文件重建，保证回放不丢用户消息（对话定位依赖它）
    this.rebuildHistoryIfTruncated(state);
    // 后台预热运行时会话：冷启动构建要等插件/MCP 初始化（可达分钟级），
    // 不能让第一次 prompt/edit 在请求里白等；等它构建好，后续请求直接可用。
    if (!state.session) {
      this.attach(id, true).catch((error) => {
        console.error("[pi-web] runtime warm failed:", error instanceof Error ? error.message : String(error));
      });
    }
    // 切换会话的"秒开"路径：前端带上已渲染到的最新 seq + bootId，
    // 只回新增帧（否则每次都要传几 MB 全量历史）。bootId 不匹配说明服务端重启过 → 回全量。
    const since = Number.isFinite(options.since) && options.since > 0 ? options.since : 0;
    const sameBoot = !options.boot || options.boot === this.bootId;
    const events = since && sameBoot ? state.events.filter((frame) => frame.seq > since) : state.events;
    return { session: this.sessionView(state), events, bootId: this.bootId };
  }

  /** SSE 订阅：只回放 history 之后的新帧，再接实时流。 */
  subscribe(id, res, options = {}) {
    return this.attach(id, false).then((state) => {
      if (res.destroyed) return; // 快速切换期间客户端可能已经取消订阅
      if (!state) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("session not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.flushHeaders?.(); // 没有新增帧时也立即建立 SSE 连接
      this.rebuildHistoryIfTruncated(state);
      const since = Number.isFinite(options.since) && options.since > 0 ? options.since : 0;
      const sameBoot = !options.boot || options.boot === this.bootId;
      const replay = since && sameBoot ? state.events.filter((frame) => frame.seq > since) : state.events;
      for (const frame of replay) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      state.subscribers.add(res);
      res.on("close", () => state.subscribers.delete(res));
      // 与 history 一致：打开过会话就后台预热运行时，第一次 prompt/edit 不再白等
      if (!state.session) {
        this.attach(id, true).catch((error) => {
          console.error("[pi-web] runtime warm failed:", error instanceof Error ? error.message : String(error));
        });
      }
    });
  }

  /**
   * 把用户附带的图片落盘到 config/.pi-web/attachments/<会话>/，
   * 返回可给模型读的绝对路径（模型"看得见"图，但要处理原图/切图/像素化还得有文件）。
   * 落盘失败不影响发送，只是模型拿不到路径。
   */
  savePromptImages(id, pics) {
    const out = [];
    try {
      const dir = path.join(SESSION_DIR, "attachments", String(id));
      fs.mkdirSync(dir, { recursive: true });
      pics.forEach((im, i) => {
        const ext = (String(im.mimeType || "image/png").split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
        const file = path.join(dir, `${Date.now()}-${i + 1}.${ext}`);
        fs.writeFileSync(file, Buffer.from(String(im.data), "base64"));
        out.push(file);
      });
    } catch (error) {
      console.error("[pi-web] 附件图片落盘失败:", error instanceof Error ? error.message : error);
    }
    return out;
  }

  async prompt(id, text, images) {
    const state = await this.attach(id);
    if (!state || !state.session) return { ok: false, error: "session not found" };
    if (state.session.isStreaming || state.promptPending) {
      // 任务进行中不接受新 prompt：避免把正在跑的任务打断（前端应先排队/停止）
      return { ok: false, status: 409, error: "任务进行中：先点「■ 停止」停止当前任务" };
    }
    const body = String(text ?? "").trim();
    const pics = Array.isArray(images) ? images.slice(0, 8) : [];
    // 只发图不带字是合法的：文本为空时用占位文案，别报 empty prompt
    if (!body && !pics.length) return { ok: false, error: "empty prompt" };
    state.promptPending = true; // 原子锁：SDK 的 isStreaming 要等首个 delta 才为真，不加锁会被连点穿透
    this.push(state, { type: "user", text: body || "[图片]", ...this.userImageMeta(pics) });
    const opts = pics.length
      ? { images: pics.map((im) => ({ type: "image", data: String(im.data), mimeType: String(im.mimeType) })) }
      : undefined;
    // 附件图片落盘：把路径一并告诉模型，否则它只能"看"图、没法处理原图文件
    const savedImages = pics.length ? this.savePromptImages(state.id, pics) : [];
    const promptText = savedImages.length
      ? `${body}${body ? "\n\n" : ""}[附件图片已保存到以下路径，需要处理原图（裁剪/像素化/改尺寸等）时直接读这些文件：\n${savedImages.map((f) => `- ${f}`).join("\n")}]`
      : body;
    const manager = state.session.sessionManager;
    // 新用户消息的父节点 = 发送前的叶子；落盘后据此补推条目 id（流式 user 事件没有 id）。
    // 前端「双击编辑重发」依赖它，否则本条消息要等会话从文件重建后才能编辑。
    let prevLeafId = null;
    try { prevLeafId = manager && typeof manager.getLeafEntry === "function" ? (manager.getLeafEntry()?.id ?? null) : null; } catch { prevLeafId = null; }
    const expectParent = prevLeafId;
    state.session.prompt(promptText, opts).catch((error) => {
      console.error("[pi-web] prompt failed:", error instanceof Error ? error.message : error);
      state.promptPending = false; // 起跑失败：解锁，允许重新发送
      this.pushStatus(state, "retry");
      this.push(state, { type: "assistant-end", stopReason: "error", error: error instanceof Error ? error.message : String(error) });
      this.pushStatus(state, "idle");
    });
    let tries = 0;
    const attachId = () => {
      const leaf = manager && typeof manager.getLeafEntry === "function" ? manager.getLeafEntry() : null;
      if (leaf && leaf.id !== prevLeafId && leaf.type === "message" && leaf.message?.role === "user" && (leaf.parentId || null) === expectParent) {
        this.push(state, { type: "user-id", id: leaf.id, text: body || "[图片]" });
      } else if (++tries < 100) {
        setTimeout(attachId, 100);
      }
    };
    attachId();
    return { ok: true };
  }

  // ── 服务端待发队列（切走会话也能后台按序发出） ─────────────────────

  /** 队列视图（给前端渲染）：只带元信息，不带图片数据。 */
  queueView(id) {
    return (this.promptQueues.get(String(id)) || []).map((item) => ({
      id: item.id,
      text: item.text,
      images: (item.images || []).length,
    }));
  }

  pushPromptQueue(state) {
    if (!state) return;
    this.push(state, { type: "prompt-queue", items: this.queueView(state.id) });
  }

  async enqueuePrompt(id, text, images) {
    const state = await this.attach(id);
    if (!state || !state.session) return { ok: false, status: 404, error: "session not found" };
    const body = String(text ?? "").trim();
    const pics = Array.isArray(images) ? images.slice(0, 8) : [];
    if (!body && !pics.length) return { ok: false, status: 400, error: "empty prompt" };
    const item = { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: body, images: pics };
    const queue = this.promptQueues.get(state.id) || [];
    queue.push(item);
    this.promptQueues.set(state.id, queue);
    this.pushPromptQueue(state);
    void this.drainPromptQueue(state.id);
    return { ok: true, id: item.id, queue: this.queueView(state.id) };
  }

  async removeQueuedPrompt(id, itemId) {
    const key = String(id);
    const queue = this.promptQueues.get(key) || [];
    const index = queue.findIndex((item) => item.id === itemId);
    if (index < 0) return { ok: false, status: 404, error: "queue item not found" };
    queue.splice(index, 1);
    this.promptQueues.set(key, queue);
    this.pushPromptQueue(this.sessions.get(key));
    return { ok: true, queue: this.queueView(key) };
  }

  /** 插队：提到队首并打断当前任务，让它立刻发出。 */
  async jumpQueuedPrompt(id, itemId) {
    const key = String(id);
    const queue = this.promptQueues.get(key) || [];
    const index = queue.findIndex((item) => item.id === itemId);
    if (index < 0) return { ok: false, status: 404, error: "queue item not found" };
    const [item] = queue.splice(index, 1);
    queue.unshift(item);
    this.promptQueues.set(key, queue);
    const state = this.sessions.get(key);
    this.pushPromptQueue(state);
    if (state && (state.session?.isStreaming || state.promptPending)) await this.stop(key);
    void this.drainPromptQueue(key);
    return { ok: true, queue: this.queueView(key) };
  }

  /** 空闲就发出队首；发送失败保留在队首，等下次时机。 */
  async drainPromptQueue(id) {
    const key = String(id);
    const state = this.sessions.get(key);
    if (!state || !state.session || state.drainingQueue) return;
    if (state.session.isStreaming || state.promptPending) return;
    const queue = this.promptQueues.get(key) || [];
    if (!queue.length) return;
    state.drainingQueue = true;
    try {
      const item = queue[0];
      const result = await this.prompt(key, item.text, item.images);
      if (result && result.ok) {
        queue.shift();
        this.pushPromptQueue(state);
      }
    } finally {
      state.drainingQueue = false;
    }
  }

  /**
   * 编辑历史用户消息并重新发送：navigateTree 把叶子回退到该消息之前（旧分支
   * 保留在文件里，agent 上下文同步重建），新文本作为该位置的新分支发出。
   */
  async editPrompt(id, entryId, text) {
    const state = await this.attach(id);
    if (!state || !state.session) return { ok: false, error: "session not found" };
    const body = String(text ?? "").trim();
    if (!body) return { ok: false, error: "empty prompt" };
    if (state.session.isStreaming) return { ok: false, status: 409, error: "会话运行中，请先停止再编辑" };
    const manager = state.session.sessionManager;
    const entry = manager.getEntry(String(entryId));
    if (!entry || entry.type !== "message" || entry.message?.role !== "user") {
      return { ok: false, error: "找不到可编辑的消息（可能已被编辑过）" };
    }
    try {
      const nav = await state.session.navigateTree(String(entryId));
      if (nav?.cancelled) return { ok: false, status: 409, error: "编辑被取消" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // 事件缓冲重建为新分支的回放（旧分支消息从视图中消失）；seq 继续递增，
    // 已连接的订阅端按 seq 去重不会漏收，靠 transcript-reset 清空重绘。
    state.events = [];
    state.hasStreamed = false;
    const replay = this.translateBranch(manager.getBranch(), state);
    for (const event of replay) state.events.push(this.frame(state, event));
    state.turn = replay.filter((e) => e.type === "turn-start").length;
    this.push(state, { type: "transcript-reset", events: replay }, { type: "transcript-reset" });
    this.push(state, { type: "user", text: body });
    state.session.prompt(body).catch((error) => {
      console.error("[pi-web] edit prompt failed:", error instanceof Error ? error.message : error);
      this.pushStatus(state, "retry");
      this.push(state, { type: "assistant-end", stopReason: "error", error: error instanceof Error ? error.message : String(error) });
      this.pushStatus(state, "idle");
    });
    // prompt 落盘用户消息后补推条目 id（流式 user 事件没有 id）；
    // 以「父节点 = 编辑点原父节点」精确匹配，避免误绑到旧分支的同文本消息。
    const expectParent = entry.parentId || null;
    let tries = 0;
    const attachId = () => {
      const leaf = typeof manager.getLeafEntry === "function" ? manager.getLeafEntry() : null;
      if (leaf && leaf.type === "message" && leaf.message?.role === "user" && (leaf.parentId || null) === expectParent) {
        this.push(state, { type: "user-id", id: leaf.id, text: body });
      } else if (++tries < 100) {
        setTimeout(attachId, 100);
      }
    };
    attachId();
    return { ok: true };
  }

  async stop(id) {
    const state = await this.attach(id);
    if (state?.session && typeof state.session.abort === "function") {
      // 反复点击停止时复用同一个收尾任务，避免多个轮询互相覆盖状态。
      if (state.stopPromise) return { ok: true, stopping: true };
      state.promptPending = false; // 停止后解锁，允许立刻再发
      state.stopRequested = true;
      // 立刻推「停止中」：abort 真正停稳可能要几秒（甚至等不到 agent_end）。
      // 以前这里会同步等 8s 才回 HTTP，点击像没反应，用户只能刷新页面确认。
      try { this.push(state, { type: "stopping" }); } catch { /* 界面旁路 */ }
      // 后台盯到停稳，再补 turn-end / status：不阻塞 stop 请求本身。
      // SDK 的 abort 在部分工具（尤其 subagent_wait）上可能返回 Promise，
      // 也可能永远等不到 isStreaming=false，因此必须有本地硬兜底。
      state.stopPromise = (async () => {
        let abortError = null;
        try {
          await Promise.race([
            Promise.resolve(state.session.abort()),
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]);
        } catch (error) {
          abortError = error;
        }
        const deadline = Date.now() + 10000;
        while (state.session.isStreaming && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const stillStreaming = Boolean(state.session.isStreaming);
        state.stopRequested = false;
        state.promptPending = false;
        state.calls.clear();
        state.streaming = false;
        state.msgStartedAt = 0;
        // 无论 SDK 是否及时更新状态，前端都必须收到终态，不能永久停在“停止中”。
        this.push(state, { type: "turn-end", turn: state.turn, retry: false, aborted: true });
        this.pushStatus(state, "idle");
        if (stillStreaming || abortError) {
          try {
            this.push(state, { type: "notice", text: stillStreaming
              ? "停止请求已发送，后台工具仍在退出；界面已恢复，可稍后重试。"
              : `停止请求遇到异常：${abortError instanceof Error ? abortError.message : String(abortError)}` });
          } catch { /* 旁路 */ }
        }
        if (!stillStreaming) setTimeout(() => void this.drainPromptQueue(state.id), 0);
        state.stopPromise = null;
      })();
    }
    return { ok: true };
  }
  // ── 以下方法为误删后从 git HEAD 原样恢复（本会话未改动过这些方法） ──

  async compact(id) {
    const state = await this.attach(id);
    if (!state || !state.session) return { ok: false, error: "session not found" };
    if (state.session.isStreaming) return { ok: false, status: 409, error: "会话运行中，请先停止再压缩" };
    if (state.session.isCompacting) return { ok: false, status: 409, error: "压缩已在进行中" };
    try {
      const result = await state.session.compact();
      return { ok: true, result: result || null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async rename(id, title) {
    const state = await this.attach(id);
    if (!state) return { ok: false, error: "session not found" };
    const clean = String(title ?? "").trim().slice(0, 80);
    state.title = clean || undefined;
    if (state.session && typeof state.session.setSessionName === "function") {
      try {
        state.session.setSessionName(clean);
      } catch {
        // 会话名持久化失败不影响运行
      }
    }
    this.push(state, { type: "title", title: this.titleOf(state) });
    return { ok: true, title: this.titleOf(state) };
  }

  async remove(id) {
    this.diskCacheUntil = 0; // 删除会话：磁盘列表缓存立刻过期
    const state = this.sessions.get(id);
    if (state?.session?.isStreaming) return { ok: false, status: 409, error: "session is running" };
    const file = await this.resolveSessionFile(id);
    if (state) {
      if (state.unsubscribe) state.unsubscribe();
      if (state.session && typeof state.session.dispose === "function") {
        try {
          state.session.dispose();
        } catch {
          // dispose 不存在或失败都不阻断删除
        }
      }
      this.sessions.delete(id);
    }
    if (!file) {
      // 空会话不落盘（首条消息才写文件）：内存态已清即为删除成功。
      if (state) return { ok: true };
      return { ok: false, status: 404, error: "session not found" };
    }
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) };
    }
    this.sessionPaths.delete(id);
    this.diskCacheUntil = 0;
    if (this.diskCache) this.diskCache = this.diskCache.filter((item) => String(item.id) !== String(id));
    return { ok: true };
  }

  async setModel(id, provider, modelId) {
    const state = await this.attach(id);
    if (!state?.session) return { ok: false, status: 404, error: "session not found" };
    const runtime = await this.runtime();
    const model = runtime.getModel(String(provider ?? "").trim(), String(modelId ?? "").trim());
    if (!model) return { ok: false, status: 400, error: `model not in catalog: ${provider}/${modelId}` };
    try {
      await state.session.setModel(model);
    } catch (error) {
      return { ok: false, status: 409, error: error instanceof Error ? error.message : String(error) };
    }
    if (state.session.__retryRef) state.session.__retryRef.provider = model.provider;
    this.push(state, { type: "model", provider: model.provider, modelId: model.id });
    // setModel 内部会按新模型重挑思考强度（per-model 覆盖/默认值），补推真实生效值
    this.push(state, {
      type: "thinking",
      level: state.session.thinkingLevel ?? null,
      explicit: Boolean(state.thinkingChosen),
    });
    return { ok: true };
  }

  async setThinking(id, level) {
    const state = await this.attach(id);
    if (!state?.session) return { ok: false, status: 404, error: "session not found" };
    try {
      state.session.setThinkingLevel(String(level ?? "").trim());
    } catch (error) {
      return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
    }
    state.thinkingChosen = true; // 用户主动选过，之后显示不再是「默认」
    this.push(state, {
      type: "thinking",
      level: state.session.thinkingLevel ?? level,
      explicit: true,
    });
    return { ok: true, level: state.session.thinkingLevel ?? level };
  }

  async thinkingInfo(id) {
    const state = await this.attach(id, false);
    if (!state) return { ok: false, status: 404, error: "会话不存在" };
    const view = this.sessionView(state);
    if (!view.model) return { ok: false, status: 400, error: "请先选择模型" };
    const runtime = await this.runtime();
    const model = (runtime.getModels(view.model.provider) || []).find((item) => item.id === view.model.modelId);
    if (!model) return { ok: false, status: 404, error: "模型已不在当前配置中，请重新选择" };
    const sdk = await this.sdkReady();
    const levels = sdk.AgentSession.prototype.getAvailableThinkingLevels.call({ model });
    return {
      ok: true,
      levels,
      source: "configuration",
      level: view.thinkingLevel,
      explicit: Boolean(state.thinkingChosen),
      model: view.model,
    };
  }

  async contextInfo(id) {
    const state = await this.attach(id, false);
    if (!state) return { ok: false, status: 404, error: "session not found" };
    const session = state.session;
    if (!session) return { ok: true, contextWindow: 0, total: null, percent: null, parts: {}, cache: null, model: this.sessionView(state).model };
    let usage = null;
    try {
      usage = session.getContextUsage() || null;
    } catch {
      usage = null;
    }
    const model = session.model;
    const contextWindow = usage?.contextWindow || model?.contextWindow || 0;
    const est = (text) => Math.ceil(String(text || "").length / 4);
    let block = null;
    try {
      block = this.presetStore.buildBlock(state.cwd, state.id);
    } catch {
      block = null;
    }
    const presetsTok = block ? est(block) : 0;
    const sysText = typeof session.systemPrompt === "string" ? session.systemPrompt : "";
    let sysTok = est(sysText);
    if (block && sysText.includes(block)) sysTok = Math.max(0, sysTok - presetsTok);
    let toolsTok = 0;
    try {
      const active = new Set(session.getActiveToolNames() || []);
      for (const t of session.getAllTools() || []) {
        if (!t || !t.name || !active.has(t.name)) continue;
        let schema = "";
        try {
          schema = JSON.stringify(t.parameters ?? {});
        } catch {
          schema = "";
        }
        toolsTok += est(`${t.name}\n${t.description || ""}\n${t.promptGuidelines || ""}\n${schema}`);
      }
    } catch {
      // 工具面读不到按 0，不阻断其余分项
    }
    const total = typeof usage?.tokens === "number" ? usage.tokens : null;
    const historyTok = total === null ? null : Math.max(0, total - sysTok - toolsTok - presetsTok);
    // 缓存命中：取最后一条带 usage 的 assistant 消息（provider 口径：
    // 命中率 = cacheRead ÷ (input + cacheRead + cacheWrite)）
    let cache = null;
    try {
      const msgs = session.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const u = msgs[i]?.usage;
        if (msgs[i]?.role === "assistant" && u && typeof u.cacheRead === "number") {
          cache = { read: u.cacheRead || 0, write: u.cacheWrite || 0, input: u.input || 0 };
          break;
        }
      }
    } catch {
      cache = null;
    }
    return {
      ok: true,
      contextWindow,
      total,
      percent: typeof usage?.percent === "number" ? usage.percent : null,
      parts: { system: sysTok, tools: toolsTok, presets: presetsTok, history: historyTok },
      // 本对话累计用量：把整条分支上所有 assistant 消息的 usage 加总（含输入/输出/缓存）
      totals: (() => {
        const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0 };
        try {
          const branch = session.sessionManager && typeof session.sessionManager.getBranch === "function"
            ? session.sessionManager.getBranch()
            : [];
          for (const entry of branch) {
            if (!entry || entry.type !== "message") continue;
            const m = entry.message;
            if (!m || m.role !== "assistant" || !m.usage) continue;
            const u = m.usage;
            sum.input += Number(u.input) || 0;
            sum.output += Number(u.output) || 0;
            sum.cacheRead += Number(u.cacheRead) || 0;
            sum.cacheWrite += Number(u.cacheWrite) || 0;
            // 统一口径：total = input + cache + output。provider 的 totalTokens 有的不含缓存、
            // 有的只算非缓存输入，直接加总会出现「累计比输入还小」这种自相矛盾
            sum.total += (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
            sum.calls += 1;
          }
        } catch {
          // 读不到分支就当 0，不影响上下文分项
        }
        return sum;
      })(),
      cache,
      model: model ? { provider: model.provider, modelId: model.id } : null,
    };
  }

  /**
   * 用量报表：扫全部会话文件里 assistant 消息的 usage，按「服务商/模型」汇总。
   * 带 60s 缓存（会话文件可能几十 MB，列表页不该每次重扫）。
   */
  async usageReport() {
    const now = Date.now();
    if (this.usageCache && now - this.usageCache.at < 60_000) return this.usageCache.data;
    const models = new Map(); // provider/modelId -> 汇总
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0 };
    let sessions = 0;
    let lastAt = 0;
    const bump = (key, provider, modelId, u, at) => {
      let row = models.get(key);
      if (!row) { row = { provider, modelId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0, lastAt: 0 }; models.set(key, row); }
      row.input += Number(u.input) || 0;
      row.output += Number(u.output) || 0;
      row.cacheRead += Number(u.cacheRead) || 0;
      row.cacheWrite += Number(u.cacheWrite) || 0;
      row.total += (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
      row.calls += 1;
      if (at > row.lastAt) row.lastAt = at;
      totals.input += Number(u.input) || 0;
      totals.output += Number(u.output) || 0;
      totals.cacheRead += Number(u.cacheRead) || 0;
      totals.cacheWrite += Number(u.cacheWrite) || 0;
      totals.total += row.total;
      totals.calls += 1;
      if (at > lastAt) lastAt = at;
    };
    try {
      const files = fs.existsSync(SESSION_DIR) ? fs.readdirSync(SESSION_DIR).filter((n) => n.endsWith(".jsonl")) : [];
      for (const name of files) {
        const file = path.join(SESSION_DIR, name);
        let text = "";
        try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
        sessions += 1;
        const mtime = (() => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } })();
        for (const line of text.split(/\r?\n/)) {
          if (!line || line.indexOf('"usage"') < 0 || line.indexOf('"role":"assistant"') < 0) continue;
          try {
            const row = JSON.parse(line);
            const m = row && row.message;
            if (!m || m.role !== "assistant" || !m.usage) continue;
            const provider = m.provider || "未知";
            const modelId = m.model || m.modelId || "未知";
            const at = Date.parse(row.timestamp || "") || mtime;
            bump(provider + "/" + modelId, provider, modelId, m.usage, at);
          } catch { /* 半截行 */ }
        }
      }
    } catch (error) {
      console.log(`[pi-web] usage report failed: ${error && error.message}`);
    }
    // totals 重新按 models 汇总，避免上面占位逻辑绕
    totals.input = totals.output = totals.cacheRead = totals.cacheWrite = totals.total = totals.calls = 0;
    for (const row of models.values()) {
      totals.input += row.input; totals.output += row.output;
      totals.cacheRead += row.cacheRead; totals.cacheWrite += row.cacheWrite;
      totals.total += row.total; totals.calls += row.calls;
    }
    const data = {
      ok: true,
      sessions,
      lastAt,
      totals,
      models: [...models.values()].sort((a, b) => b.total - a.total),
    };
    this.usageCache = { at: now, data };
    return data;
  }

  async probeThinking(id) {
    const state = await this.attach(id);
    if (!state?.session) return { ok: false, status: 404, error: "session not found" };
    const model = state.session.model;
    if (!model) return { ok: false, status: 400, error: "会话还没选模型" };
    const runtime = await this.runtime();
    const probeModel = probeModelOf(model);
    const maxTokens = /responses$/.test(String(model.api)) ? 16
      : model.api === "anthropic-messages" ? 4096
      : 1;
    const context = {
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with just: ok" }] }],
      tools: [],
    };
    const results = [{ level: "off", supported: true }];
    for (const level of PROBE_LEVELS) {
      try {
        const stream = runtime.stream(probeModel, context, {
          reasoning: level,
          maxTokens,
          signal: AbortSignal.timeout(20_000),
        });
        const msg = await stream.result();
        if (msg?.stopReason === "error") {
          results.push({ level, supported: false, note: String(msg.errorMessage || "请求失败").slice(0, 160) });
          continue;
        }
        const hasThinking = Array.isArray(msg?.content) && msg.content.some((c) => c.type === "thinking");
        results.push(hasThinking
          ? { level, supported: true }
          : { level, supported: false, note: "端点未报错但没产出思考内容（参数可能被吞）" });
      } catch (error) {
        results.push({ level, supported: false, note: String(error?.message || error).slice(0, 160) });
      }
    }
    return { ok: true, model: { provider: model.provider, modelId: model.id }, results };
  }

  async catalog() {
    const runtime = await this.runtime();
    const sdk = await this.sdkReady();
    const configured = new Set(Object.keys(this.readProviders().providers || {}));
    const groups = [];
    for (const p of runtime.getProviders() || []) {
      if (!configured.has(p.id)) continue;
      let models = [];
      try {
        models = runtime.getModels(p.id) || [];
      } catch {
        models = [];
      }
      if (!models.length) continue;
      groups.push({
        id: p.id,
        name: p.name || p.id,
        models: models.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          reasoning: Boolean(m.reasoning),
          contextWindow: capacity(m.contextWindow) ? m.contextWindow : undefined,
          maxTokens: capacity(m.maxTokens) ? m.maxTokens : undefined,
          // thinkingLevelMap 声明的级别（值非 null 的 + 缺席的 off），未声
          // 明时 reasoning 模型兜底 medium/high。
          efforts: sdk.AgentSession.prototype.getAvailableThinkingLevels.call({ model: m }),
        })),
      });
    }
    return groups;
  }

  readProviders() {
    try {
      const parsed = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object" && typeof parsed.providers === "object") return parsed;
    } catch {
      // 读失败按空目录处理
    }
    return { providers: {} };
  }

  writeProviders(data) {
    fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
    fs.writeFileSync(MODELS_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async providers() {
    const [nativeIds, runtime] = await Promise.all([this.nativeCatalogIds(), this.runtime().catch(() => null)]);
    const configured = this.readProviders().providers || {};
    const rows = [];
    for (const [id, entry] of Object.entries(configured)) {
      rows.push({
        id,
        name: (entry && entry.displayName) || id,
        shadowNative: nativeIds.has(id),
        configured: true,
        active: Boolean(runtime && runtime.hasConfiguredAuth(id)),
        entry: {
          api: entry.api || "",
          baseUrl: entry.baseUrl || "",
          hasKey: Boolean(entry.apiKey),
          retryCount: entry.retryCount ?? null,
          retryWaitMs: entry.retryWaitMs ?? null,
          models: (entry.models || []).map((m) => ({
            id: m.id,
            name: m.name || m.id,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            reasoning: Boolean(m.reasoning),
            thinkingEfforts: thinkingEffortsOf(m),
            input: modelInputOf(m.input) || undefined,
          })),
        },
      });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return rows;
  }

  async saveProvider(id, draft) {
    const route = String(id ?? "").trim();
    if (!route) return { ok: false, status: 400, error: "missing provider id" };
    const renameFrom = str(draft.renameFrom);
    if (renameFrom && renameFrom !== route) {
      // pi 的 models.json 键接受任意非空字符串（中文亦可），不再额外限制
    }
    const nativeRows = await this.nativeCatalog();
    const isNative = nativeRows.some((r) => r.id === route);
    const data = this.readProviders();
    let existing = data.providers[route] || null;
    // 改名迁移：旧条目整体搬到新键（目标已存在其它配置则拒绝，防误覆盖）
    if (renameFrom && renameFrom !== route) {
      const moved = data.providers[renameFrom] || null;
      if (moved && existing && existing !== moved) {
        return { ok: false, status: 409, error: `服务商「${route}」已存在，不能覆盖` };
      }
      if (moved) {
        existing = moved;
        delete data.providers[renameFrom];
      }
    }
    const next = { ...(existing || {}) };
    delete next.displayName; // 显示名由 UI 直接用路由 id（pi 无 display 字段）
    delete next.apiKeyEnv;

    const api = str(draft.api);
    const baseUrl = str(draft.baseUrl);
    if (api) next.api = api;
    else if (!isNative) next.api = (existing && existing.api) || "openai-completions";
    if (baseUrl) next.baseUrl = baseUrl;
    else if (!isNative) next.baseUrl = (existing && existing.baseUrl) || "";

    // 重试设置：留空（null）或非法 = 删除字段，回落全局默认（5 次、15s 基数）
    if (draft.retryCount === null || draft.retryCount === undefined) delete next.retryCount;
    else {
      const retryCount = Number(draft.retryCount);
      if (Number.isInteger(retryCount) && retryCount >= 0 && retryCount <= 50) next.retryCount = retryCount;
      else delete next.retryCount;
    }
    if (draft.retryWaitSeconds === null || draft.retryWaitSeconds === undefined) delete next.retryWaitMs;
    else {
      const waitSec = Number(draft.retryWaitSeconds);
      if (Number.isFinite(waitSec) && waitSec > 0 && waitSec <= 600) next.retryWaitMs = Math.round(waitSec * 1000);
      else delete next.retryWaitMs;
    }

    if (typeof draft.apiKey === "string" && draft.apiKey.trim()) next.apiKey = draft.apiKey.trim();
    // 密钥留空 = 保持已存密钥不动（表单密钥框是「改密才填」语义）；清空密钥的唯一途径是删除服务商。

    const rows = Array.isArray(draft.models) ? draft.models : null;
    if (rows) {
      // 按 id 合并而不是整体替换：表单不编辑 cost/compat 等，直接替换会把它们抹掉。
      // input 除外，识图勾选改的就是它。
      const prevById = new Map(((existing && existing.models) || []).map((m) => [m.id, m]));
      const mapped = rows
        .filter((m) => m && typeof m.id === "string" && m.id.trim())
        .map((m) => {
          const id2 = m.id.trim();
          const prev = prevById.get(id2) || null;
          // 先继承已存条目的全部字段，再用表单覆盖可编辑部分
          const model = { ...(prev || {}) };
          model.id = id2;
          model.name = str(m.name) || id2;
          if (Number.isFinite(m.contextWindow) && m.contextWindow > 0) model.contextWindow = m.contextWindow;
          else delete model.contextWindow;
          if (Number.isFinite(m.maxTokens) && m.maxTokens > 0) model.maxTokens = m.maxTokens;
          else delete model.maxTokens;
          delete model.thinkingEfforts;
          const effortsRaw = m.thinkingEfforts === false ? false : str(m.thinkingEfforts);
          if (prev && thinkingEffortsOf(prev) === effortsRaw) {
            // 思考声明没动过：原样保留 reasoning/thinkingLevelMap，
            // 不做 null 展开（那会把隐含可用的级别变成显式不支持）
            if (prev.reasoning !== undefined) model.reasoning = prev.reasoning;
            if (prev.thinkingLevelMap === undefined) delete model.thinkingLevelMap;
          } else {
            const efforts = normalizeEfforts(effortsRaw);
            if (efforts === false) {
              model.thinkingLevelMap = undefined;
              model.reasoning = false;
            } else if (efforts) {
              model.reasoning = true;
              model.thinkingLevelMap = efforts;
            } else {
              delete model.thinkingLevelMap; // 缺席 = 继承（内置目录模型自带）
              model.reasoning = Boolean(m.reasoning);
            }
          }
          if (!model.reasoning) delete model.thinkingLevelMap;
          const input = modelInputOf(m.input);
          if (input) model.input = input;
          return cleanUndefined(model);
        });
      if (mapped.length) next.models = mapped;
      else if (!isNative) next.models = (existing && existing.models) || [];
      else delete next.models;
    }

    if (!isNative && !next.baseUrl) return { ok: false, status: 400, error: "自定义服务商需要 baseUrl" };
    if (!isNative && !next.api) return { ok: false, status: 400, error: "自定义服务商需要 api 协议" };

    data.providers[route] = next;
    this.writeProviders(data);
    return { ok: true };
  }

  async deleteProvider(id) {
    const route = String(id ?? "").trim();
    const data = this.readProviders();
    if (!data.providers[route]) return { ok: false, status: 404, error: "provider not configured" };
    delete data.providers[route];
    this.writeProviders(data);
    return { ok: true };
  }

  async sessionDiff(id) {
    const state = await this.attach(id, false);
    if (!state) return null;
    const manager = state.manager || state.session?.sessionManager;
    if (!manager) return { files: [] };
    const calls = new Map();
    const branch = manager.getBranch();
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const m = entry.message;
      if (!m || !Array.isArray(m.content)) continue;
      if (m.role === "assistant") {
        for (const c of m.content) {
          if (c.type !== "toolCall" || !c.id) continue;
          if (c.name !== "write" && c.name !== "edit") continue;
          let args = {};
          try {
            args = typeof c.arguments === "string" ? JSON.parse(c.arguments) : c.arguments || {};
          } catch {
            continue;
          }
          calls.set(c.id, { name: c.name, args });
        }
      } else if (m.role === "toolResult") {
        if (m.isError) continue;
        const call = calls.get(m.toolCallId || "");
        if (call) call.applied = true;
      }
    }
    const files = new Map();
    for (const call of calls.values()) {
      if (!call.applied) continue;
      const p = path.resolve(String(call.args.path ?? ""));
      if (!files.has(p)) files.set(p, []);
      const group = files.get(p);
      if (call.name === "write") {
        group.push({ type: "write", content: String(call.args.content ?? "") });
      } else {
        const edits = Array.isArray(call.args.edits)
          ? call.args.edits
          : [{ oldText: call.args.oldText, newText: call.args.newText }];
        for (const e of edits) {
          if (typeof e.oldText === "string" || typeof e.newText === "string") {
            group.push({ type: "edit", oldText: String(e.oldText ?? ""), newText: String(e.newText ?? "") });
          }
        }
      }
    }
    const out = [];
    for (const [p, ops] of files) {
      let patch = "";
      let additions = 0;
      let deletions = 0;
      for (const op of ops) {
        const before = op.type === "write" ? "" : op.oldText;
        const after = op.type === "write" ? op.content : op.newText;
        const section = Diff.createTwoFilesPatch(p, p, before, after, undefined, undefined, { context: 2 });
        patch += (patch ? "\n" : "") + section;
        for (const line of section.split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
          else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
        }
      }
      out.push({ path: p, additions, deletions, patch });
    }
    return { files: out };
  }

  async presetsView() {
    const config = this.presetStore.readConfig();
    const selected = new Set(config.defaultSelected || []);
    const existsIn = (file) => fs.existsSync(path.join(ROOT, file));
    return {
      presets: (config.presets || []).map((p) => ({
        id: p.id,
        name: p.name,
        enabled: selected.has(p.id),
        rules: (p.rules || []).map((r) => ({
          id: r.id,
          name: r.name || "",
          content: r.content || "",
          enabled: r.enabled !== false,
        })),
      })),
      defaultSelected: config.defaultSelected || [],
      contextFiles: [
        { file: "AGENTS.md", enabled: config.agentsMd === true, exists: existsIn("AGENTS.md") },
        { file: "CLAUDE.md", enabled: config.claudeMd === true, exists: existsIn("CLAUDE.md") },
      ],
    };
  }

  async savePresets(payload) {
    const current = this.presetStore.readConfig();
    const normalized = normalizePresetConfig({
      version: 2,
      agentsMd: Boolean(payload.agentsMd ?? current.agentsMd),
      claudeMd: Boolean(payload.claudeMd ?? current.claudeMd),
      presets: Array.isArray(payload.presets) ? payload.presets : current.presets || [],
      defaultSelected: Array.isArray(payload.defaultSelected) ? payload.defaultSelected : current.defaultSelected || [],
    });
    this.presetStore.saveConfig(normalized);
    return this.presetsView();
  }

  writeContextFile(file, content) {
    const name = String(file ?? "");
    if (name !== "AGENTS.md" && name !== "CLAUDE.md") {
      return { ok: false, status: 400, error: "只支持创建 AGENTS.md / CLAUDE.md" };
    }
    const target = path.join(ROOT, name);
    if (fs.existsSync(target)) return { ok: false, status: 400, error: `${name} 已存在` };
    fs.writeFileSync(target, String(content ?? ""), "utf8");
    return { ok: true, path: target };
  }

  async envInfo() {
    const sdk = await this.sdkReady();
    const { readMcpServers } = await import("@mcca/pi-mcp");
    const mcp = readMcpServers(path.join(ROOT, "config", "mcp.json")).map((s) => s.serverName);
    const plugins = [];
    const pluginDirs = [path.join(ROOT, "plugins"), path.join(ROOT, "packages", "agent-ide", "plugins")];
    let enableConfig = {};
    try {
      enableConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "plugins.json"), "utf8").replace(/^\uFEFF/, "")) || {};
    } catch {
      // 无配置按全默认
    }
    for (const pluginsDir of pluginDirs) {
      try {
        for (const name of fs.readdirSync(pluginsDir)) {
          const manifestFile = path.join(pluginsDir, name, "manifest.json");
          if (!fs.existsSync(manifestFile)) continue;
          const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
          if (!manifest?.name || plugins.some((item) => item.name === manifest.name)) continue;
          plugins.push({
            name: manifest.name,
            kind: manifest.kind || "tool",
            description: manifest.description || "",
            enabled: enableConfig.pi?.[manifest.name] !== false,
          });
        }
      } catch {
        // 目录不可读按空
      }
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    let skills = 0;
    const seenSkills = new Set();
    for (const dir of [path.join(ROOT, "skills"), path.join(ROOT, "packages", "agent-ide", "skills")]) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (seenSkills.has(name)) continue;
          if (!fs.existsSync(path.join(dir, name, "SKILL.md"))) continue;
          seenSkills.add(name);
          skills += 1;
        }
      } catch {
        // 目录不可读就跳过
      }
    }
    return { piVersion: sdk.VERSION, cwd: ROOT, mcp, plugins, skills };
  }

  settingsFile() {
    return process.env.MCCA_PI_WEB_SETTINGS || path.join(ROOT, "config", ".pi-web", "settings.json");
  }

  readSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.settingsFile(), "utf8").replace(/^\uFEFF/, "")) || {};
    } catch {
      return {};
    }
  }

  getCompactionModel() {
    const c = this.readSettings().compactionModel;
    return c && c.provider && c.model ? { provider: c.provider, modelId: c.model } : null;
  }

  async setCompactionModel(payload) {
    const stored = this.readSettings();
    const provider = typeof payload?.provider === "string" ? payload.provider.trim() : "";
    const modelId = typeof payload?.modelId === "string" ? payload.modelId.trim() : "";
    if (provider && modelId) {
      const runtime = await this.runtime();
      if (!runtime.getModel(provider, modelId)) {
        return { ok: false, status: 400, error: `模型不存在：${provider}/${modelId}` };
      }
      stored.compactionModel = { provider, model: modelId };
    } else {
      delete stored.compactionModel; // 清空 = 跟随会话模型
    }
    this.writeSettings(stored);
    return { ok: true, compactionModel: this.getCompactionModel() };
  }

  async listSubagents(cwd = ROOT) {
    const cached = this.agentCatalogCache.get(cwd);
    if (cached && Date.now() < cached.until) return cached.agents;
    const agents = subagents.effective(cwd);
    this.agentCatalogCache.set(cwd, { agents, until: Date.now() + 1000 });
    return agents;
  }

  async manageSubagent(action, payload, cwd = ROOT) {
    if (!subagents.ALLOWED_ACTIONS.has(action)) return { ok: false, error: "Unknown action: " + action };
    const runtime = await this.runtime();
    const result = await subagents.manage(action, payload, cwd, this.adaptModelRegistry(runtime));
    if (result?.isError) return { ok: false, error: subagents.errorText(result), result, agents: subagents.effective(cwd) };
    this.notifySubagentConfig();
    return { ok: true, result, agents: subagents.effective(cwd) };
  }
  /**
   * 注册表快照里「刚变终态」的 run → 回执。
   *
   * 为什么不用 pi-subagents 的 `subagent:async-complete`：它依赖 async status.json
   * 里的 sessionId（被截断的父会话路径）和宿主身份相等，长路径下永远不匹配，
   * 事件根本不会发出来。注册表是我们自己从 asyncDir/status.json 对账的，改成
   * 「谁先到终态谁发回执」，和包的实现解耦。
   */
  /**
   * 卡住的忙态看门狗：promptPending 为 true 但没有活的 turn，而且会话文件很久没写，
   * 说明这轮早就死了（进程被杀 / provider 挂掉），不清掉的话 /api/sessions 永远报
   * running → 旗帜挂着、界面一直显示任务中。
   */
  sweepStuckBusySessions(maxIdleMs = 30 * 60 * 1000) {
    for (const [id, state] of this.sessions) {
      if (!state || !state.promptPending) continue;
      if (state.session && state.session.isStreaming) continue; // 真在跑：不动
      let file = "";
      try { file = this.sessionPaths.get(String(id)) || (state.manager && typeof state.manager.getSessionFile === "function" ? state.manager.getSessionFile() : "") || ""; } catch { file = ""; }
      let stale = !file;
      try { if (file && fs.existsSync(file)) stale = Date.now() - fs.statSync(file).mtimeMs > maxIdleMs; } catch { stale = false; }
      if (!stale) continue;
      state.promptPending = false;
      state.streaming = false;
      state.stopRequested = false;
      this.pushStatus(state, "idle");
      console.log(`[pi-web] unstick ${String(id).slice(0, 8)}: promptPending 残留但会话已停 (${file ? Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000) + " 分钟无写入" : "找不到文件"})`);
    }
  }

  /** 手动解除忙态（卡住的会话；正常情况看门狗会自己清）。 */
  async unstick(id) {
    const state = await this.attach(id);
    if (!state) return { ok: false, error: "session not found" };
    const streaming = Boolean(state.session && state.session.isStreaming);
    state.promptPending = false;
    state.streaming = false;
    state.stopRequested = false;
    this.pushStatus(state, "idle");
    this.push(state, { type: "status", status: streaming ? "working" : "idle" });
    return { ok: true, streaming };
  }

  receiptsFromSnapshot(sessionId, snapshot) {
    const delivered = this.deliveredReceiptKeys(sessionId); // 会话文件里已投递过的（跨进程重启也有效）
    for (const run of (snapshot && snapshot.runs) || []) {
      const status = String(run.status || "");
      if (status !== "completed" && status !== "failed" && status !== "stopped") continue;
      const base = run.runId || String(run.id || "").split(":")[0];
      const index = Number.isFinite(run.index) ? run.index : 0;
      const key = `run:${sessionId}:${base}:${index}`;
      const now = Date.now();
      this.subagentReceiptSeen ||= new Map();
      const seenAt = this.subagentReceiptSeen.get(key);
      if (seenAt !== undefined && now - seenAt < SUBAGENT_RECEIPT_TTL_MS) continue;
      this.subagentReceiptSeen.set(key, now);
      if (delivered.has(key)) continue; // 已写进会话文件：重启后不再重发（重复回执就是这么堆出来的）
      const success = status === "completed";
      this.queueSubagentReceipt(sessionId, "subagent:async-complete", {
        runId: base,
        taskIndex: index,
        agent: run.agent,
        success,
        state: success ? "complete" : status,
        stopped: status === "stopped",
        durationMs: run.endedAt && run.startedAt ? Math.max(0, run.endedAt - run.startedAt) : 0,
        summary: run.result || run.error || "",
        artifactPath: run.transcriptPath || "",
      }, key);
    }
  }

  /**
   * 会话文件里已经投递过的回执 key（details.keys / details.key）。
   *
   * 内存里的 subagentReceiptSeen 一重启就没了，扫描器会把所有历史终态 run 再回执一遍
   * （一次重启 = 每个 run 多一条），所以必须从落盘的会话文件里认账。只读文件尾部一段：
   * 回执总是追加在末尾；带 5s 缓存，扫描周期内不重复读盘。
   */
  deliveredReceiptKeys(sessionId) {
    this.subagentDeliveredCache ||= new Map();
    const cached = this.subagentDeliveredCache.get(sessionId);
    if (cached && Date.now() - cached.at < 60000) return cached.keys;
    const keys = new Set();
    try {
      let file = this.sessionPaths.get(String(sessionId)) || "";
      if (!file || !fs.existsSync(file)) {
        const hit = fs.existsSync(SESSION_DIR)
          ? fs.readdirSync(SESSION_DIR).find((n) => n.endsWith(`_${sessionId}.jsonl`))
          : null;
        if (hit) file = path.join(SESSION_DIR, hit);
      }
      if (file && fs.existsSync(file)) {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - 1_500_000);
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        for (const line of buf.toString("utf8").split(/\r?\n/)) {
          if (!line.includes("subagent-receipt")) continue;
          try {
            const row = JSON.parse(line);
            if (!row || row.customType !== "subagent-receipt" || !row.details) continue;
            if (row.details.key) keys.add(String(row.details.key));
            for (const k of Array.isArray(row.details.keys) ? row.details.keys : []) keys.add(String(k));
          } catch {
            // 尾部被切半的行：忽略
          }
        }
      }
    } catch {
      // 读不到就当空集：最多多回执一次，前端还有内容去重兜底
    }
    this.subagentDeliveredCache.set(sessionId, { at: Date.now(), keys });
    return keys;
  }

  /**
   * 子代理回执（宿主侧兜底）。
   *
   * pi-subagents 自己的完成通知走 `pi.sendMessage({customType:"subagent-notify"})`，
   * 但它在网页宿主里会被静默丢掉：要么 `intercomDelivered === true` 直接当已送达，
   * 要么 `result.sessionId !== state.currentSessionId`（会话身份形式不同）直接 return，
   * 而且宿主绑 sendMessage 时是异步吞错的——结果就是「子代理干完了，主对话一无所知」。
   *
   * 这里用我们自己的观察者拿同一批终态事件，攒 1.2s（同批完成合成一条），
   * 然后：① 推一条 notice 让界面可见；② 用 SDK 的 sendCustomMessage 唤醒父会话，
   * 让它有机会汇报/接着干。同 run 去重，重复事件不重复播报。
   */
  queueSubagentReceipt(sessionId, name, data, explicitKey = "") {
    if (name !== "subagent:async-complete" && name !== "subagent:foreground-complete") return;
    if (!data || typeof data !== "object") return;
    const key = explicitKey || `run:${sessionId}:${data.runId || data.id || data.agent || "agent"}:${Number.isFinite(data.taskIndex) ? data.taskIndex : 0}`;
    const now = Date.now();
    this.subagentReceiptSeen ||= new Map();
    const seenAt = this.subagentReceiptSeen.get(key);
    if (seenAt !== undefined && now - seenAt < SUBAGENT_RECEIPT_TTL_MS) return;
    this.subagentReceiptSeen.set(key, now);
    if (this.subagentReceiptSeen.size > 400) {
      for (const [k, at] of this.subagentReceiptSeen) {
        if (now - at > SUBAGENT_RECEIPT_TTL_MS) this.subagentReceiptSeen.delete(k);
      }
    }
    this.subagentReceiptPending ||= new Map();
    let bucket = this.subagentReceiptPending.get(sessionId);
    if (!bucket) {
      bucket = { items: [], timer: null };
      this.subagentReceiptPending.set(sessionId, bucket);
    }
    bucket.items.push({ data, key });
    if (bucket.timer) return;
    bucket.timer = setTimeout(() => {
      this.subagentReceiptPending.delete(sessionId);
      void this.flushSubagentReceipt(sessionId, bucket.items);
    }, 1200);
    if (bucket.timer.unref) bucket.timer.unref();
  }

  /** 把攒好的一批回执发给父会话：界面可见 + 唤醒（sendCustomMessage）。 */
  async flushSubagentReceipt(sessionId, items) {
    if (!Array.isArray(items) || !items.length) return;
    const datas = items.map((it) => (it && it.data) || it);
    const keys = items.map((it) => it && it.key).filter(Boolean);
    const text = datas.length === 1 ? formatSubagentReceipt(datas[0]) : formatSubagentReceiptGroup(datas);
    if (!text) return;
    // 会话没开在界面上时也要能叫醒它：按需 attach（会拉起该会话的 agent）
    let state = this.sessions.get(sessionId);
    if (!state) {
      try {
        state = await this.attach(sessionId, true);
      } catch (error) {
        state = null;
        console.log(`[pi-web] subagent receipt: attach ${String(sessionId).slice(0, 8)} failed: ${error && error.message}`);
      }
    }
    if (state) {
      try { this.push(state, { type: "notice", text, ...(keys.length ? { key: keys.join("|") } : {}) }); } catch { /* 界面旁路失败不影响唤醒 */ }
    }
    const session = state && state.session;
    if (session && typeof session.sendCustomMessage === "function") {
      try {
        // details.keys：重启后靠它认账，避免同一个 run 的回执被重复投递
        await session.sendCustomMessage(
          { customType: "subagent-receipt", content: text, display: true, ...(keys.length ? { details: { keys } } : {}) },
          { triggerTurn: true },
        );
      } catch (error) {
        console.log(`[pi-web] subagent receipt: 唤醒父会话失败 ${String(sessionId).slice(0, 8)}: ${error && error.message}`);
      }
    }
  }

  async subagentStatus(id) {
    // 前端每 2.5s 轮询一次；这个接口要读快照 + async 状态文件 + 磁盘会话列表，
    // 单次几百 ms 到几秒——不缓存就是周期性堵事件循环（发消息卡住的主因之一）。
    this.subagentStatusCache ||= new Map();
    const memo = this.subagentStatusCache.get(String(id));
    if (memo && Date.now() - memo.at < 2000) return memo.data;
    const data = await this.subagentStatusNow(id);
    this.subagentStatusCache.set(String(id), { at: Date.now(), data });
    if (this.subagentStatusCache.size > 30) {
      const now = Date.now();
      for (const [k, v] of this.subagentStatusCache) if (now - v.at > 30000) this.subagentStatusCache.delete(k);
    }
    return data;
  }

  // ── 慢工具/后台任务看门狗 ──────────────────────────────────────
  /** 阈值：软提醒（叫 agent 决策）与硬上限（中断本轮）。env 可覆盖，便于测试。 */
  bgLimits() {
    const env = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
    return {
      softMs: env("MCCA_BG_SOFT_MS", 5 * 60_000),
      hardMs: env("MCCA_BG_HARD_MS", 30 * 60_000),
    };
  }

  /** 工具开始运行：登记（含 agent 自己在参数里给的 timeout，单位秒）。 */
  noteToolStart(state, callId, name, argsText) {
    if (!state || !callId) return;
    state.runningTools ||= new Map();
    const args = String(argsText || "").slice(0, 4000);
    let timeoutMs = 0;
    const m = args.match(/"timeout(?:_sec|_s)?"\s*:\s*(\d+(?:\.\d+)?)/);
    if (m) timeoutMs = Math.min(Math.round(Number(m[1]) * 1000), 2_147_483_647);
    state.runningTools.set(String(callId), {
      callId: String(callId),
      name: name || "tool",
      startedAt: Date.now(),
      args,
      timeoutMs,
      softNotified: false,
    });
    this.pushBgTasks(state);
  }

  /** 工具结束：注销。 */
  noteToolEnd(state, callId) {
    if (!state || !state.runningTools) return;
    state.runningTools.delete(String(callId || ""));
    this.pushBgTasks(state);
  }

  /** 工具返回后台确认：从本回合运行列表转入真正的后台任务列表。 */
  detachBackgroundTool(state, callId, name, details = {}) {
    if (!state) return;
    state.runningTools ||= new Map();
    const live = state.runningTools.get(String(callId || ""));
    state.runningTools.delete(String(callId || ""));
    state.backgroundTools ||= new Map();
    const taskId = String(details.taskId || callId || `background-${Date.now()}`);
    state.backgroundTools.set(taskId, {
      ...(live || {}),
      callId: taskId,
      taskId,
      toolCallId: String(callId || ""),
      name: name || details.toolName || "tool",
      startedAt: Number(details.startedAt) || live?.startedAt || Date.now(),
      timeoutMs: 0,
      background: true,
    });
    this.pushBgTasks(state);
  }

  /** 异步工具结果已经回到会话：移除后台任务卡片。 */
  finishBackgroundTool(state, taskId) {
    if (!state?.backgroundTools) return;
    if (!taskId) return;
    state.backgroundTools.delete(String(taskId));
    this.pushBgTasks(state);
  }

  /** 把「运行中的工具」推给界面（左侧「后台任务」面板）。 */
  pushBgTasks(state) {
    if (!state) return;
    const tasks = [
      ...(state.runningTools ? state.runningTools.values() : []),
      ...(state.backgroundTools ? state.backgroundTools.values() : []),
    ];
    try {
      this.push(state, { type: "bg-tasks", tasks });
    } catch {
      // 界面旁路失败不影响工具
    }
  }

  /**
   * 慢工具扫描（挂在 10s 心跳上）：
   *   软阈值 → 提醒 + 让 agent 工具结束后先做决策（继续等/换方案）
   *   硬上限 → abort 本轮 + 立刻唤醒 agent 重新决策（必定再请求一次，不让任务干等）
   * 硬上限优先用 agent 在参数里写的 timeout（秒），没写才用默认值。
   */
  sweepRunningTools() {
    const { softMs, hardMs } = this.bgLimits();
    for (const state of this.sessions.values()) {
      if (!state || !state.runningTools || !state.runningTools.size) continue;
      const now = Date.now();
      for (const task of [...state.runningTools.values()]) {
        const elapsed = now - task.startedAt;
        const limit = task.timeoutMs > 0 ? Math.max(task.timeoutMs, 60_000) : hardMs;
        if (elapsed >= limit) {
          this.timeoutSlowTool(state, task, elapsed, limit);
          continue;
        }
        const soft = Math.min(softMs, Math.max(60_000, limit - 60_000));
        if (!task.softNotified && elapsed >= soft) {
          task.softNotified = true;
          this.warnSlowTool(state, task, elapsed, limit);
        }
      }
      this.pushBgTasks(state); // 让界面的计时保持新鲜
    }
  }

  /** 软提醒：不动工具，只让 agent 在工具结束后先决策。 */
  warnSlowTool(state, task, elapsed, limit) {
    const mins = (elapsed / 60000).toFixed(1);
    const cap = limit < 60_000 ? `${Math.round(limit / 1000)} 秒` : `${(limit / 60000).toFixed(0)} 分钟`;
    const text = `【慢工具提醒】${task.name} 已运行 ${mins} 分钟（硬上限 ${cap}）。它结束后请先决策：继续等、换更小的命令，还是换方案——不要把一整轮都耗在等待上。`;
    try { this.push(state, { type: "notice", text }); } catch { /* 旁路 */ }
    const session = state.session;
    if (session && typeof session.sendCustomMessage === "function") {
      Promise.resolve(session.sendCustomMessage({ customType: "slow-tool", content: text, display: true }, { triggerTurn: false })).catch(() => {});
    }
  }

  /** 硬上限：中断本轮并立刻把控制权交回 agent（必定再请求一次）。 */
  /** 硬上限：中断本轮并立刻把控制权交回 agent（必定再请求一次）。 */
  timeoutSlowTool(state, task, elapsed, limit) {
    state.runningTools.delete(task.callId);
    const mins = (elapsed / 60000).toFixed(1);
    const cap = limit < 60_000 ? `${Math.round(limit / 1000)} 秒` : `${(limit / 60000).toFixed(0)} 分钟`;
    const cmd = String(task.args || "").replace(/\s+/g, " ").slice(0, 200);
    const fromArg = task.timeoutMs > 0;
    const text = [
      `【工具超时中断】${task.name} 跑了 ${mins} 分钟还没结束（上限 ${cap}），已中断本轮。`,
      `请立刻决策并继续推进：换更小的命令 / 加 timeout 重试 / 换方案，然后告诉用户结论。`,
      fromArg ? "（这个上限来自工具参数里的 timeout）" : "（默认上限，建议长命令自己带 timeout）",
      `命令：${cmd}`,
    ].join("\n");
    try { this.push(state, { type: "notice", text }); } catch { /* 界面旁路 */ }
    try {
      if (state.session && typeof state.session.abort === "function") state.session.abort();
    } catch { /* 取消失败也要把消息发出去 */ }
    const session = state.session;
    if (session && typeof session.sendCustomMessage === "function") {
      // abort 是异步的：会话还在 streaming 时发消息会被塞进正在中止的那一轮（然后丢掉）。
      // 先等它停稳，再带 triggerTurn 发——这样才保证「必定再请求一次」。
      const wakeWhenIdle = (attempt) => {
        if (session.isStreaming && attempt <= 20) {
          setTimeout(() => wakeWhenIdle(attempt + 1), 500);
          return;
        }
        Promise.resolve(session.sendCustomMessage({ customType: "slow-tool", content: text, display: true }, { triggerTurn: true }))
          .catch((error) => console.log(`[pi-web] slow tool wake failed: ${error && error.message}`));
      };
      wakeWhenIdle(1);
    }
    console.log(`[pi-web] slow tool aborted: ${task.name} ${mins}min`);
  }

  /** subagentStatus 的真实实现（结果见 subagentStatus 的 2s 缓存）。 */
  async subagentStatusNow(id) {
    const observer = this.subagentObservers.get(id);
    if (observer) {
      observer.registry.refreshFiles();
      const live = observer.registry.snapshot(await this.listSubagents(observer.state?.cwd || ROOT));
      return this.mergeSubagentQueue(live, await this.childSessions(id));
    }
    const snapDir = path.join(SESSION_DIR, "..", "subagents");
    const snapFile = path.join(snapDir, id + ".json");
    const known = Boolean(await this.resolveSessionFile(id)) || fs.existsSync(snapFile);
    if (!known) return null;
    const registry = new SubagentRuns({ dir: snapDir, sessionId: id });
    registry.refreshFiles();
    const saved = registry.snapshot(await this.listSubagents(ROOT));
    return this.mergeSubagentQueue(saved, await this.childSessions(id));
  }

  async subagentTranscript(parentId, childId) {
    return this.childTranscript(parentId, childId);
  }

  async stopSubagent(id, runId) {
    const observer = this.subagentObservers.get(id);
    const snapDir = path.join(SESSION_DIR, "..", "subagents");
    const snapFile = path.join(snapDir, id + ".json");
    const known = Boolean(observer) || fs.existsSync(snapFile) || Boolean(await this.resolveSessionFile(id));
    if (!known) return { ok: false, status: 404, error: "session not found" };
    const registry = observer?.registry || new SubagentRuns({ dir: snapDir, sessionId: id });
    registry.refreshFiles();
    try {
      const result = await registry.stop(runId, (method, params) => {
        if (!observer?.bus) throw new Error("subagent RPC unavailable");
        return requestRpc(observer.bus, method, params);
      });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, status: 400, error: error.message };
    }
  }

  writeSettings(data) {
    fs.mkdirSync(path.dirname(this.settingsFile()), { recursive: true });
    fs.writeFileSync(this.settingsFile(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  baseName(p) {
    return path.basename(p || "") || p || "";
  }

  /**
   * 工作区列表 = 默认工作区（ROOT） + 用户注册表（settings.json） +
   * 会话 cwd 自动派生。derived 条目在其会话清空后自然消失。
   */
  async workspaces() {
    const registry = Array.isArray(this.readSettings().workspaces) ? this.readSettings().workspaces : [];
    const map = new Map();
    map.set(ROOT.toLowerCase(), { path: ROOT, title: this.baseName(ROOT), default: true });
    for (const w of registry) {
      if (w && typeof w.path === "string" && w.path && !map.has(w.path.toLowerCase())) {
        map.set(w.path.toLowerCase(), { path: w.path, title: w.title || this.baseName(w.path), custom: true });
      }
    }
    const rows = [...map.values()];
    // 工作区是启动页第一步，不能为了显示数量再扫描全部会话文件。
    // 会话列表随后异步加载，数量由后续会话数据补齐；这样即使旧会话日志很大，
    // 页面也不会永远卡在“加载工作区…”。
    for (const r of rows) r.count = 0;
    rows.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || a.title.localeCompare(b.title));
    return rows;
  }

  addWorkspace(dir, title) {
    const target = str(dir);
    if (!target) return { ok: false, status: 400, error: "missing path" };
    let resolved = path.resolve(target);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, status: 400, error: `目录不存在：${resolved}` };
    }
    const stored = this.readSettings();
    const registry = Array.isArray(stored.workspaces) ? stored.workspaces : [];
    if (resolved.toLowerCase() === ROOT.toLowerCase() || registry.some((w) => w.path.toLowerCase() === resolved.toLowerCase())) {
      return { ok: true, duplicate: true };
    }
    registry.push({ path: resolved, title: str(title) || this.baseName(resolved) });
    stored.workspaces = registry;
    this.writeSettings(stored);
    return { ok: true };
  }

  removeWorkspace(dir) {
    const resolved = path.resolve(str(dir));
    if (resolved.toLowerCase() === ROOT.toLowerCase()) {
      return { ok: false, status: 400, error: "默认工作区不可删除" };
    }
    const stored = this.readSettings();
    const registry = Array.isArray(stored.workspaces) ? stored.workspaces : [];
    const next = registry.filter((w) => path.resolve(w.path).toLowerCase() !== resolved.toLowerCase());
    if (next.length === registry.length) return { ok: false, status: 404, error: "工作区不在注册表中" };
    stored.workspaces = next;
    this.writeSettings(stored);
    return { ok: true };
  }

  /** 获取模型：注册表直答 → OpenAI 兼容 GET {base}/models。 */
  /**
   * 获取模型：「获取可用模型」= 问端点要全量清单。填了 API 地址就**必走
   * 端点探测**（注册表里的只是你已配置的子集，拿它回答等于永远刷不出新
   * 模型）；没填地址时，内置目录路由用注册表直答（内置目录没法探测）。
   * 编辑已有服务商时表单密钥留空会回退用已存密钥。
   */
  async discoverModels({ provider, baseUrl, apiKey } = {}) {
    const route = str(provider);
    const base = str(baseUrl).replace(/\/+$/, "");
    let key = str(apiKey);
    if (!key && route) {
      const stored = this.readProviders().providers[route];
      if (stored && typeof stored.apiKey === "string") key = stored.apiKey;
    }
    if (base) {
      const probed = await this.probeEndpoint(`${base}/models`, key);
      if (probed.error) {
        // 端点探测失败：注册表里有配置的回退回答（如实带 warning），其余报错
        const fromRegistry = route ? await this.registryModels(route) : [];
        if (fromRegistry.length) {
          return { models: fromRegistry, warning: `端点探测失败（${probed.error}），以下为当前已配置的模型` };
        }
        return { error: probed.error };
      }
      return probed;
    }
    if (route) {
      const fromRegistry = await this.registryModels(route);
      if (fromRegistry.length) return { models: fromRegistry };
      const nativeIds = await this.nativeCatalogIds();
      if (nativeIds.has(route)) return { models: [] };
      return { error: `pi 没有服务商「${route}」的目录条目：请填写 API 地址，或手动录入模型` };
    }
    return { error: "请先填写 API 地址再获取模型" };
  }

  /** 注册表里某路由的模型（目录形态）。 */
  async registryModels(route) {
    try {
      const runtime = await this.runtime();
      const models = runtime.getModels(route) || [];
      return models.map((m) => ({
        id: m.id,
        reasoning: Boolean(m.reasoning),
        thinkingEfforts: thinkingEffortsOf(m),
        thinkingSource: "已有配置",
        ...(m.name && m.name !== m.id ? { name: m.name } : {}),
        ...(capacity(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
        ...(capacity(m.maxTokens) ? { maxTokens: m.maxTokens } : {}),
      }));
    } catch {
      return [];
    }
  }

  /** OpenAI 兼容 GET {url}（Bearer key），解析模型清单。
   *  慢端点（如 opencode.ai/zen 首次 TLS 握手 10s+）或偶发网络抖动会导致
   *  拉取不全：这里放宽到 20s 并对网络错误/5xx 自动重试 3 次。 */
  async probeEndpoint(url, key, { attempts = 3, timeoutMs = 20000 } = {}) {
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: controller.signal,
        });
        if (!res.ok) {
          const message = `${url} → HTTP ${res.status}${res.status === 401 || res.status === 403 ? "（检查密钥）" : ""}`;
          if (res.status >= 500 && attempt < attempts) {
            lastError = message;
          } else {
            return { error: message };
          }
        } else {
          const body = await res.json();
          const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
          const seen = new Set();
          const models = [];
          for (const row of rows) {
            const id = typeof row === "string" ? row.trim() : typeof row?.id === "string" ? row.id.trim() : "";
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const name = typeof row?.name === "string" && row.name.trim() && row.name.trim() !== id ? row.name.trim() : undefined;
            const contextWindow = [row?.context_window, row?.context_length].find(positiveInt);
            const maxTokens = [row?.max_output_tokens, row?.max_tokens].find(positiveInt);
            models.push({ id, ...(name ? { name } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}), ...discoveredThinking(row) });
            if (models.length >= 500) break;
          }
          if (!models.length) return { error: `${url} 返回了 0 个模型（端点或密钥可能不对）` };
          // 端点只给裸 ID（如 opencode zen/go）时，用 models.dev 目录补显示名/容量：
          // 例 deepseek-flash →「DeepSeek V4.1 Flash」+ 1M/384K，避免拉全了却认不出来
          await fillModelsDevMeta(models);
          return { models };
        }
      } catch (error) {
        lastError = error?.name === "AbortError" ? `${url} 请求超时（${timeoutMs / 1000}s）` : `${url} → ${error?.message || error}`;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt)); // 退避后重试
    }
    return { error: lastError || `${url} 请求失败` };
  }
}

// ── 纯函数助手 ─────────────────────────────────────────────────────

/** models.dev 目录缓存：模型 id → {name, contextWindow, maxTokens}。 */
const modelsDevCache = { at: 0, index: null };
const MODELS_DEV_TTL = 60 * 60 * 1000; // 1 小时

/** 拉取后补全显示名/容量（端点不返回元数据时）。失败不阻断，回退上次缓存。 */
async function fillModelsDevMeta(models) {
  const missing = models.some((m) => !m.name || !m.contextWindow || !m.maxTokens);
  if (!missing) return;
  const index = await loadModelsDevIndex();
  if (!index) return;
  for (const m of models) {
    const meta = index.get(m.id);
    if (!meta) continue;
    if (!m.name && meta.name) m.name = meta.name;
    if (!m.contextWindow && meta.contextWindow) m.contextWindow = meta.contextWindow;
    if (!m.maxTokens && meta.maxTokens) m.maxTokens = meta.maxTokens;
  }
}

async function loadModelsDevIndex() {
  if (modelsDevCache.index && Date.now() - modelsDevCache.at < MODELS_DEV_TTL) return modelsDevCache.index;
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return modelsDevCache.index;
    const body = await res.json();
    const index = new Map();
    for (const provider of Object.values(body || {})) {
      const catalog = provider && provider.models;
      if (!catalog || typeof catalog !== "object") continue;
      for (const [id, m] of Object.entries(catalog)) {
        if (!m || typeof m !== "object") continue;
        const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : undefined;
        const contextWindow = positiveInt(m.limit && m.limit.context);
        const maxTokens = positiveInt(m.limit && m.limit.output);
        const prev = index.get(id);
        index.set(id, prev
          ? { name: prev.name || name, contextWindow: prev.contextWindow || contextWindow, maxTokens: prev.maxTokens || maxTokens }
          : { name, contextWindow, maxTokens });
      }
    }
    modelsDevCache.at = Date.now();
    modelsDevCache.index = index;
    return index;
  } catch {
    return modelsDevCache.index; // 网络失败：用旧缓存（若有），不影响拉取
  }
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** 服务商重试次数：整数 0–50，非法回落默认 5。 */
function retryCountOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 50 ? n : 5;
}

/** 服务商重试等待（毫秒）：正数封顶 10 分钟，非法回落默认 15s。 */
function retryDelayMsOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 600000) : 15000;
}

function discoveredThinking(row) {
  if (!row || typeof row !== "object") return {};
  if (row.reasoning === false) return { reasoning: false, thinkingEfforts: false, thinkingSource: "服务商声明" };
  const levels = row.supported_reasoning_efforts || row.reasoning_efforts || row.thinking_levels || row.reasoning?.efforts;
  if (Array.isArray(levels)) {
    const canonical = THINKING_LEVELS.map(([level]) => level).filter((level) => levels.includes(level));
    if (canonical.length) return { reasoning: canonical.some((level) => level !== "off"), thinkingEfforts: canonical.join(","), thinkingSource: "服务商声明" };
  }
  if (row.thinkingLevelMap && typeof row.thinkingLevelMap === "object") {
    return { reasoning: true, thinkingEfforts: thinkingEffortsOf(row), thinkingSource: "服务商声明" };
  }
  if (row.reasoning === true || row.supported_parameters?.includes?.("reasoning")) {
    return { reasoning: true, thinkingSource: "支持思考，未公布强度" };
  }
  return {};
}

function positiveInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function capacity(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** 消息部分 usage 的输出 token 数（流式/结束时都可用）；无效返回 undefined。 */
function partialOutputTokens(msg) {
  const v = msg?.usage?.output;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 消息时间戳归一为毫秒数（number / ISO 串 / Date 都接受）；无效返回 0。 */
function entryTimestamp(msg) {
  const v = msg?.timestamp;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  if (v instanceof Date) return v.getTime();
  return 0;
}

/** 思考强度真探测的级别集（off 恒支持，不发思考参数，不探测）。 */
const PROBE_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 探测用模型克隆：绕开 pi 的声明式 clamp（否则级别在发送前就被改成 off，
 * 永远试不出来）。thinkingLevelMap 保留原 wire 拼写（如 gemini 的 "LOW"），
 * 缺失/被声明为 null 的级别补 canonical 名，让每个级别都以真实参数发出。
 */
function probeModelOf(model) {
  const base = model?.thinkingLevelMap || {};
  const map = {};
  for (const level of ["off", ...PROBE_LEVELS]) {
    const v = base[level];
    map[level] = typeof v === "string" && v ? v : level;
  }
  return { ...model, reasoning: true, thinkingLevelMap: map };
}

function safeJson(v) {
  try {
    return JSON.stringify(v, null, 1);
  } catch {
    return String(v);
  }
}

function cleanUndefined(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

function extractToolOutput(result) {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
      .join("")
      .trim();
  }
  return safeJson(result).slice(0, 4000);
}

// ── 事件缓冲瘦身：工具输出/参数截断 + 大图缩略 ─────────────────────
// 历史回放直接吃 state.events；一张 2MB 的截图 base64 就能让单帧到 2.7MB，
// 缓冲区累计十几 MB，切换会话时前端解析+建 DOM 直接卡死。
const TOOL_OUTPUT_MAX_CHARS = 4000; // 前端渲染本来就是 slice(0,4000)
const TOOL_ARGS_MAX_CHARS = 2000;
const INLINE_IMAGE_MAX_CHARS = 120_000; // 约 90KB 原图以下直接内联
const IMAGE_THUMB_MAX_SIDE = 256; // 前端只显示 96px 缩略图
const IMAGE_SKIP_OVER_CHARS = 2_000_000; // 缩不了又不肯小：不内联

function capText(text, max = TOOL_OUTPUT_MAX_CHARS) {
  const s = typeof text === "string" ? text : "";
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，原 ${s.length} 字符）` : s;
}

let photonModule;
/** 懒加载 WASM 图像库（随 pi SDK 一起安装，可能在 pnpm 虚拟目录或全局 agent 目录里）。 */
function loadPhoton() {
  if (photonModule !== undefined) return photonModule;
  photonModule = null;
  try {
    const store = path.join(ROOT, "node_modules", ".pnpm");
    const dir = fs.readdirSync(store).find((name) => name.startsWith("@silvia-odwyer+photon-node@"));
    if (dir) photonModule = require(path.join(store, dir, "node_modules", "@silvia-odwyer", "photon-node"));
  } catch { /* 换下一个候选 */ }
  if (!photonModule) {
    try {
      photonModule = require(path.join(AGENT_DIR, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@silvia-odwyer", "photon-node"));
    } catch { /* 没有再退回“不缩图” */ }
  }
  return photonModule;
}

/** 把 base64 图片缩到 maxSide 内（最近邻，保像素风）；缩不动返回 null。 */
function shrinkImageData(dataB64, maxSide = IMAGE_THUMB_MAX_SIDE) {
  const photon = loadPhoton();
  if (!photon || typeof dataB64 !== "string" || !dataB64) return null;
  // 超大图直接放弃：解码 + WASM 分配本身就可能把进程顶爆，不值得为一张缩略图冒险
  if (dataB64.length > IMAGE_SKIP_OVER_CHARS) return null;
  let img = null;
  let out = null;
  try {
    img = photon.PhotonImage.new_from_byteslice(new Uint8Array(Buffer.from(dataB64, "base64")));
    const w = img.get_width();
    const h = img.get_height();
    if (!w || !h) return null;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    if (scale >= 1) return null;
    out = photon.resize(img, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), photon.SamplingFilter.Nearest);
    return Buffer.from(out.get_bytes()).toString("base64"); // get_bytes() = PNG
  } catch {
    // photon 是 Rust/WASM：遇到损坏或不支持的图会 panic，这里当缩不了处理
    return null;
  } finally {
    // 必须显式 free：photon 的 WASM 线性内存只涨不还，不释放的话每张图涨 ~7MB，
    // 长会话（生图 / 截图轮询）几小时后 V8 external 爆掉，进程直接 abort（退出码 134）
    try { if (img) img.free(); } catch { /* 已释放 */ }
    try { if (out) out.free(); } catch { /* 已释放 */ }
  }
}

function toolResultImages(result) {
  const images = [];
  if (!Array.isArray(result?.content)) return images;
  for (const c of result.content) {
    if (images.length >= 4) break;
    if (c?.type !== "image" || typeof c.data !== "string") continue;
    let data = c.data;
    let mime = c.mimeType || "image/png";
    if (data.length > INLINE_IMAGE_MAX_CHARS) {
      const small = shrinkImageData(data);
      if (small) {
        data = small;
        mime = "image/png";
      } else if (data.length > IMAGE_SKIP_OVER_CHARS) {
        continue; // 缩不了又太大：宁可不内联，也不拖垮历史回放
      }
    }
    images.push({ mime, data });
  }
  return images;
}

/**
 * 模型的 thinkingLevelMap → UI 可编辑的思考强度列表。
 * 值非 null 的级别 + 缺席的 off（= 支持、发空）；值为 null 的级别不提供。
 */
function effortsOf(model) {
  const map = model.thinkingLevelMap;
  const declared = new Set();
  for (const [level] of THINKING_LEVELS) {
    if (level === "off" && (map?.[level] === undefined || typeof map?.[level] === "string")) declared.add(level);
    else if (map && typeof map[level] === "string") declared.add(level);
  }
  if (!declared.size) {
    return model.reasoning ? ["medium", "high"] : [];
  }
  return THINKING_LEVELS.map(([level]) => level).filter((l) => declared.has(l));
}

/** pi Model.input 只接受 text/image；text 始终保留。不是数组则返回 null（这次没改）。 */
function modelInputOf(raw) {
  if (!Array.isArray(raw)) return null;
  const input = [];
  for (const value of raw) {
    if ((value === "text" || value === "image") && !input.includes(value)) input.push(value);
  }
  if (!input.includes("text")) input.unshift("text");
  return input;
}

/** pi 条目的 thinkingLevelMap → UI 的逗号分隔级别列表；false = 显式关闭。 */
function thinkingEffortsOf(model) {
  if (model.reasoning === false) return false;
  const map = model.thinkingLevelMap;
  if (!map) return model.reasoning ? "medium,high" : "";
  const levels = THINKING_LEVELS.map(([level]) => level).filter((l) => typeof map[l] === "string" || (l === "off" && map[l] === undefined));
  return levels.join(",");
}

/**
 * UI 的级别列表（逗号分隔，canonical 词表）→ pi 的 thinkingLevelMap。
 * 返回 false 表示显式关闭思考；null 表示字段缺席（继承目录）。
 * 声明的级别带 wire 拼写（= canonical），未声明级别显式置 null，off 缺席。
 */
function normalizeEfforts(raw) {
  if (raw === false) return false;
  const text = str(raw);
  if (!text) return null;
  const valid = new Set(THINKING_LEVELS.map(([l]) => l));
  const levels = [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!levels.length) return null;
  if (levels.some((l) => !valid.has(l))) return { __invalid: levels.filter((l) => !valid.has(l)).join(",") };
  const hasThinking = levels.some((l) => l !== "off");
  if (!hasThinking) return { __invalid: "至少声明一个 off 以外的思考级别" };
  const map = {};
  for (const [level] of THINKING_LEVELS) {
    if (level === "off") {
      // off 声明 → 键缺席（pi 语义：支持、不发送参数）；未声明 → null（不支持）
      if (!levels.includes("off")) map.off = null;
    } else {
      map[level] = levels.includes(level) ? level : null;
    }
  }
  return map;
}

module.exports = { PiWebBridge, ROOT, AGENT_DIR, SESSION_DIR, THINKING_LEVELS };













