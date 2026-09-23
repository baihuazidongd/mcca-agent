$ErrorActionPreference = 'SilentlyContinue'
# Does the watched profile patch layer really recompose? Test a HOST row both
# ways: append -> expect the route to appear; remove -> expect it to disappear.
$f = "D:\dshpi\config\dsh-home\profiles\web\cordis.patch.yml"
$bak = "$f.probe-bak"
Copy-Item $f $bak -Force

function Probe {
  # Unknown paths fall back to the SPA index with 200 text/html, so the status
  # code alone proves nothing: only application/json means the plugin answered.
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:3081/mcca/patch-probe" -UseBasicParsing -TimeoutSec 5
    $type = $r.Headers["Content-Type"]
    if ($type -like "*application/json*") { return "JSON" }
    return "SPA"
  } catch {
    return "ERR"
  }
}

"before ADD : $(Probe)   (expect SPA = not mounted)"
$row = "`n- insert:`n    - id: mcca-patch-probe`n      name: 'file:///D:/dshpi/packages/patch-probe/src/index.js'`n"
Add-Content -Path $f -Value $row -Encoding UTF8
$d = (Get-Date).AddSeconds(25); $hit = "SPA"
while ((Get-Date) -lt $d) { Start-Sleep -Seconds 3; $hit = Probe; if ($hit -eq "JSON") { break } }
"after ADD  : $hit   (expect JSON if the watcher recomposes)"

Copy-Item $bak $f -Force
$d2 = (Get-Date).AddSeconds(25); $hit2 = "JSON"
while ((Get-Date) -lt $d2) { Start-Sleep -Seconds 3; $hit2 = Probe; if ($hit2 -ne "JSON") { break } }
"after REMOVE: $hit2   (expect SPA if unmount is hot too)"

Remove-Item $bak -Force
Remove-Item "D:\dshpi\packages\patch-probe" -Recurse -Force
"cleanup: probe dir removed = $(-not (Test-Path 'D:\dshpi\packages\patch-probe'))"
