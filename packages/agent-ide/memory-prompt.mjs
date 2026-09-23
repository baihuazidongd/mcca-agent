/**
 * pi extension: append the memory index on before_agent_start.
 * An empty store returns undefined so the system prompt stays byte-for-byte
 * unchanged and the provider prompt cache does not bust.
 */

import { buildMemoryPrompt, memoryRoot } from "./memory-store.mjs";

export function createMemoryContextExtension() {
  return function memoryContextExtension(pi) {
    pi.on("before_agent_start", (event, ctx) => {
      try {
        const cwd =
          (event?.systemPromptOptions && typeof event.systemPromptOptions.cwd === "string" && event.systemPromptOptions.cwd) ||
          (ctx && typeof ctx.cwd === "string" && ctx.cwd) ||
          "";
        const block = buildMemoryPrompt(memoryRoot(), cwd);
        if (!block) return undefined;
        const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
        return { systemPrompt: base ? `${base}\n\n${block}` : block };
      } catch {
        return undefined;
      }
    });
  };
}
