$ErrorActionPreference = 'Stop'
trap {
    Write-Host ("Portal update failed: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host $_.ScriptStackTrace
    exit 1
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
& $nodeExecutable --check (Join-Path $repoRoot 'packages/portal/server.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Portal syntax check failed; existing process retained.' }
$desk = Invoke-RestMethod 'http://127.0.0.1:3470/api/desk' -TimeoutSec 20
if (@($desk.running).Count -gt 0) { throw 'Active IDE tasks detected; finish or explicitly stop them before portal update.' }
try {
    Invoke-RestMethod 'http://127.0.0.1:3470/api/workbench/prepare-restart' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 30 | Out-Null
} catch {
    if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
}
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
            $catalog = Invoke-RestMethod 'http://127.0.0.1:3470/api/runtimes' -TimeoutSec 5
            $current = Invoke-RestMethod 'http://127.0.0.1:3470/api/status' -TimeoutSec 10
            if ($current.ok -and $catalog.ok -and @($catalog.runtimes).Count -gt 0) { break }
        } catch { $current = $null }
    } while ((Get-Date) -lt $deadline)
    try {
        $catalog = Invoke-RestMethod 'http://127.0.0.1:3470/api/runtimes' -TimeoutSec 15
        $current = Invoke-RestMethod 'http://127.0.0.1:3470/api/status' -TimeoutSec 15
    } catch {
        throw "Portal did not start. Check $logDir\portal-resource-err.log"
    }
    if (-not $current -or -not $catalog -or $current.ok -ne $true -or $catalog.ok -ne $true) { throw "Portal did not start. Check $logDir\portal-resource-err.log" }
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
