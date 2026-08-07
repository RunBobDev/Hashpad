# Testing

Manual test checklist and recorded measurement baselines for Hashpad, per checkpoint. Run `scripts/measure.ps1` against a fresh `wails build` output to reproduce the budget figures below.

## Checkpoint A baseline

Recorded 2026-07-29 on a VMware VM (virtual GPU, 8 GB RAM) via `pwsh -File scripts/measure.ps1` against `build/bin/hashpad.exe`.

**Correction:** the figures originally recorded here (705.7 MB / 404.5 MB whole-tree memory over 13 processes, 2532.3 ms average cold start) were wrong and have been replaced below. The memory figures counted every `msedgewebview2.exe` on the machine by name, which on this VM also swept in ~6 processes belonging to Windows' own Widgets Board shell feature (~390 MB of unrelated working set). The cold-start figure was an unweighted mean over a run where `WaitForInputIdle` returned wildly inconsistently, which a single average hid rather than exposed. `scripts/measure.ps1` was fixed to scope memory to Hashpad's actual descendant process tree and to report the cold-start distribution with a median-based verdict; see that script's header comment for the mechanism. **Do not compare future checkpoints against the old numbers named in this correction (705.7 MB / 404.5 MB, 2532.3 ms) — they were never real.**

```
Hashpad budget report
---------------------
Binary size      : 11 MB  (budget 25 MB) [PASS]
Cold start        : median 59.6 ms  (avg 89.6, min 50.9, max 211.4 ms, n=5) [PASS, provisional]
  per-run (ms)    : 211.4, 74, 59.6, 52.1, 50.9

Note: WaitForInputIdle measures "message loop pumping", not first paint --
it can return well before WebView2 has rendered anything, or hit its own
timeout. A trustworthy first-paint number needs the frontend to report a
performance.now() mark back to Go over the Wails runtime bridge -- a
follow-up, not implemented by this script. Treat the verdict above as provisional.

Memory, one empty document (budget 100 MB with five tabs):
  hashpad.exe working set    : 25.4 MB
  whole tree working set     : 310.9 MB  (6 descendant processes, 7 total incl. hashpad.exe)
  whole tree private commit  : 169.7 MB
  process breakdown          : hashpad x1, msedgewebview2 x6
  resolved PIDs              : 6772, 4116, 9596, 12700, 8972, 5524, 8768

Note: this is one empty document, not the five-tab budget case.
Five-tab measurement lands with tabs at Checkpoint C.

Virtual GPU detected (VMware SVGA 3D).
Startup figures will be pessimistic versus physical hardware.
```

**Reading this baseline:**

- Binary size and `hashpad.exe`'s own working set are clean measurements, unaffected by either defect. Both pass their budgets by a wide margin.
- Memory is now scoped to the actual process tree launched by this script: starting from the launched `hashpad.exe` PID, the script walks `Win32_Process` parent/child links transitively (any depth, not just direct children) to find the WebView2 browser, renderer, GPU, and utility processes that are really Hashpad's. That resolved to 6 descendant `msedgewebview2.exe` processes (7 total including `hashpad.exe`), listed above by PID for auditability. Net Hashpad-attributable usage is 310.9 MB working set / 169.7 MB private commit — materially lower than the old contaminated 705.7 MB / 404.5 MB, and close to the ~300 MB / ~170 MB estimate manually derived from the earlier run, which is a good sanity check that the fix is measuring the right thing. Both figures remain over the 100 MB budget. Which of the three memory figures the budget refers to is still an open question, per `scripts/measure.ps1`'s own doc comment — this baseline reports all three rather than picking one.
- Cold start is now reported as a full distribution rather than a single mean, because the mean hides the exact thing that matters here: `WaitForInputIdle` is a weak proxy for "window painted" (it returns once the process has a message loop pumping, which can precede first paint, or in rarer cases can hit its own timeout), and its per-run noise is the signal that it's unreliable, not something to average away. This run's median is 59.6 ms against per-run timings of 211.4, 74, 59.6, 52.1, 50.9 ms — a real spread, though nowhere near as extreme as the 47x (53.5 ms to 2532.3 ms average) seen on the run that produced the old, discarded numbers. The PASS verdict above is based on the median and is explicitly labeled provisional: a trustworthy first-paint number requires the frontend to report a `performance.now()` mark back to Go over the Wails runtime bridge, which is a follow-up and not implemented here. Cold start is measured on a VM with a virtual GPU (VMware SVGA 3D), which the script detects and flags; figures here should not be taken as a verdict on real hardware without re-measuring there.

