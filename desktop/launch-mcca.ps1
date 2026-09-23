# mcca desktop one-click launcher.
# Ensures the portal (:3470) is running, then opens the Tauri native window.
# If a window already exists it is brought to the foreground.
$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot   # this script lives at <repo>/desktop/
$exe  = Join-Path $PSScriptRoot "src-tauri\target\release\mcca-desktop.exe"

# Register the app's AUMID so Windows renders our toast notifications
# (tauri-plugin-notification dispatches with identifier com.mcca.desktop).
$aumidKey = 'HKCU:\SOFTWARE\Classes\AppUserModelId\com.mcca.desktop'
if (-not (Test-Path $aumidKey)) {
  New-Item -Path $aumidKey -Force | Out-Null
  Set-ItemProperty -Path $aumidKey -Name 'DisplayName' -Value 'mcca'
  $iconPath = Join-Path $PSScriptRoot 'src-tauri\icons\icon.ico'
  if (Test-Path $iconPath) { Set-ItemProperty -Path $aumidKey -Name 'IconUri' -Value $iconPath }
}

function Test-Portal {
  try {
    Invoke-WebRequest http://127.0.0.1:3470/api/status -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch { return $false }
}

if (-not (Test-Portal)) {
  $out = Join-Path $env:TEMP "mcca-portal.out.log"
  $err = Join-Path $env:TEMP "mcca-portal.err.log"
  Start-Process node `
    -ArgumentList "`"$(Join-Path $root 'packages\portal\server.cjs')`"" `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {              # wait up to ~16s
    Start-Sleep -Milliseconds 400
    if (Test-Portal) { $ready = $true; break }
  }

  if (-not $ready) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "Failed to start portal. Error log:`n$err",
      "mcca", "OK", "Error") | Out-Null
    exit 1
  }
}

# Single-instance guard: focus the existing window, otherwise start a new one.
# The guard must verify the window is actually usable: after a WebView2 crash
# the process can linger with a degenerate ~15x15 untitled window, which would
# otherwise swallow the "focus" branch forever and the app would never appear.
Add-Type -Namespace Native -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
public struct RECT { public int Left, Top, Right, Bottom; }
'@

function Test-UsableWindow($proc) {
  if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { return $false }
  $rect = New-Object Native.Win32+RECT
  if (-not [Native.Win32]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)) { return $false }
  return (($rect.Right - $rect.Left) -ge 200 -and ($rect.Bottom - $rect.Top) -ge 150)
}

$running = Get-Process mcca-desktop -ErrorAction SilentlyContinue |
  Where-Object { Test-UsableWindow $_ } | Select-Object -First 1

if ($running) {
  [Native.Win32]::SetForegroundWindow($running.MainWindowHandle) | Out-Null
} else {
  # Replace any degenerate leftover processes before starting fresh.
  Get-Process mcca-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Test-Path $exe) {
    Start-Process $exe -WorkingDirectory $PSScriptRoot
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "Desktop exe not found:`n$exe`n`nBuild it first with:`npnpm --filter mcca-desktop tauri build --no-bundle",
      "mcca", "OK", "Warning") | Out-Null
    exit 1
  }
}

exit 0
