"use strict";

const assert = require("node:assert/strict");
const { mapUpdates } = require("../bridge.cjs");

const lines = [
  JSON.stringify({ timestamp: "2026-09-22T00:00:00Z", params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "只回复一个字" } } } }),
  JSON.stringify({ timestamp: "2026-09-22T00:00:01Z", params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "：是" } } } }),
  JSON.stringify({ timestamp: "2026-09-22T00:00:02Z", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想一下" } } } }),
  JSON.stringify({ timestamp: "2026-09-22T00:00:03Z", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "是" } } } }),
  JSON.stringify({ timestamp: "2026-09-22T00:00:04Z", params: { update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "read_file", rawInput: { path: "a.txt" } } } }),
  JSON.stringify({ timestamp: "2026-09-22T00:00:05Z", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "c1", title: "read_file", status: "completed", content: [{ text: "ok" }] } } }),
  JSON.stringify({ timestamp: "2026-09-22T00:00:06Z", params: { update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } } }),
];

const events = mapUpdates(lines).map((item) => item.event.type);
assert.deepEqual(events, [
  "user",
  "turn-start",
  "assistant-start",
  "thinking-delta",
  "thinking-end",
  "assistant-delta",
  "tool",
  "tool",
  "assistant-end",
  "turn-end",
]);
assert.equal(mapUpdates(lines)[0].event.text, "只回复一个字：是");
console.log("map ok");
