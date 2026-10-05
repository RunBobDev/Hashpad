<#
.SYNOPSIS
  Films the real app scrolling under real OS wheel input, so scroll smoothness
  can be measured instead of described.

.DESCRIPTION
  Launches a probe build (`task build:probe`), opens -Doc, switches to -Mode
  with the probe's hidden chords, then turns the wheel with `mouse_event` -- the
  same input a physical mouse produces -- while capturing a thin vertical strip
  of the screen as fast as GDI allows. The captures are laid side by side into a
  kymograph: x is time, y is screen row. `scroll-film.py` measures it.

  Why this exists: no browser available to development can show a scrolling
  bug. The automation browser used in development has smooth scrolling off, its synthetic wheel
  events bypass the compositor, and requestAnimationFrame starves while it is
  hidden. The split/reading-view choppiness went through four wrong fixes
  reasoned from code before this rig filmed it in two minutes.

  It moves the real mouse and takes keyboard focus for the duration. Close every
  Hashpad window first: every build shares one single-instance lock, so a second
  launch only focuses the first.

.EXAMPLE
  ./scripts/scroll-film.ps1 -Doc C:\notes\long.md -Mode split -WheelAt 0.25 -Out split.png
  python scripts/scroll-film.py split.png
#>
param(
  [Parameter(Mandatory)][string]$Doc,
  [Parameter(Mandatory)][string]$Out,
  [ValidateSet('source', 'live', 'split', 'preview')][string]$Mode = 'split',
  # Defaults to `task build:probe`'s output. Resolved below, not here: Windows
  # PowerShell leaves $PSScriptRoot empty while parameter defaults are bound.
  [string]$Exe = '',
  # Where the wheel turns and where the strip is filmed, as fractions of the
  # window's width. In split: ~0.25 is the editor, ~0.8 the preview.
  [double]$WheelAt = 0.5,
  [double]$FilmAt = 0.02,
  [ValidateSet('top', 'end')][string]$Start = 'top',
  [int]$Ticks = 40,
  [int]$GapMs = 110
)

Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
public static class ScrollFilm {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  // Scan codes matter: without one, Chromium reports an empty `event.code`.
  public static void Keys(byte[] keys) {
    foreach (var k in keys) { keybd_event(k, (byte)MapVirtualKey(k, 0), 0, UIntPtr.Zero); Thread.Sleep(30); }
    for (int i = keys.Length - 1; i >= 0; i--) { keybd_event(keys[i], (byte)MapVirtualKey(keys[i], 0), 2, UIntPtr.Zero); Thread.Sleep(30); }
  }

  public static string Film(int x, int y, int w, int h, int ticks, int gapMs, int dir, string outPng) {
    var cols = new List<byte[]>(); var times = new List<double>();
    var sw = Stopwatch.StartNew(); bool done = false;
    var t = new Thread(() => {
      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
      using (var g = Graphics.FromImage(bmp)) {
        while (!Volatile.Read(ref done)) {
          g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
          var d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
          var buf = new byte[d.Stride * h]; Marshal.Copy(d.Scan0, buf, 0, buf.Length); bmp.UnlockBits(d);
          var col = new byte[h];
          for (int yy = 0; yy < h; yy++) { int s = 0; for (int xx = 0; xx < w; xx++) { int i = yy * d.Stride + xx * 4; s += (buf[i] + buf[i + 1] + buf[i + 2]) / 3; } col[yy] = (byte)(s / w); }
          cols.Add(col); times.Add(sw.Elapsed.TotalMilliseconds);
        }
      }
    });
    t.Start(); Thread.Sleep(150);
    for (int i = 0; i < ticks; i++) { mouse_event(0x0800, 0, 0, dir * -120, UIntPtr.Zero); Thread.Sleep(gapMs); }
    Thread.Sleep(500); Volatile.Write(ref done, true); t.Join();
    using (var k = new Bitmap(cols.Count, h)) {
      for (int c = 0; c < cols.Count; c++) for (int yy = 0; yy < h; yy++) { int v = cols[c][yy]; k.SetPixel(c, yy, Color.FromArgb(v, v, v)); }
      k.Save(outPng, ImageFormat.Png);
    }
    var gaps = new List<double>(); for (int i = 1; i < times.Count; i++) gaps.Add(times[i] - times[i - 1]);
    gaps.Sort();
    return string.Format("{0} captures over {1:F0} ms, interval median {2:F1} ms", cols.Count, times[times.Count - 1] - times[0], gaps[gaps.Count / 2]);
  }
}
'@
[void][ScrollFilm]::SetProcessDPIAware()
if ($Exe -eq '') { $Exe = Join-Path $PSScriptRoot '..\build\bin\probe\Hashpad.exe' }
$Out = [System.IO.Path]::GetFullPath($Out)

$p = Start-Process -FilePath $Exe -ArgumentList ('"' + (Resolve-Path $Doc) + '"') -PassThru
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $p.Refresh(); $h = $p.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) { throw 'the app never showed a window -- is another Hashpad open?' }
Start-Sleep -Seconds 4
[void][ScrollFilm]::SetForegroundWindow($h)
$r = New-Object ScrollFilm+RECT; [void][ScrollFilm]::GetWindowRect($h, [ref]$r)
$width = $r.R - $r.L; $height = $r.B - $r.T
$cy = [int]($r.T + $height * 0.55)

# A click gives the webview keyboard focus; it only moves the caret.
[void][ScrollFilm]::SetCursorPos([int]($r.L + $width * 0.5), $cy)
[ScrollFilm]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [ScrollFilm]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 500

# Ctrl+Alt+Shift + S / L / P / R: the probe's own mode chords (ui/scrollprobe.ts).
$vk = @{ source = 0x53; live = 0x4C; split = 0x50; preview = 0x52 }[$Mode]
[ScrollFilm]::Keys([byte[]](0x11, 0x12, 0x10, $vk)); Start-Sleep -Milliseconds 1500
$jump = if ($Start -eq 'top') { 0x24 } else { 0x23 }
[ScrollFilm]::Keys([byte[]](0x11, $jump)); Start-Sleep -Milliseconds 1500

# **Moved after the layout settles, not before.** Chromium aims a wheel at what
# was under the pointer when it last moved, so a pointer parked over the editor
# in live mode keeps scrolling the editor after the switch to split.
[void][ScrollFilm]::SetCursorPos([int]($r.L + $width * $WheelAt), $cy + 1)
[void][ScrollFilm]::SetCursorPos([int]($r.L + $width * $WheelAt), $cy)
Start-Sleep -Milliseconds 300

$dir = if ($Start -eq 'top') { 1 } else { -1 }
[ScrollFilm]::Film([int]($r.L + $width * $FilmAt) + 30, $r.T + 160, 60, $height - 230, $Ticks, $GapMs, $dir, $Out)

[void]$p.CloseMainWindow(); Start-Sleep -Seconds 2
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
