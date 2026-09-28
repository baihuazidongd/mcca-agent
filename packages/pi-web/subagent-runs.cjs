"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TERMINAL = new Set(["completed", "stopped", "failed"]);
const MANAGEMENT_ACTIONS = new Set(["list", "get", "models", "create", "update", "delete", "eject", "disable", "enable", "reset"]);
// A run with no async directory / child session can never be reconciled from
// disk. If it is still "working" after this long, a live run is implausible
// (foreground launches are capped at 30 min), so it is an orphan.
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;
// 与上游 stale-run-reconciler 同阈值：PID 活着但状态一天没动，说明这个 PID
// 可能已经被别的进程复用，归属无法验证，才判死。
const STALE_ALIVE_PID_MS = 24 * 60 * 60 * 1000;

// 上游把「一次输出都没有」判成失败，但这不是代理拒绝干活；角色名不存在也不是
// 权限不够。这几类都要单独标出来，人看一眼就知道是降并发重跑、改角色名还是删白名单，
// 而不是以为子代理被锁了职能。类别取自她自己的 110 条 run 的实际死法。
const FAILURE_CLASSES = [
  { key: "empty_output", label: "空返回", hint: "模型这一趟一个字都没出，多半是并发打满或冷启动。降 fan-out 并发重跑，或给这个 agent 配 fallbackModels。" },
  { key: "unknown_agent", label: "角色名不存在", hint: "派出来的角色名在 agent 列表里没有。用内置角色名（worker/reviewer/…），或在 .pi/agents 里建同名角色。" },
  { key: "timeout", label: "超时", hint: "子代理跑满了单次时限被砍掉。拆小任务或提高该角色的时限。" },
  // 派它的进程没了或临时目录被回收：这一条不会再有结果，重跑就行。
  // 不标出来，它和「代理拒绝干活」在界面上是同一个词。
  { key: "runner_gone", label: "进程已退出", hint: "派出它的进程已退出或临时目录被回收，这条 run 不会再有结果。直接重跑这个子任务。" },
  // 内置 researcher 就死在这条上：它的 tools 白名单点名了 web_search，而子会话没接扩展。
  { key: "missing_tools", label: "工具不可用", hint: "角色的 tools 白名单点名了子会话里没有的工具（web_search 这类来自扩展或 MCP）。删掉该角色的 tools 让它继承父会话，或把对应扩展接上。" },
  { key: "acceptance_rejected", label: "验收被拒", hint: "子代理出了东西，但没过该角色的验收条件（多半是报告里没附上它跑过的命令与输出）。让它把证据写进报告，或放宽该角色的验收。" },
  { key: "provider_error", label: "上游拒绝", hint: "服务商把这个请求打回来了（鉴权、参数或内容审核）。先在 pi 里用同一个模型手动跑一次：pi 能跑就是我们的配置问题，别记成模型不行。" },
];

const FAILURE_BY_KEY = new Map(FAILURE_CLASSES.map((item) => [item.key, item]));

function classifyFailure(error) {
  const text = String(error || "");
  if (!text) return null;
  if (/produced no output|no output \(possible model cold-start/i.test(text)) return FAILURE_BY_KEY.get("empty_output");
  if (/(?:^|\n)\s*Unknown agent:/i.test(text)) return FAILURE_BY_KEY.get("unknown_agent");
  if (/timed out after \d+ms/i.test(text)) return FAILURE_BY_KEY.get("timeout");
  if (/Orphaned run|Async runner process \d+ (?:exited|has a live PID)/i.test(text)) return FAILURE_BY_KEY.get("runner_gone");
  if (/requested unavailable child tools/i.test(text)) return FAILURE_BY_KEY.get("missing_tools");
  if (/Acceptance rejected:/i.test(text)) return FAILURE_BY_KEY.get("acceptance_rejected");
  // 状态码要带上下文才认：光一个 401 会撞上产物路径和调用 id 里的十六进制串。
  if (/invalid_request_error|Upstream request failed|Error from provider|api key|token expired|invalid key|(?:\b(?:http|status|code)[^0-9]{0,4}40[13]\b|\b40[13]\s*[:])/i.test(text)) return FAILURE_BY_KEY.get("provider_error");
  return null;
}

// 落盘的旧快照里存的是改动前写的 run，没有 failClass：分类只依赖 error 文本，
// restore 时重算一次，老数据也一样能标出「空返回」而不是干巴巴的「失败」。
function applyFailureClass(run) {
  if (run.status === "failed") {
    const failure = classifyFailure(run.error);
    run.failClass = failure ? failure.key : "";
  } else if (run.failClass) {
    delete run.failClass;
  }
  return run;
}

function pidLiveness(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error && error.code === "ESRCH" ? "dead" : "unknown";
  }
}

