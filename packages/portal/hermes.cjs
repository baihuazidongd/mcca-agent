"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const INSTALL_URL = "https://hermes-agent.nousresearch.com/install.ps1";
const RELEASE_URL = "https://github.com/NousResearch/hermes-agent/releases/latest";

function createHermes({ root }) {
  const home = process.env.MCCA_HERMES_HOME || path.join(root, "vendor", "cli", "hermes");
  const installDir = path.join(home, "hermes-agent");
  const workspace = process.env.MCCA_HERMES_WORKSPACE || path.join(root, "workspace", "hermes");

  function ensureWorkspace() {
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  function launcher() {
    const bin = path.join(home, "bin");
    const exe = path.join(bin, "hermes.exe");
    const cmd = path.join(bin, "hermes.cmd");
    if (fs.existsSync(exe)) return { file: exe, args: [] };
    if (fs.existsSync(cmd)) return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", cmd] };
    return null;
  }

  function installed() {
    return Boolean(launcher());
  }

  function versionFile() {
    return path.join(home, "version.txt");
  }

  function readVersion() {
    try {
      return fs.readFileSync(versionFile(), "utf8").trim();
    } catch {
      return "";
    }
  }

  function writeVersion(version) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(versionFile(), `${version}\n`);
  }

  function spawnInstaller(tag) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
    const proxyLines = proxy
      ? [
          `$proxy = New-Object System.Net.WebProxy('${proxy.replaceAll("'", "''")}', $true)`,
          "[System.Net.WebRequest]::DefaultWebProxy = $proxy",
          `$env:HTTP_PROXY = '${proxy.replaceAll("'", "''")}'`,
          `$env:HTTPS_PROXY = '${proxy.replaceAll("'", "''")}'`,
          `$env:GIT_CONFIG_COUNT = '2'`,
          `$env:GIT_CONFIG_KEY_0 = 'http.proxy'`,
          `$env:GIT_CONFIG_VALUE_0 = '${proxy.replaceAll("'", "''")}'`,
          `$env:GIT_CONFIG_KEY_1 = 'http.version'`,
          `$env:GIT_CONFIG_VALUE_1 = 'HTTP/1.1'`,
        ]
      : [];
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
      ...proxyLines,
      `$scriptPath = Join-Path $env:TEMP 'mcca-hermes-install.ps1'`,
      `Invoke-WebRequest -Uri '${INSTALL_URL}' -OutFile $scriptPath -UseBasicParsing`,
      `$args = @{ HermesHome = '${home.replaceAll("'", "''")}'; InstallDir = '${installDir.replaceAll("'", "''")}'; NonInteractive = $true }`,
      tag ? `$args.Tag = 'v${tag.replace(/[^0-9A-Za-z._-]/g, "").replace(/^v/, "")}'` : "",
      `& $scriptPath @args`,
      "if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ].filter(Boolean).join("; ");
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, env: { ...process.env, HERMES_HOME: home } },
    );
  }

  return { home, installDir, workspace, ensureWorkspace, launcher, installed, readVersion, writeVersion, spawnInstaller, RELEASE_URL };
}

module.exports = { createHermes, INSTALL_URL, RELEASE_URL };
