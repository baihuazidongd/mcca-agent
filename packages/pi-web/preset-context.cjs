"use strict";

/**
 * @pi-dsh-bridge/pi-dsh-web — 预设上下文（preset context）核心。
 *
 * 预设（preset）是用户命名的规则分组；每条消息发送时，该会话勾选的预设里的
 * 启用规则按固定顺序追加到本回合的系统提示词（会话级多选，勾选持久化）。
 * 另保留 AGENTS.md / CLAUDE.md 项目文件注入：开关是全局的，文件按会话所在的
 * 工作区现场解析——会话落在哪个工作区，就检查那个工作区里的文件，找到即注入。
 *
 * 存储与全局性：
 *   - 配置落盘在 pi 全局 agent 目录（AGENT_DIR/dsh-web-settings.json，可用
 *     PDB_AGENT_DIR 覆盖），与工作区无关——同一份预设对所有工作区/会话可用，
 *     不被任何固定目录（如某个固定检出目录）绑死。
 *   - 兼容旧版：全局文件缺少 `preset-context` 段时回退读工作区
 *     dsh-web-settings.json 的同名字段（旧版扁平 rules 自动迁移成一个
 *     「默认预设」并设为默认启用）；写入只落全局文件，不回写旧文件。
 *
 * 数据形态（v2）：
 *   {
 *     version: 2,
 *     agentsMd: boolean, claudeMd: boolean,
 *     presets: [{ id, name, rules: [{ id, name, content, enabled }] }],
 *     defaultSelected: [presetId],          // 未做过显式选择的会话的默认勾选
 *     sessions: { [sessionId]: [presetId] } // 会话显式勾选（多选，可为空数组）
 *   }
 *
 * 生效与性能契约：
 *   - 即时生效：扩展在 pi 的 `before_agent_start` 事件（每条用户消息恰好触发一次，
 *     agent 循环内不重复触发）里现场解析配置；改动保存后的下一条消息即生效，
 *     无需重启进程或新建会话。
 *   - 不影响运行速度：配置与上下文文件都按 (mtimeMs:size) 缓存——稳态下每条
 *     消息只有 3 次 `stat`（全局设置文件 + 两个上下文文件），内容未变不重读；
 *     没有启用任何注入项时返回 null，系统提示词保持原样（不触发 provider 缓存失效）。
 *   - 隔离：构建注入块的任何异常都被吞掉并降级为“本回合不注入”，绝不阻断会话。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** 单条规则内容上限（字符）：预设指令进入系统提示词，拒绝异常体量。 */
const RULE_MAX_CHARS = 64 * 1024;
/** 全部预设全部规则内容总量上限（字符）。 */
const TOTAL_RULES_MAX_CHARS = 1024 * 1024;
/** 单个预设最多规则条数。 */
const MAX_RULES = 100;
/** 最多预设条数。 */
const MAX_PRESETS = 50;
/** 会话勾选记录上限（超过按插入序淘汰最旧）。 */
const MAX_SESSION_SELECTIONS = 500;
/** 旧版扁平规则迁移出的预设 id（确定性，保证 defaultSelected 引用稳定）。 */
const LEGACY_PRESET_ID = "preset-default";

function newPresetId() {
  return `preset-${crypto.randomUUID().slice(0, 8)}`;
}

/** 生成规则 id（客户端留空时由服务端补）。 */
function newRuleId() {
  return `rule-${crypto.randomUUID().slice(0, 8)}`;
}

