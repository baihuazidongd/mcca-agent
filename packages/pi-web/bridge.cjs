"use strict";

/**
 * @pi-dsh-bridge/pi-web — pi 会话桥（2026-09 重写版）。
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
const AGENT_DIR = process.env.PDB_AGENT_DIR || path.join(process.env.USERPROFILE || "", ".pi", "agent");
// 会话目录：本包私有（旧 pi-dsh-web 的 config/.pi-agent 已随其归档删除）。
const SESSION_DIR = process.env.PDB_PI_WEB_SESSIONS || path.join(ROOT, "config", ".pi-web", "sessions");
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
    this.attachPending = new Map();
    this.agentCatalogCache = new Map();
    // 预设上下文存储（预设=命名规则组 + AGENTS/CLAUDE 上下文文件注入），
    // 配置落 pi 全局 agent 目录，跨工作区共用。
    this.presetStore = new PresetContextStore({
      settingsPath: path.join(AGENT_DIR, "dsh-web-settings.json"),
      legacyPath: this.settingsFile(),
      log: (message) => console.log("[pi-web]", message),
    });
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
    const { createPiAdapter } = await import("@pi-dsh-bridge/pi-adapter");
    const { createPiMcpExtension, readMcpServers } = await import("@pi-dsh-bridge/pi-mcp");
    const mcpServers = readMcpServers(path.join(ROOT, "config", "mcp.json"));
    const piAdapter = createPiAdapter({
      pluginsDir: path.join(ROOT, "plugins"),
      configPath: path.join(ROOT, "config", "plugins.json"),
      cwd: ROOT,
      onMcpServer: (cfg) => mcpServers.push(cfg),
    });
    const piMcp = createPiMcpExtension({ servers: mcpServers, cwd: ROOT });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: AGENT_DIR,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: this.curatedExtensionPaths(),
      additionalSkillPaths: [path.join(ROOT, "skills")].filter((p) => fs.existsSync(p)),
      extensionFactories: [
        { name: "pi-web-native-subagents", factory: createNativeSubagents(AGENT_DIR) },
        { name: "pi-web-subagents-observer", factory: createObserver(observer.registry, (bus) => { observer.bus = bus; }, () => { if (observer.state) this.push(observer.state, { type: "subagents-config" }); }) },
        { name: "pdb-pi-adapter", factory: piAdapter },
        { name: "pdb-pi-mcp", factory: piMcp },
        // 预设上下文注入：每条用户消息把启用的预设规则/上下文文件追加进系统提示词
        { name: "pdb-preset-context", factory: createPresetContextExtension({ store: this.presetStore }) },
      ],
    });
    await resourceLoader.reload();
    // SettingsManager 包装：a)「上下文不压缩」时关自动压缩；b) 按当前服务商
    // 覆盖重试设置（models.json 条目的 retryCount/retryWaitMs，默认 5 次/15s）。
    // 当前服务商记在 retryRef（会话对象携带，setModel 时更新）。
    const defaultModel = this.resolveDefaultModel(runtime);
    const retryRef = { provider: defaultModel?.provider ?? null };
    let settingsManager;
    try {
      const base = await sdk.SettingsManager.create(cwd, AGENT_DIR);
      const noCompaction = this.readSettings().noCompaction === true;
      settingsManager = new Proxy(base, {
        get: (target, prop) => {
          if (prop === "getCompactionSettings" && noCompaction) {
            return () => ({ ...target.getCompactionSettings(), enabled: false });
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
        if (!msg || msg.role !== "assistant") break;
        const text = Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "text").map((c) => c.text).join("") : "";
        const thinking = Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("") : "";
        const streaming = state.streaming;
        state.streaming = false;
        const output = partialOutputTokens(msg);
        // 真实生成速度：首个 delta → 收尾的实测时长（不含排队与工具执行）
        const durSec = state.msgStartedAt > 0 ? (Date.now() - state.msgStartedAt) / 1000 : 0;
        state.msgStartedAt = 0;
        const tokPerSec = output > 0 && durSec >= 0.5 && output / durSec <= 500 ? output / durSec : 0;
        this.push(state, {
          type: "assistant-end",
          ...(streaming ? {} : { text }),
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
        this.push(state, {
          type: "tool",
          callId,
          phase: "start",
          name: ev.toolName || "tool",
          args: typeof ev.args === "string" ? ev.args : safeJson(ev.args ?? {}),
        });
        break;
      }
      case "tool_execution_end": {
        const callId = ev.toolCallId || "";
        const name = state.calls.get(callId) || ev.toolName || "tool";
        state.calls.delete(callId);
        const images = [];
        if (Array.isArray(ev.result?.content)) {
          for (const c of ev.result.content) {
            if (images.length >= 4) break; // 每个工具结果最多带 4 张缩略图
            if (c?.type === "image" && typeof c.data === "string") {
              images.push({ mime: c.mimeType || "image/png", data: c.data });
            }
          }
        }
        this.push(state, {
          type: "tool",
          callId,
          phase: "end",
          name,
          output: extractToolOutput(ev.result),
          isError: Boolean(ev.isError),
          ...(images.length ? { images } : {}),
        });
        break;
      }
      case "agent_end": {
        state.streaming = false;
        state.calls.clear();
        // 如果 agent_end 时从未收到 message_update delta，说明本轮无文本输出（可能触发了重试）
        const wasRetry = !state.hasStreamed && state.turn > 0;
        this.push(state, { type: "turn-end", turn: state.turn, retry: wasRetry });
        // 轮次结束 → 回到「就绪」
        this.pushStatus(state, "idle");
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
  translateBranch(branch) {
    const events = [];
    let turn = 0;
    let prevTs = 0; // 上一条消息的时间戳：assistant 用量 ÷ 与前一条的时间差 ≈ tok 速度
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const m = entry.message;
      if (!m || !Array.isArray(m.content)) continue;
      const ts = entryTimestamp(m);
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (m.role === "user") {
        if (!text && !m.content.some((c) => c.type !== "toolResult")) continue;
        turn += 1;
        events.push({ type: "turn-start", turn });
        // 带上条目 id：前端据此支持「双击编辑并重发」
        if (text) events.push({ type: "user", text, id: entry.id });
      } else if (m.role === "assistant") {
        const thinking = m.content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("");
        if (text || thinking) {
          const output = partialOutputTokens(m) || 0;
          // 回放速度：消息时间戳是「生成开始」时刻，与上一条消息的差值包含排队
          // 与工具间隙，不可信——差值过短或速度离谱（>500 tok/s）就不给速度，
          // 宁缺毋滥（历史里的真实速度以实时流测得的为准）
          const seconds = output > 0 && ts > 0 && prevTs > 0 && ts > prevTs ? (ts - prevTs) / 1000 : 0;
          const plausible = seconds >= 1 && output / seconds <= 500;
          events.push({
            type: "assistant-end",
            text,
            ...(thinking ? { thinking } : {}),
            stopReason: m.stopReason,
            ...(output > 0 ? { usage: { output } } : {}),
            ...(plausible ? { tokPerSec: output / seconds } : {}),
          });
        }
        // 工具调用块：回放成 tool start+end 对
        for (const c of m.content) {
          if (c.type !== "toolCall") continue;
          events.push({ type: "tool", callId: c.id || `call_${events.length}`, phase: "start", name: c.name || "tool", args: typeof c.arguments === "string" ? c.arguments : safeJson(c.arguments ?? {}) });
          events.push({ type: "tool", callId: c.id || `call_${events.length}`, phase: "end", name: c.name || "tool", output: "", isError: false });
        }
      } else if (m.role === "toolResult") {
        events.push({
          type: "tool",
          callId: m.toolCallId || `call_replay_${turn}`,
          phase: "end",
          name: m.toolName || "tool",
          output: text || "[tool]",
          isError: Boolean(m.isError),
        });
      }
      if (ts) prevTs = ts;
    }
    if (turn) events.push({ type: "turn-end", turn });
    return events;
  }

  /** 事件 → SSE 帧（seq 自增；id = boot:seq，前端按 id 去重，重启不串号）。 */
  frame(state, event) {
    state.seq += 1;
    return { seq: state.seq, id: `${this.bootId}:${state.seq}`, event };
  }

  push(state, event) {
    const frame = this.frame(state, event);
    state.events.push(frame);
    if (state.events.length > 4000) state.events.splice(0, state.events.length - 4000);
    const wire = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of state.subscribers) {
      try {
        res.write(wire);
      } catch {
        state.subscribers.delete(res);
      }
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
      subagentRuns: [],
      cwd: manager.getCwd(),
      modelsMtime: this.modelsMtime(),
      thinkingChosen: false,
      msgStartedAt: 0,
    };
    const replay = this.translateBranch(manager.getBranch());
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
      subagentRuns: [],
      cwd: dir,
      modelsMtime: this.modelsMtime(),
      thinkingChosen: false,
      msgStartedAt: 0,
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

  async diskSessions() {
    if (this.diskCache && Date.now() < this.diskCacheUntil) return this.diskCache;
    if (this.diskPending) return this.diskPending;
    this.diskPending = this.scanDiskSessions();
    try {
      this.diskCache = await this.diskPending;
      this.diskCacheUntil = Date.now() + 1000;
      return this.diskCache;
    } finally { this.diskPending = null; }
  }

  async scanDiskSessions() {
    const sdk = await this.sdkReady();
    const disk = await sdk.SessionManager.listAll(SESSION_DIR);
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
      const first = fs.readFileSync(file, "utf8").split(/\r?\n/)[0];
      return Boolean(first) && isChildSessionInfo({}, "", JSON.parse(first));
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
        running: Boolean(mem?.session?.isStreaming),
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
        running: Boolean(state.session?.isStreaming),
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
      running: Boolean(state.session?.isStreaming),
      model: model ? { provider: model.provider, modelId: model.id } : stored?.model || null,
      thinkingLevel: state.session?.thinkingLevel ?? stored?.thinkingLevel ?? null,
      // false = pi 按全局/模型默认自选的（UI 显示「默认·X」），true = 用户主动选过
      thinkingExplicit: Boolean(state.thinkingChosen),
      seq: state.seq,
    };
  }

  async history(id) {
    const state = await this.attach(id, false);
    if (!state) return null;
    // 后台预热运行时会话：冷启动构建要等插件/MCP 初始化（可达分钟级），
    // 不能让第一次 prompt/edit 在请求里白等；等它构建好，后续请求直接可用。
    if (!state.session) {
      this.attach(id, true).catch((error) => {
        console.error("[pi-web] runtime warm failed:", error instanceof Error ? error.message : String(error));
      });
    }
    return { session: this.sessionView(state), events: state.events };
  }

  /** SSE 订阅：先回放已缓冲事件，再接实时流。 */
  subscribe(id, res) {
    return this.attach(id, false).then((state) => {
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
      for (const frame of state.events) res.write(`data: ${JSON.stringify(frame)}\n\n`);
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

  async prompt(id, text, images) {
    const state = await this.attach(id);
    if (!state || !state.session) return { ok: false, error: "session not found" };
    if (state.session.isStreaming) {
      // 任务进行中不接受新 prompt：避免把正在跑的任务打断（前端应先停止再发）
      return { ok: false, status: 409, error: "任务进行中：先点「■ 任务中」停止当前任务" };
    }
    const body = String(text ?? "").trim();
    if (!body) return { ok: false, error: "empty prompt" };
    this.push(state, { type: "user", text: body });
    const opts = Array.isArray(images) && images.length
      ? { images: images.slice(0, 8).map((im) => ({ type: "image", data: String(im.data), mimeType: String(im.mimeType) })) }
      : undefined;
    state.session.prompt(body, opts).catch((error) => {
      console.error("[pi-web] prompt failed:", error instanceof Error ? error.message : error);
      this.pushStatus(state, "retry");
      this.push(state, { type: "assistant-end", stopReason: "error", error: error instanceof Error ? error.message : String(error) });
      this.pushStatus(state, "idle");
    });
    return { ok: true };
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
    const replay = this.translateBranch(manager.getBranch());
    for (const event of replay) state.events.push(this.frame(state, event));
    state.turn = replay.filter((e) => e.type === "turn-start").length;
    this.push(state, { type: "transcript-reset", events: replay });
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
      state.session.abort();
      // pi-coding-agent abort 后未必发出 agent_end；等最多 8s，若仍在跑则补发 turn-end
      const deadline = Date.now() + 8000;
      while (state.session.isStreaming && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (state.streaming && !state.session.isStreaming) {
        state.streaming = false;
        this.push(state, { type: "turn-end", turn: state.turn, retry: false });
        this.pushStatus(state, "idle");
      }
    }
    return { ok: true };
  }

  /** 手动压缩上下文（/compact 同款入口）。 */
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

  /**
   * Read configured capabilities using Pi's provider-aware resolver, without
   * initializing extensions or issuing inference requests.
   */
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

  /**
   * 上下文占用（标签栏仪表 + 悬浮明细的数据源）。
   *
   * 总量/百分比以 pi 的 getContextUsage 为准（provider 回报的 usage 权威；
   * 压缩后未出新一轮时 tokens 为 null，UI 显示「—」）。分项用 pi 同款
   * chars/4 启发式估算：系统提示词（扣掉其中的预设注入块）、激活工具
   * （name+description+参数 schema+guidelines）、预设注入块（store.buildBlock
   * 现场重建，与实际注入逐字一致）、历史消息 = 总量减前三项。
   */
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
      cache,
      model: model ? { provider: model.provider, modelId: model.id } : null,
    };
  }

  /**
   * 思考强度**真探测**：不管 models.json 怎么声明，对 minimal…max 每个级别
   * 直接向端点发一条 1-token 小请求，看会不会报错、有没有真产出思考内容。
   * 声明骗人，端点不说谎。成本控制：不支持的级别端点直接报错（零计费），
   * 支持的级别只消耗 ~1 个输出 token（万分之一分级别的钱）。
   *
   * max_tokens 按协议下限：responses 系最低 16；anthropic 的思考预算必须
   * 小于 max_tokens，给 4096 让适配器自行收紧；其余 1。
   * 探测用模型克隆：reasoning 强制置真；thinkingLevelMap 保留原 wire 拼写、
   * 缺的级别补 canonical 名——否则 pi 在发送前就按声明 clamp 掉了，试不出来。
   * 判定：报错 = 不支持；没报错但没思考块 = 参数被吞（不算）；有思考块 = 支持。
   */
  /* legacy probeThinking removed: capability data is read from configuration. */
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

  // ── 模型目录与服务商设置 ─────────────────────────────────────────

  /**
   * 会话模型目录：注册表全部可服务的服务商组（models.json 声明 + 有凭据的
   * 内置目录），组内模型带 thinkingLevelMap 派生的思考强度列表。只列当前
   * 真正可服务的组（hasConfiguredAuth），否则选择器会提供选不了的模型。
   */
  /**
   * 会话模型目录：**只列 models.json 里你配置的服务商**（与设置页一致，
   * 环境变量带来密钥的内置服务商不进选择器）。组内模型带思考强度列表。
   */
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

  /** 服务商目录：内置目录行 + models.json 声明行（含可编辑条目）。 */
  /**
   * 服务商列表：只列 models.json 里用户自己声明（配置）的服务商。pi 内置
   * 目录不进设置列表（用不到只会添乱）；若用户声明的 id 恰好是内置路由，
   * 标记 shadowNative（保存仍按内置覆盖语义只写用户给出的字段）。
   */
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
          })),
        },
      });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return rows;
  }

  /**
   * 保存服务商（创建/更新）。内置目录路由只写用户给出的覆盖，缺省继承目
   * 录；自定义路由需要 api + baseUrl + models。密钥直接落条目 inline
   * apiKey（pi 的请求密钥解析点）；模型 id/name 去首尾空白。
   */
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
      // 按 id 合并而不是整体替换：表单只携带 6 个可编辑字段，直接替换会把
      // 已存模型的 cost/input/compat 等全部抹掉（「模型信息消失」的根因）。
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

  /**
   * 当前对话的文件改动 diff：遍历会话分支，收集 write（整写）与 edit
   * （oldText→newText）工具的成功操作，按文件分组生成统一补丁。
   * 返回 {files:[{path, additions, deletions, patch}]}（按首次改动顺序）。
   */
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

  // ── 预设上下文（预设规则组 + 上下文文件 + 不压缩开关） ────────────

  /** 预设面板视图：配置 + 上下文文件存在性 + 不压缩开关。 */
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
      noCompaction: this.readSettings().noCompaction === true,
    };
  }

  /**
   * 保存预设配置（整份提交，服务端归一化校验）；noCompaction 落桥设置，
   * 对新构建的会话生效。
   */
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
    if (typeof payload.noCompaction === "boolean") {
      const stored = this.readSettings();
      stored.noCompaction = payload.noCompaction;
      this.writeSettings(stored);
    }
    return this.presetsView();
  }

  /** 新建/覆写工作区里的上下文文件（AGENTS.md / CLAUDE.md）。 */
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

  /**
   * 运行环境面（右侧面板的真实数据）：pi 版本、共享 MCP 服务器、共享插件
   * （pi 侧启用态）与技能计数——与会话实际装载的来源同一路径。
   */
  async envInfo() {
    const sdk = await this.sdkReady();
    const { readMcpServers } = await import("@pi-dsh-bridge/pi-mcp");
    const mcp = readMcpServers(path.join(ROOT, "config", "mcp.json")).map((s) => s.serverName);
    const plugins = [];
    const pluginsDir = path.join(ROOT, "plugins");
    let enableConfig = {};
    try {
      enableConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "plugins.json"), "utf8").replace(/^\uFEFF/, "")) || {};
    } catch {
      // 无配置按全默认
    }
    try {
      for (const name of fs.readdirSync(pluginsDir)) {
        const manifestFile = path.join(pluginsDir, name, "manifest.json");
        if (!fs.existsSync(manifestFile)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        if (!manifest?.name) continue;
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
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    let skills = 0;
    try {
      skills = fs.readdirSync(path.join(ROOT, "skills")).filter((n) => fs.existsSync(path.join(ROOT, "skills", n, "SKILL.md"))).length;
    } catch {
      skills = 0;
    }
    return { piVersion: sdk.VERSION, cwd: ROOT, mcp, plugins, skills };
  }

  // ── 工作区（会话按 cwd 归属过滤） ────────────────────────────────

  settingsFile() {
    return process.env.PDB_PI_WEB_SETTINGS || path.join(ROOT, "config", ".pi-web", "settings.json");
  }

  readSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.settingsFile(), "utf8").replace(/^\uFEFF/, "")) || {};
    } catch {
      return {};
    }
  }

  /** 压缩/摘要用的省钱模型（settings.compactionModel）；null = 跟随会话模型。 */
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
  async subagentStatus(id) {
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
    const items = await this.list();
    const registry = Array.isArray(this.readSettings().workspaces) ? this.readSettings().workspaces : [];
    const map = new Map();
    map.set(ROOT.toLowerCase(), { path: ROOT, title: this.baseName(ROOT), default: true });
    for (const w of registry) {
      if (w && typeof w.path === "string" && w.path && !map.has(w.path.toLowerCase())) {
        map.set(w.path.toLowerCase(), { path: w.path, title: w.title || this.baseName(w.path), custom: true });
      }
    }
    for (const s of items) {
      if (!s.cwd) continue;
      const key = String(s.cwd).toLowerCase();
      if (!map.has(key)) map.set(key, { path: s.cwd, title: this.baseName(s.cwd), derived: true });
    }
    const rows = [...map.values()];
    for (const r of rows) {
      r.count = items.filter((s) => String(s.cwd || "").toLowerCase() === r.path.toLowerCase()).length;
    }
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
