$ErrorActionPreference = 'Stop'
$env:MCCA_HOME = $PSScriptRoot
$env:MCCA_DATA_DIR = Join-Path $env:LOCALAPPDATA 'mcca'
$env:MCCA_AGENT_DIR = Join-Path $env:MCCA_DATA_DIR 'pi-agent'
$env:MCCA_PI_MODELS = Join-Path $env:MCCA_AGENT_DIR 'models.json'
$env:MCCA_HERMES_HOME = Join-Path $env:MCCA_DATA_DIR 'runtimes\hermes'
$env:MCCA_MEMORY_ROOT = Join-Path $env:MCCA_DATA_DIR 'memory'
$env:MCCA_NODE = Join-Path $PSScriptRoot 'runtime\node.exe'
$env:MCCA_PLUGINS_DIR = Join-Path $env:MCCA_DATA_DIR 'plugins'
$env:MCCA_SKILLS_DIR = Join-Path $env:MCCA_DATA_DIR 'skills'
New-Item -ItemType Directory -Path $env:MCCA_DATA_DIR, $env:MCCA_AGENT_DIR, $env:MCCA_PLUGINS_DIR, $env:MCCA_SKILLS_DIR -Force | Out-Null
$state = Join-Path $env:MCCA_DATA_DIR 'portal-instances.json'
if (!(Test-Path -LiteralPath $state)) { [IO.File]::WriteAllText($state, '{"installed":["pi-web","codex-web"],"resident":[]}', [Text.UTF8Encoding]::new($false)) }
try {
  $response = Invoke-RestMethod 'http://127.0.0.1:3470/api/runtimes' -TimeoutSec 2
  $ready = $response.ok
} catch { $ready = $false }
if (!$ready) {
  Start-Process -FilePath $env:MCCA_NODE -ArgumentList ('"' + (Join-Path $PSScriptRoot 'packages\portal\server.cjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:MCCA_DATA_DIR 'portal.out.log') -RedirectStandardError (Join-Path $env:MCCA_DATA_DIR 'portal.err.log') | Out-Null
  for ($attempt=0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { if ((Invoke-RestMethod 'http://127.0.0.1:3470/api/runtimes' -TimeoutSec 1).ok) { $ready=$true; break } } catch {}
  }
}
if (!$ready) { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show("启动失败。日志：$env:MCCA_DATA_DIR\portal.err.log", 'mcca') | Out-Null; exit 1 }
Start-Process 'http://127.0.0.1:3470/#/workbench'