/** 规范化单条规则（读路径宽容：畸形条目剔除而不是抛错）。 */
function normalizeRule(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  return {
    id: typeof item.id === "string" && item.id ? item.id : newRuleId(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "未命名规则",
    content: typeof item.content === "string" ? item.content : "",
    enabled: item.enabled !== false,
  };
}

/**
 * 规范化一份存储/读路径形态的预设配置。畸形条目被剔除（设置文件是用户可手
 * 编辑的 JSON，读路径必须永远可用）；v1 扁平 rules 迁移成单个「默认预设」。
 * @param {unknown} raw - 设置 JSON 里的 `preset-context` 值。
 * @returns {{ version: number, agentsMd: boolean, claudeMd: boolean, presets: Array<object>, defaultSelected: string[], sessions: Record<string, string[]> }}
 */
function normalizePresetConfig(raw) {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const presets = [];
  const sourcePresets = Array.isArray(cfg.presets) ? cfg.presets : null;
  const usedIds = new Set();
  if (sourcePresets) {
    for (const item of sourcePresets) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rules = (Array.isArray(item.rules) ? item.rules : [])
        .map(normalizeRule)
        .filter(Boolean);
      let id = typeof item.id === "string" && item.id ? item.id : newPresetId();
      if (usedIds.has(id)) id = newPresetId();
      usedIds.add(id);
      presets.push({
        id,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "未命名预设",
        rules,
      });
      if (presets.length >= MAX_PRESETS) break;
    }
  } else if (Array.isArray(cfg.rules)) {
    // v1：扁平 rules → 单个默认预设，并设为默认启用（保持旧版“全局注入”语义）。
    const rules = cfg.rules.map(normalizeRule).filter(Boolean);
    presets.push({ id: LEGACY_PRESET_ID, name: "默认预设", rules });
  }
  const presetIds = new Set(presets.map((p) => p.id));
  const v1Migration = !sourcePresets && presets.length > 0;
  const defaultSelected = (Array.isArray(cfg.defaultSelected) ? cfg.defaultSelected : (v1Migration ? [LEGACY_PRESET_ID] : []))
    .filter((id) => typeof id === "string" && presetIds.has(id));
  const sessions = {};
  const rawSessions = cfg.sessions && typeof cfg.sessions === "object" && !Array.isArray(cfg.sessions)
    ? cfg.sessions
    : {};
  for (const [sessionId, ids] of Object.entries(rawSessions)) {
    if (!sessionId || !Array.isArray(ids)) continue;
    sessions[sessionId] = ids.filter((id) => typeof id === "string" && presetIds.has(id));
  }
  return {
    version: 2,
    agentsMd: cfg.agentsMd === true,
    claudeMd: cfg.claudeMd === true,
    presets,
    defaultSelected,
    sessions,
  };
}

/**
 * 校验并规范化 presetContext.set 的请求体（写路径，严格校验）。
 * sessions（会话勾选）不由该请求携带——由 presetContext.select 单独维护，
 * 保存时在存储层原样保留。
 * @param {unknown} payload - 请求体：{ agentsMd?, claudeMd?, presets?, defaultSelected? }（全量替换语义）。
 * @returns {{ config?: object, error?: string }}
 */
function normalizePresetInput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "presetContext.set: payload 必须是对象" };
  }
  const presetsInput = Array.isArray(payload.presets) ? payload.presets : [];
  if (presetsInput.length > MAX_PRESETS) {
    return { error: `presetContext.set: 预设数量超过上限（${MAX_PRESETS}）` };
  }
  let totalChars = 0;
  const presets = [];
  const usedIds = new Set();
  for (const item of presetsInput) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "presetContext.set: presets 条目必须是对象" };
    }
    const rulesInput = Array.isArray(item.rules) ? item.rules : [];
    if (rulesInput.length > MAX_RULES) {
      return { error: `presetContext.set: 预设「${String(item.name || "未命名")}」规则数量超过上限（${MAX_RULES}）` };
    }
    const rules = [];
    for (const rule of rulesInput) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        return { error: "presetContext.set: 规则条目必须是对象" };
      }
      const content = typeof rule.content === "string" ? rule.content : "";
      totalChars += content.length;
      if (content.length > RULE_MAX_CHARS) {
        return { error: `presetContext.set: 规则「${String(rule.name || "未命名")}」超过 ${RULE_MAX_CHARS} 字符上限` };
      }
      rules.push({
        id: typeof rule.id === "string" && rule.id ? rule.id : newRuleId(),
        name: typeof rule.name === "string" && rule.name.trim() ? rule.name.trim() : "未命名规则",
        content,
        enabled: rule.enabled !== false,
      });
    }
    let id = typeof item.id === "string" && item.id ? item.id : newPresetId();
    if (usedIds.has(id)) id = newPresetId();
    usedIds.add(id);
    presets.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "未命名预设",
      rules,
    });
  }
  if (totalChars > TOTAL_RULES_MAX_CHARS) {
    return { error: `presetContext.set: 规则总内容超过 ${TOTAL_RULES_MAX_CHARS} 字符上限` };
  }
  const config = {
    version: 2,
    agentsMd: payload.agentsMd === true,
    claudeMd: payload.claudeMd === true,
    presets,
    defaultSelected: [],
    sessions: {},
  };
  const presetIds = new Set(presets.map((p) => p.id));
  config.defaultSelected = (Array.isArray(payload.defaultSelected) ? payload.defaultSelected : [])
    .filter((id) => typeof id === "string" && presetIds.has(id));
  return { config };
}

/**
 * 会话工作区里的可勾选上下文文件候选（注入解析与设置面板展示共用同一定义）。
 * @param {string} cwd - 会话工作目录。
 */
