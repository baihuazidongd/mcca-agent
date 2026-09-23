/**
 * @mcca/hot-mount — 宿主插件的热挂载监管器（根治“改插件必须重启”）。
 *
 * 问题：mcca 的宿主插件（dsh-adapter / session-delete / task-notify …）原先各占
 * 一条 `--patch config/dsh.patch.yml` 行。patch 覆盖层只在启动时读一次，行里的
 * file:// 说明符又被 Node 的 ESM 缓存钉死——于是新增插件要重启、删插件要重启、
 * 连改一行源码都要重启。
 *
 * 本插件把“插件集”从启动期配置变成运行期清单：
 *   1. 读 `config/hot-plugins.json`：`[{ id, file, config? }]`；
 *   2. 轮询清单与每个插件文件的 mtime（Windows 上比 fs.watch 稳，成本几次 stat）；
 *   3. 新增 → 以 `?t=<mtime>` 破缓存动态 import，经 `ctx.plugin()` 挂上；
 *   4. 改动 → 先 `fiber.dispose()` 再重导重挂（同名重复注册会抛，故必须先卸）；
 *   5. 删除（从清单或磁盘消失）→ dispose 并移除；
 *   6. 挂载失败只记录该条目的错误并继续，绝不打死宿主（与 portal 的隔离姿态一致）。
 *
 * 监管器自身仍是启动期一行，且放在 profile 的 `cordis.patch.yml`（被
 * watchUserPatches 实时监听），所以连这一行以后也能热改。
 *
 * 观测面：`GET /mcca/hot-plugins` 返回每条的挂载状态/版本/错误，用于验证
 * “不重启就生效”。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Cordis function plugin name. */
export const name = "mcca-hot-mount";

/** Services required before the supervisor may mount children. */
export const inject = ["webServer"];

/** 轮询周期：改文件到生效的延迟上限。 */
const POLL_MS = 700;

/**
 * 子 fiber 激活/卸载的等待上限。
 *
 * 关键：cordis 里“inject 的服务还没出现”是**合法挂起**（fiber settled-but-
 * pending，等服务出现才激活）。直接 `await fiber.await()` 会永远不返回，把
 * 对账循环钉死——于是“改插件/删插件不生效”。这里一律有界等待：超时只记状态，
 * 绝不阻塞后续对账，也绝不因为慢就杀掉一个合法挂起的插件。
 */
const SETTLE_MS = 5000;

/** 给一个 promise 加超时；超时返回 sentinel，不抛错、不取消底层。 */
async function withTimeout(promise, ms, sentinel) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(sentinel), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 仓库根（本文件在 packages/hot-mount/src/index.js）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * 读取插件清单。缺失/坏 JSON 一律按空集处理并记录原因——监管器不能因清单
 * 写坏而拖垮宿主，但也不能静默吞掉：错误经状态路由可见。
 * @param {string} manifestPath - 清单绝对路径。
 * @returns {{ entries: Array<{id: string, file: string, config?: object}>, error: string | null }}
 */
