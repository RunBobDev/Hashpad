<#
.SYNOPSIS
  Measures Hashpad against the SPEC section 2.3 budgets.

.DESCRIPTION
  Budgets: binary under 25 MB, cold start under 500 ms, under 100 MB RAM.

  Memory is reported three ways because WebView2 runs a multi-process browser and
  the honest answer depends on what is being counted. Deciding which figure the
  budget refers to is a conversation to have with real numbers in hand rather
  than an assumption to bake in.

  The tree is scoped by walking Win32_Process parent links transitively from the
  PID this script launched, not by matching on process name -- name matching also
  catches unrelated WebView2 hosts on the machine (e.g. Windows' own Widgets Board),
  which has no relationship to Hashpad's memory footprint.

  Cold start here is process-start to main-window-visible, which includes
  WebView2 initialisation. It is measured on whatever machine runs it — on a VM
  with a virtual GPU expect figures materially worse than the "mid-range machine"
  the budget refers to. WaitForInputIdle is a known-weak proxy for that (see the
  note printed with the cold-start figures), so the distribution is reported in
  full and the verdict is provisional.
#>
[CmdletBinding()]
param(
    [int]$Runs = 5,
    [string]$ExePath
)

$ErrorActionPreference = 'Stop'

if (-not $ExePath) {
    # $PSScriptRoot comes back empty under some nested invocations, which turned
    # a missing path into a confusing "Not found: \..\build\bin" error. Fall back
    # to the working directory so the script still resolves when run from the
    # repo root, which is how the Taskfile target will call it.
    $root = if ($PSScriptRoot) { Join-Path $PSScriptRoot '..' } else { Get-Location }
    $ExePath = Join-Path $root 'build\bin\hashpad.exe'
}

if (-not (Test-Path $ExePath)) {
    throw "Not found: $ExePath. Run 'wails build' first, or pass -ExePath explicitly."
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

    # WaitForInputIdle returns once the process has a message loop pumping, which
    # can happen well before WebView2 has actually rendered anything (or, less
    # often, may not return until its own timeout). It's a weak proxy for "the
    # window is usable" -- kept because it needs no changes to the app, but read
    # the distribution below rather than trusting any single number from it.
    [void]$proc.WaitForInputIdle(20000)
    $sw.Stop()
    $startupTimes += $sw.Elapsed.TotalMilliseconds

    if ($i -eq $Runs) {
        # Let the last run settle, then sample memory across the whole tree.
        Start-Sleep -Milliseconds 2500

        $rootId = [uint32]$proc.Id

        # Matching by process name (the previous approach) also catches unrelated
        # WebView2 hosts on the machine -- e.g. Windows' own Widgets Board, which
        # runs msedgewebview2.exe too. The only way to scope this to processes that
        # are actually ours is to walk process ancestry from the PID we launched.
        #
        # A single-level parent check (direct children of hashpad.exe) is not
        # enough either: hashpad.exe starts one WebView2 browser process, and that
        # browser process is what spawns the renderer, GPU, and utility processes --
        # so most of the tree we care about are grandchildren or deeper. We snapshot
        # the whole machine's parent/child links once and walk them breadth-first
        # from our root PID to any depth, which finds all of them and can never
        # match a same-named process from a different lineage.
        $processTable = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
        $childrenOf = @{}
        foreach ($p in $processTable) {
            $parentId = [uint32]$p.ParentProcessId
            if (-not $childrenOf.ContainsKey($parentId)) {
                $childrenOf[$parentId] = [System.Collections.Generic.List[uint32]]::new()
            }
            $childrenOf[$parentId].Add([uint32]$p.ProcessId)
        }

        $descendantIds = [System.Collections.Generic.List[uint32]]::new()
        $queue = [System.Collections.Generic.Queue[uint32]]::new()
        $queue.Enqueue($rootId)
        while ($queue.Count -gt 0) {
            $current = $queue.Dequeue()
            if ($childrenOf.ContainsKey($current)) {
                foreach ($childId in $childrenOf[$current]) {
                    $descendantIds.Add($childId)
                    $queue.Enqueue($childId)
                }
            }
        }

        $treeIds = @($rootId) + @($descendantIds)
        $tree = @(Get-Process -Id $treeIds -ErrorAction SilentlyContinue)

        $ownWorkingSet = ($tree | Where-Object { $_.Id -eq $rootId } |
            Measure-Object -Property WorkingSet64 -Sum).Sum
        $treeWorkingSet = ($tree | Measure-Object -Property WorkingSet64 -Sum).Sum
        $treeCommit = ($tree | Measure-Object -Property PrivateMemorySize64 -Sum).Sum
        $descendantCount = $descendantIds.Count

        # Auditable trail: what did "the tree" actually resolve to, so a future
        # reader (or a future checkpoint's diff) can tell what was measured.
        $treeByName = @($tree | Group-Object -Property ProcessName | ForEach-Object { "{0} x{1}" -f $_.Name, $_.Count })
        $treeByNameSummary = if ($treeByName.Count -gt 0) { $treeByName -join ', ' } else { '(none)' }
    }

    $proc.CloseMainWindow() | Out-Null
    if (-not $proc.WaitForExit(5000)) { $proc.Kill() }
    Start-Sleep -Milliseconds 750
}

$avg = [math]::Round(($startupTimes | Measure-Object -Average).Average, 1)
$min = [math]::Round(($startupTimes | Measure-Object -Minimum).Minimum, 1)
$max = [math]::Round(($startupTimes | Measure-Object -Maximum).Maximum, 1)

# Windows PowerShell 5.1's Measure-Object has no -Median switch (that landed in
# pwsh 7+), and the mean is exactly what's unreliable here: WaitForInputIdle
# returning early on some runs and not on others produces a skewed distribution
# where the average describes neither the typical case nor the worst case.
# Median is the honest "what does a typical run look like" number.
function Get-Median([double[]]$Values) {
    $sorted = $Values | Sort-Object
    $mid = [math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2 -eq 1) { return $sorted[$mid] }
    return ($sorted[$mid - 1] + $sorted[$mid]) / 2
}
$median = [math]::Round((Get-Median $startupTimes), 1)
$perRun = ($startupTimes | ForEach-Object { [math]::Round($_, 1) }) -join ', '

# Verdict is based on the median, not the mean, since the mean is skewed by
# whichever runs WaitForInputIdle happened to return early (or late) on.
$startVerdict = if ($median -lt 500) { 'PASS' } else { 'OVER' }
Write-Host ("Cold start        : median {0} ms  (avg {1}, min {2}, max {3} ms, n={4}) [{5}, provisional]" -f $median, $avg, $min, $max, $Runs, $startVerdict)
Write-Host ("  per-run (ms)    : {0}" -f $perRun)
Write-Host ''
Write-Host 'Note: WaitForInputIdle measures "message loop pumping", not first paint --' -ForegroundColor DarkGray
Write-Host 'it can return well before WebView2 has rendered anything, or hit its own' -ForegroundColor DarkGray
Write-Host 'timeout. A trustworthy first-paint number needs the frontend to report a' -ForegroundColor DarkGray
Write-Host 'performance.now() mark back to Go over the Wails runtime bridge -- a' -ForegroundColor DarkGray
Write-Host 'follow-up, not implemented by this script. Treat the verdict above as provisional.' -ForegroundColor DarkGray

Write-Host ''
Write-Host 'Memory, one empty document (budget 100 MB with five tabs):'
Write-Host ("  hashpad.exe working set    : {0} MB" -f [math]::Round($ownWorkingSet / 1MB, 1))
Write-Host ("  whole tree working set     : {0} MB  ({1} descendant processes, {2} total incl. hashpad.exe)" -f [math]::Round($treeWorkingSet / 1MB, 1), $descendantCount, $tree.Count)
Write-Host ("  whole tree private commit  : {0} MB" -f [math]::Round($treeCommit / 1MB, 1))
Write-Host ("  process breakdown          : {0}" -f $treeByNameSummary)
Write-Host ("  resolved PIDs              : {0}" -f ($treeIds -join ', '))
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
