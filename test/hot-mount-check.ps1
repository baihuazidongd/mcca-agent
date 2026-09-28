$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot      # this script lives in <repo>/test
$dir = Join-Path $root "plugins\tmp-hot-probe"
$log = Join-Path $root "test\hot-probe.log"
$logFwd = $log -replace '\\', '/'
if (Test-Path $log) { Remove-Item $log -Force }

New-Item -ItemType Directory -Path $dir -Force | Out-Null
@'
{
  "name": "tmp-hot-probe",
  "version": "0.0.1",
  "kind": "tool",
  "targets": ["ds", "pi"],
  "description": "temporary hot-reload probe (delete after test)",
  "entry": "index.mjs"
}
'@ | Set-Content "$dir\manifest.json" -Encoding UTF8

(@'
import fs from "node:fs";
const LOG = "__LOG_PATH__";
export default function probe(api) {
  fs.appendFileSync(LOG, `load pid=${process.pid}\n`);
  api.registerTool({
    name: "tmp_hot_probe",
    description: "probe",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "probe" }] }; },
  });
  return () => { fs.appendFileSync(LOG, `dispose pid=${process.pid}\n`); };
}
'@).Replace('__LOG_PATH__', $logFwd) | Set-Content "$dir\index.mjs" -Encoding UTF8

function Lines { if (Test-Path $log) { (Get-Content $log) } else { @() } }

Start-Sleep -Seconds 6
$a = Lines
"HOT MOUNT (no restart): lines=$($a.Count) => $($a -join ' | ')"

# 关掉 ds 开关（portal API 写 config/plugins.json → dsh 侧 watch 重载）
$body = @{ agent = "ds"; enabled = $false } | ConvertTo-Json
Invoke-RestMethod "http://127.0.0.1:3470/api/plugins/tmp-hot-probe" -Method Post -Body $body -ContentType "application/json" | Out-Null
Start-Sleep -Seconds 5
$b = Lines
"AFTER DISABLE: lines=$($b.Count) (expect a dispose line, no new load)"

# 再触碰文件：若开关生效，重载不应再产生 load 行
(Get-Item "$dir\index.mjs").LastWriteTime = Get-Date
Start-Sleep -Seconds 6
$c = Lines
$loadsAfterDisable = @($c | Where-Object { $_ -match "^load" }).Count
"TOUCH AFTER DISABLE: load lines total=$loadsAfterDisable (expect unchanged = $($a | Where-Object { $_ -match '^load' }).Count)"

# 重新打开 → 应再次 load
$body2 = @{ agent = "ds"; enabled = $true } | ConvertTo-Json
Invoke-RestMethod "http://127.0.0.1:3470/api/plugins/tmp-hot-probe" -Method Post -Body $body2 -ContentType "application/json" | Out-Null
Start-Sleep -Seconds 6
$d = Lines
$loadsFinal = @($d | Where-Object { $_ -match "^load" }).Count
"RE-ENABLE: load lines total=$loadsFinal (expect > $loadsAfterDisable)"

# 清理
Remove-Item $dir -Recurse -Force
Invoke-RestMethod "http://127.0.0.1:3470/api/plugins/tmp-hot-probe" -Method Post -Body (@{ agent = "pi"; enabled = $true } | ConvertTo-Json) -ContentType "application/json" | Out-Null
"CLEANUP: dir removed=$(-not (Test-Path $dir))"
"FULL LOG:`n" + (($d) -join "`n")
