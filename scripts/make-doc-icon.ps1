# Draws build/windows/mdicon.ico -- the icon Explorer puts on .md files once
# Hashpad is registered for them.
#
# **A document icon, not the application icon.** Windows convention is that a
# file looks different from the program that opens it, and until now the
# associations reused `appicon`, so every markdown file on the machine showed
# Hashpad's own "H". Reported as unintuitive, which it is: the icon said "this is
# Hashpad" where it needed to say "this is a markdown file".
#
# Same white rounded tile as the application icon, so the two read as a family,
# with ".MD" in place of the "H". The glyph is the whole difference, which is
# what makes them tell apart at a glance while still belonging together.
#
# Committed as a script rather than only as the .ico it produces, because a
# binary in a repository is a thing nobody can review or adjust. Re-run it and
# the icon is rebuilt:
#
#     powershell.exe -ExecutionPolicy Bypass -File scripts/make-doc-icon.ps1
#
# **PNG-compressed frames, not BMP.** The ICO format allows either; Windows has
# read PNG frames since Vista and they are a fraction of the size at 256x256.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

# Every size Explorer and the shell actually ask for. 16 is the list view and the
# one that decides whether this was worth doing; 256 is the extra-large view.
$sizes = @(16, 20, 24, 32, 48, 64, 128, 256)

$tile = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$ink = [System.Drawing.Color]::FromArgb(255, 31, 31, 31)
$edge = [System.Drawing.Color]::FromArgb(255, 214, 214, 214)

function New-RoundedPath {
    param([single]$x, [single]$y, [single]$w, [single]$h, [single]$r)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

# The largest font whose ".MD" still fits the usable width. Measured rather than
# computed from the size: the glyphs' advance widths are not proportional to the
# point size in a way worth predicting, and at 16px being one pixel too wide is
# the difference between legible and clipped.
function Get-FittedFont {
    param([System.Drawing.Graphics]$g, [string]$text, [single]$maxWidth, [single]$maxHeight)
    $family = New-Object System.Drawing.FontFamily('Segoe UI')
    $best = $null
    for ($points = 4.0; $points -le 220.0; $points += 0.5) {
        $candidate = New-Object System.Drawing.Font($family, $points, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $measured = $g.MeasureString($text, $candidate)
        if ($measured.Width -gt $maxWidth -or $measured.Height -gt $maxHeight) {
            $candidate.Dispose()
            break
        }
        if ($null -ne $best) { $best.Dispose() }
        $best = $candidate
    }
    if ($null -eq $best) {
        $best = New-Object System.Drawing.Font($family, 4.0, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    }
    return $best
}

function New-IconFrame {
    param([int]$size)

    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    # A hairline inset so the tile's edge is not clipped by the bitmap bounds,
    # and a corner radius that stays proportional rather than square at 16px.
    $inset = [single]([Math]::Max(1.0, $size * 0.06))
    $side = [single]($size - ($inset * 2))
    $radius = [single]([Math]::Max(1.5, $size * 0.16))

    $path = New-RoundedPath -x $inset -y $inset -w $side -h $side -r $radius
    $fill = New-Object System.Drawing.SolidBrush($tile)
    $g.FillPath($fill, $path)
    $fill.Dispose()

    # Only drawn where it will not muddy the shape. Below about 20px a 1px border
    # is a large fraction of the tile and reads as a grey blur.
    if ($size -ge 24) {
        $pen = New-Object System.Drawing.Pen($edge, [single]([Math]::Max(1.0, $size / 64.0)))
        $g.DrawPath($pen, $path)
        $pen.Dispose()
    }
    $path.Dispose()

    # Wider than the tile's own padding suggests: ".MD" is three glyphs where the
    # application icon has one, so it needs most of the width to stay readable in
    # a list view.
    $text = '.MD'
    $font = Get-FittedFont -g $g -text $text -maxWidth ([single]($side * 0.88)) -maxHeight ([single]($side * 0.74))

    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    # **NoWrap, or a font one pixel too wide silently becomes two lines.** The
    # measured fit above should prevent it, but `MeasureString` and `DrawString`
    # do not always agree to the pixel, and the failure is not subtle: ".MD"
    # rendered as ".M" over "D", which looked deliberate at 256px and like noise
    # at 16. Clipping a glyph would be the better failure of the two, and this
    # makes that the one that can happen.
    $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap

    $brush = New-Object System.Drawing.SolidBrush($ink)
    $box = New-Object System.Drawing.RectangleF($inset, $inset, $side, $side)
    $g.DrawString($text, $font, $brush, $box, $format)

    $brush.Dispose()
    $format.Dispose()
    $font.Dispose()
    $g.Dispose()

    $stream = New-Object System.IO.MemoryStream
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    # **The leading comma is load-bearing.** PowerShell unrolls a returned array
    # into the pipeline, so a bare `return $bytes` emits several hundred
    # individual bytes and the caller collects an `Object[]` of them. The
    # resulting file was a valid-looking 142-byte ICO -- a correct header
    # followed by nothing -- rather than an error.
    return , $stream.ToArray()
}

# ICONDIR, then one 16-byte ICONDIRENTRY per frame, then the frames. A width or
# height of 256 is stored as 0 -- the field is one byte, so 256 does not fit and
# the format spells it that way.
$frames = @()
foreach ($size in $sizes) { $frames += , ([byte[]](New-IconFrame -size $size)) }

$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($out)

$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$sizes.Count)

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $size = $sizes[$i]
    $bytes = $frames[$i]
    $writer.Write([Byte]$(if ($size -ge 256) { 0 } else { $size }))
    $writer.Write([Byte]$(if ($size -ge 256) { 0 } else { $size }))
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($bytes in $frames) { $writer.Write($bytes) }

$writer.Flush()
$target = Join-Path $PSScriptRoot '..\build\windows\mdicon.ico'
[System.IO.File]::WriteAllBytes([System.IO.Path]::GetFullPath($target), $out.ToArray())
$writer.Dispose()
$out.Dispose()

$written = Get-Item ([System.IO.Path]::GetFullPath($target))
Write-Output ("wrote {0} ({1} frames, {2:N0} bytes)" -f $written.FullName, $sizes.Count, $written.Length)

# **Wails generates association icons from a PNG, not from the .ico above.**
# `iconName: "mdicon"` in wails.json makes it look for `build/mdicon.png` during
# "Generating application assets", and it fails the build outright if that file
# is missing -- which is how this was found. The .ico is still written because it
# is the artefact with per-size rendering in it: text hinted at 16px is legible
# in a way a downscaled 1024px tile is not, and it is there for anyone who needs
# to point at a real icon file.
$source = Join-Path $PSScriptRoot '..\build\mdicon.png'
$png = New-IconFrame -size 1024
[System.IO.File]::WriteAllBytes([System.IO.Path]::GetFullPath($source), [byte[]]$png)

$sourceWritten = Get-Item ([System.IO.Path]::GetFullPath($source))
Write-Output ("wrote {0} (1024x1024, {1:N0} bytes)" -f $sourceWritten.FullName, $sourceWritten.Length)
