/**
 * @mcca/client-flags — 客户端插件开关的宿主侧读点。
 *
 * 为什么需要它：dsh 的 boot 图由 ClientModuleRegistry 从 loader 行增量推导，
 * 它只在“挂载”事件上处理，**不回收已删除的行**（其自身注释：plugin-set
 * changes take effect on restart）。所以被监听层删掉一个客户端行后，旧行仍会
 * 留在 boot 图里直到重启——“禁用”就没有即时效果。
 *
 * 绕开这个限制的办法是让 bundle 自己服从实时开关：bundle 在 apply 里取一次
 * `GET /mcca/client-flags`，被禁用就不产生任何效果；本路由每次请求都重读
 * `config/client-plugins.json`，因此改配置即刻生效，不需要重启任何进程。
 *
 * pi 侧不需要它：pi-dsh-web 的 boot 图每次响应现算，禁用即从图里消失。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis function plugin name. */
export const name = "mcca-client-flags";

/** Services required before the route may mount. */
export const inject = ["webServer"];

/** 共享开关表（与 portal 的客户端插件开关同一份文件）。 */
// 读点必须与 portal 的写点（server.cjs 的 paths.data）同一约定，否则便携分发下
// 数据目录一搬，这里就会静默读到不存在的路径并按 fail open 放行全部插件。
const APP = path.resolve(
  process.env.MCCA_HOME || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
);
const CONFIG = path.join(process.env.MCCA_DATA_DIR || path.join(APP, "config"), "client-plugins.json");

/** 读禁用集；文件缺失或坏 JSON 一律按“全启用”处理（fail open）。 */
function disabledIds() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/^﻿/, ""));
    const ds = raw && typeof raw.ds === "object" && raw.ds !== null ? raw.ds : {};
    return Object.keys(ds).filter((id) => ds[id] === false);
  } catch {
    return [];
  }
}

/**
 * Mount `GET /mcca/client-flags`.
 * @param {object} ctx - dsh Context (duck-typed).
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/mcca/client-flags",
    handler: async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, disabled: disabledIds() }));
    },
  }), "mcca-client-flags: route");
}
