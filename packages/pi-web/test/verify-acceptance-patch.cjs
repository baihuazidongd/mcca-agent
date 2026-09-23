/* 验证 pi-subagents 验收补丁：中文只读审查任务 → 应得 level=none。 */
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const root = path.join(process.env.USERPROFILE, ".pi", "agent", "npm", "node_modules", "pi-subagents");
const req = createRequire(path.join(root, "package.json"));
const jitiMod = req("jiti");
const jiti = typeof jitiMod.createJiti === "function"
  ? jitiMod.createJiti(__filename, { interopDefault: true })
  : jitiMod(__filename, { interopDefault: true });

(async () => {
  const shared = await jiti.import(pathToFileURL(path.join(root, "src", "runs", "shared", "acceptance.ts")).href);
  const { resolveEffectiveAcceptance } = shared;

  const task = `请独立批评下面这张 16×32 像素少女网格。不要给泛泛教程，也不要为作者辩护。逐项指出为什么它看起来丑、哪些结构关系失败、哪些像素模式导致它不像人/少女，并给出可操作的修正原则。只分析，不改文件。

网格：
................
....RR..........
..RRHHHHH.......
.RHHHHHHHHHH....

字符含义：H/h=头发，S=皮肤。`;

  const cases = [
    { name: "reviewer 中文只读 + dynamicGroup", input: { agentName: "reviewer", task, mode: "workflow", async: true, dynamicGroup: true } },
    { name: "reviewer 中文只读（无 dynamic）", input: { agentName: "reviewer", task } },
    { name: "worker 写入任务（应保持 checked）", input: { agentName: "worker", task: "Fix the failing unit tests in src/foo.ts and run the suite.", async: true } },
  ];
  for (const c of cases) {
    const r = resolveEffectiveAcceptance(c.input);
    console.log(`${c.name}: level=${r.level} evidence=[${r.evidence.join(",")}]`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
