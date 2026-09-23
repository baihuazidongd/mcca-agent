/**
 * @mcca/session-delete — deployment extension: deletes one archived (or any
 * cold) session durably, exposed as `POST /mcca/sessions/delete`.
 *
 * The dsh wire has archive/unarchive but no session deletion; the web client's
 * archive section (mcca-patched ui-session-archive) calls this same-origin
 * route on both backends. This module is the dsh half; pi-dsh-web's server.cjs
 * implements the identical route against pi session storage.
 *
 * Deletion sequence per request:
 *   1. Resolve the session header via `sessionPersistence.list()`.
 *   2. Refuse live agents (a running conversation is not deletable).
 *   3. Remove the durable artifact at `persistence.locate()`.
 *   4. Detach the id from its workspace record and unarchive it — the
 *      workspace domain writes make the apiproxy host stream fan out
 *      `host/workspace-changed` and `host/archived-sessions-changed` frames.
 *   5. Emit `mcca/session-deleted` — the vendored apiproxy host stream relays
 *      it as `host/session-removed`, so clients drop the row immediately.
 *
 * Duck-typed ctx like @mcca/dsh-adapter: services resolve through `ctx.get`,
 * so this module imports nothing from dsh and mounts through a `file://` row
 * in config/dsh.patch.yml. Log the vendored-listener pairing in vendor/README
 * local modifications when the vendor copy is re-synced.
 */

import fs from "node:fs";

/** Cordis function plugin name. */
export const name = "mcca-session-delete";

/** Services required before the delete route may mount. */
export const inject = ["webServer"];

/** JSON body limit for the delete route. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Mount `POST /mcca/sessions/delete` on the host webserver.
 * @param {object} ctx - host Context (webServer + registry/persistence services).
 */
export function apply(ctx) {
  // 注册即 effect：fiber 卸载时才会回收路由。apply 的返回值被 cordis 忽略
  // （`apply(ctx, config): any`），返回 disposer 是无效的——热卸载会留下
  // 占住路由的孤儿注册。
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/mcca/sessions/delete",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        json(res, 400, { ok: false, error: { code: "session-id-required", message: "sessionId is required" } });
        return;
      }
      const persistence = ctx.get("sessionPersistence");
      const registry = ctx.get("workspaceRegistry");
      if (!persistence || !registry) {
        json(res, 500, { ok: false, error: { code: "services-missing", message: "session persistence or workspace registry is not mounted" } });
        return;
      }
      try {
        await deleteSession(ctx, persistence, registry, sessionId, res);
      } catch (error) {
        json(res, 500, {
          ok: false,
          error: { code: "delete-failed", message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  }), "mcca-session-delete: route");
}

/**
 * Delete one cold session end to end; writes the HTTP response.
 * @param {object} ctx - host Context.
 * @param {object} persistence - SessionPersistence service.
 * @param {object} registry - WorkspaceRegistry service.
 * @param {string} sessionId - raw session id (unbranded wire form).
 * @param {object} res - node http.ServerResponse.
 */
async function deleteSession(ctx, persistence, registry, sessionId, res) {
  const headers = await persistence.list();
  const meta = headers.find((header) => String(header.id) === sessionId);
  if (!meta) {
    json(res, 404, { ok: false, error: { code: "session-not-found", message: `no persisted session ${sessionId}` } });
    return;
  }
  // A live agent means a possibly-running conversation: refuse rather than
  // pull the log out from under it.
  const agent = ctx.get("agents")?.get?.(meta.id);
  if (agent) {
    json(res, 409, { ok: false, error: { code: "session-running", message: "会话正在运行，先停止再删除" } });
    return;
  }
  const location = persistence.locate(meta);
  // Detach from its workspace record (archived sessions keep their membership)
  // and drop the archive-set entry first — both domain writes fan out host
  // frames, and the durable filtered-candidate prune runs while the header is
  // still readable. The artifact goes away last.
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.some((id) => String(id) === sessionId)) {
      await workspace.detachSession(meta.id);
    }
  }
  await registry.unarchiveSession(meta.id).catch(() => {});
  if (location?.path && fs.existsSync(location.path)) {
    await fs.promises.rm(location.path, { recursive: true, force: true });
  }
  ctx.emit?.("mcca/session-deleted", { sessionId: meta.id });
  json(res, 200, { ok: true, deleted: true });
}

/** Read one bounded JSON request body; rejects oversized or malformed bodies. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Write one JSON response with no-store (delete outcomes are not cacheable). */
function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}
