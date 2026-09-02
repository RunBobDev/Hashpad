# Draws Hashpad's two icons.
#
#   build/appicon.png          the source Wails generates assets from
#   build/windows/icon.ico     the executable's icon, and the installer's
#   build/windows/appicon.ico  kept in step; Wails looks for both names
#   build/mdicon.png           the source for the association icon
#   build/windows/mdicon.ico   what Explorer puts on .md files
#
# **The application icon was Wails' own "W" until now.** Not a placeholder anyone
# had chosen -- the stock logo from `wails init`, shipped in every build and
# every installer. A tilted "H" in the same shape replaces it.
#
# The document icon is the same white rounded tile carrying ".MD", so the two
# read as a family and are told apart by the glyph. Windows convention is that a
# file looks different from the program that opens it.
#
# Committed as a script rather than only as the binaries it produces, because an
# .ico in a repository is a thing nobody can review or adjust:
#
#     powershell.exe -ExecutionPolicy Bypass -File scripts/make-icons.ps1
#
# **Two drawing techniques, on purpose.** The "H" is a filled `GraphicsPath`,
# because it has to be sheared and a path can be transformed and then fitted to
# its own measured bounds -- exact centring, no guessing. ".MD" is drawn as text
# with `AntiAliasGridFit`, because it is three small glyphs and hinting is what
# keeps them legible at 16px; the same glyphs as outlines go soft. One glyph that
# must lean and three that must stay sharp are different problems.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

# Every size the shell asks for. 16 is the list view, and for ".MD" it is the one
# that decides whether rendering each size separately was worth it; 256 is the
# extra-large view.
$sizes = @(16, 20, 24, 32, 48, 64, 128, 256)

$tile = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$ink = [System.Drawing.Color]::FromArgb(255, 35, 35, 35)
$edge = [System.Drawing.Color]::FromArgb(255, 214, 214, 214)

# How far the "H" leans, as the x-shift per unit of height. Matched by eye to the
# "W" it replaces, which is steeper than an ordinary italic.
$lean = 0.26

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

# The tile every icon sits on, and the pen along its edge. Returned as a path so
# the caller can fill it and then stroke the same outline.
function New-Tile {
    param([System.Drawing.Graphics]$g, [int]$size)
    $inset = [single]([Math]::Max(1.0, $size * 0.06))
    $side = [single]($size - ($inset * 2))
    $radius = [single]([Math]::Max(1.5, $size * 0.16))

    $path = New-RoundedPath -x $inset -y $inset -w $side -h $side -r $radius
    $fill = New-Object System.Drawing.SolidBrush($tile)
    $g.FillPath($fill, $path)
    $fill.Dispose()

    # Only where it will not muddy the shape. Below about 24px a 1px border is a
    # large fraction of the tile and reads as a grey blur rather than an edge.
    if ($size -ge 24) {
        $pen = New-Object System.Drawing.Pen($edge, [single]([Math]::Max(1.0, $size / 64.0)))
        $g.DrawPath($pen, $path)
        $pen.Dispose()
    }
    $path.Dispose()
    return @{ Inset = $inset; Side = $side }
}

# The leaning "H".
#
# Built at a nominal em size and then scaled by its own measured bounds, so the
# glyph fills the same fraction of the tile at every size and is centred on what
# was actually drawn rather than on the font's metrics -- which include ascent
# and descent this letter does not use, and would sit it visibly high.
function Add-LeaningGlyph {
    param([System.Drawing.Graphics]$g, [string]$text, [single]$inset, [single]$side)

    $family = New-Object System.Drawing.FontFamily('Segoe UI')
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $format = New-Object System.Drawing.StringFormat
    $path.AddString($text, $family, [int][System.Drawing.FontStyle]::Bold, 400.0,
        (New-Object System.Drawing.PointF(0, 0)), $format)

    # Shear about the origin, then fit. Doing it in this order means the lean is
    # part of what gets measured, so a leaning glyph cannot overflow the box a
    # straight one would have fitted.
    $shear = New-Object System.Drawing.Drawing2D.Matrix(1, 0, -$lean, 1, 0, 0)
    $path.Transform($shear)
    $shear.Dispose()

    $bounds = $path.GetBounds()
    # Matched to the "W" this replaces: a little over half the tile's height.
    $maxWidth = [single]($side * 0.70)
    $maxHeight = [single]($side * 0.58)
    $scale = [single]([Math]::Min($maxWidth / $bounds.Width, $maxHeight / $bounds.Height))

    $fit = New-Object System.Drawing.Drawing2D.Matrix
    $fit.Scale($scale, $scale)
    $path.Transform($fit)
    $fit.Dispose()

    $bounds = $path.GetBounds()
    $move = New-Object System.Drawing.Drawing2D.Matrix
    $move.Translate(
        [single]($inset + ($side - $bounds.Width) / 2 - $bounds.X),
        [single]($inset + ($side - $bounds.Height) / 2 - $bounds.Y))
    $path.Transform($move)
    $move.Dispose()

    $brush = New-Object System.Drawing.SolidBrush($ink)
    $g.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()
    $format.Dispose()
    $family.Dispose()
}

