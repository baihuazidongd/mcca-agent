"use strict";

/**
 * On-disk pi extension entry point.
 *
 * pi's loader treats a CommonJS module whose `module.exports` is a function as
 * an extension factory. This file resolves the shared plugins/config locations
 * from environment variables (with sensible defaults relative to the repo
 * root) and exports the adapter factory, so pi-web (or any pi host) can point
 * `additionalExtensionPaths` at this file.
 *
 * Hot reload: call `clearExtensionCache()` then re-discover this extension
 * (e.g. `session.reload()`); pi re-runs the factory and the plugin host re-reads
 * the shared plugins directory.
 */

const path = require("node:path");
const { createPiAdapter } = require("./index.cjs");

// This file lives at packages/pi-adapter/src/extension.cjs, so the repo root is
// three levels up.
const ROOT = path.resolve(__dirname, "..", "..", "..");

const pluginsDir = process.env.MCCA_PLUGINS_DIR || path.join(ROOT, "plugins");
const configPath = process.env.MCCA_PLUGINS_CONFIG || path.join(ROOT, "config", "plugins.json");
const cwd = process.env.MCCA_CWD || ROOT;

module.exports = createPiAdapter({ pluginsDir, configPath, cwd });