function readManifest(manifestPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^﻿/, ""));
    if (!Array.isArray(raw)) return { entries: [], error: "manifest is not an array" };
    const entries = [];
    for (const row of raw) {
      if (!row || typeof row.id !== "string" || typeof row.file !== "string") continue;
      entries.push({ id: row.id, file: path.resolve(row.file), ...(row.config ? { config: row.config } : {}) });
    }
    return { entries, error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { entries: [], error: null };
    return { entries: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** 文件版本（mtime + size）；不存在返回 null。 */
function fileRev(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? `${Math.round(st.mtimeMs)}-${st.size}` : null;
  } catch {
    return null;
  }
}

/**
 * 从模块命名空间取出函数插件面 `{ name, inject, apply }`。
 * 兼容 default 导出与具名导出两种写法。
 * @param {object} mod - 动态 import 得到的命名空间。
 * @param {string} id - 清单里的插件 id（缺 name 时兜底）。
 * @returns {{ name: string, inject: string[], apply: Function } | null}
 */
function pluginFaceOf(mod, id) {
  const source = typeof mod?.apply === "function" ? mod : mod?.default;
  if (!source || typeof source.apply !== "function") return null;
  return {
    name: typeof source.name === "string" && source.name ? source.name : id,
    inject: Array.isArray(source.inject) ? source.inject : [],
    apply: source.apply,
  };
}

/**
 * 挂载监管器。
 * @param {object} ctx - dsh Context（duck-typed：ctx.plugin / ctx.effect / webServer）。
 * @param {{ manifest?: string }} [config] - 行配置；`manifest` 覆盖清单路径。
 */
export function apply(ctx, config) {
  const manifestPath = path.resolve(config?.manifest ?? path.join(ROOT, "config", "hot-plugins.json"));
  /** @type {Map<string, { file: string, rev: string, fiber: object, mountedAt: number, error: string | null }>} */
  const mounted = new Map();
  let manifestError = null;
  let ticking = false;

  /** @type {string[]} 当前一轮对账里正在等待的步骤（诊断卡点用）。 */
  const inFlight = [];
  let ticks = 0;
  let lastTickAt = 0;

  /** 卸载一条子插件（dispose 其 fiber 树；插件注册的一切都是 fiber 上的 effect）。 */
  async function unmount(id) {
    const record = mounted.get(id);
    if (!record) return;
    mounted.delete(id);
    if (!record.fiber) return;
    inFlight.push(`dispose:${id}`);
    try {
      const outcome = await withTimeout(record.fiber.dispose(), SETTLE_MS, "timeout");
      if (outcome === "timeout") console.warn(`[mcca-hot] dispose ${id} still running after ${SETTLE_MS}ms; moving on`);
    } catch (error) {
      console.error(`[mcca-hot] dispose ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      const at = inFlight.lastIndexOf(`dispose:${id}`);
      if (at >= 0) inFlight.splice(at, 1);
    }
  }

  /**
   * 挂载（或重挂）一条子插件。
   *
   * 三条铁律，都是踩出来的：
   *   1. `ctx.plugin()` 一拿到 fiber **立刻记账**——之后任何一步失败都得能把
   *      它 dispose 掉，否则留下一个“注册还在、监管器不认识”的孤儿 fiber：
   *      它会占住路由/服务名，让重挂必然失败、让删除无从下手（表现就是
   *      “改了删了都不生效”）。
   *   2. 激活等待必须有界（见 SETTLE_MS 注释）。
   *   3. 失败不每轮自旋重试：同 rev 直接跳过，错误经状态路由暴露；改文件
   *      （rev 变）或重新入清单才再试。
   */
  async function mount(entry) {
    const rev = fileRev(entry.file);
    const current = mounted.get(entry.id);
    if (rev === null) {
      if (current) await unmount(entry.id);
      return;
    }
    if (current && current.rev === rev) return;
    if (current) await unmount(entry.id);
    let fiber = null;
    try {
      // ?t=<rev> 破 ESM 缓存：改过的文件必然换一个新说明符，拿到新模块。
      const mod = await import(`${pathToFileURL(entry.file).href}?t=${rev}`);
      const face = pluginFaceOf(mod, entry.id);
      if (!face) throw new Error("plugin module must export apply (named or default)");
      fiber = ctx.plugin(face, entry.config ?? {});
      mounted.set(entry.id, {
        file: entry.file, rev, fiber, mountedAt: Date.now(), error: null, pending: false, waitingFor: [],
      });
      inFlight.push(`await:${entry.id}`);
      let outcome;
      try {
        outcome = await withTimeout(fiber.await(), SETTLE_MS, "pending");
      } finally {
        const at = inFlight.lastIndexOf(`await:${entry.id}`);
        if (at >= 0) inFlight.splice(at, 1);
      }
      // 合法挂起（inject 的服务还没出现）：算挂载成功，稍后自行激活。
      const waitingFor = outcome === "pending"
        ? Object.keys(fiber.inject ?? {}).filter((service) => ctx.get(service) === undefined)
        : [];
      mounted.set(entry.id, {
        file: entry.file, rev, fiber, mountedAt: Date.now(), error: null,
        pending: outcome === "pending", waitingFor,
      });
      console.log(
        `[mcca-hot] mounted ${entry.id} (${face.name}) rev=${rev}`
        + (outcome === "pending" ? ` — pending on [${waitingFor.join(", ")}]` : ""),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 失败必须把半挂载的 fiber 收干净，绝不把注册留在场上。
      if (fiber) {
        await withTimeout(fiber.dispose(), SETTLE_MS, "timeout").catch(() => {});
      }
      mounted.set(entry.id, {
        file: entry.file, rev, fiber: null, mountedAt: Date.now(), error: message, pending: false, waitingFor: [],
      });
      console.error(`[mcca-hot] mount ${entry.id} failed: ${message}`);
    }
  }

  /** 一轮对账：清单增删 + 文件版本变化。 */
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const { entries, error } = readManifest(manifestPath);
      manifestError = error;
      const wanted = new Map(entries.map((entry) => [entry.id, entry]));
      for (const id of [...mounted.keys()]) {
        if (!wanted.has(id)) await unmount(id);
      }
      for (const entry of wanted.values()) await mount(entry);
      ticks += 1;
      lastTickAt = Date.now();
    } finally {
      ticking = false;
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/mcca/hot-plugins",
    handler: async (_req, res) => {
      const { entries } = readManifest(manifestPath);
      const plugins = entries.map((entry) => {
        const record = mounted.get(entry.id);
        return {
          id: entry.id,
          file: entry.file,
          onDisk: fileRev(entry.file) !== null,
          diskRev: fileRev(entry.file),
          mounted: Boolean(record?.fiber),
          rev: record?.rev ?? null,
          stale: record ? record.rev !== fileRev(entry.file) : null,
          pending: record?.pending ?? false,
          waitingFor: record?.waitingFor ?? [],
          mountedAt: record?.mountedAt ?? null,
          error: record?.error ?? null,
        };
      });
      // 自诊断：轮询是否还活着。ticking 长期为 true = 某一轮 await 卡住
      // （典型是 fiber.await() 永不 settle），那会让后续对账全部空转。
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        manifest: manifestPath,
        manifestError,
        pollMs: POLL_MS,
        ticks,
        ticking,
        lastTickAt,
        inFlight: inFlight.slice(0, 8),
        mountedIds: [...mounted.keys()],
        plugins,
      }));
    },
  }), "mcca-hot-mount: status route");

  ctx.effect(() => {
    void tick();
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      clearInterval(timer);
      return Promise.all([...mounted.keys()].map((id) => unmount(id)));
    };
  }, "mcca-hot-mount: manifest poll");
}