# The largest font whose text still fits, measured rather than computed: the
# glyphs' advance widths are not proportional to the point size in a way worth
# predicting, and at 16px one pixel too wide is the difference between legible
# and clipped.
function Get-FittedFont {
    param([System.Drawing.Graphics]$g, [string]$text, [single]$maxWidth, [single]$maxHeight)
    $family = New-Object System.Drawing.FontFamily('Segoe UI')
    $best = $null
    for ($points = 4.0; $points -le 900.0; $points += 0.5) {
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

function Add-HintedText {
    param([System.Drawing.Graphics]$g, [string]$text, [single]$inset, [single]$side)

    $font = Get-FittedFont -g $g -text $text -maxWidth ([single]($side * 0.88)) -maxHeight ([single]($side * 0.74))

    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    # **NoWrap, or a font one pixel too wide silently becomes two lines.** The
    # measured fit above should prevent it, but `MeasureString` and `DrawString`
    # do not always agree to the pixel, and the failure is not subtle: ".MD"
    # rendered as ".M" over "D", which looked deliberate at 256px and like noise
    # at 16. Clipping a glyph is the better failure of the two, and this makes it
    # the one that can happen.
    $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap

    $brush = New-Object System.Drawing.SolidBrush($ink)
    $box = New-Object System.Drawing.RectangleF($inset, $inset, $side, $side)
    $g.DrawString($text, $font, $brush, $box, $format)

    $brush.Dispose()
    $format.Dispose()
    $font.Dispose()
}

function New-IconFrame {
    param([int]$size, [string]$text, [string]$style)

    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $tileBox = New-Tile -g $g -size $size
    if ($style -eq 'lean') {
        Add-LeaningGlyph -g $g -text $text -inset $tileBox.Inset -side $tileBox.Side
    }
    else {
        Add-HintedText -g $g -text $text -inset $tileBox.Inset -side $tileBox.Side
    }
    $g.Dispose()

    $stream = New-Object System.IO.MemoryStream
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    # **The leading comma is load-bearing.** PowerShell unrolls a returned array
    # into the pipeline, so a bare `return $bytes` emits several hundred
    # individual bytes and the caller collects an `Object[]` of them. That wrote
    # a structurally valid 142-byte icon -- correct header, every offset in
    # range, no image data -- and reported success.
    return , $stream.ToArray()
}

# ICONDIR, then one 16-byte ICONDIRENTRY per frame, then the frames. A width or
# height of 256 is stored as 0: the field is one byte, so 256 does not fit and
# the format spells it that way.
function Write-Ico {
    param([string]$path, [string]$text, [string]$style)

    $frames = @()
    foreach ($size in $sizes) { $frames += , ([byte[]](New-IconFrame -size $size -text $text -style $style)) }

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

    $full = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $path))
    [System.IO.File]::WriteAllBytes($full, $out.ToArray())
    $writer.Dispose()
    $out.Dispose()
    Write-Output ("  {0}  ({1} frames, {2:N0} bytes)" -f $full, $sizes.Count, (Get-Item $full).Length)
}

function Write-Png {
    param([string]$path, [string]$text, [string]$style)
    $full = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $path))
    [System.IO.File]::WriteAllBytes($full, [byte[]](New-IconFrame -size 1024 -text $text -style $style))
    Write-Output ("  {0}  (1024x1024, {1:N0} bytes)" -f $full, (Get-Item $full).Length)
}

Write-Output 'application icon (a leaning H):'
# Wails generates assets from the PNG and fails the build if it is missing; it
# leaves an existing .ico alone, which is why both are written here. `icon.ico`
# is what the executable and the installer use, `appicon.ico` is the name Wails
# looks for elsewhere -- kept identical rather than allowed to drift.
Write-Png -path '..\build\appicon.png' -text 'H' -style 'lean'
Write-Ico -path '..\build\windows\icon.ico' -text 'H' -style 'lean'
Write-Ico -path '..\build\windows\appicon.ico' -text 'H' -style 'lean'

Write-Output 'document icon (.MD):'
Write-Png -path '..\build\mdicon.png' -text '.MD' -style 'text'
Write-Ico -path '..\build\windows\mdicon.ico' -text '.MD' -style 'text'

# No PNG for this one: `.txt` is registered by project.nsi directly rather than
# through wails.json's fileAssociations, so Wails never asks for a source image.
# Taking .txt is a bigger imposition than taking .md -- it is Notepad's -- which
# is why it is a separate opt-in with its own icon rather than being folded in
# with the markdown extensions.
Write-Output 'document icon (.TXT):'
Write-Ico -path '..\build\windows\txticon.ico' -text '.TXT' -style 'text'
