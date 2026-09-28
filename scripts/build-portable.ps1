param([string]$OutputDirectory = "", [switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (!$OutputDirectory) { $OutputDirectory = Join-Path $repo ('dist\mcca-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$target = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) { throw 'Output must be a new directory; existing files are never overwritten.' }
New-Item -ItemType Directory -Path $target -Force | Out-Null
$encoding = [Text.UTF8Encoding]::new($false)
$packageNames = @('portal','runtime-core','browser-extension','mobile-bridge','mobile-relay','pi-web','pi-adapter','dsh-adapter','pi-mcp','plugin-host','plugin-sdk','agent-ide','mini-web','grok-web','openhands-web','hot-mount','client-flags','session-delete','task-notify')
foreach ($name in $packageNames) {
  $source = Join-Path $repo "packages\$name"
  $destination = Join-Path $target "packages\$name"
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  & robocopy $source $destination /E /XD node_modules test tests .git .gradle build /XF *.log *.tsbuildinfo /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Copy failed: $name" }
}
New-Item -ItemType Directory -Path (Join-Path $target 'config'), (Join-Path $target 'scripts'), (Join-Path $target 'runtime') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'config\runtimes.json') -Destination (Join-Path $target 'config\runtimes.json')
Copy-Item -LiteralPath (Join-Path $repo 'scripts\gen-dsh-mcp-patch.mjs') -Destination (Join-Path $target 'scripts\gen-dsh-mcp-patch.mjs')
[IO.File]::WriteAllText((Join-Path $target 'config\dsh.patch.yml'), "[]`n", $encoding)
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $target 'runtime\node.exe')
$npmSource = Join-Path (Split-Path (Get-Command node.exe).Source) 'node_modules\npm'
if (!(Test-Path -LiteralPath (Join-Path $npmSource 'bin\npm-cli.js'))) { throw 'Bundled npm is required for on-demand IDE installation.' }
Copy-Item -LiteralPath $npmSource -Destination (Join-Path $target 'runtime\npm') -Recurse
$deps = [ordered]@{}
foreach ($name in $packageNames) {
  $manifest = Join-Path $repo "packages\$name\package.json"
  if (!(Test-Path -LiteralPath $manifest)) { continue }
  $package = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  foreach ($entry in $package.dependencies.PSObject.Properties) {
    if ($entry.Value -notlike 'workspace:*') { $deps[$entry.Name] = $entry.Value }
  }
}
$manifest = [ordered]@{ name = 'mcca-portable'; version = '0.1.0'; private = $true; type = 'module'; dependencies = $deps }
[IO.File]::WriteAllText((Join-Path $target 'package.json'), ($manifest | ConvertTo-Json -Depth 8), $encoding)
if (!$SkipInstall) {
  & npm.cmd install --prefix $target --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }
}
# Copy workspace packages as real directories: the portable folder has no
# junctions pointing back into the author's pnpm store or source checkout.
foreach ($name in $packageNames) {
  $manifestPath = Join-Path $target "packages\$name\package.json"
  if (!(Test-Path -LiteralPath $manifestPath)) { continue }
  $package = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($package.name -notlike '@mcca/*') { continue }
  $destination = Join-Path $target ('node_modules\' + $package.name.Replace('/', '\'))
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Copy-Item -Path (Join-Path $target "packages\$name\*") -Destination $destination -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $repo 'scripts\portable-start.ps1') -Destination (Join-Path $target 'start.ps1')
$launcher = @'
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\start.ps1""", 0, False
'@
[IO.File]::WriteAllText((Join-Path $target 'Start mcca.vbs'), $launcher, $encoding)
[IO.File]::WriteAllText((Join-Path $target 'README.txt'), @'
Double-click Start mcca.vbs. The workbench opens in your browser.
Node and application dependencies are included; user data is in LocalAppData/mcca.
Includes pi, Node, npm and the workbench. Codex, dsh, OpenHands, Hermes,
scrcpy and jadx can be installed on demand inside the app.
Browser control needs Edge/Chrome; physical Android devices need USB authorization.
No author credentials, sessions, private extensions or personal configuration are bundled.
'@, $encoding)
$report = [ordered]@{ schemaVersion=1; createdAt=(Get-Date).ToString('o'); node=(& node -v); directory=$target; dependencyInstallSkipped=[bool]$SkipInstall; packages=$packageNames; distribution='preview'; dataIncluded=$false }
[IO.File]::WriteAllText((Join-Path $target 'build-report.json'), ($report | ConvertTo-Json -Depth 5), $encoding)
Write-Output $target
