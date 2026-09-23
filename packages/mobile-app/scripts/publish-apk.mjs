#!/usr/bin/env node
/**
 * 发布 APK：把构建产物 + 版本元数据整理好，供 relay 下发、App 内更新读取。
 *
 *   node packages/mobile-app/scripts/publish-apk.mjs [--apk <path>] [--out <dir>]
 *
 * 产出（默认写到 app/build/outputs/apk/release/）：
 *   app-release.apk    安装包（原样）
 *   version.json       {versionCode, versionName, sha256, size, builtAt}
 *
 * 部署（在能 ssh 的机器上）：
 *   scp app-release.apk version.json  root@<relay>:/opt/mcca-relay/
 *   （或 relay 目录里放 app.apk + version.json 两个文件即可）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const root = path.resolve(appDir, "..", "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const apkPath = path.resolve(arg("--apk", path.join(appDir, "app", "build", "outputs", "apk", "release", "app-release.apk")));
if (!fs.existsSync(apkPath)) {
  console.error(`找不到 APK：${apkPath}\n先跑 pnpm --filter @mcca/mobile-app apk`);
  process.exit(1);
}

// 从 build.gradle.kts 读版本号，保证和安装包一致
const gradle = fs.readFileSync(path.join(appDir, "app", "build.gradle.kts"), "utf8");
const versionCode = Number(/versionCode\s*=\s*(\d+)/.exec(gradle)?.[1] || 0);
const versionName = /versionName\s*=\s*"([^"]+)"/.exec(gradle)?.[1] || "0.0.0";
if (!versionCode) {
  console.error("解析 versionCode 失败（app/build.gradle.kts）");
  process.exit(1);
}

const buf = fs.readFileSync(apkPath);
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
const meta = {
  versionCode,
  versionName,
  sha256,
  size: buf.length,
  builtAt: new Date().toISOString(),
  app: "mcca-mobile",
};
const outFile = path.join(path.dirname(apkPath), "version.json");
fs.writeFileSync(outFile, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

console.log(`APK      : ${apkPath} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`版本     : ${versionName} (${versionCode})`);
console.log(`sha256   : ${sha256}`);
console.log(`元数据   : ${outFile}`);
console.log("");
console.log("部署到中转（relay 目录下这两份文件）：");
console.log(`  scp "${apkPath}" "${outFile}" <user>@<relay>:/opt/mcca-relay/`);
console.log("  # 服务器上：mv app-release.apk app.apk && chown www-data:www-data app.apk version.json");
void root;
