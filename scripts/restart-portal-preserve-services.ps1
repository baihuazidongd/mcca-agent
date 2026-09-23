$ErrorActionPreference = 'Stop'
trap {
    Write-Host ("Portal update failed: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host $_.ScriptStackTrace
    Read-Host 'Press Enter to return'
    break
}
$repoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { 'D:\dshpi' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'packages/portal/server.cjs'))) {
    throw "Portal source not found under $repoRoot"
}
$status = Invoke-RestMethod 'http://127.0.0.1:3470/api/status'
$records = @($status.agents | Where-Object running | ForEach-Object {
    $serviceProcess = Get-Process -Id $_.pid
    @{
        agent = $_.agent
        pid = $_.pid
        startedAt = $_.startedAt
        started = $serviceProcess.StartTime.ToUniversalTime().Ticks.ToString()
    }
})
$portalProcessId = (Get-NetTCPConnection -LocalPort 3470 -State Listen | Select-Object -First 1).OwningProcess
$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$portalProcessId"
if ($owner.CommandLine -notmatch 'packages[\\/]portal[\\/]server.cjs') {
    throw 'Unexpected process on port 3470; nothing was stopped.'
}
$nodeExecutable = (Get-Command node.exe).Source
$logDir = Join-Path $repoRoot '.playwright-mcp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$records | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $logDir 'portal-handover.json') -Encoding UTF8
$env:MCCA_PORTAL_HANDOVER = ConvertTo-Json -InputObject $records -Compress
$env:PORTAL_PORT = '3470'
$env:MCCA_NO_AUTOSTART_MOBILE = '1'
try {
    Stop-Process -Id $portalProcessId
    Wait-Process -Id $portalProcessId -Timeout 10 -ErrorAction SilentlyContinue
    Start-Process -FilePath $nodeExecutable -ArgumentList 'packages/portal/server.cjs' -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'portal-resource-out.log') -RedirectStandardError (Join-Path $logDir 'portal-resource-err.log') | Out-Null
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        try {
            $current = Invoke-RestMethod 'http://127.0.0.1:3470/api/status' -TimeoutSec 2
            if ($current.ok) { break }
        } catch { $current = $null }
    } while ((Get-Date) -lt $deadline)
    if (-not $current.ok) { throw "Portal did not start. Check $logDir\portal-resource-err.log" }
    foreach ($record in $records) {
        $service = $current.agents | Where-Object agent -eq $record.agent
        if (-not $service.running -or $service.pid -ne $record.pid) { throw "Service handover failed: $($record.agent)" }
    }
    $resources = Invoke-RestMethod 'http://127.0.0.1:3470/api/resources' -TimeoutSec 30
    if ($null -eq $resources.processes) { throw 'Resource process details are missing.' }
    Write-Host "Portal updated. $($resources.processes.Count) process rows available. Existing service PIDs preserved. Refresh the app."
} finally {
    Remove-Item Env:MCCA_PORTAL_HANDOVER -ErrorAction SilentlyContinue
    Remove-Item Env:PORTAL_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:MCCA_NO_AUTOSTART_MOBILE -ErrorAction SilentlyContinue
}