function contextFileCandidates(cwd) {
  return [
    { key: "agentsMd", label: "AGENTS.md", path: path.join(cwd, "AGENTS.md") },
    { key: "claudeMd", label: "CLAUDE.md", path: path.join(cwd, "CLAUDE.md") },
  ];
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** (mtimeMs:size) 指纹：内容未变就不重读。 */
function stampOf(stat) {
  return stat ? `${stat.mtimeMs}:${stat.size}` : "missing";
}

function readJsonSection(file, key) {
  const stat = statOrNull(file);
  if (!stat) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw[key] : undefined;
  } catch (error) {
    return { __error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 预设上下文存储：全局设置文件的 mtime 缓存读 + 上下文文件内容缓存。
 * 一个 pi-dsh-web 进程一个实例，所有会话共享（改动即时可见）。
 */
class PresetContextStore {
  /**
   * @param {object} options
   * @param {string} options.settingsPath - 全局 dsh-web-settings.json 绝对路径（读+写）。
   * @param {string} [options.legacyPath] - 旧版工作区设置文件（只读回退，首次保存后自然失效）。
   * @param {((message: string) => void)} [options.log] - 诊断日志（默认静默）。
   */
  constructor(options) {
    this.settingsPath = options.settingsPath;
    this.legacyPath = options.legacyPath || "";
    this.log = options.log || (() => {});
    /** @type {{ stamp: string, config: object } | null} */
    this.configCache = null;
    /** @type {Map<string, { stamp: string, exists: boolean, content: string }>} */
    this.fileCache = new Map();
  }

  /** 保存配置后调用：抹掉设置文件缓存（写入可能落在同一 mtime 粒度内）。 */
  invalidateConfig() {
    this.configCache = null;
  }

  /** 全局配置文件里 `preset-context` 段的读取（带指纹）。 */
  readGlobalSection() {
    const stat = statOrNull(this.settingsPath);
    const stamp = stat ? stampOf(stat) : "missing";
    if (this.configCache && this.configCache.stamp === stamp) return this.configCache;
    let section;
    if (stat) {
      section = readJsonSection(this.settingsPath, "preset-context");
      if (section && section.__error) {
        this.log(`preset-context: settings read failed, treating as empty (${section.__error})`);
        section = undefined;
      }
    }
    this.configCache = { stamp, section };
    return this.configCache;
  }

  /**
   * 读取（并规范化）当前预设配置：全局文件优先，缺失段回退旧工作区文件
   * （v1 迁移在 normalizePresetConfig 内完成）。设置文件缺失/损坏按空配置处理。
   */
  readConfig() {
    const global_ = this.readGlobalSection();
    let section = global_.section;
    if (section === undefined && this.legacyPath) {
      const legacy = readJsonSection(this.legacyPath, "preset-context");
      if (legacy && !legacy.__error) section = legacy;
    }
    return normalizePresetConfig(section);
  }

  /**
   * 全量保存预设配置（presets/defaultSelected/文件勾选），原样保留现存的
   * 会话勾选记录（sessions 由 presetContext.select 单独维护）。
   * @param {object} config - normalizePresetInput 产出的 config（sessions 为空占位）。
   * @returns {object} 保存后的完整配置（含保留的 sessions）。
   */
  saveConfig(config) {
    const current = this.readConfig();
    const next = { ...config, sessions: current.sessions };
    this.writeSection(next);
    return next;
  }

  /** 写穿全局设置文件的 `preset-context` 段（读-改-写保留文件其他段）。 */
  writeSection(config) {
    let raw = {};
    const stat = statOrNull(this.settingsPath);
    if (stat) {
      try {
        raw = JSON.parse(fs.readFileSync(this.settingsPath, "utf8").replace(/^\uFEFF/, ""));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
      } catch {
        raw = {};
      }
    }
    raw["preset-context"] = config;
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    this.invalidateConfig();
  }

  /**
   * 某会话的生效勾选：显式记录优先，否则用默认勾选；引用已被删除的预设时剔除。
   * @param {string} sessionId - dsh/pi 会话 id。
   * @returns {string[]}
   */
  selectionFor(sessionId) {
    const config = this.readConfig();
    const presetIds = new Set(config.presets.map((p) => p.id));
    const explicit = config.sessions[sessionId];
    const source = Array.isArray(explicit) ? explicit : config.defaultSelected;
    return source.filter((id) => presetIds.has(id));
  }

  /**
   * 保存某会话的显式勾选（多选）。空数组也是显式记录（该会话一个预设都不注入）。
   * @param {string} sessionId - 会话 id。
   * @param {unknown} presetIds - 期望勾选的预设 id 列表（原样保存，读取时再剔除失效项）。
   * @returns {{ ids?: string[], error?: string }}
   */
  saveSelection(sessionId, presetIds) {
    if (typeof sessionId !== "string" || !sessionId) {
      return { error: "presetContext.select: sessionId 必须是非空字符串" };
    }
    if (!Array.isArray(presetIds)) {
      return { error: "presetContext.select: presetIds 必须是数组" };
    }
    const config = this.readConfig();
    const sessions = { ...config.sessions, [sessionId]: presetIds.map(String) };
    const keys = Object.keys(sessions);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSION_SELECTIONS))) {
      delete sessions[key];
    }
    this.writeSection({ ...config, sessions });
    return { ids: this.selectionFor(sessionId) };
  }

  /**
   * 读取一个上下文文件（存在性 + 内容），按指纹缓存。
   * @param {string} file - 绝对路径。
   * @returns {{ exists: boolean, content: string }}
   */
  fileContent(file) {
    const stat = statOrNull(file);
    const stamp = stampOf(stat);
    const cached = this.fileCache.get(file);
    if (cached && cached.stamp === stamp) return cached;
    let entry;
    if (!stat) {
      entry = { stamp, exists: false, content: "" };
    } else {
      try {
        entry = { stamp, exists: true, content: fs.readFileSync(file, "utf8") };
      } catch (error) {
        // stat 成功但读失败（权限/占用）：本回合按缺失处理，下一回合重试
        this.log(`preset-context: read failed for ${file} (${error instanceof Error ? error.message : String(error)})`);
        entry = { stamp, exists: false, content: "" };
      }
    }
    this.fileCache.set(file, entry);
    return entry;
  }

  /**
   * 组装注入块：项目上下文文件段 + 每个已选预设一段（只含该预设内启用的规则）。
   * @param {string} cwd - 会话工作目录。
   * @param {string[]} presetIds - 本会话勾选的预设 id（多选）。
   * @returns {string | null} 没有任何注入项时返回 null（不注入）。
   */
  buildBlockFor(cwd, presetIds) {
    const config = this.readConfig();
    const sections = [];
    for (const candidate of contextFileCandidates(cwd)) {
      const enabled = candidate.key === "agentsMd" ? config.agentsMd : config.claudeMd;
      if (!enabled) continue;
      const file = this.fileContent(candidate.path);
      const body = file.content.trim();
      if (!body) continue;
      sections.push(`## ${candidate.label}（项目上下文）\n\n路径：${candidate.path}\n\n${body}`);
    }
    const wanted = new Set(Array.isArray(presetIds) ? presetIds.map(String) : []);
    for (const preset of config.presets) {
      if (!wanted.has(preset.id)) continue;
      const rules = preset.rules.filter((r) => r.enabled && r.content.trim());
      if (!rules.length) continue;
      const body = rules.map((r) => `### ${r.name}\n\n${r.content.trim()}`).join("\n\n");
      sections.push(`## 预设：${preset.name}\n\n${body}`);
    }
    if (!sections.length) return null;
    return [
      "# 预设上下文",
      "",
      "以下是用户的持久性预设指令，是本会话的长期约束，优先于默认行为；在整个会话期间持续有效。",
      "",
      ...sections,
    ].join("\n\n");
  }

  /**
   * 注入块便捷入口：按会话解析勾选（显式记录 > 默认勾选）后组装。
   * @param {string} cwd - 会话工作目录。
   * @param {string} [sessionId] - 会话 id；缺省按默认勾选。
   */
  buildBlock(cwd, sessionId) {
    return this.buildBlockFor(cwd, sessionId ? this.selectionFor(sessionId) : this.readConfig().defaultSelected);
  }
}

