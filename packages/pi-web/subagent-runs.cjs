"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TERMINAL = new Set(["completed", "stopped", "failed"]);
const MANAGEMENT_ACTIONS = new Set(["list", "get", "models", "create", "update", "delete", "eject", "disable", "enable", "reset"]);

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
  const a = String(left);
  const b = String(right);
  if (a === b) return true;
  return a.length >= 8 && b.length >= 8 && (a.includes(b) || b.includes(a));
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
    } else if (event.type === "assistant-end" && (event.text || event.error)) {
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
    this.lastError = null;
    this.restore();
    this.refreshFiles(false);
  }

  restore() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.sessionId !== this.sessionId || !Array.isArray(saved.runs)) throw new Error("Invalid run snapshot");
      for (const run of saved.runs) {
        if (run.status === "working" && !run.background) run.status = "unknown";
        this.runs.set(run.id, run);
        if (run.asyncDir) this.sources.set(run.runId, run.asyncDir);
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
    run.agent = clip(run.agent, 128);
    run.task = clip(run.task);
    run.result = clip(run.result);
    run.error = clip(run.error, 4000);
    run.background = Boolean(run.background);
    if (TERMINAL.has(run.status)) {
      run.endedAt = run.endedAt || Date.now();
      run.stopRequested = false;
    }
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
    const background = Boolean(details.background || details.asyncId || details.mode === "workflow" || args.async === true);
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
      try {
        const statusFile = path.join(dir, "status.json");
        const data = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (data.sessionId && !sameSession(data.sessionId, this.sessionId)) continue;
        if (data.runId && data.runId !== runId) continue;
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
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) this.lastError = error.message;
      }
    }
    changed = changed && before !== JSON.stringify([...this.runs.values()]);
    if (changed && persist) this.save();
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
      runs: runs.map(({ asyncDir, callId, sessionFile, transcriptPath, ...run }) => run),
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
  MANAGEMENT_ACTIONS,
  sameSession,
  idFromSessionFile,
  extractDelegatedTask,
  conversationEvents,
  isChildSessionInfo,
};