The app closed cleanly on every run via `CloseMainWindow()`; the `Kill()` fallback did not fire (verified separately in the prior run: `CloseMainWindow()` returned `True` and `WaitForExit(5000)` succeeded in ~82 ms on the frameless window).

## Checkpoint B manual checks

Automation cannot drive real file dialogs, real files on disk, or a real OS
close request, so the following need a human running `build/bin/hashpad.exe`.

- [ ] Open a CRLF file, make no edits, save it, and confirm the bytes on disk are unchanged (byte-identical round trip).
- [ ] Open a UTF-8-BOM file, make an edit, save, and confirm the BOM is still present in the saved file.
- [ ] Open a UTF-16LE file and confirm its text is readable (not garbled) in the editor.
- [ ] Press Ctrl+S on an untitled (never-saved) document and confirm it opens the Save As dialog rather than silently failing.
- [ ] Start a Save As, then cancel the dialog, and confirm the document is still marked dirty and still unsaved.
- [ ] With unsaved changes, close the window and confirm the Save / Don't Save / Cancel prompt appears with all three buttons, and that Cancel aborts the close (the window stays open).

## Checkpoint C manual checks

Automation cannot drive a real OS-level drag gesture, real horizontal scroll physics, or real hover/pointer timing, so the following need a human running `build/bin/hashpad.exe`.

- [ ] Drag a tab past several others and confirm the order sticks (survives switching away and back, and survives closing an unrelated tab).
- [ ] Open enough tabs to trigger horizontal scrolling in the strip.
- [ ] Middle-click a tab and confirm it closes.
- [ ] Hover a tab and confirm the dirty dot becomes an × (and back, on mouse-out).
- [ ] Hover a saved tab and confirm the tooltip shows the full path.
- [ ] Ctrl+W on the last remaining tab leaves a fresh untitled document, not a window with zero tabs.
- [ ] Ctrl+Shift+T after closing a saved tab reopens it.
- [ ] Ctrl+Shift+T after closing an untitled tab does nothing (there is no path to reopen).

**Known gap:** drag-to-reorder has no keyboard equivalent. Every other tab-strip action (activate, close, cycle, jump to position) has a keyboard path; reordering does not. This is a real accessibility gap, not an oversight to wave away -- SPEC §6.2 only asks for drag, but a keyboard-only user cannot reorder tabs at all in this checkpoint.

## Checkpoint D manual checks

