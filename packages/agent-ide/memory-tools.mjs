/**
 * Neutral memory tools. Both adapters register this factory.
 * scope=feature is 功能记忆 (one store for every workspace).
 * scope=project is 项目记忆 (isolated by the session cwd).
 */

import {
  BODY_MAX,
  FEATURE_TYPES,
  PROJECT_TYPES,
  forgetMemory,
  memoryEnabled,
  memoryRoot,
  readMemory,
  searchMemory,
  writeMemory,
} from "./memory-store.mjs";

function text(value) {
  return { content: [{ type: "text", text: String(value) }] };
}

function fail(error) {
  const matches = Array.isArray(error?.matches)
    ? `\n${error.matches.map((item) => `- ${item.name}: ${item.title}`).join("\n")}`
    : "";
  return text(`${error instanceof Error ? error.message : String(error)}${matches}`);
}

function disabled() {
  return text("记忆已关闭。把 config/memory.json 的 enabled 设为 true，或去掉环境变量 MCCA_MEMORY=0，然后新开会话。");
}

export function registerMemoryTools(api) {
  api.registerTool({
    name: "memory_write",
    description: "立刻写入一条长期记忆。功能记忆 scope=feature，跨所有项目，type 为 user、feedback、feature、reference。项目记忆 scope=project，只属于当前工作区，type 为 user、feedback、project、reference。用户说记住时调用。不要记代码结构、git 历史、AGENTS.md 已有内容或密钥。",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["feature", "project"], description: "feature 是功能记忆，project 是项目记忆。" },
        type: { type: "string", description: `功能记忆: ${FEATURE_TYPES.join("/")}。项目记忆: ${PROJECT_TYPES.join("/")}。` },
        title: { type: "string", description: "索引上的一行标题。" },
        description: { type: "string", description: "可选。索引上的短钩子，不写就取正文第一句。" },
        body: { type: "string", description: `记忆正文，最多 ${BODY_MAX} 字符。` },
        name: { type: "string", description: "可选。要更新的已有条目文件名，不含 .md。" },
      },
      required: ["scope", "type", "title", "body"],
    },
    async execute(args, ctx) {
      if (!memoryEnabled()) return disabled();
      try {
        const saved = writeMemory(memoryRoot(), {
          scope: args?.scope,
          type: args?.type,
          title: args?.title,
          description: args?.description,
          body: args?.body,
          name: args?.name,
          cwd: ctx?.cwd,
        });
        return text(`已写入${saved.scope === "feature" ? "功能记忆" : "项目记忆"} ${saved.name}（${saved.type}）：${saved.title}`);
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "memory_read",
    description: "读取功能记忆或项目记忆。不传 name 时返回 MEMORY.md 索引；传 name 时返回那一条的正文。",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["feature", "project"] },
        name: { type: "string", description: "条目文件名，不含 .md。省略则返回索引。" },
      },
      required: ["scope"],
    },
    async execute(args, ctx) {
      if (!memoryEnabled()) return disabled();
      try {
        const result = readMemory(memoryRoot(), { scope: args?.scope, name: args?.name, cwd: ctx?.cwd });
        if (result.index !== undefined) {
          return text(result.index || "（这个范围还没有记忆）");
        }
        return text(`# ${result.title}\n\n类型: ${result.type}\n\n${result.body}`);
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "memory_search",
    description: "在功能记忆和项目记忆里按标题、钩子和正文搜索。scope 可省略，省略时两边都搜。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["feature", "project", "all"] },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      if (!memoryEnabled()) return disabled();
      try {
        const scope = args?.scope === "all" ? undefined : args?.scope;
        const hits = searchMemory(memoryRoot(), { query: args?.query, scope, cwd: ctx?.cwd });
        if (!hits.length) return text("没有匹配的记忆");
        return text(hits.map((hit) => `- [${hit.scope}] ${hit.name} (${hit.type}) ${hit.title} — ${hit.description}`).join("\n"));
      } catch (error) {
        return fail(error);
      }
    },
  });

  api.registerTool({
    name: "memory_forget",
    description: "删除一条功能记忆或项目记忆。用户说忘掉时调用。多条匹配时不会删，会把候选 name 列出来。",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["feature", "project"] },
        name: { type: "string", description: "条目文件名，不含 .md。" },
        query: { type: "string", description: "没有 name 时按标题或钩子匹配。必须唯一。" },
      },
      required: ["scope"],
    },
    async execute(args, ctx) {
      if (!memoryEnabled()) return disabled();
      try {
        const removed = forgetMemory(memoryRoot(), {
          scope: args?.scope,
          name: args?.name,
          query: args?.query,
          cwd: ctx?.cwd,
        });
        return text(`已删除 ${removed.name}：${removed.title}`);
      } catch (error) {
        return fail(error);
      }
    },
  });
}
