// 回执是父代理唯一的信息来源：一整批同样死法的孩子，要在回执里说成一个可执行的结论。
const test = require("node:test");
const assert = require("node:assert");

const { formatSubagentReceipt, formatSubagentReceiptGroup } = require("../bridge.cjs");

const EMPTY = "Run fan-out: 10/64 used\nSubagent produced no output (possible model cold-start or empty response).";

test("a failed receipt names the failure instead of dumping the raw error", () => {
  const text = formatSubagentReceipt({ agent: "worker", success: false, error: EMPTY, durationMs: 4200 });
  assert.match(text, /子代理回执/);
  assert.match(text, /失败/);
  assert.match(text, /空返回：/);
  assert.match(text, /fallbackModels/);
  assert.doesNotMatch(text, /possible model cold-start/);
});

test("an unclassified failure keeps the preview it has", () => {
  const text = formatSubagentReceipt({ agent: "worker", success: false, error: "provider 400 bad request", summary: "上游拒了" });
  assert.match(text, /上游拒了/);
  assert.doesNotMatch(text, /空返回|角色名不存在|超时|进程已退出/);
});

test("a completed receipt still reports the summary and the artifact", () => {
  const text = formatSubagentReceipt({ agent: "translator", success: true, summary: "翻完 3 章", artifactPath: "D:/out/zh.md" });
  assert.match(text, /完成/);
  assert.match(text, /翻完 3 章/);
  assert.match(text, /产物：D:\/out\/zh\.md/);
});

test("a fan-out receipt collapses into one actionable line per failure class", () => {
  const items = Array.from({ length: 36 }, () => ({ agent: "translator", success: false, error: EMPTY }));
  const text = formatSubagentReceiptGroup(items);
  const lines = text.split("\n");
  assert.equal(lines[0], "【子代理回执】36 个任务结束");
  assert.equal(lines.filter((l) => /空返回/.test(l)).length, 37);
  const tally = lines[lines.length - 1];
  assert.match(tally, /^空返回 ×36：/);
  assert.match(tally, /降 fan-out 并发重跑|fallbackModels/);
});

test("a mixed fan-out tallies each class and leaves the rest readable", () => {
  const items = [
    { agent: "a", success: false, error: EMPTY },
    { agent: "b", success: false, error: "Unknown agent: translator" },
    { agent: "c", success: true, summary: "这一条成了", artifactPath: "D:/out/c.md" },
    { agent: "d", success: false, error: "provider 400 bad request" },
  ];
  const text = formatSubagentReceiptGroup(items);
  assert.match(text, /1\. a 失败：空返回/);
  assert.match(text, /2\. b 失败：角色名不存在/);
  assert.match(text, /3\. c 完成：这一条成了/);
  assert.match(text, /4\. d 失败：provider 400 bad request/);
  assert.match(text, /^空返回 ×1：/m);
  assert.match(text, /^角色名不存在 ×1：/m);
  // 有一类失败时不报产物：那半批根本没写出东西，报路径等于让父代理去读不存在的文件
  assert.doesNotMatch(text, /产物：/);
});
