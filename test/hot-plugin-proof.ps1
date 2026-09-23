$ErrorActionPreference = 'SilentlyContinue'
# Hot-plugin proof: add / edit / delete a host plugin and a client bundle with
# NO process restart. Prints status codes only (never response bodies).
$probeDir = "D:\dshpi\packages\hot-probe\src"
$probeFile = "$probeDir\index.js"
$manifest = "D:\dshpi\config\hot-plugins.json"
$piClient = "D:\dshpi\packages\client-plugins\mcca-hot-test\client.js"

function Route-Code($url) {
  try {
    $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 6
    return @{ code = $r.StatusCode; type = $r.Headers["Content-Type"]; len = $r.RawContentLength }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { return @{ code = [int]$resp.StatusCode; type = ""; len = 0 } }
    return @{ code = -1; type = $_.Exception.Message; len = 0 }
  }
}
function Supervisor-Line($id) {
  $s = (Invoke-WebRequest "http://127.0.0.1:3081/mcca/hot-plugins" -UseBasicParsing -TimeoutSec 8).Content | ConvertFrom-Json
  $p = $s.plugins | Where-Object { $_.id -eq $id }
  "  supervisor: mounted=$($p.mounted) pending=$($p.pending) stale=$($p.stale) err=$($p.error) ticks=$($s.ticks)"
}

# ---- 1. ADD a host plugin -------------------------------------------------
New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
$src = @'
export const name = "mcca-hot-probe";
export const inject = ["webServer"];
export const VERSION = "v1";
export function apply(ctx) {
  // Registrations must go through ctx.effect: cordis ignores apply's return
  // value, so a returned disposer never unwinds on hot unmount.
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/mcca/hot-probe",
    handler: async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ version: VERSION }));
    },
  }), "hot-probe: route");
}
'@
Set-Content -Path $probeFile -Value $src -Encoding ASCII
$entries = @((Get-Content $manifest -Raw | ConvertFrom-Json)) + [pscustomobject]@{ id = "mcca-hot-probe"; file = "D:/dshpi/packages/hot-probe/src/index.js" }
ConvertTo-Json $entries -Depth 5 | Set-Content -Path $manifest -Encoding ASCII
Start-Sleep -Seconds 5
$a = Route-Code "http://127.0.0.1:3081/mcca/hot-probe"
"ADD    : status=$($a.code) type=$($a.type) len=$($a.len)   (expect 200 application/json)"
Supervisor-Line "mcca-hot-probe"

# ---- 2. EDIT its source ---------------------------------------------------
(Get-Content $probeFile -Raw).Replace('VERSION = "v1"', 'VERSION = "v2"') | Set-Content -Path $probeFile -Encoding ASCII
Start-Sleep -Seconds 5
$b = Route-Code "http://127.0.0.1:3081/mcca/hot-probe"
$body = (Invoke-WebRequest "http://127.0.0.1:3081/mcca/hot-probe" -UseBasicParsing -TimeoutSec 6).Content
"EDIT   : status=$($b.code) body=$body   (expect v2 without restart)"
Supervisor-Line "mcca-hot-probe"

# ---- 3. DELETE it ---------------------------------------------------------
$kept = @((Get-Content $manifest -Raw | ConvertFrom-Json) | Where-Object { $_.id -ne "mcca-hot-probe" })
ConvertTo-Json $kept -Depth 5 | Set-Content -Path $manifest -Encoding ASCII
Start-Sleep -Seconds 5
$c = Route-Code "http://127.0.0.1:3081/mcca/hot-probe"
"DELETE : status=$($c.code) type=$($c.type)   (expect SPA text/html = route gone)"
Supervisor-Line "mcca-hot-probe"

# ---- 4. pi client bundle: add / edit / delete -----------------------------
New-Item -ItemType Directory -Path (Split-Path $piClient) -Force | Out-Null
Set-Content -Path $piClient -Value "(function(){window.__ModuleLoader__.load({id:'mcca-hot-test',factory:function(){return {inject:[],apply:function(){window.__mccaHotTest='v1';}}};});})();" -Encoding ASCII
$h1 = (Invoke-WebRequest "http://127.0.0.1:3458/" -UseBasicParsing -TimeoutSec 8).Content
$rev1 = if ($h1 -match 'plugins/mcca-hot-test/client\.js\?rev=([0-9a-f]+)') { $Matches[1] } else { "none" }
"PI ADD : inBoot=$($h1 -match 'mcca-hot-test') rev=$rev1"
Set-Content -Path $piClient -Value "(function(){window.__ModuleLoader__.load({id:'mcca-hot-test',factory:function(){return {inject:[],apply:function(){window.__mccaHotTest='v2';}}};});})();" -Encoding ASCII
$h2 = (Invoke-WebRequest "http://127.0.0.1:3458/" -UseBasicParsing -TimeoutSec 8).Content
$rev2 = if ($h2 -match 'plugins/mcca-hot-test/client\.js\?rev=([0-9a-f]+)') { $Matches[1] } else { "none" }
$served = (Invoke-WebRequest "http://127.0.0.1:3458/plugins/mcca-hot-test/client.js" -UseBasicParsing -TimeoutSec 8).Content
"PI EDIT: rev changed=$($rev1 -ne $rev2) servedHasV2=$($served -match "__mccaHotTest='v2'")"
Remove-Item (Split-Path $piClient) -Recurse -Force
$h3 = (Invoke-WebRequest "http://127.0.0.1:3458/" -UseBasicParsing -TimeoutSec 8).Content
"PI DEL : removedFromBoot=$($h3 -notmatch 'mcca-hot-test')"

# ---- cleanup --------------------------------------------------------------
Remove-Item "D:\dshpi\packages\hot-probe" -Recurse -Force
$final = (Invoke-WebRequest "http://127.0.0.1:3081/mcca/hot-plugins" -UseBasicParsing -TimeoutSec 8).Content | ConvertFrom-Json
"FINAL  : $(($final.plugins | ForEach-Object { "$($_.id)=$($_.mounted)" }) -join ' ')  probeDirRemoved=$(-not (Test-Path 'D:\dshpi\packages\hot-probe'))"
