# Testing

Manual test checklist and recorded measurement baselines for Hashpad, per checkpoint. Run `scripts/measure.ps1` against a fresh `wails build` output to reproduce the budget figures below.

## Checkpoint A baseline

Recorded 2026-07-29 on a VMware VM (virtual GPU, 8 GB RAM) via `pwsh -File scripts/measure.ps1` against `build/bin/hashpad.exe`.

```
Hashpad budget report
---------------------
Binary size      : 11 MB  (budget 25 MB) [PASS]
Cold start (avg) : 2532.3 ms  (budget 500 ms, best 53.5 ms, n=5) [OVER]

Memory, one empty document (budget 100 MB with five tabs):
  hashpad.exe working set    : 25.4 MB
  whole tree working set     : 705.7 MB  (13 processes)
  whole tree private commit  : 404.5 MB

Note: this is one empty document, not the five-tab budget case.
Five-tab measurement lands with tabs at Checkpoint C.

Virtual GPU detected (VMware SVGA 3D).
Startup figures will be pessimistic versus physical hardware.
```

**Reading this baseline:**

- Binary size and `hashpad.exe`'s own working set are clean measurements. Both pass their budgets by a wide margin.
- Cold start is measured on a VM with a virtual GPU (VMware SVGA 3D), which the script detects and flags. The 2532.3 ms average is expected to be materially worse than the "mid-range machine" the 500 ms budget targets; the 53.5 ms best-of-five reflects `WaitForInputIdle` returning as soon as the process has a message loop pumping, which can precede the window actually painting. Neither figure should be taken as a verdict on real hardware without re-measuring there.
- The two whole-tree figures (705.7 MB working set, 404.5 MB private commit) were inflated on this run by processes outside Hashpad's control: `Get-Process -Name 'msedgewebview2'` matches every WebView2 host process on the machine, not just Hashpad's children. On this VM, Windows' own Widgets Board (`WidgetBoard.exe`, part of the OS shell) was running and contributed roughly 5 of the 13 counted processes and an estimated ~390 MB working set / ~235 MB private memory that has nothing to do with Hashpad. The script matches by process name only (no parent-process check), so this contamination will recur on any machine with another WebView2-based app or the Widgets Board running, and the size of the effect will vary machine to machine. Net Hashpad-attributable tree usage this run was closer to ~300 MB working set / ~170 MB private commit, still over the 100 MB budget, but the exact whole-tree numbers above should not be read as Hashpad-only without accounting for this.
- Which of the three memory figures the 100 MB budget refers to is still an open question, per `scripts/measure.ps1`'s own doc comment — this baseline reports all three rather than picking one.

The app closed cleanly on every run via `CloseMainWindow()`; the `Kill()` fallback did not fire (verified separately: `CloseMainWindow()` returned `True` and `WaitForExit(5000)` succeeded in ~82 ms on the frameless window).
