/**
 * Local memory for both agents.
 *
 * Two stores, same file layout as ZCode project memory (one Markdown file per
 * fact, MEMORY.md is only the index):
 *
 *   <root>/memories/features/                         功能记忆，跨项目
 *   <root>/memories/projects/<slug>-<hash>/memory/    项目记忆，按工作区隔离
 *
 * The root defaults to ~/.mcca and is not inside the git worktree. Nothing
 * here is uploaded. Code layout and git history are not this store's job.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const FEATURE_TYPES = ["user", "feedback", "feature", "reference"];
export const PROJECT_TYPES = ["user", "feedback", "project", "reference"];
export const INDEX_LINE_LIMIT = 200;
export const INDEX_CHAR_LIMIT = 25_000;
export const BODY_MAX = 8_000;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 180;
export const MAX_ITEMS = 100;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_RE = /(sk-[A-Za-z0-9_\-]{16,})|(api[_-]?key\s*[:=]\s*\S{8,})|(AKIA[0-9A-Z]{16})|(-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

export function memoryRoot() {
  const override = process.env.MCCA_MEMORY_ROOT;
  if (typeof override === "string" && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), ".mcca");
}

export function memoryEnabled() {
  const flag = process.env.MCCA_MEMORY;
  if (flag === "0" || flag === "false") return false;
  const file = process.env.MCCA_MEMORY_CONFIG || path.join(REPO_ROOT, "config", "memory.json");
  if (!fs.existsSync(file)) return true;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return raw?.enabled !== false;
  } catch {
    return true;
  }
}

export function projectMemoryDir(root, cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("项目记忆需要会话工作区，当前没有 cwd");
  }
  const normalized = path.resolve(cwd);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const slug = sanitizeSlug(path.basename(normalized));
  return path.join(root, "memories", "projects", `${slug}-${hash}`, "memory");
}

export function featureMemoryDir(root) {
  return path.join(root, "memories", "features");
}

export function scopeDir(root, scope, cwd) {
  if (scope === "feature") return featureMemoryDir(root);
  if (scope === "project") return projectMemoryDir(root, cwd);
  throw new Error("scope 只能是 feature（功能记忆）或 project（项目记忆）");
}

function typesFor(scope) {
  if (scope === "feature") return FEATURE_TYPES;
  if (scope === "project") return PROJECT_TYPES;
  throw new Error("scope 只能是 feature（功能记忆）或 project（项目记忆）");
}

function sanitizeSlug(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function slugFromTitle(title) {
  const ascii = sanitizeSlug(title);
  if (/[a-z0-9]/.test(ascii) && ascii !== "project") return ascii.slice(0, 48);
  return `mem-${createHash("sha256").update(String(title)).digest("hex").slice(0, 8)}`;
}

function oneLine(value, max) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[\[\]]/g, "")
    .trim()
    .slice(0, max);
}

function quote(value) {
  return JSON.stringify(String(value ?? ""));
}

function field(frontmatter, key) {
  const match = new RegExp(`^\\s*${key}:\\s*(.+)\\s*$`, "m").exec(frontmatter);
  if (!match) return "";
  const raw = match[1].trim();
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.replace(/^"|"$/g, "");
    }
  }
  return raw;
}

function parseMemoryFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const name = field(match[1], "name");
  const title = field(match[1], "title");
  const type = field(match[1], "type");
  if (!NAME_RE.test(name) || !title || !type) return null;
  return {
    name,
    title,
    description: field(match[1], "description") || title,
    type,
    created: field(match[1], "created") || "",
    body: match[2].trim(),
  };
}

function containedFile(dir, name) {
  if (!NAME_RE.test(name)) return null;
  const file = path.resolve(dir, `${name}.md`);
  const relative = path.relative(path.resolve(dir), file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return file;
}

export function listMemories(root, scope, cwd) {
  const dir = scopeDir(root, scope, cwd);
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "MEMORY.md" || !entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    const file = containedFile(dir, name);
    if (!file || !fs.existsSync(file)) continue;
    const parsed = parseMemoryFile(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.name !== name) continue;
    items.push(parsed);
  }
  items.sort((a, b) => (a.created || "").localeCompare(b.created || "") || a.name.localeCompare(b.name));
  return items;
}

function renderIndex(items) {
  return items
    .map((item) => `- [${oneLine(item.title, TITLE_MAX)}](${item.name}.md) — ${oneLine(item.description, DESCRIPTION_MAX)}`)
    .join("\n");
}

function writeIndex(dir, items) {
  const text = renderIndex(items);
  fs.writeFileSync(path.join(dir, "MEMORY.md"), text ? `${text}\n` : "", "utf8");
}

export function formatMemoryIndex(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const lineTruncated = lines.length > INDEX_LINE_LIMIT;
  const charTruncated = trimmed.length > INDEX_CHAR_LIMIT;
  if (!lineTruncated && !charTruncated) return trimmed;
  let truncated = lineTruncated ? lines.slice(0, INDEX_LINE_LIMIT).join("\n") : trimmed;
  if (truncated.length > INDEX_CHAR_LIMIT) {
    const cut = truncated.lastIndexOf("\n", INDEX_CHAR_LIMIT);
    truncated = truncated.slice(0, cut > 0 ? cut : INDEX_CHAR_LIMIT);
  }
  const why = charTruncated && !lineTruncated
    ? `${trimmed.length} 字符，上限 ${INDEX_CHAR_LIMIT}`
    : lineTruncated && !charTruncated
      ? `${lines.length} 行，上限 ${INDEX_LINE_LIMIT}`
      : `${lines.length} 行、${trimmed.length} 字符`;
  return `${truncated}\n\n> 警告：MEMORY.md 超过上限（${why}）。索引每条保持一行，细节放进对应文件。`;
}

function assertNoSecret(text) {
  if (SECRET_RE.test(text)) throw new Error("记忆里不能写密钥、令牌或私钥");
}

export function writeMemory(root, input) {
  const scope = input?.scope;
  const allowed = typesFor(scope);
  const type = String(input?.type || "");
  if (!allowed.includes(type)) {
    throw new Error(`${scope === "feature" ? "功能记忆" : "项目记忆"}的 type 只能是 ${allowed.join(" / ")}`);
  }
  const title = oneLine(input?.title, TITLE_MAX);
  const body = String(input?.body || "").trim();
  if (!title) throw new Error("title 不能为空");
  if (!body) throw new Error("body 不能为空");
  if (body.length > BODY_MAX) throw new Error(`body 超过 ${BODY_MAX} 字符`);
  assertNoSecret(`${title}\n${body}\n${input?.description || ""}`);
  const description = oneLine(input?.description || body, DESCRIPTION_MAX) || title;
  const dir = scopeDir(root, scope, input?.cwd);
  fs.mkdirSync(dir, { recursive: true });
  const existing = listMemories(root, scope, input?.cwd);
  let name = typeof input?.name === "string" && input.name ? input.name : slugFromTitle(title);
  if (!NAME_RE.test(name)) throw new Error("记忆文件名只能是小写字母、数字、点、下划线和短横线");
  const previous = existing.find((item) => item.name === name);
  if (!previous && existing.length >= MAX_ITEMS) {
    throw new Error(`这个范围已经有 ${MAX_ITEMS} 条记忆。先 memory_forget 再写`);
  }
  const created = previous?.created || new Date().toISOString();
  const file = containedFile(dir, name);
  if (!file) throw new Error("记忆路径越界");
  const text = [
    "---",
    `name: ${quote(name)}`,
    `title: ${quote(title)}`,
    `description: ${quote(description)}`,
    "metadata:",
    `  type: ${type}`,
    `  created: ${quote(created)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  const items = listMemories(root, scope, input?.cwd);
  writeIndex(dir, items);
  return { name, title, description, type, scope, path: file, created };
}

export function readMemory(root, input) {
  const scope = input?.scope;
  const dir = scopeDir(root, scope, input?.cwd);
  const name = input?.name ? String(input.name).replace(/\.md$/, "") : "";
  if (!name) {
    const items = listMemories(root, scope, input?.cwd);
    const index = formatMemoryIndex(renderIndex(items));
    return { index, items, dir };
  }
  const file = containedFile(dir, name);
  if (!file || !fs.existsSync(file)) throw new Error(`没有这条记忆: ${name}`);
  const parsed = parseMemoryFile(fs.readFileSync(file, "utf8"));
  if (!parsed) throw new Error(`记忆文件损坏: ${name}`);
  return parsed;
}

export function searchMemory(root, input) {
  const query = oneLine(input?.query, 200).toLowerCase();
  if (!query) throw new Error("query 不能为空");
  const scopes = input?.scope === "feature" || input?.scope === "project"
    ? [input.scope]
    : ["feature", "project"];
  const hits = [];
  for (const scope of scopes) {
    let items = [];
    try {
      items = listMemories(root, scope, input?.cwd);
    } catch (error) {
      if (scope === "project") continue;
      throw error;
    }
    for (const item of items) {
      const hay = `${item.title}\n${item.description}\n${item.body}`.toLowerCase();
      if (!hay.includes(query)) continue;
      hits.push({
        scope,
        name: item.name,
        type: item.type,
        title: item.title,
        description: item.description,
      });
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

export function forgetMemory(root, input) {
  const scope = input?.scope;
  const items = listMemories(root, scope, input?.cwd);
  const name = input?.name ? String(input.name).replace(/\.md$/, "") : "";
  let matches = [];
  if (name) {
    matches = items.filter((item) => item.name === name);
  } else {
    const query = oneLine(input?.query, 200).toLowerCase();
    if (!query) throw new Error("忘掉记忆需要 name 或 query");
    matches = items.filter((item) => `${item.name}\n${item.title}\n${item.description}`.toLowerCase().includes(query));
  }
  if (matches.length === 0) throw new Error("没有匹配的记忆");
  if (matches.length > 1) {
    const error = new Error("匹配到多条记忆，请用 name 指定一条");
    error.matches = matches.map((item) => ({ name: item.name, title: item.title }));
    throw error;
  }
  const dir = scopeDir(root, scope, input?.cwd);
  const file = containedFile(dir, matches[0].name);
  if (!file) throw new Error("记忆路径越界");
  fs.rmSync(file, { force: true });
  writeIndex(dir, listMemories(root, scope, input?.cwd));
  return matches[0];
}

export function buildMemoryPrompt(root, cwd) {
  if (!memoryEnabled()) return null;
  const sections = [];
  const feature = formatMemoryIndex(renderIndex(listMemories(root, "feature")));
  if (feature) {
    sections.push(`## 功能记忆\n\n跨项目。类型是 user / feedback / feature / reference。\n\n${feature}`);
  }
  if (cwd) {
    try {
      const project = formatMemoryIndex(renderIndex(listMemories(root, "project", cwd)));
      if (project) {
        sections.push(`## 项目记忆\n\n只属于当前工作区 ${cwd}。类型是 user / feedback / project / reference。\n\n${project}`);
      }
    } catch {
      // 没有工作区就不注入项目记忆，功能记忆照常。
    }
  }
  if (!sections.length) return null;
  return [
    "# 记忆",
    "",
    "下面是本机长期记忆的索引，不是本轮任务。需要正文时用 memory_read。用户说记住时立刻 memory_write；说忘掉时 memory_forget。不要把代码结构、git 历史、已经写在 AGENTS.md / CLAUDE.md 里的内容再写进去，也不要记密钥。",
    "",
    ...sections,
  ].join("\n\n");
}