Automation cannot drive a real Windows theme change, a real cold-start paint, or (per Task 5's own investigation, recorded in `.superpowers/sdd/task-5-report.md`) fully exercise CodeMirror's async grammar-loading path under jsdom, so the following need a human running `build/bin/hashpad.exe`.

- [ ] With Hashpad running, switch the Windows theme (Settings > Personalization > Colors > Choose your mode) and confirm the app's own theme follows within about a second -- Hashpad re-reads the system theme on window focus (SPEC §6.12's deviation, recorded in the plan's self-review: this is focus-triggered, not a live OS event subscription, so switching the theme while Hashpad is the focused window and waiting won't update it until you focus away and back).
- [ ] Set the Windows theme to Dark, fully close Hashpad, then relaunch it, and confirm there is no flash of a light-themed window before the dark theme applies (a flash means the theme is being applied after first paint rather than before it).
- [ ] Open the View menu and confirm all three entries are present and each one applies immediately: Theme: Follow System, Theme: Light, Theme: Dark.
- [ ] Set `appearance.accentColor` in `settings.json` (see `internal/app/settings.go`'s `SettingsPath` for its location) to a saturated, easily-recognized colour, restart Hashpad, and confirm the new colour shows up in all four places SPEC §6.12 names: links, text selection, focus rings, and the active tab's indicator.
- [ ] Open or paste a document containing a fenced block with a recognized language, e.g.:
  ```` ```python
  def greet(name):
      return f"hello {name}"
  ``` ````
  and confirm the code inside is coloured (keywords, strings, etc. rendered distinctly from plain text), not shown as one undifferentiated colour. If it briefly renders unhighlighted right after opening, click into the document or type a character -- this task's own investigation found CodeMirror's lazy-grammar-loading path needs some follow-up document activity to redraw the block once the language finishes loading; it is not expected to require repeated edits or a long wait once you interact with the document at all.
- [ ] In that same document, confirm the fence markers (` ``` `) are still visible on their own lines, and that elsewhere in the document `#` (headings), `**` (bold), and `>` (blockquote) markers remain visible as dim-but-readable text rather than disappearing -- source mode (SPEC §6.6) keeps every marker on screen; only their colour changes.

## Checkpoint E manual checks

Automation cannot press a real key on a real keyboard layout, judge whether a
16×16 icon reads at a glance, or drive a real right-click, so the following
need a human running `build/bin/hashpad.exe`.

**Layout.**

- [ ] The formatting row sits **between the tab strip and the editor**, per
      SPEC §6.1 — not below the editor at the bottom of the window. The row
      mounts from an async bootstrap once settings are known, so its position
      depends on being inserted rather than appended; that shipped wrong once
      and every test was silent on it.

**Icons.** Sixteen were hand-drawn and never rendered by the agent that drew
them. Four pairs were flagged as most at risk of looking alike at this size —
check these first:

- [ ] Inline code vs Code block are distinguishable at a glance.
- [ ] Horizontal rule vs Strikethrough are distinguishable at a glance.
- [ ] Bullet list vs Task list are distinguishable at a glance.
- [ ] Numbered list vs Footnote are distinguishable at a glance.
- [ ] Every icon is legible at 100% zoom in **both** light and dark themes.
- [ ] The `···` overflow button sits comfortably beside the icon set. It is a
      text glyph at the UI font size, not a 16px SVG, so it may read as
      optically lighter or smaller than its neighbours.

**Keyboard.** The shifted-punctuation chords are matched through CodeMirror's
base-layout fallback, which the tests exercise with synthetic keycodes. Only a
real keyboard proves the real path.

- [ ] Ctrl+Shift+8 inserts a bullet list; Ctrl+Shift+7 a numbered list;
      Ctrl+Shift+9 a task list.
- [ ] Ctrl+Shift+. inserts a blockquote; Ctrl+Shift+- a horizontal rule;
      Ctrl+` wraps in inline code.
- [ ] Ctrl+Alt+T inserts a 3×3 table. This is the deviation recorded in design
      §4.12, and it is the one chord `@codemirror/view` deliberately refuses to
      resolve through the base layout (its AltGr guard), so a non-US layout is
      where it would fail.
- [ ] Ctrl+Shift+T still reopens a closed tab rather than inserting a table.
- [ ] Ctrl+Shift+I inserts an image reference rather than opening DevTools. (A
      release build strips the inspector; on a `wails build -debug` binary
      expect DevTools to win, and do not treat that as a bug.)
- [ ] Ctrl+B and Ctrl+I inside a fenced code block do nothing at all — no
      asterisks inserted, and no selection jump. The selection-jump half was a
      real bug: the chord used to fall through to CodeMirror's
      `selectParentSyntax`.
- [ ] Tab moves into the toolbar as a **single** stop, then Left/Right/Home/End
      move between buttons. Press Enter on one: the format applies and focus
      stays on that same button rather than returning to the top of the
      document.

**Pinning.**

- [ ] Right-click the toolbar, untick two commands, and confirm they vanish
      from the row and are still listed in the `···` menu.
- [ ] Restart and confirm the layout persisted.
- [ ] Untick every command. The `···` button must remain, and every command
      must still be reachable through it. **Then restart.** The empty list is a
      legitimate choice and must survive: coming back with all ten defaults
      restored is the failure mode, and no automated test crosses the Go↔TS
      boundary to catch it.
- [ ] Right-click near the right-hand end of the row: the menu should appear at
      the button you clicked, not at the row's far left.
- [ ] Open the pin menu with Shift+F10 and choose an item with Enter — focus
      should land back on a toolbar button, not vanish to the page.
- [ ] Set `toolbar.pinned` in `settings.json` (see `internal/app/settings.go`'s
      `SettingsPath` for its location) to a list containing a nonsense id,
      restart, and confirm the app starts with that id ignored rather than
      failing.
- [ ] Set `toolbar.visible` to `false`, restart, and confirm the row is absent
      entirely — not present-but-empty.

**Active state and formatting.**

- [ ] Put the cursor inside bold text: the B button fills. Move out: it clears.
- [ ] Switch tabs between a document whose caret is inside `**bold**` and one
      in plain text — the active buttons must update on the switch, without
      typing anything.
- [ ] Type `==marked==` and confirm the wash renders and the `==` characters
      stay visible but dimmer than the text they wrap.
- [ ] Select two lines, one already a bullet and one not, and press Ctrl+Shift+8 —
      both end up bulleted, rather than the marker alternating.
- [ ] With `- [x] done` selected alongside a plain line, apply Bullet list and
      confirm the checkbox survives.