/**
 * 落盘的 status.json 说这个 run 其实已经不会再动了：runner 进程已经退出，或者
 * 归属无法验证的僵死。返回判死原因，返回 null 表示还在活着。
 * 上游的 stale-run-reconciler 会把这些写回 status.json，但它只在父会话活着、
 * 且走 RPC/tracker 时才跑；pi-web 直接读文件，永远等不到那次修复。
 */
function runnerVerdict(status, now = Date.now(), liveness = pidLiveness) {
  if (!status || typeof status !== "object") return null;
  if (statusOf(status.state) !== "working") return null;
  const pid = status.pid;
  // 上游没有 pid 就不判（reconcileAsyncRun 同样要求 typeof pid === "number"）：
  // 没有进程可查，任何「死」的结论都只是猜。
  if (typeof pid !== "number") return null;
  const alive = liveness(pid);
  if (alive === "dead") {
    return `Async runner process ${pid} exited or disappeared before writing a result.`;
  }
  const last = Number(status.lastUpdate) || Number(status.startedAt) || 0;
  if (last && now - last > STALE_ALIVE_PID_MS) {
    return `Async runner process ${pid} has a live PID, but its status has not updated for ${now - last}ms; ownership cannot be verified.`;
  }
  return null;
}

function clip(value, limit = 16000) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function statusOf(value, fallback = "unknown") {
  if (["running", "working", "detached"].includes(value)) return "working";
  if (["complete", "completed", "done", "succeeded", "success"].includes(value)) return "completed";
  if (["stopped", "interrupted", "cancelled", "canceled"].includes(value)) return "stopped";
  if (["failed", "rejected", "error"].includes(value)) return "failed";
  if (["pending", "queued"].includes(value)) return "queued";
  return fallback;
}

function childId(runId, index) {
  return String(runId) + ":" + (Number.isInteger(index) ? index : 0);
}

function assistantText(item) {
  if (!item) return "";
  if (typeof item.finalOutput === "string") return item.finalOutput;
  if (Array.isArray(item.recentOutput)) return item.recentOutput.join("\n");
  const messages = Array.isArray(item.messages) ? item.messages : [];
  return messages.filter((message) => message && message.role === "assistant").flatMap((message) => {
    if (typeof message.content === "string") return [message.content];
    if (!Array.isArray(message.content)) return [];
    return message.content.filter((part) => part && part.type === "text").map((part) => part.text);
  }).join("\n");
}

function asArgs(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content.map((part) => typeof part === "string" ? part : (part && part.text) || "").join("\n");
  }
  return typeof result.text === "string" ? result.text : "";
}

function asyncIdFrom(result, details, text) {
  return details.asyncId || details.runId || details.id
    || (String(text).match(/Async workflow \[([a-zA-Z0-9._-]+)\]/) || [])[1]
    || (String(text).match(/async run[^\[]*\[([a-zA-Z0-9._-]+)\]/i) || [])[1]
    || null;
}

function sameSession(left, right) {
  if (left == null || right == null) return false;
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  if (a === b) return true;
  if (a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a))) return true;
  // pi-subagents 往 async status.json 里写的 sessionId 是「父会话文件路径」，而且
  // 长路径会按字符截断（只留前 96 字符，连 .jsonl 和 uuid 尾巴都没了）。和 uuid
  // 直接比永远不等，整条 run 的完成状态就被当成"别的会话"丢掉——这里按 uuid 前缀
  // 宽松对齐（截断只会少尾巴，不会少开头）。
  const uuidOf = (s) => {
    const m = s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12})/);
    return m ? m[1] : "";
  };
  const ua = uuidOf(a);
  const ub = uuidOf(b);
  if (!ua || !ub) return false;
  const n = Math.min(ua.length, ub.length);
  return n >= 8 && ua.slice(0, n) === ub.slice(0, n);
}