/**
 * 创建 pi 扩展工厂：在 `before_agent_start`（每条用户消息一次）把该会话勾选的
 * 预设与启用文件追加到系统提示词。空配置 / 任何异常都返回 undefined——本回合
 * 不注入，系统提示词保持 pi 原样（不影响 provider 端的提示词缓存）。
 * @param {object} options
 * @param {PresetContextStore} options.store - 共享存储实例。
 * @returns {(pi: object) => void}
 */
function createPresetContextExtension(options) {
  const store = options.store;
  return function presetContextExtension(pi) {
    pi.on("before_agent_start", (event, ctx) => {
      try {
        const cwd =
          (event.systemPromptOptions && typeof event.systemPromptOptions.cwd === "string" && event.systemPromptOptions.cwd) ||
          (ctx && typeof ctx.cwd === "string" && ctx.cwd) ||
          "";
        if (!cwd) return undefined;
        const sessionId = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === "function"
          ? String(ctx.sessionManager.getSessionId() || "")
          : "";
        const block = store.buildBlock(cwd, sessionId);
        if (!block) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      } catch (error) {
        store.log(`preset-context: injection skipped this turn (${error instanceof Error ? error.message : String(error)})`);
        return undefined;
      }
    });
  };
}

module.exports = {
  RULE_MAX_CHARS,
  TOTAL_RULES_MAX_CHARS,
  MAX_RULES,
  MAX_PRESETS,
  MAX_SESSION_SELECTIONS,
  LEGACY_PRESET_ID,
  newPresetId,
  newRuleId,
  normalizePresetConfig,
  normalizePresetInput,
  contextFileCandidates,
  PresetContextStore,
  createPresetContextExtension,
};
