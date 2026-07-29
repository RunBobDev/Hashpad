<#
.SYNOPSIS
  Measures Hashpad against the SPEC section 2.3 budgets.

.DESCRIPTION
  Budgets: binary under 25 MB, cold start under 500 ms, under 100 MB RAM.

  Memory is reported three ways because WebView2 runs a multi-process browser and
  the honest answer depends on what is being counted. Deciding which figure the
  budget refers to is a conversation to have with real numbers in hand rather
  than an assumption to bake in.

  Cold start here is process-start to main-window-visible, which includes
  WebView2 initialisation. It is measured on whatever machine runs it — on a VM
  with a virtual GPU expect figures materially worse than the "mid-range machine"
  the budget refers to.
#>
[CmdletBinding()]
param(
    [int]$Runs = 5,
    [string]$ExePath = "$PSScriptRoot\..\build\bin\hashpad.exe"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ExePath)) {
    throw "Not found: $ExePath. Run 'wails build' first."
}

$exe = Get-Item $ExePath
$sizeMB = [math]::Round($exe.Length / 1MB, 2)

Write-Host ''
Write-Host 'Hashpad budget report' -ForegroundColor Cyan
Write-Host '---------------------'
$sizeVerdict = if ($sizeMB -lt 25) { 'PASS' } else { 'OVER' }
Write-Host ("Binary size      : {0} MB  (budget 25 MB) [{1}]" -f $sizeMB, $sizeVerdict)

$startupTimes = @()
foreach ($i in 1..$Runs) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $exe.FullName -PassThru

    # WaitForInputIdle returns once the process has a message loop pumping,
    # which is the closest available proxy for "the window is usable".
    [void]$proc.WaitForInputIdle(20000)
    $sw.Stop()
    $startupTimes += $sw.Elapsed.TotalMilliseconds

    if ($i -eq $Runs) {
        # Let the last run settle, then sample memory across the whole tree.
        Start-Sleep -Milliseconds 2500

        $tree = @(Get-Process -Name 'hashpad' -ErrorAction SilentlyContinue)
        $tree += @(Get-Process -Name 'msedgewebview2' -ErrorAction SilentlyContinue)

        $ownWorkingSet = ($tree | Where-Object { $_.Name -eq 'hashpad' } |
            Measure-Object -Property WorkingSet64 -Sum).Sum
        $treeWorkingSet = ($tree | Measure-Object -Property WorkingSet64 -Sum).Sum
        $treeCommit = ($tree | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
        $procCount = $tree.Count
    }

    $proc.CloseMainWindow() | Out-Null
    if (-not $proc.WaitForExit(5000)) { $proc.Kill() }
    Start-Sleep -Milliseconds 750
}

$avg = [math]::Round(($startupTimes | Measure-Object -Average).Average, 1)
$min = [math]::Round(($startupTimes | Measure-Object -Minimum).Minimum, 1)
$startVerdict = if ($avg -lt 500) { 'PASS' } else { 'OVER' }
Write-Host ("Cold start (avg) : {0} ms  (budget 500 ms, best {1} ms, n={2}) [{3}]" -f $avg, $min, $Runs, $startVerdict)

Write-Host ''
Write-Host 'Memory, one empty document (budget 100 MB with five tabs):'
Write-Host ("  hashpad.exe working set    : {0} MB" -f [math]::Round($ownWorkingSet / 1MB, 1))
Write-Host ("  whole tree working set     : {0} MB  ({1} processes)" -f [math]::Round($treeWorkingSet / 1MB, 1), $procCount)
Write-Host ("  whole tree private commit  : {0} MB" -f [math]::Round($treeCommit / 1MB, 1))
Write-Host ''
Write-Host 'Note: this is one empty document, not the five-tab budget case.' -ForegroundColor DarkGray
Write-Host 'Five-tab measurement lands with tabs at Checkpoint C.' -ForegroundColor DarkGray
Write-Host ''

$gpu = (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name
if ($gpu -match 'VMware|VirtualBox|Hyper-V|Basic Display') {
    Write-Host "Virtual GPU detected ($gpu)." -ForegroundColor Yellow
    Write-Host 'Startup figures will be pessimistic versus physical hardware.' -ForegroundColor Yellow
    Write-Host ''
}