function idFromSessionFile(file) {
  const base = path.basename(String(file || ""), ".jsonl");
  const match = base.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
    || base.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : "";
}

function extractDelegatedTask(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (/^\s*\[prompt redacted\]/i.test(raw) && raw.length < 120) return "";
  const blocks = [...raw.matchAll(/(?:^|\n)Task:\s*\n([\s\S]*?)(?=\n\s*##\s+|\n\s*Acceptance level:|$)/gi)];
  const task = blocks.length ? blocks[blocks.length - 1][1].trim() : "";
  if (task) return task;
  if (/delegated subagent|sole job is to execute the task/i.test(raw)) {
    return raw.replace(/##\s+Acceptance Contract[\s\S]*$/i, "").trim();
  }
  return raw;
}

function conversationEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const start = list.findIndex((event) => event.type === "user" && /delegated subagent|sole job is to execute the task|(?:^|\n)Task:\s*\n/i.test(event.text || ""));
  const slice = start >= 0 ? list.slice(start) : list;
  const out = [];
  for (const event of slice) {
    if (event.type === "user") {
      const text = extractDelegatedTask(event.text);
      if (text) out.push({ ...event, text });
    } else if (event.type === "assistant-end") {
      // 思考块单独成条：子代理对话要跟主对话一样能看到「在想什么」
      if (event.thinking) out.push({ type: "thinking", text: event.thinking, ...(event.at ? { at: event.at } : {}) });
      if (event.text || event.error) out.push(event);
    } else if (event.type === "tool") {
      // 工具调用原样保留（含 start/end、参数、输出、失败标记）：不然子代理卡在
      // 某个命令上时，界面只有一片空白，用户根本分不清是在跑还是死了
      out.push(event);
    }
  }
  return out;
}

function isChildSessionInfo(info = {}, extraName = "", header = null) {
  if (info.parentSessionPath || info.parentSession) return true;
  if (header && (header.parentSession || header.parentSessionPath || header.origin === "subagent")) return true;
  const name = info.name || extraName || "";
  return /^subagent[-_]/i.test(String(name));
}

class SubagentRuns {
  constructor({ dir, sessionId, onChange = null } = {}) {
    if (!sessionId || !/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error("Invalid session id");
    this.sessionId = sessionId;
    this.dir = dir;
    this.file = path.join(dir, sessionId + ".json");
    this.onChange = typeof onChange === "function" ? onChange : null;
    this.runs = new Map();
    this.calls = new Map();
    this.sources = new Map();
    // runId -> 派它出来的那次 subagent 工具调用 id。
    // 一次 workflow 扇出只有一个工具调用、却有 N 个子代理，而这些子代理大多是
    // refreshFiles() 从 async status.json 里发现的——那条路径拿不到 callId。
    // 没有它，前端就没法把子对话挂回主对话里它被派出来的那一行下面。
    this.runCalls = new Map();
    this.lastError = null;
    this.restore();
    if (this.refreshFiles(false)) this.save();
  }

  restore() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.sessionId !== this.sessionId || !Array.isArray(saved.runs)) throw new Error("Invalid run snapshot");
      for (const run of saved.runs) {
        if (run.status === "working" && !run.background) run.status = "unknown";
        this.runs.set(run.id, applyFailureClass(run));
        if (run.asyncDir) this.sources.set(run.runId, run.asyncDir);
        // 重启后 this.calls 是空的，锚点只能从落盘的 run 上把 runId->callId 找回来。
        // run 不会被淘汰，所以每个 runId 至少有一条带 callId 的落盘记录可复原。
        if (run.callId && run.runId && !this.runCalls.has(run.runId)) this.runCalls.set(run.runId, run.callId);
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.lastError = error.message;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessionId: this.sessionId, runs: [...this.runs.values()] }), "utf8");
      fs.renameSync(tmp, this.file);
      this.lastError = null;
    } finally {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    if (this.onChange) this.onChange(this.snapshot());
  }

  put(input) {
    if (!input || !input.runId || !input.agent || input.status === "queued") return null;
    const index = Number.isInteger(input.index) ? input.index : 0;
    const id = childId(input.runId, index);
    const old = this.runs.get(id) || { id, sessionId: this.sessionId, startedAt: Date.now(), status: "unknown", stopRequested: false };
    const run = { ...old };
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) run[key] = value;
    }
    run.id = id;
    run.runId = String(input.runId);
    run.index = index;
    // 同一次扇出的兄弟 run 已经带锚点就补上：refreshFiles 从 status.json 建 run
    // 的那条路径自己拿不到 callId，不补就永远挂不回主对话。
    if (!run.callId) {
      const anchor = this.runCalls.get(run.runId);
      if (anchor) run.callId = anchor;
    }
    run.agent = clip(run.agent, 128);
    run.task = clip(run.task);
    run.result = clip(run.result);
    run.error = clip(run.error, 4000);
    run.background = Boolean(run.background);
    if (TERMINAL.has(run.status)) {
      run.endedAt = run.endedAt || Date.now();
      run.stopRequested = false;
    }
    applyFailureClass(run);
    this.runs.set(id, run);
    if (run.asyncDir) this.sources.set(run.runId, run.asyncDir);
    return run;
  }

  begin(callId, args) {
    this.calls.set(callId, asArgs(args));
  }

  isManagement(args, details) {
    if (details && details.mode === "management") return true;
    const action = args && args.action;
    return typeof action === "string" && MANAGEMENT_ACTIONS.has(action);
  }

  tool(callId, result, final = false, isError = false) {
    const args = asArgs(this.calls.get(callId) || result && result.args);
    const details = (result && result.details) || {};
    if (this.isManagement(args, details)) {
      if (final) this.calls.delete(callId);
      return false;
    }
    const text = resultText(result);
    const runId = asyncIdFrom(result, details, text);
    if (!runId) {
      if (final) this.calls.delete(callId);
      return false;
    }
    if (!this.runCalls.has(String(runId))) this.runCalls.set(String(runId), callId);
    // A workflow can be rejected by its acceptance gate after the child has
    // already been recorded as working.  The gate does not always emit the
    // normal async-complete event, so close the child here from the tool's
    // terminal error response instead of leaving it stuck forever.
    if (final && isError && /acceptance\s+rejected|acceptance\s+failed/i.test(text)) {
      let changed = false;
      for (const run of this.runs.values()) {
        if (run.runId !== runId || TERMINAL.has(run.status)) continue;
        this.put({ ...run, status: "failed", error: clip(text, 4000), endedAt: Date.now() });
        changed = true;
      }
      if (!changed) {
        const agent = args.agent || (Array.isArray(args.agents) ? args.agents[0] : null) || details.agent;
        if (agent) {
          this.put({ runId, index: 0, agent, task: args.task, model: args.model || details.model,
            background: true, asyncDir: details.asyncDir, callId, status: "failed", error: clip(text, 4000), endedAt: Date.now() });
          changed = true;
        }
      }
      if (changed) this.save();
      this.calls.delete(callId);
      return changed;
    }
    // An explicit async:false launch is foreground even when details report
    // mode "workflow": the workflow settles inside this tool call, so it must be
    // finalized from the results below rather than left waiting for an
    // async-complete event that a foreground workflow never emits.
    const background = args.async === false
      ? false
      : Boolean(details.background || details.asyncId || details.mode === "workflow" || args.async === true);
    let changed = false;
    for (const progress of details.progress || []) {
      if (!progress.agent || progress.status === "pending" || progress.status === "queued") continue;
      this.put({
        runId, index: progress.index, agent: progress.agent, task: progress.task, model: progress.model,
        thinking: progress.thinking, background, asyncDir: details.asyncDir, callId,
        status: statusOf(progress.status, "working"),
        result: Array.isArray(progress.recentOutput) ? progress.recentOutput.join("\n") : progress.finalOutput,
        error: progress.error,
      });
      changed = true;
    }
    for (const item of details.results || []) {
      if (!item.agent) continue;
      const id = childId(runId, item.index ?? 0);
      const known = this.runs.get(id);
      let status = known && known.status ? known.status : "working";
      if (item.stopped || item.interrupted || details.stopped) status = "stopped";
      else if (item.detached || background) status = known && TERMINAL.has(known.status) ? known.status : "working";
      else if (final) status = isError || item.error || (item.exitCode !== undefined && item.exitCode !== 0) ? "failed" : "completed";
      this.put({
        runId, index: item.index, agent: item.agent, task: item.task, model: item.model, thinking: item.thinking,
        background: background || Boolean(item.detached), asyncDir: details.asyncDir, callId, status,
        result: assistantText(item), error: item.error,
      });
      changed = true;
    }
    // Foreground launches settle inside this tool call. Whatever the progress
    // and results loops left open must be closed here, or a failed child (for
    // example a provider 400) stays "working" forever with no terminal event.
    if (final && !background) {
      for (const run of this.runs.values()) {
        if (run.runId !== runId || TERMINAL.has(run.status)) continue;
        this.put({
          ...run,
          status: isError ? "failed" : "completed",
          error: run.error || (isError ? clip(text, 4000) : undefined),
          endedAt: run.endedAt || Date.now(),
        });
        changed = true;
      }
    }
    if (background && details.asyncDir) {
      this.sources.set(runId, details.asyncDir);
      changed = this.refreshFiles(false) || changed;
    }
    const agent = args.agent || (Array.isArray(args.agents) ? args.agents[0] : null) || details.agent;
    if (agent && ![...this.runs.values()].some((run) => run.runId === runId)) {
      this.put({
        runId,
        index: 0,
        agent,
        task: args.task,
        model: args.model || details.model,
        thinking: args.thinking || details.thinking,
        background,
        asyncDir: details.asyncDir,
        callId,
        status: background ? "working" : (final ? (isError ? "failed" : "completed") : "working"),
        result: background ? undefined : text,
      });
      changed = true;
    }
    if (final) this.calls.delete(callId);
    if (changed) this.save();
    return changed;
  }

  event(name, event = {}) {
    if (event.sessionId && !sameSession(event.sessionId, this.sessionId)) return false;
    if (name === "subagent:async-started") {
      const runId = event.id || event.runId;
      if (!runId || !event.asyncDir) return false;
      if (!this.allowedDir(event.asyncDir)) this.sources.set(String(runId), event.asyncDir);
      else this.sources.set(String(runId), event.asyncDir);
      const agents = event.agents || (event.agent ? [event.agent] : []);
      if (agents.length === 1) {
        this.put({ runId, index: 0, agent: agents[0], task: event.task || event.goal, background: true, asyncDir: event.asyncDir, status: "working" });
      }
      this.refreshFiles(false);
      this.save();
      return true;
    }
    const runId = event.runId || event.id;
    if (!runId) return false;
    if (name === "subagent:foreground-complete" && event.agent) {
      this.put({
        runId, index: event.taskIndex ?? event.index ?? 0, agent: event.agent, background: false,
        status: event.stopped || event.interrupted ? "stopped" : statusOf(event.state, event.success === false ? "failed" : "completed"),
        result: event.summary, error: event.error, endedAt: event.timestamp || Date.now(),
      });
    } else if (name === "subagent:async-complete") {
      for (const run of this.runs.values()) {
        if (run.runId !== runId) continue;
        this.put({
          ...run,
          status: event.stopped ? "stopped" : statusOf(event.state, event.success === false ? "failed" : "completed"),
          result: event.summary ?? run.result, error: event.error ?? run.error, endedAt: event.timestamp || Date.now(),
        });
      }
    } else if (name === "subagent:process-terminal") {
      const asyncDir = this.sources.get(runId) || event.asyncDir;
      if (asyncDir) this.sources.set(runId, asyncDir);
    }
    this.refreshFiles(false);
    this.save();
    return true;
  }

  allowedDir(dir) {
    if (!dir) return false;
    const resolved = path.resolve(dir);
    for (const registered of this.sources.values()) {
      if (path.resolve(registered) === resolved) return true;
    }
    return false;
  }

  refreshFiles(persist = true) {
    const before = JSON.stringify([...this.runs.values()]);
    let changed = false;
    for (const [runId, dir] of this.sources) {
      if (!dir) continue;
      let dirGone = false;
      try {
        const statusFile = path.join(dir, "status.json");
        const data = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (data.sessionId && !sameSession(data.sessionId, this.sessionId)) continue;
        if (data.runId && data.runId !== runId) continue;
        // pi-subagents 把派生它的那次工具调用 id 写进了 status.json。
        // 进程重启后、以及改动之前落盘的老快照里，扇出的子代理只有这一处锚点可寻；
        // put() 会拿它补上 run.callId，主对话才挂得回去。
        // 直接写 runCalls 而不是走 put()：状态没变的 run 不会被 put() 重写，
        // 老快照里的无锚点 run 就永远修不好。
        if (data.toolCallId) {
          const anchor = String(data.toolCallId);
          if (!this.runCalls.has(String(runId))) this.runCalls.set(String(runId), anchor);
          for (const run of this.runs.values()) {
            if (run.runId === String(runId) && !run.callId) { run.callId = anchor; changed = true; }
          }
        }
        for (const [offset, item] of (data.steps || []).entries()) {
          if (!item.agent || ["pending", "queued"].includes(item.status)) continue;
          const index = Number.isInteger(item.index) ? item.index : offset;
          const old = this.runs.get(childId(runId, index));
          const sessionFile = item.sessionFile || (old && old.sessionFile);
          const transcriptPath = item.transcriptPath || (item.artifactPaths && item.artifactPaths.transcriptPath) || (old && old.transcriptPath);
          this.put({
            runId, index, agent: item.agent, task: (old && old.task) || item.description || item.task,
            model: item.model, thinking: item.thinking, background: true, asyncDir: dir,
            status: statusOf(item.status, statusOf(data.state, "working")),
            startedAt: item.startedAt ?? data.startedAt, endedAt: item.endedAt ?? data.endedAt,
            error: item.error ?? data.error,
            result: item.finalOutput || assistantText(item) || (old && old.result),
            childSessionId: idFromSessionFile(sessionFile) || (old && old.childSessionId),
            sessionFile,
            transcriptPath,
          });
          changed = true;
        }
        if (TERMINAL.has(statusOf(data.state))) {
          for (const run of this.runs.values()) {
            if (run.runId === runId && (run.status === "working" || run.status === "unknown")) {
              this.put({ ...run, status: statusOf(data.state), error: data.error || run.error, endedAt: data.endedAt || Date.now() });
              changed = true;
            }
          }
        } else {
          // 状态文件还写着 running，但派它的进程已经死了：这一批 fan-out 子代理
          // 谁也不会再来更新它们。不判死就永远挂在「工作中」，父对话也等不到回执。
          const dead = runnerVerdict(data);
          if (dead) {
            const now = Date.now();
            for (const run of this.runs.values()) {
              if (run.runId !== runId || TERMINAL.has(run.status)) continue;
              this.put({ ...run, status: "failed", error: run.error || dead, endedAt: run.endedAt || now });
              changed = true;
            }
          }
        }
      } catch (error) {
        if (error.code === "ENOENT") dirGone = true;
        else if (!(error instanceof SyntaxError)) this.lastError = error.message;
      }
      // 上游会回收已结束 run 的临时目录。目录没了还写着 working，就是这条 run
      // 再没有可信的数据源——按孤儿处理，不然快照里的老 run 永远收不了口。
      if (dirGone) changed = this.reconcileOrphans(ORPHAN_MAX_AGE_MS, runId, true) || changed;
    }
    changed = this.reconcileOrphans() || changed;
    changed = changed && before !== JSON.stringify([...this.runs.values()]);
    if (changed && persist) this.save();
    return changed;
  }

  /**
   * Fail runs that can never be reconciled from disk: still "working" and old
   * enough that a live run is implausible. Two shapes:
   * - nothing to reconcile from at all (no async dir, no child session);
   * - sourceGone: the run's async directory was pruned, so even a run that
   *   still has a child session can never report a terminal state again.
   * Prevents a phantom "工作中" row after a child dies without a terminal event.
   */
  reconcileOrphans(maxAgeMs = ORPHAN_MAX_AGE_MS, onlyRunId = null, sourceGone = false) {
    const now = Date.now();
    let changed = false;
    for (const run of this.runs.values()) {
      if (run.status !== "working") continue;
      if (onlyRunId && run.runId !== String(onlyRunId)) continue;
      if (!sourceGone) {
        if (run.asyncDir || run.sessionFile || run.transcriptPath || run.childSessionId) continue;
        if (this.sources.get(run.runId)) continue;
      }
      const startedAt = run.startedAt || 0;
      if (!startedAt || now - startedAt < maxAgeMs) continue;
      this.put({
        ...run,
        status: "failed",
        error: run.error || "Orphaned run: no async directory or child session to reconcile.",
        endedAt: run.endedAt || now,
      });
      changed = true;
    }
    return changed;
  }

  applyRpcStatus(payload) {
    if (!payload || typeof payload !== "object") return false;
    const runs = [];
    if (Array.isArray(payload.asyncSnapshot && payload.asyncSnapshot.runs)) runs.push(...payload.asyncSnapshot.runs);
    if (Array.isArray(payload.runs)) runs.push(...payload.runs);
    let changed = false;
    for (const item of runs) {
      const runId = item.asyncId || item.runId || item.id;
      if (!runId || item.fleetKey) continue;
      const agents = item.agents || (item.agent ? [item.agent] : (item.label ? [item.label] : []));
      if (!agents.length) continue;
      this.put({
        runId, index: item.index ?? 0, agent: agents[0], task: item.goal || item.task, model: item.model,
        thinking: item.effort || item.thinking, background: true, asyncDir: item.asyncDir,
        status: statusOf(item.state, "working"), startedAt: item.startedAt, endedAt: item.endedAt,
      });
      if (item.asyncDir) this.sources.set(runId, item.asyncDir);
      changed = true;
    }
    if (changed) {
      this.refreshFiles(false);
      this.save();
    }
    return changed;
  }

  snapshot(configured = []) {
    this.reconcileOrphans();
    const runs = [...this.runs.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const names = [...new Set(runs.map((run) => run.agent))];
    const agents = names.map((agent) => {
      const items = runs.filter((run) => run.agent === agent);
      const working = items.filter((run) => run.status === "working");
      const latest = working[0] || items[0];
      const disabled = configured.some((entry) => entry.name === agent && entry.disabled);
      return {
        agent,
        name: agent,
        status: working.length ? "working" : (disabled ? "stopped" : latest.status),
        activeCount: working.length,
        runId: latest.id,
        sessionId: latest.childSessionId || "",
        model: latest.model || "",
        thinking: latest.thinking || "",
        disabled,
        conversations: items.map((run) => run.childSessionId && {
          sessionId: run.childSessionId,
          name: run.agent,
          updatedAt: run.endedAt || run.startedAt || 0,
        }).filter(Boolean),
      };
    });
    return {
      sessionId: this.sessionId,
      agents,
      // callId 是子对话挂进父对话的锚点：父转录里那次 subagent 工具调用的
      // data-call 就是它。剥掉它就只剩按 agent 名字开坞弹模态一条路。
      // 三个路径字段仍然不发，本地绝对路径不该进浏览器。
      runs: runs.map(({ asyncDir, sessionFile, transcriptPath, ...run }) => {
        // 文案在这里出，前端只管渲染：分类规则只有一处，改判定不用两头同步
        const failure = run.failClass ? classifyFailure(run.error) : null;
        return failure ? { ...run, failLabel: failure.label, failHint: failure.hint } : run;
      }),
      error: this.lastError,
    };
  }

  writeStopRequest(asyncDir) {
    const control = path.join(asyncDir, "control");
    fs.mkdirSync(control, { recursive: true });
    const file = path.join(control, "stop.json");
    const tmp = file + "." + crypto.randomUUID() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ type: "stop", ts: Date.now(), source: "pi-web" }));
    fs.renameSync(tmp, file);
    return file;
  }

  async stop(id, rpc) {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found in this session");
    if (run.status !== "working") throw new Error("Run is not working");
    const asyncDir = run.asyncDir || this.sources.get(run.runId);
    if (run.background && asyncDir) {
      this.writeStopRequest(asyncDir);
      run.stopRequested = true;
      this.save();
      return { state: "stopping", message: "Stop requested" };
    }
    const result = await rpc(
      "interrupt",
      { runId: run.runId, index: run.index },
    );
    run.stopRequested = true;
    this.save();
    return result;
  }
}

module.exports = {
  SubagentRuns,
  statusOf,
  pidLiveness,
  runnerVerdict,
  classifyFailure,
  FAILURE_CLASSES,
  MANAGEMENT_ACTIONS,
  sameSession,
  idFromSessionFile,
  extractDelegatedTask,
  conversationEvents,
  isChildSessionInfo,
};
