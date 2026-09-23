$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Emit([hashtable]$obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
}

$src = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class MccaCua {
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const int INPUT_KEYBOARD = 1;

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public int mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION u;
  }

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")]
  static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  struct RECT { public int Left, Top, Right, Bottom; }
  static EnumProc _enum;

  static void Send(List<INPUT> inputs) {
    int size = Marshal.SizeOf(typeof(INPUT));
    if (size != 28 && size != 40) throw new InvalidOperationException("unexpected INPUT size " + size);
    INPUT[] arr = inputs.ToArray();
    uint sent = SendInput((uint)arr.Length, arr, size);
    if (sent != arr.Length) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }

  static INPUT Unicode(char ch, bool up) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wScan = ch;
    input.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return input;
  }

  static INPUT Virtual(ushort vk, bool up) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return input;
  }

  public static int InputSize() {
    return Marshal.SizeOf(typeof(INPUT));
  }

  public static void TypeText(string text) {
    List<INPUT> inputs = new List<INPUT>();
    foreach (char ch in text) {
      inputs.Add(Unicode(ch, false));
      inputs.Add(Unicode(ch, true));
    }
    Send(inputs);
  }

  public static void KeyChord(ushort[] mods, ushort key) {
    List<INPUT> inputs = new List<INPUT>();
    foreach (ushort mod in mods) inputs.Add(Virtual(mod, false));
    inputs.Add(Virtual(key, false));
    inputs.Add(Virtual(key, true));
    for (int i = mods.Length - 1; i >= 0; i--) inputs.Add(Virtual(mods[i], true));
    Send(inputs);
  }

  public static void Click(int x, int y, string button, int clicks) {
    SetCursorPos(x, y);
    Thread.Sleep(30);
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; }
    else if (button == "middle") { down = 0x0020; up = 0x0040; }
    for (int i = 0; i < clicks; i++) {
      mouse_event(down, 0, 0, 0, UIntPtr.Zero);
      mouse_event(up, 0, 0, 0, UIntPtr.Zero);
      if (i + 1 < clicks) Thread.Sleep(50);
    }
  }

  public static void Scroll(int x, int y, int dy) {
    SetCursorPos(x, y);
    int notches = dy;
    if (notches > 10) notches = 10;
    if (notches < -10) notches = -10;
    mouse_event(0x0800, 0, 0, -notches * 120, UIntPtr.Zero);
  }

  public static string Screenshot(string path, int maxEdge) {
    Rectangle bounds = Screen.PrimaryScreen.Bounds;
    int sw = bounds.Width;
    int sh = bounds.Height;
    double scale = 1.0;
    if (sw > maxEdge) scale = Math.Min(scale, (double)maxEdge / sw);
    if (sh > maxEdge) scale = Math.Min(scale, (double)maxEdge / sh);
    int iw = Math.Max(1, (int)Math.Round(sw * scale));
    int ih = Math.Max(1, (int)Math.Round(sh * scale));
    using (Bitmap src = new Bitmap(sw, sh))
    using (Graphics g = Graphics.FromImage(src)) {
      g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
      using (Bitmap dst = new Bitmap(iw, ih))
      using (Graphics g2 = Graphics.FromImage(dst)) {
        g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g2.DrawImage(src, 0, 0, iw, ih);
        dst.Save(path, ImageFormat.Png);
      }
    }
    return "{\"ok\":true,\"screen\":{\"x\":" + bounds.X + ",\"y\":" + bounds.Y
      + ",\"width\":" + sw + ",\"height\":" + sh
      + "},\"image\":{\"width\":" + iw + ",\"height\":" + ih + "}}";
  }

  static string Esc(string s) {
    if (s == null) return "";
    return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
  }

  public static string Windows() {
    List<string> rows = new List<string>();
    _enum = delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString().Trim();
      if (title.Length == 0) return true;
      RECT r;
      if (!GetWindowRect(hWnd, out r)) return true;
      int w = r.Right - r.Left;
      int h = r.Bottom - r.Top;
      if (w < 40 || h < 40) return true;
      if (rows.Count < 40) {
        rows.Add("{\"title\":\"" + Esc(title) + "\",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"width\":" + w + ",\"height\":" + h + "}");
      }
      return true;
    };
    EnumWindows(_enum, IntPtr.Zero);
    return "{\"ok\":true,\"windows\":[" + string.Join(",", rows.ToArray()) + "]}";
  }

  public static string Focus(string title) {
    string needle = (title ?? "").Trim();
    List<string> matches = new List<string>();
    IntPtr found = IntPtr.Zero;
    _enum = delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(hWnd, sb, sb.Capacity);
      string text = sb.ToString().Trim();
      if (text.Length == 0) return true;
      if (text.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      matches.Add(text);
      if (found == IntPtr.Zero) found = hWnd;
      return true;
    };
    EnumWindows(_enum, IntPtr.Zero);
    if (matches.Count == 0) return "{\"ok\":false,\"error\":\"no-match\"}";
    if (matches.Count > 1) {
      string[] quoted = new string[matches.Count];
      for (int i = 0; i < matches.Count; i++) quoted[i] = "\"" + Esc(matches[i]) + "\"";
      return "{\"ok\":false,\"error\":\"many-matches\",\"matches\":[" + string.Join(",", quoted) + "]}";
    }
    ShowWindow(found, 9);
    SetForegroundWindow(found);
    return "{\"ok\":true,\"title\":\"" + Esc(matches[0]) + "\"}";
  }

  public static void Launch(string target) {
    Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true });
  }
}
"@

try {
  if (-not ("MccaCua" -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition $src -Language CSharp -ErrorAction Stop
  }
  $payload = $env:MCCA_CUA_JSON | ConvertFrom-Json
  if (-not $payload) { throw "missing MCCA_CUA_JSON" }
  switch ([string]$payload.op) {
    "probe" { Emit @{ ok = $true; inputSize = [MccaCua]::InputSize() } }
    "screenshot" { [Console]::Out.WriteLine([MccaCua]::Screenshot([string]$payload.path, 1280)) }
    "click" { [MccaCua]::Click([int]$payload.x, [int]$payload.y, [string]$payload.button, [int]$payload.clicks); Emit @{ ok = $true } }
    "scroll" { [MccaCua]::Scroll([int]$payload.x, [int]$payload.y, [int]$payload.dy); Emit @{ ok = $true } }
    "type" { [MccaCua]::TypeText([string]$payload.text); Emit @{ ok = $true } }
    "key" {
      $mods = @()
      if ($payload.mods) { $mods = @($payload.mods | ForEach-Object { [uint16]$_ }) }
      [MccaCua]::KeyChord($mods, [uint16]$payload.key)
      Emit @{ ok = $true }
    }
    "windows" { [Console]::Out.WriteLine([MccaCua]::Windows()) }
    "focus" { [Console]::Out.WriteLine([MccaCua]::Focus([string]$payload.title)) }
    "launch" { [MccaCua]::Launch([string]$payload.target); Emit @{ ok = $true } }
    default { throw "unknown op" }
  }
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
