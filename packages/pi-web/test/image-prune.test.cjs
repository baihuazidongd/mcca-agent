"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pruneMessages } = require("../image-prune.cjs");

const img = (n) => ({ type: "image", data: "x".repeat(n), mimeType: "image/png" });
const msg = (...content) => ({ role: "toolResult", content });

test("只保留最近 N 张图片，其余换成文字说明", () => {
  const messages = [msg(img(10)), { role: "user", content: "hi" }, msg(img(10), img(10)), msg(img(10))];
  const { messages: next, dropped } = pruneMessages(messages, 2);
  assert.equal(dropped, 2);
  const types = next.map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.type).join("+") : m.content));
  assert.deepEqual(types, ["text", "hi", "text+image", "image"]);
  // 原对象不动
  assert.equal(messages[0].content[0].type, "image");
  assert.equal(next[0].role, "toolResult");
  assert.match(next[0].content[0].text, /图片已省略/);
});

test("图片数不超过保留数时原样返回", () => {
  const messages = [msg(img(10)), msg(img(10))];
  const { messages: next, dropped } = pruneMessages(messages, 4);
  assert.equal(dropped, 0);
  assert.equal(next, messages);
});

test("兼容 image_url / anthropic base64 源", () => {
  const messages = [
    msg({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }),
    msg({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }),
    msg(img(4)),
  ];
  const { dropped } = pruneMessages(messages, 1);
  assert.equal(dropped, 2);
});

test("保留数为 0 时全部裁剪", () => {
  const messages = [msg(img(1)), msg(img(1))];
  const { dropped, messages: next } = pruneMessages(messages, 0);
  assert.equal(dropped, 2);
  assert.ok(next.every((m) => m.content.every((c) => c.type === "text")));
});
