# Testing

Manual test checklist and recorded measurement baselines for Hashpad, per checkpoint. Run `scripts/measure.ps1` against a fresh `wails build` output to reproduce the budget figures below.

## What this file is, and what it is not

**This is the list of things a test cannot reach.** It is not the project's test coverage, and a reader who takes the ratio of ticked to unticked boxes as a measure of how well Hashpad has been tested will get the wrong answer in both directions.

What is verified, as of 2026-08-31:

- **1,443 automated tests, all passing** -- 116 in Go (`go test ./...`), 1,327 across 50 files in the frontend suite. They cover the logic: the document model, the file operations, encoding detection and writing, every formatting command, the markdown render pipeline, path containment for images, scroll-sync arithmetic, settings load and migration.
- **Months of daily use by the owner**, which is where the defects actually came from. Fourteen sections below exist *because* of a bug found that way and fixed: shortcuts not working outside the editor, the View menu not showing which toggles were on, F11 greyed out, the preview not sticking between documents, the same file opening twice, four window edges that would not resize, the text column capped when it should not have been, scroll sync stopping short of a document's end, the caret and the wheel disagreeing, the formatting row appearing below the editor, and four separate defects in the installer. Each one left a check behind so it cannot come back unnoticed.

What is **not** verified is everything below that is still unticked: appearance, layout, real keyboard chords, real drag gestures, and what Windows does with the installed program. jsdom has no layout engine, resolves every CSS variable to an empty string, never issues an image request, and has no focus model. A green suite says nothing about whether a colour reads or a window resizes. That gap is the entire reason this file is written down rather than assumed away.

## How to read a box

**A ticked box means a person ran that check against a build and it passed.** It does not mean a test covers it. Every tick carries a date and a source, because a bare tick some months from now is indistinguishable from a hopeful one:

- *owner* -- run and reported by the project owner.
- *measured* -- observed directly from a build artifact or a measurement script, with the reader named where the choice of reader matters.

A box with only part of its claim confirmed stays **unticked**. Half a check is not a check.

## Checkpoint A baseline

Recorded 2026-07-29 on a VMware VM (virtual GPU, 8 GB RAM) via `pwsh -File scripts/measure.ps1` against `build/bin/Hashpad.exe`.

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
  Hashpad.exe working set    : 25.4 MB
  whole tree working set     : 310.9 MB  (6 descendant processes, 7 total incl. Hashpad.exe)
  whole tree private commit  : 169.7 MB
  process breakdown          : hashpad x1, msedgewebview2 x6
  resolved PIDs              : 6772, 4116, 9596, 12700, 8972, 5524, 8768

Note: this is one empty document, not the five-tab budget case.
Five-tab measurement lands with tabs at Checkpoint C.

Virtual GPU detected (VMware SVGA 3D).
Startup figures will be pessimistic versus physical hardware.
```

**Reading this baseline:**

- Binary size and `Hashpad.exe`'s own working set are clean measurements, unaffected by either defect. Both pass their budgets by a wide margin.
- Memory is now scoped to the actual process tree launched by this script: starting from the launched `Hashpad.exe` PID, the script walks `Win32_Process` parent/child links transitively (any depth, not just direct children) to find the WebView2 browser, renderer, GPU, and utility processes that are really Hashpad's. That resolved to 6 descendant `msedgewebview2.exe` processes (7 total including `Hashpad.exe`), listed above by PID for auditability. Net Hashpad-attributable usage is 310.9 MB working set / 169.7 MB private commit — materially lower than the old contaminated 705.7 MB / 404.5 MB, and close to the ~300 MB / ~170 MB estimate manually derived from the earlier run, which is a good sanity check that the fix is measuring the right thing. Both figures remain over the 100 MB budget. Which of the three memory figures the budget refers to is still an open question, per `scripts/measure.ps1`'s own doc comment — this baseline reports all three rather than picking one.
- Cold start is now reported as a full distribution rather than a single mean, because the mean hides the exact thing that matters here: `WaitForInputIdle` is a weak proxy for "window painted" (it returns once the process has a message loop pumping, which can precede first paint, or in rarer cases can hit its own timeout), and its per-run noise is the signal that it's unreliable, not something to average away. This run's median is 59.6 ms against per-run timings of 211.4, 74, 59.6, 52.1, 50.9 ms — a real spread, though nowhere near as extreme as the 47x (53.5 ms to 2532.3 ms average) seen on the run that produced the old, discarded numbers. The PASS verdict above is based on the median and is explicitly labeled provisional: a trustworthy first-paint number requires the frontend to report a `performance.now()` mark back to Go over the Wails runtime bridge, which is a follow-up and not implemented here. Cold start is measured on a VM with a virtual GPU (VMware SVGA 3D), which the script detects and flags; figures here should not be taken as a verdict on real hardware without re-measuring there.

The app closed cleanly on every run via `CloseMainWindow()`; the `Kill()` fallback did not fire (verified separately in the prior run: `CloseMainWindow()` returned `True` and `WaitForExit(5000)` succeeded in ~82 ms on the frameless window).

## Checkpoint B manual checks

Automation cannot drive real file dialogs, real files on disk, or a real OS
close request, so the following need a human running `build/bin/Hashpad.exe`.

- [ ] Open a CRLF file, make no edits, save it, and confirm the bytes on disk are unchanged (byte-identical round trip).
- [ ] Open a UTF-8-BOM file, make an edit, save, and confirm the BOM is still present in the saved file.
- [ ] Open a UTF-16LE file and confirm its text is readable (not garbled) in the editor.
- [ ] Press Ctrl+S on an untitled (never-saved) document and confirm it opens the Save As dialog rather than silently failing.
- [ ] Start a Save As, then cancel the dialog, and confirm the document is still marked dirty and still unsaved.
- [ ] With unsaved changes, close the window and confirm the Save / Don't Save / Cancel prompt appears with all three buttons, and that Cancel aborts the close (the window stays open).

## Checkpoint C manual checks

Automation cannot drive a real OS-level drag gesture, real horizontal scroll physics, or real hover/pointer timing, so the following need a human running `build/bin/Hashpad.exe`.

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

Automation cannot drive a real Windows theme change, a real cold-start paint, or (per Task 5's own investigation, recorded in `.superpowers/sdd/task-5-report.md`) fully exercise CodeMirror's async grammar-loading path under jsdom, so the following need a human running `build/bin/Hashpad.exe`.

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
need a human running `build/bin/Hashpad.exe`.

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
      lands **in the editor**, ready to keep typing — not back at the top of
      the document's tab order. (Every formatting command ends with
      `view.focus()`, so the editor is the intended destination here.)
- [ ] Open the pin/unpin menu with Shift+F10 and choose an item. **No command
      runs on this path**, so nothing pulls focus into the editor — focus must
      come back to a toolbar button. This is the path where the Tab stop is
      genuinely at risk.

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
- [ ] Right-click the row's *empty space* rather than a button, then press
      Escape. Known gap: the menu falls back to anchoring on the row itself,
      which is a div with no tabindex, so focus lands on the page rather than
      on a toolbar button. Confirm it is only mildly annoying rather than
      trapping you.
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

## Checkpoint F measurements

Recorded 2026-08-17 on the same VMware VM as the Checkpoint A baseline, via
`powershell.exe -ExecutionPolicy Bypass -File scripts/measure.ps1` against a
fresh `wails build`, plus `npm run build` for the bundle figures.

```
Binary size      : 12.53 MB  (budget 25 MB) [PASS]
Cold start        : median 53.8 ms  (avg 262.8, min 46.1, max 1103.8 ms, n=5)
  per-run (ms)    : 1103.8, 52.7, 46.1, 53.8, 57.5
Memory, one empty document:
  Hashpad.exe working set    : 26.8 MB
  whole tree working set     : 327 MB  (6 descendant processes, 7 total)
  whole tree private commit  : 173.2 MB
```

| Figure | This checkpoint | Reference | Verdict |
|---|---|---|---|
| Binary | 12.53 MB | 25 MB budget | PASS, half the budget |
| Entry chunk | 578.54 kB (198.66 kB gzip) | 577.51 kB pre-Checkpoint-F | +1.03 kB, +0.18% |
| Preview chunk | 156.81 kB (63.63 kB gzip) | — | separate, lazy |
| Stylesheet | 12.02 kB (2.89 kB gzip) | ~9.47 kB before Task 8 | +2.55 kB, all of it `preview.css` |
| Cold start | median 53.8 ms | 53.9 ms at Checkpoint E | unchanged |

The whole preview feature costs the entry bundle **1.03 kB**. markdown-it,
DOMPurify and the render pipeline are all in `pane-*.js`, which is reached only
through a dynamic `import()` — the lazy split is real and was verified by grep in
Task 6. The stylesheet grew by the whole of `preview.css`, which is expected:
`vite.config.ts` sets `cssCodeSplit: false`, so there is exactly one CSS file and
it is always loaded.

**Two caveats on these numbers, both real:**

- **Cold start's mean is meaningless here and the median is what to read.** One
  run of five came back at 1103.8 ms against four in the 46–58 ms band. That is
  the same `WaitForInputIdle` unreliability the Checkpoint A baseline documents
  at length, not a regression: the median moved 0.1 ms. Cold start remains
  **provisional** until the frontend reports a `performance.now()` mark back to
  Go, and it is measured on a virtual GPU, which the script detects and flags.
- **The memory figure is not trustworthy and no conclusion is drawn from it.**
  Both tree figures remain over the nominal 100 MB budget, as they have since
  Checkpoint A, and which of the three numbers the budget refers to is still
  open. This run resolved 7 processes (1 `Hashpad.exe` + 6 `msedgewebview2.exe`),
  matching Checkpoints A and D — the process-count defect seen elsewhere in this
  checkpoint, where the script reported 1, did **not** reproduce here.
  Deliberately not investigated in this task.

## Checkpoint F — local image serving (Task 4)

Automation covers the traversal rejections; these are the ones it cannot reach.

- [ ] **Symlink escape is accepted, by design.** Put a symlink inside a
      document's folder pointing at an image outside it, reference it from the
      document, and confirm the preview shows it. Containment is decided
      lexically — `filepath.EvalSymlinks` on every request costs a syscall per
      image and fails for paths that do not exist yet. The residual exposure is
      "displays a local image you did not expect": there is no network to send
      it anywhere (SPEC §2.1), and the extension allow-list keeps it to images.
      **If that trade ever stops being acceptable, `internal/app/assets.go` is
      the one place to change.**
- [ ] **A document saved at a drive root** (`C:\notes.md`) still shows its
      images. `C:` alone is drive-relative on Windows and resolves against the
      process working directory; the separator is what makes it absolute.
- [ ] **Save As into a different folder**, then confirm relative images still
      resolve. This is the one path that changes the document's folder without
      changing which document is active.
- [ ] **Two folders, same filename.** Put a *different* `pic.png` in each of two
      folders, open a document from each referencing `pic.png`, and switch tabs
      back and forth several times. Each tab must keep showing its own image.
      jsdom never issues the `<img>` GET, so no automated test in this repo can
      reach this: the whole failure lives in when the webview fetches and what
      it caches. It used to fail both ways — the directory was server-side state
      set by an async IPC call the render did not wait for, and the two URLs were
      byte-identical so the cache could pin the wrong answer for the session.
      The directory now rides in the URL, which is also what makes the two URLs
      differ. **Also confirm the reverse**: a name that exists in only one of the
      two folders shows there and shows a broken image in the other, rather than
      silently showing the other folder's file.
- [ ] **An image with a non-ASCII or spaced filename** (`café.png`,
      `my pic.png`) loads. Percent-encoding is applied exactly once; encoding
      twice makes every such file 404.
- [ ] **An `.svg` referenced as a link rather than an image** does not run
      script. The handler sends `Content-Security-Policy: default-src 'none';
      sandbox` and `X-Content-Type-Options: nosniff` for exactly this — an SVG
      is a document, and `index.html`'s CSP is a `<meta>` tag that does not
      apply to a page the webview navigates to.

## Checkpoint F — scroll sync (Task 7)

Everything here is geometry, and jsdom has no layout engine: every rect it
reports is zero and `documentTop` is zero at any scroll position. The automated
tests state a geometry and check the arithmetic and the wiring on top of it
(`preview/scrollsync.test.ts` for the mapping, the `scroll sync` block of
`preview/pane.test.ts` for the two directions). **That the numbers a real
browser reports are the ones those tests assume is unverified, and only these
checks can settle it.** Use a document with a tall image and a long fenced block
so the rendered height diverges from the source height — a proportional mapping
looks right without one.

- [ ] **Scrolled by content, not by fraction.** Put the caret on a known heading
      near the tall image, scroll the editor so that heading is at the top, and
      confirm the *same* heading is at the top of the preview. Then the reverse.
      A sync that is a constant fraction off is what a wrong coordinate
      conversion looks like, and the pane's own two conversions
      (`preview/pane.ts`'s `syncFromEditor`/`syncFromPreview`) both go through
      the scroller's screen rect, which jsdom reports as zero.
- [ ] **No oscillation at either extreme.** Scroll each pane hard to the top and
      to the bottom and let go. Any judder or creep is the loop guard failing:
      the browser fires `scroll` asynchronously after `scrollTop` is assigned,
      and the flag that suppresses that echo is cleared on the next animation
      frame.
- [ ] **A fenced code block lands right.** Its `data-source-line` sits on the
      inline `<code>`, not the `<pre>`, so its measured top is the top of the
      first line box — a padding below the block. Confirm the drift is not
      visible; if it is, `anchorOffsets` should resolve to the nearest block
      ancestor instead.
- [ ] **`preview.syncScroll: false` in settings.json really stops it**, in both
      directions, with the panes then scrolling independently. There is no UI for
      this until Checkpoint H, so hand-editing the file is the only way in.
- [ ] **Minimise with the preview open, restore, and scroll again.** The loop
      guard is cleared on an animation frame, and Chromium defers frame callbacks
      for a window that is not painting rather than dropping them — that is the
      reasoning, not a measurement against WebView2.

## Checkpoint F — the pane, the divider, and the styling (Tasks 2, 5, 8)

The rest of Checkpoint F. jsdom has no layout engine, never issues an `<img>`
GET, and cannot judge whether a colour reads — so everything below needs a human
running `build/bin/Hashpad.exe`. **Nothing in this section has been ticked by an
agent; every box is genuinely open.**

**Use `docs/fixtures/preview-checks.md`**, which exercises every construct these
checks name — front matter including a malformed line, headings down to `h4`, a
blockquote, a five-row table, a task list, `==highlight==`, a footnote, inline
code, four fenced blocks, a horizontal rule, a local image, a remote one, and
enough filler to scroll. Copy it out of the repo first and drop any image beside
it named `pic.png`; nothing in this repo can ship a binary, so that one reference
is broken until you do.

**The toggle and the divider.**

- [ ] **Ctrl+Shift+P toggles the pane**, and **View > Preview** does the same
      thing. Both are new in this checkpoint; the chord is matched through
      CodeMirror's base-layout fallback like the Checkpoint E chords, so a
      non-US keyboard layout is where it would fail.
- [ ] **Toggle it off and on again on the same tab**: the pane comes back at the
      width you left it, not at the default ratio.
- [ ] **Switch to a tab that has never had the preview open**, and confirm it
      opens in source mode — the mode is per document, the divider ratio is per
      window.
- [ ] **Dragging the divider feels right.** No lag behind the pointer, no jump
      when the drag starts, and it stops rather than inverting when you drag it
      past either end. Drag is a real OS pointer gesture; the tests drive
      synthetic events.
- [ ] **The divider moves with the keyboard too** — focus it with Tab and use
      Left/Right. This is the only keyboard path to a width, so if it is
      unusable the pane is mouse-only.
- [ ] **The position survives a restart.** Drag it well off centre, close
      Hashpad completely, relaunch, and open the preview: it must come back at
      the width you left. `window.previewSplitRatio` crosses the Go↔TS boundary
      and no automated test crosses it.
- [ ] **Drag it to each extreme and restart from there.** The clamp is applied
      on the way in as well as on the way out, so a ratio saved at the limit
      must not come back as a pane you cannot see or cannot get rid of.
- [ ] **Typing feels like it re-renders about 150 ms after you stop**, not on
      every keystroke and not seconds later. Then switch tabs: that one must
      re-render immediately, with no visible pause showing the previous
      document's render.

**Images.** The local-image paths are in the Task 4 section above; these two are
the placeholders, which that section does not cover.

- [ ] **A local image loads** (`![x](pic.png)` beside a saved document) — the
      short version of the Task 4 checks, worth doing first because everything
      there assumes it.
- [ ] **A remote image shows the placeholder with its URL**, not a broken-image
      icon and not a network request. SPEC §2.1 is zero-network; the placeholder
      is the whole feature. Confirm the URL is readable inside the dashed box and
      wraps rather than overflowing the pane — it is set to `break-all` for long
      URLs, which is untested against a real one.
- [ ] **An unsaved document shows "save the document to load local images"**
      rather than a broken image. Then save it and confirm the image appears
      without needing a restart.

**Legibility, both themes, real hardware.** The ratios are asserted as numbers by
`editor/codetheme.test.ts`, so what is left is everything a number does not say.
Do each of these in **light and dark**, switching with View > Theme.

- [ ] **The front-matter card reads as a card**, set apart from the document
      rather than looking like the first paragraph. It is the tightest contrast
      pairing in `styles/preview.css` — `--fg-muted` on `--bg-hover`, 4.73:1
      light and 4.54:1 dark — so it is dim on purpose and the question is
      whether it is dim *and comfortable*, not whether it clears a threshold.
- [ ] **A front-matter line with no colon** (type a bare `notes` line inside the
      `---` fences) spans the full width of the card instead of being squeezed
      into the narrow key column. This is also the shape malformed YAML takes.
- [ ] **The image placeholder is legible and obviously a placeholder.** Dashed
      border, muted text, 5.74:1 in both themes.
- [ ] **The table's banded rows are visible but not stripey.** `--bg-hover` is
      the same tint the header row uses, which is deliberate; confirm the header
      still reads as a header.
- [ ] **The fenced block's tint separates it from the prose** without looking
      like a hole in the page, and its colours match what the editor shows for
      the same code — one `HighlightStyle` feeds both panes.
- [ ] **`h1` and `h2` rules read as section breaks**, and no heading below `h2`
      has one.
- [ ] **The light-theme fence's keywords are comfortable to read.** This is the
      one pairing in the checkpoint that shipped below AA and was caught by
      measurement rather than by looking: `--syn-code-keyword` was 5.05:1 against
      the editor background but **4.43:1** on `--syn-code-bg`, the tint a fence
      actually has. Retuned to 5.71:1. Worth a specific look because it is the
      case a human eye would most plausibly have caught first, and did not.
- [ ] **The footnote block reads as apparatus, not prose.** Dimmer and smaller
      than the body, behind its rule, with the `↩` backrefs visible as links but
      not underlined. It had no styling at all until the Task 8 review noticed
      that a whole rendered construct had been given no styling decision, so this
      is the least-looked-at part of the pane.
- [ ] **A long line inside a fence scrolls the fence, not the pane.** The
      horizontal scrollbar should appear on the code block.
- [ ] **Task list items have no bullet beside the checkbox**, and the checkboxes
      do not respond to a click — the preview renders the document, it does not
      edit it.
- [ ] **`==highlight==` renders as a wash** in the preview, matching what the
      editor shows.
- [ ] **Break the renderer on purpose if you can** and check the error card:
      red rule down its left, the message readable, and it replaces the render
      rather than sitting under a stale one. Its colour changed in Task 8 from
      `--bg-danger` to `--syn-code-invalid` precisely because `--bg-danger`
      measured **3.07:1** as text on the dark editor background; if the card
      still looks washed out in dark mode, that swap did not take.

**Known and accepted.**

- [ ] **A fenced code block may render unhighlighted for one frame**, then
      recolour. CodeMirror loads grammars lazily and the preview renders from the
      same parsers, so a fence whose language has not loaded yet renders as plain
      escaped code and is coloured on the next render. Confirm it is a flash and
      not a stuck state: the block must end up coloured without further edits.
      **This is acceptable, not a bug to file** — the alternative is bundling
      every grammar eagerly, which §6.4 of the design document rules out.
- [ ] **The symlink limitation from Task 4 is understood**, not just observed:
      containment is decided lexically, so a symlink inside a document's folder
      pointing outside it will be served. See the Task 4 section for the full
      reasoning and the one file to change if that trade stops being acceptable.

## Checkpoint G.2 — the status bar

The automated tests cover what the row *says* (`ui/statusbar.test.ts`), the
counting rules behind it (`statusOf` in `state/document.test.ts`), the two
publish seams (`editor/extensions.test.ts`, `files/documentops.test.ts`) and the
View toggle (`main.test.ts`). None of them can see the row, because jsdom has no
layout engine and resolves `var(--…)` to the empty string — so its height, its
contrast and whether it clips gracefully are only checkable here.

- [ ] **It is 24px and it is at the bottom**, below the editor *and* below the
      preview when the split is open — one full-width row, not one per pane.
      `--h-statusbar` is 24px and `--size-ui` is 14px, which is tight; if the
      text looks cramped or is clipped vertically, the row needs its own size
      token rather than a taller bar (SPEC §6.1 fixes the height).
- [ ] **The text reads in both themes.** `--fg-secondary` on `--bg-app`, which
      is a pairing no existing row uses — every other use of that token is on
      `--bg-editor` or `--bg-elevated`. Check light and dark.
- [ ] **A narrow window clips rather than wraps.** Drag the window as narrow as
      it goes. The row must lose its right-hand segments off the edge; if it
      wraps to a second line it will push the editor up, and `white-space:
      nowrap` plus `overflow: hidden` is what is supposed to prevent that.
- [ ] **Ln/Col tracks the caret with no lag**, including held arrow keys and
      click-to-place. This is the one number that updates on every cursor move,
      and `countWords` runs on the same path — measured at 2.05 ms on a
      5,000-line document, which should be invisible. Try it on something long;
      if typing feels heavier with the bar on than off, the count needs the
      150 ms debounce that `state/document.ts`'s `countWords` comment names.
- [ ] **Select some text and the counts change subject**, with " selected" on
      both. Deselect and they go back to the whole document.
- [ ] **Encoding and line ending match the file.** Open a CRLF file and a UTF-8
      BOM file and confirm the row names them — this is the first UI anywhere
      that surfaces Checkpoint B's detection, so it is also the first chance to
      notice the detector being wrong.
- [ ] **The view-mode segment follows Ctrl+Shift+P**, Source ↔ Split.
- [ ] **View > Status Bar removes the row and the editor grows into the space**,
      and the choice survives a restart. The row is unmounted, not hidden, so a
      leftover 24px gap means the flex row is still reserving it.
- [ ] **Ctrl+scroll does not scale it.** The status bar is chrome, and SPEC §6.6
      says zoom never touches chrome — the same check as G.1's, now with one
      more row to watch.

## Checkpoint G.2 — shortcuts without editor focus

Reported in testing: "when I open Hashpad and press Ctrl+Shift+P nothing
happens -- the only time I can use macros is when I press inside the editor".
Every shortcut except zoom is declared in the editor's keymap, which CodeMirror
installs on `view.contentDOM`, so a key pressed anywhere else never reached it.
`ui/shortcuts.ts` forwards those through CodeMirror's own `runScopeHandlers`;
bootstrap now also focuses the editor so the first keystroke lands.

jsdom can dispatch keys but has no real focus model and no browser defaults, so
what it cannot check is whether WebView2 agrees.

- [ ] **Type immediately after launch, without clicking.** The caret should
      already be in the document.
- [ ] **Ctrl+Shift+P straight after launch**, again without clicking anywhere.
- [ ] **Click the preview pane, then use shortcuts.** Ctrl+S, Ctrl+B, Ctrl+Tab.
      Then the same with focus on the divider and on a tab.
- [ ] **Ctrl+O does not open Chromium's file picker as well as ours.** The
      forwarder calls `preventDefault` itself, because outside the editor there
      is nothing else doing it; if both dialogs appear, that call is missing.
- [ ] **Enter on a focused menu-bar button does not also insert a newline**, and
      Left/Right on the preview divider moves only the divider. Unmodified keys
      are deliberately not forwarded, and this is what that protects.
- [ ] **Shift+Enter with focus outside the editor inserts nothing.** Shift alone
      is not treated as a chord; `defaultKeymap` binds Shift+Enter, so if it were
      this would put a newline in the document from anywhere in the app.
- [ ] **Ctrl+S while the Save / Don't Save prompt is open does nothing.** The
      forwarder stands aside for an open `<dialog>`, or a save would start behind
      the prompt that is asking about it.

## Checkpoint G.2b — the encoding and line-ending menus

SPEC §6.11's clickable segments. The file model changed to make them possible:
`Document` now carries `savedEncoding`/`savedLineEnding` beside `savedDoc`, so
`isDirty` sees a metadata change and a switched line ending is something Ctrl+S
can actually write. jsdom can click the buttons but cannot check what lands on
disk, which is the whole point of the feature.

- [ ] **Switch a CRLF file to LF, save, and check the bytes.** The tab must show
      a dirty dot the moment the menu closes, and the saved file must actually
      use LF. This is the end-to-end claim; everything else here is detail.
- [ ] **Switch the encoding to UTF-8 BOM and save.** The file should gain a BOM.
      Then reopen it and confirm the segment still says UTF-8 BOM -- that is the
      detector and the writer agreeing, which no frontend test can check.
- [ ] **UTF-16 LE round trip**, the same way. Non-ASCII text is worth using here.

`docs/fixtures/encoding-*.md` are the same document saved four ways, produced by
exactly these checks being run against the G.2b build, and kept because
they are the inputs the *next* round needs. `preview-checks.md` is the UTF-8 / LF
original; the other four are UTF-8 CRLF, UTF-8 BOM CRLF, UTF-16 LE LF and
UTF-16 LE CRLF. Opening each should show its own encoding and line ending in the
status bar with no conversion prompt and no dirty dot -- which is the detector
and the writer agreeing, end to end, on files this project actually produced.
Note the sizes differ (5,205 / 5,365 / 5,208 / 10,380 / 10,700 bytes); that
spread is itself the evidence the encodings are real rather than nominal.
- [ ] **Change a setting and close the tab without saving.** The Save / Don't
      Save prompt must appear -- if it does not, `isDirty` is not seeing
      metadata and the choice is being silently discarded.
- [ ] **Open a file with mixed line endings** and hover the line-ending segment.
      The tooltip should warn that saving flattens the file. Then save and
      confirm it did, and that the warning is gone after reopening.
- [ ] **The two segments look like readouts, not buttons**, until hovered. They
      are real `<button>`s with their chrome stripped; check the hover
      background reads in both themes and that Tab reaches them with a visible
      focus ring.
- [ ] **Keyboard only:** Tab to the encoding segment, Enter to open, arrows to
      move, Enter to choose, Escape to dismiss. Focus should come back to the
      segment.
- [ ] **Clicking the segment a second time closes its menu** rather than
      reopening it.
- [ ] **An untitled document lets you pick both**, and Save As then writes what
      was picked.

## Checkpoint G.3a — the outline sidebar

SPEC §6.9, minus the "current section highlighted as you scroll" half, which is
G.3b. The layout changed to make room: `.workspace` is a new row holding the
sidebar beside `.editor-split`, so the preview's split ratio stays a share of
the editor and preview alone.

jsdom has no layout engine, so nothing below about width, wrapping or scrolling
is covered by a test.

- [ ] **Ctrl+Shift+O, and View > Outline.** Hidden on first launch; the choice
      survives a restart.
- [ ] **The sidebar is on the left of the editor, not above it**, and the status
      bar still spans the full window *under* it. That is the nesting the new
      `.workspace` row exists for.
- [ ] **Open the preview with the outline already open.** The preview must keep
      the width it had -- if it shrinks when the sidebar opens, the two rows have
      been flattened and `previewSplitRatio` is being measured against the wrong
      thing.
- [ ] **Drag the resizer.** The width should follow the pointer exactly, clamp
      at both ends, and survive a restart. Then the same with Left/Right after
      tabbing to it.
- [ ] **Click a heading near the bottom of a long document.** It should land at
      the *top* of the viewport, not merely be scrolled barely into view, and the
      caret should be on it so typing continues there.
- [ ] **A document with no headings** shows "No headings" rather than a blank
      column.
- [ ] **A long heading is clipped with an ellipsis**, not wrapped -- and narrow
      the sidebar to check.
- [ ] **Type in a paragraph with the outline open.** The list must not flicker;
      it is only rebuilt when the headings actually change.
- [ ] **Headings inside a fenced code block do not appear.** Paste a shell
      script with `# comments` in a fence -- this is the case the line scan
      exists for.
- [ ] **Colours read in both themes**, including the hover state and the focus
      ring on the resizer.

### G.3b — the current section

jsdom has no layout, so every test of this states a scroll position rather than
producing one. That the numbers a real editor reports are the ones those tests
assume is only checkable here.

- [ ] **Scroll the editor and watch the sidebar keep up.** The highlighted item
      should change as each heading passes the top of the viewport -- not late,
      not a section behind.
- [ ] **Exactly one item is ever marked.**
- [ ] **Scroll above the first heading** (a document with an intro paragraph, or
      front matter). Nothing should be marked: there is no section there.
- [ ] **A long outline scrolls itself to follow**, but only when the current item
      would otherwise be off-screen -- it must not yank while you are reading.
- [ ] **Click a heading, then check the mark moved to *that* heading.** This is
      the case that was wrong: a click scrolls the heading's line exactly to the
      top of the viewport, which lands on a block boundary, and CodeMirror
      resolves a boundary to the block above -- so the sidebar marked the section
      before the one clicked. Ordinary scrolling almost never lands on a boundary,
      so only a click shows it. Try several headings, including the first.
- [ ] **Type above a heading with the outline open.** Lines shift down; the mark
      must stay on the section you are in rather than jumping or vanishing.
- [ ] **The mark is legible in both themes**, and distinguishable from hover
      while hovering a *different* item.
- [ ] **Un-maximise the window and put something wide in the preview** -- a long
      fenced code line, or a 400-character unbroken token. The pane must gain a
      horizontal scrollbar and the text must be reachable. This was broken by
      G.3a and fixed in the same checkpoint; `frontend/harness/layout.html` is
      the fastest way to re-check it, via `window.layout.overflow()`.

## Window resizing at the right edge

The window is frameless, so there is no OS resize border: Wails' injected
runtime watches `mousemove` on `window` and arms a resize when the pointer comes
within 6px of an edge. Chromium dispatches no mouse events over a native
scrollbar, and a scrollbar is 15px sitting flush at the right edge -- so beside
the editor or the preview, Wails never saw the pointer and the window would not
resize. `.resize-gutter` is a transparent strip in that band so there is
something to be over.

None of this is visible to jsdom, and `frontend/harness/layout.html` can only
show what the pointer would *land on* (`window.layout.rightEdge()`), not whether
Windows then resizes. Only these checks can.

- [ ] **Drag the right edge beside the editor**, with a document long enough to
      show a scrollbar. Then the same beside the preview with the split open.
      Both were broken before this fix.
- [ ] **Drag the right edge over the tab strip and over the status bar.** These
      always worked; they must keep working.
- [ ] **The top-right corner still closes the window.** The gutter deliberately
      stops below the menu bar so it cannot put a dead strip across the close
      button -- if the button feels 6px narrow, it is spanning too far.
- [ ] **The preview's scrollbar is still grabbable.** The gutter takes the outer
      6px of its 15px, leaving 9px.
- [ ] **The cursor turns into a resize arrow** on that edge.
- [ ] **Left, top and bottom edges still resize.** They have no scrollbar
      against them and so were never affected.

**Superseded.** The single right-edge gutter above was replaced by a full set of
eight strips (`ui/windowedges.ts`) after three more places were found where the
edge did not work. The checks below replace the ones above, and the
status-bar-hidden gap is closed by the `s` strip being fixed to the viewport
rather than living in a row.

- [ ] **Every edge and every corner resizes**: all four sides, all four corners.
- [ ] **Over the chrome buttons.** The top edge above File / Edit / View / Help
      and above minimise / maximise / close; the bottom edge over the status
      bar's encoding and line-ending buttons. These were the reported failures.
- [ ] **The buttons still work below the strip.** Clicking the middle of File
      opens the menu; clicking close still closes. Only the outer 6px resizes --
      which is what a real Windows title bar does too.
- [ ] **The corners are comfortable**, not pixel-perfect. They are 14px.
- [ ] **No white flash while dragging an edge in dark mode.** `applyTheme` now
      hands the theme's `--bg-app` to `WindowSetBackgroundColour`, so the strip
      Windows paints before WebView2 catches up is the right colour. Check the
      right and bottom edges especially -- that is where it was seen.
- [ ] **Switch theme with the window open**, then resize again: the flash must
      not come back in the theme you switched *to*.
- [ ] **A menu taller than the window scrolls.** Un-maximise until the window is
      shorter than the View menu, open it, and confirm it is bounded and
      scrollable rather than clipped. Same for the toolbar's `···` overflow menu.
- [ ] **Maximise and restore.** The strips are fixed to the viewport, so they
      should follow without leaving a dead band.

## Checkpoint G.4 — find and replace

SPEC §6.7, both halves. G.4a was find; G.4b added the replace row.

Built on `@codemirror/search`, which SPEC names, with our own panel through
`createPanel` -- both because the spec asks for it styled to match the app and
because match highlighting is gated on CodeMirror's panel being open.

jsdom has no layout and cannot paint, so nothing below about appearance,
highlighting or scrolling is covered by a test.

- [ ] **Ctrl+F opens it with the cursor already in the box** on the *first*
      press, and Edit > Find does the same. Then Escape closes it and the caret
      returns to the text. `openSearchPanel` does not focus a panel it is
      opening -- only one already open -- so the panel focuses itself on mount;
      needing a second Ctrl+F is the symptom of that regressing.
- [ ] **Reopen find after a search.** The previous query should still be there
      and selected, so typing replaces it rather than appending.
- [ ] **Every match is highlighted in the document**, and the current one
      differently from the rest. This is the part that would have been silently
      lost by rendering the panel outside CodeMirror's panel slot.
- [ ] **Enter walks forward, Shift+Enter back, and both wrap** at the ends. F3
      and Ctrl+G do the same from inside the editor.
- [ ] **The count reads sensibly** -- "3 of 12" once you are on a match, "12
      matches" before you have moved to one, "1 match", "No results", and
      "999+ matches" in a document with more than that (try searching for `e`).
- [ ] **A half-typed regex says "Bad pattern"** rather than "No results": turn
      the `.*` toggle on and type `(`.
- [ ] **The three toggles change what matches** and look engaged when on, in
      both themes. Check `Aa` against a mixed-case word, `ab` against a word
      that is also a prefix of another, and `.*` with something like `c.t`.
- [ ] **Ctrl+A inside the find box selects the box's text**, not the whole
      document. The box is the app's first text field, and the shortcut
      forwarder had to learn to leave text fields alone.
- [ ] **The panel does not scale with Ctrl+scroll** -- it is chrome, even though
      it lives inside the editor's DOM.
- [ ] **Scroll to a match far down a long document.** The editor should bring it
      into view.
- [ ] **Open find, switch tabs, come back.** The search state belongs to the
      editor, so behaviour here is worth a look either way.

### G.4b — replace

- [ ] **One line, in this order**: find field, count, ‹ ›, the three toggles,
      replace field, Replace, Replace All, ×. Both fields the same width.
- [ ] **Ctrl+H opens the bar with the cursor in the *replace* field**, from
      closed and from an already-open bar. Ctrl+F puts it in the find field.
      That is now the only difference between them.
- [ ] **The Edit menu has one entry, "Find and Replace…" (Ctrl+F)**, not two.
- [ ] **Narrow the window right down.** The bar must stay on one line -- the two
      fields shrink, the buttons keep their labels, and × stays reachable. If it
      wraps to a second row the editor shifts down under the cursor mid-type.
- [ ] **Open it with the outline showing**, which is the narrowest the editor
      gets.
- [ ] **Open a menu with the find bar showing.** File, Edit and View must draw
      *over* the bar, not under it -- CodeMirror puts its editor panels at
      z-index 300 and the menus were at 100, so the overlapping rows of the
      dropdown disappeared. Check with the replace row open too, which is taller.
- [ ] **Drag the top window edge with the find bar open.** Same cause, one layer
      up: the resize border was below the bar, so the top edge could not be
      grabbed while find was showing.
- [ ] **Ctrl+F alone never shows the replace row.** It is the commoner case and
      should stay one line.
- [ ] **Replace works on the first click.** Type a query, type a replacement,
      click Replace once -- one match should change. CodeMirror's own
      `replaceNext` only replaces when the caret is already exactly on a match,
      so a first click that does nothing visible is that guard regressing.
- [ ] **Replace All changes every match and nothing else.**
- [ ] **Enter in the replace field replaces**; Enter in the find field still
      searches on.
- [ ] **One Ctrl+Z undoes a Replace All** -- the whole thing, not one match at a
      time.
- [ ] **The toggles apply to replacing too.** Turn on `Aa` and Replace All
      against mixed case; only the exact-case matches should change.
- [ ] **Regex replace with a capture group.** With `.*` on, replace `(\w+)@(\w+)`
      by `$2:$1` and check the groups land the right way round -- this is
      CodeMirror's substitution syntax, not ours, and nothing in `src/` tests it.
- [ ] **Replace All on a large file** stays responsive, and Escape still closes.
- [ ] **Both rows read correctly in dark mode**, and the buttons' hover states.

## Checkpoint G.5a — dropping files on the window

SPEC §6.4's last unbuilt bullet. The paths come from Wails' `OnFileDrop`
(`EnableFileDrop` in `main.go`), not from a DOM `drop` listener -- a webview
hands JavaScript `File` objects with no filesystem path, so there is nothing to
open without the native side.

None of this is reachable from Vitest: the whole mechanism is the Wails runtime
plus WebView2's `postMessageWithAdditionalObjects`, neither of which exists
there. The tests cover which paths get opened and that the editor keeps its
hands off; whether a drop is *received at all* is only observable here.

- [ ] **Drop a `.md` file anywhere on the window** -- editor, preview, outline,
      tab strip, the status bar, the gap beside the menus. It opens in a new tab
      in every one of them. `useDropTarget` is false precisely so no region has
      to opt in; a region that does nothing is the symptom of that regressing.
- [ ] **The file's text is *not* also pasted into the document you were
      editing.** CodeMirror's own drop handler reads a dropped file and inserts
      it at the cursor, so this is a real thing that happens when
      `suppressEditorFileDrop` is missing -- and the tab opening at the same
      time makes it easy to miss.
- [ ] **Drop several files at once.** Each becomes its own tab, in the order
      Explorer lists them.
- [ ] **Drop a `.png`, a `.zip`, or a file with no extension.** Nothing happens
      -- no tab, no error. Every file this app opens is decoded as markdown, so
      opening one would be a tab of mojibake.
- [ ] **Drop a mix of markdown and non-markdown.** The markdown opens; the rest
      is ignored.
- [ ] **Dragging a selection *within* a document still moves the text.**
      Internal drags are not file drops and must be left alone.
- [ ] **Drop a file on the untitled scratch tab.** It replaces it, the same way
      File > Open does, rather than leaving an empty tab behind.
- [ ] **Drop a file that is open in another program** (a locked file) -- it is
      skipped, and any other files in the same drop still open.

## Checkpoint G.5b — pasted and dropped images

SPEC §6.10 is the paste. Dropping an image into the document is an addition on
top of it, by request -- the spec's drop bullet (§6.4) only opens
tabs.

Go does the filesystem work (`internal/app/images.go`) and its tests cover the
naming, the collisions, the containment and the re-encode. What no test reaches
is the clipboard itself: WebView2's clipboard, the Save As dialog, and whether
the preview then renders what was written.

- [ ] **Copy a screenshot (PrtScn or Win+Shift+S) and press Ctrl+V** in a saved
      document. An `assets/` folder appears beside the file, the image lands in
      it as `image-YYYYMMDD-HHMMSS.png`, and `![](assets/image-….png)` is
      inserted at the cursor.
- [ ] **Turn the preview on and check the image actually renders**, which is the
      end-to-end proof: the markdown, the asset route and the file on disk all
      have to agree.
- [ ] **Paste twice inside the same second.** Two files, the second suffixed
      `-2`. The names come from a whole-second timestamp, so this is easy to hit.
- [ ] **Paste into an untitled document.** A prompt explains why it needs saving,
      then Save As. Cancelling either one leaves the document untouched, and the
      image is still on the clipboard to try again.
- [ ] **Copy an image from a browser and paste it.** Browsers often put a JPEG on
      the clipboard; the file written must still be a real PNG (open it and
      check it is not a renamed JPEG).
- [ ] **Paste ordinary text.** Unchanged -- the image path must not have taken
      over Ctrl+V.
- [ ] **Drag an image file onto the editor.** It is copied into `assets/` under
      its own name and inserted **where the pointer was**, not at the caret.
- [ ] **Drag an image whose filename has a space in it** -- the Snipping Tool's
      own default (`Screenshot 2026-08-21 120000.png`) will do. It must render,
      not appear as literal text. A bare space ends a CommonMark destination, so
      before the fix this was every screenshot dragged in by its own name; the
      generated markdown wraps such paths in `<>` now. Same for a name with
      parentheses, which `Copy` gives you as ` (1)`.
- [ ] **Drag the same image twice.** The second becomes `name-2.png` rather than
      overwriting the first.
- [ ] **Drag an image that already sits beside the document** (from the folder
      the document was opened from). It is referenced where it is, not copied --
      check no duplicate appears.
- [ ] **Drag several images at once.** All of them, in order, left to right.
- [ ] **Drag a mix of markdown and images.** The markdown opens as tabs and the
      images go into the current document, in one gesture.
- [ ] **Drop an image onto the preview pane rather than the editor.** It goes in
      at the caret, since there is no text position under the pointer there.
- [ ] **Hand-edit `files.assetFolder` in settings.json to `../evil`** and paste.
      Nothing is written outside the document's folder. Go refuses it
      (`filepath.IsLocal`); the paste reports a failure rather than escaping.

## Checkpoint H.1 — typography and content width from settings

SPEC §6.13's Appearance/Editor/Preview typography, wired to CSS custom
properties (`settings/typography.ts`). There is no dialog yet -- that is H.4 --
so these are checked by editing `settings.json` by hand and relaunching.

Two places the file can live, and **the one beside the executable wins**
(SPEC §6.13 portable mode), which is the easier one to test with:

- portable: `settings.json` in the same folder as `Hashpad.exe`
- installed: `%APPDATA%\Hashpad\settings.json`

A partial file is fine -- `LoadSettingsFrom` starts from the defaults and
unmarshals over them, so only the keys you want to change need to be present.
`version` does have to be there, or the file is treated as a bad version,
backed up, and ignored.

jsdom stores custom properties but resolves and renders nothing, so every item
below is invisible to the test suite.

- [ ] **`appearance.uiFontSize`** changes the menu bar, tabs, toolbar and status
      bar, and **not** the editor or preview text.
- [ ] **`editor.fontFamily` and `editor.fontSize`** change the editor only. Try a
      face that is obviously not monospace so a silent fallback is visible.
- [ ] **A font name that is not installed** still gives a monospace editor
      (`Consolas`, then the generic), not a proportional one.
- [ ] **`editor.lineHeight`** changes the editor's leading. The preview
      deliberately shares this token, so it should move too -- scroll sync
      interpolates between the two panes' heights and matched leading is one
      fewer source of drift.
- [ ] **`preview.fontFamily` and `preview.fontSize`** change the preview only.
- [ ] **An existing settings.json is migrated, not discarded.** Take a v1 file
      with `"version": 1`, `"maxContentWidth": 900` and a non-default theme;
      launch. The cap is gone, the theme survives, and the log says "migrating
      settings ... from version 1 to 2". This is the one that bit: `SaveSettings`
      writes the whole struct, so the first time any setting is changed, every
      default in force is frozen into the file and later default changes never
      reach it.
- [ ] **A settings.json from a *newer* build is replaced and backed up**, not
      migrated -- set `"version": 99`.
- [ ] **Migration does not write to disk.** After launching on a v1 file, the
      file itself is still v1 until something saves. That is deliberate: portable
      mode may sit on read-only media, and loading settings must not need to
      write. Confirm the app runs from a read-only folder.
- [ ] **The shipped default is uncapped** (design §4.19): with no
      `maxContentWidth` in settings.json, text fills the whole editor width at
      any window size. SPEC §6.13's example block shows 900, but §6.1 calls the
      cap optional, and it was reported twice as a defect.
- [ ] **`editor.maxContentWidth`** caps the text column in **both** panes.
      Maximise the window to see it. The text still **starts at the left**, one
      `--pad-editor` in -- the cap bounds how far a line runs, it does not move
      where it begins. An earlier version centred the column, and the editor's
      text was then reported as starting a third of the way across the window.
      The scrollbars must stay at the pane edges, not move inward with the text.
- [ ] **`"maxContentWidth": 0`** means no cap -- text runs the full width again.
- [ ] **Ctrl+scroll and Ctrl+Plus/Minus still zoom** after changing the font
      sizes, and still leave the chrome alone. This is the one most likely to
      break: the size tokens carry a `* var(--zoom)` factor and an override that
      dropped it would disable zoom only for users who had set a font size.
- [ ] **Nonsense values do not brick it.** `"fontSize": 0`, `-5`, `99999`, and
      `"fontFamily": ""` each give a readable window.
- [ ] **Delete `settings.json` entirely** -- the app opens on the compiled-in
      defaults, with text running the full width rather than capped.

## Checkpoint H.2a — View menu shows which toggles are on

Owner report: with word wrap enabled there was no way to tell without resizing
the window to see whether lines wrapped. Same for Preview, Outline, Status Bar
and which theme was active.

Three carriers, deliberately: a glyph (the Windows convention, and the only one
that survives greyscale), a bolder label (findable while scanning), and the
accent colour. Colour is not carrying it alone -- SPEC §10.

jsdom has no layout, so alignment and colour are invisible to the suite.

- [ ] **Open View with word wrap on.** A tick sits left of "Word Wrap". Toggle
      it off, reopen: the tick is gone. Repeat for Preview, Outline, Status Bar.
- [ ] **The three Theme rows show a bullet, not a tick**, on exactly one of
      them -- they are a one-of-three choice, not three switches.
- [ ] **Switch tabs with the preview open in one and not the other.** The
      Preview tick follows the *active document*, because that is where the view
      mode lives. This is the one that would break if the state were cached.
- [ ] **Labels line up.** Every row in View reserves the indicator column, so
      the text does not step sideways between ticked and unticked rows.
- [ ] **File and Edit have no empty gutter** -- neither menu has anything
      stateful, so neither reserves the column.
- [ ] **Both themes.** The tick uses the accent colour; check it is legible on
      the popup background in light and dark, and against a hovered row.
- [ ] **Narrator (Win+Ctrl+Enter) announces the state**: "Word Wrap, checked"
      for a toggle and "Theme: Dark, selected" for the radio group. The roles
      are what make this work; `aria-checked` on a plain menuitem is ignored.

## Checkpoint H.2 — line numbers, tab width, tabs vs spaces (and F11)

SPEC §6.13's three editor behaviours, plus the Full Screen entry that was
reported as greyed out with a dead shortcut.

**`tabSize` and `insertSpaces` needed a Tab binding to mean anything.**
CodeMirror binds no Tab by default and `defaultKeymap` has no Tab entry, so
before this both settings were fields in a JSON file that nothing read. Binding
Tab takes away the keyboard's way out of the editor, which is why the two escape
routes below are part of the feature rather than a nicety.

- [ ] **F11 enters and leaves full screen**, and so does View > Full Screen. The
      entry is no longer greyed out, and carries a tick while full screen.
- [ ] **The chrome behaves in full screen** -- menus open, the window edges still
      resize after leaving, and the tab bar is where it should be.
- [ ] **View > Line Numbers** turns the gutter on and off, and carries a tick
      while on. Setting `showLineNumbers` in settings.json prompted the question "what
      line numbers?" -- the feature worked, but nothing in the app switched it
      on, so the only route was hand-editing a file.
- [ ] **`showLineNumbers: true`** in settings.json has the same effect at
      startup, and the menu tick agrees with it.
- [ ] **The gutter's colours are CodeMirror's, not ours** -- `#f5f5f5`/`#6c6c6c`
      light, `#333338`/`#ccc` dark, hard-coded in its base theme and not derived
      from `variables.css`. Measured in `frontend/harness/gutter.html`. Judge
      whether they sit right against the editor in both themes; if not, they need
      the same treatment `editor/theme.ts` already gives the active-line
      highlight for exactly this reason.
- [ ] **`insertSpaces: true` with `tabSize: 4`** -- Tab inserts four spaces.
      Arrow back over them: four presses, not one.
- [ ] **`insertSpaces: false`** -- Tab inserts one tab character, and `tabSize`
      changes how wide it looks without changing the file's bytes. Save and
      reopen in another editor to confirm what is actually on disk.
- [ ] **Select several lines and press Tab** -- all of them indent, rather than
      the selection being replaced by an indent. Shift+Tab outdents.
- [ ] **Tab still escapes the editor after Escape.** Press Escape, then Tab:
      focus leaves the editor instead of indenting. CodeMirror enables this for
      two seconds after Escape, by itself.
- [ ] **Ctrl+M is the sticky version** -- press it and Tab moves focus until it
      is pressed again. This comes from `defaultKeymap`, not from us.
- [ ] **A hand-edited `"tabSize": 0`** does not make Tab insert nothing; the
      value is clamped to 1. `999` clamps to 16.
- [ ] **Open a new tab after changing the settings** -- it picks up the same
      line numbers, width and indent behaviour as the first one. New tabs build
      their own `EditorState`, so this is a separate path from the live view.

## Scroll sync — the editor's end is the preview's end

Owner report: with a very tall image at the end of a document, scrolling the
editor all the way down left the preview short of its own bottom -- **and only
when scrolling gradually**. A single jump to the end worked, which is what made
it look intermittent.

Cause: `endpoints()` derived the saturation line from `view.contentHeight`,
CodeMirror's *estimate* for lines outside the rendered viewport, while the live
mapping uses the scroller's real geometry. An overestimate put the anchor on a
line the editor could never reach, and every measured anchor past it is
discarded -- so whatever sat in the gap was unreachable. Measured at 2311px of
a 2400px image. The jump case rebuilt the anchors at a moment the estimate
happened to agree.

`frontend/harness/scrollsync.html` reproduces it: jsdom reports every scroll
dimension as 0, so `endpoints` returns nothing there and none of this is
reachable in the unit tests without stubbing the geometry.

- [ ] **Put a tall image at the end of a document** and scroll the editor to the
      bottom **with the wheel, gradually**. The preview ends at its own bottom.
      Then do it again with Ctrl+End, and by dragging the scrollbar.
- [ ] **The same with the image in the middle** -- both panes still line up on
      the text after it.
- [ ] **Scroll the preview to its bottom instead.** The editor follows to its
      own end. The reverse direction saturates earlier by nature: the image is
      one editor line and half the preview, so the last stretch of preview maps
      to no editor movement at all.
- [ ] **Jumpiness through a tall image is expected**, not a defect: one source
      line is hundreds of rendered pixels, so the editor has only one line of
      scroll to spend there. This is accepted; what must not happen is
      content that cannot be reached at all.
- [ ] **A document with no images** still tracks smoothly end to end, in both
      directions -- the fix must not have cost the middle its interpolation.

## Scroll sync — the caret hybrid

Agreed after the end-clamp fix: **an addition to scroll sync, not
a replacement.** Design §4.17 still rejects driving the whole mapping from the
caret, because the caret does not move when you use the wheel, so the other pane
would freeze during ordinary scrolling. The two gestures keep separate mappings
and the last one wins.

Measured in `frontend/harness/scrollsync.html`: alignment was exact (699/699,
133/133, 312/312 pixels from each pane's top).

- [ ] **Click a line in the editor.** That line moves to the same height in the
      preview. It works for a line already on screen -- the point is that the two
      panes line up, not merely that the line becomes visible.
- [ ] **Arrow or Ctrl+End to a distant line.** Same thing, after the editor
      scrolls to it.
- [ ] **Now scroll with the wheel without touching the caret.** The preview
      follows the *top line* as before. The caret must not be holding it in
      place.
- [ ] **Near the top of a document**, the preview may not be able to match --
      matching would mean scrolling above its own top, so it stops at 0. Expected.
- [ ] **Type at the end of a long document.** The preview keeps up rather than
      lagging behind the caret.
- [ ] **Turn sync scroll off** (settings `preview.syncScroll`). Neither gesture
      moves the other pane.
- [ ] **Switch to a tab that is not in split view and move the caret there.**
      Nothing moves in the pane belonging to the other document.
- [ ] **At the very bottom, with the image filling the preview, click a line in
      the editor.** The preview jumps to put that line at the same height --
      leaving the image behind if the line is near the top of the editor's
      viewport. It must not nudge slightly *upward* from the end and land on the
      wrong text: that was the report, and it happened because the caret
      was reading the *scroll* mapping, which answers "the bottom" for any line
      in the last screenful by design.
- [ ] **Click the last few lines before the image.** Each lands at its own
      height, not at the pane's end.
- [ ] **The end still clamps.** Scroll to the bottom after clicking around --
      this is the sequence that reintroduced the bug in the harness, because the
      caret path gives the anchor cache another chance to be built at an awkward
      moment.

## The preview sticks (H.3, `editor.defaultViewMode`)

Reported in testing: *"if I open the preview and I close the app or open
another document the preview disappears and I need to enable it again."*

`viewMode` is per document by design (Checkpoint F), and all three places that
mint a `Document` wrote a literal `'source'` into it — so nothing could carry
the mode from one document to the next, and `editor.defaultViewMode` was read
by nobody. View > Preview now writes the setting, the same way word wrap, line
numbers, the status bar and the outline always have.

**A note on what to expect from the first launch after this build.** Your
settings.json already says `"defaultViewMode": "source"`, so Hashpad opens in
source mode exactly as before. It becomes sticky from the first time you open
the preview, not before.

- [ ] **Open the preview, then File > New.** The new tab has the preview too.
- [ ] **Open the preview, then open a file** (Ctrl+O, or drop one on the
      window). Same — the pane stays, showing the file you just opened.
- [ ] **Close the preview, then open a document.** It stays closed. Sticky runs
      in both directions; it is not "preview always on".
- [ ] **Open the preview, close Hashpad, start it again.** It comes back with
      the preview already showing, and no visible flicker of a source-only
      window first — the pane is mounted before the window appears, the same as
      the theme and the fonts.
- [ ] **Check settings.json** (`%APPDATA%\Hashpad\settings.json`) after each
      toggle: `editor.defaultViewMode` reads `"split"` or `"source"` to match.
- [ ] **Tabs still keep their own modes.** With the preview open on one tab,
      switch to another and turn it off there; switch back and the first tab
      still has it. The setting is the mode a *new* document opens in, not a
      window-wide override.
- [ ] **Hand-edit `defaultViewMode` to nonsense** (`"preview"`, `""`) and
      launch. Hashpad opens in source mode rather than in a mode that renders
      nothing. It is a hand-editable file, so this is a trust boundary.

## Checkpoint H.3 — the encoding a new document is written as

`files.defaultEncoding` reaches **untitled** documents only. An opened file
keeps the encoding Go detected on read (SPEC §3.1) and is written back the same
way — a default that overrode detection would transcode your file the first
time you saved it.

There is no UI for this until H.4's settings dialog, so these checks need
`%APPDATA%\Hashpad\settings.json` edited by hand and the app restarted.

- [ ] **Default (`"utf-8"`).** The status bar reads UTF-8 on the startup tab and
      on File > New. Nothing has changed from before.
- [ ] **Set `files.defaultEncoding` to `"utf-16le"` and relaunch.** The startup
      tab's status bar reads UTF-16 LE, and so does a File > New tab.
- [ ] **The startup tab is not dirty.** No dot on the tab, and closing the app
      asks nothing. This is the one worth looking at twice: the encoding is
      compared against the *saved* encoding to decide dirtiness, so a half-
      applied default shows up as a document you never touched refusing to
      close quietly.
- [ ] **Save that new tab** (Ctrl+S → pick a name). Reopen it: still UTF-16 LE,
      and the bytes on disk are UTF-16 (the file is roughly twice the size of
      the equivalent ASCII, and starts with `FF FE`).
- [ ] **Open an existing UTF-8 file while the default says `"utf-16le"`.** The
      status bar reads UTF-8, not UTF-16 LE. Edit and save it — still UTF-8 on
      disk. The default must not touch a file that was read from disk.
- [ ] **Change one document's encoding from the status bar.** It affects that
      document only: the tab goes dirty (the change reaches disk on the next
      Ctrl+S, like any edit), and a new tab still opens on the settings value.
      Picking an encoding for one file is not a preference change.
- [ ] **Hand-edit it to nonsense** (`"utf8"`, `"UTF-8"`, `"utf-16be"`, `""`) and
      relaunch. Everything opens UTF-8. Near-misses matter more than obvious
      garbage here — `"utf8"` is what a person actually types.

## Checkpoint H.4a — the settings dialog (shell + Appearance)

Ctrl+, or File > Settings. This is the **first slice**: the dialog itself and
the Appearance group. Editor, Files and Advanced arrive in H.4b/H.4c — an empty
group is worse than an absent one, so their legends are not there yet.

Measured in `harness/settings.html` (jsdom has no `showModal()`, no top layer
and no layout, so none of the below is visible to the test suite): the label
column and the control column each line up across all three rows, the dialog is
560×325 and inside the viewport, and the body is the thing that scrolls.
Contrast, resolved through a canvas rather than parsed from the computed string
— `--accent` is an `oklab()` and a regex silently drops its minus signs:

| | light | dark |
|---|---|---|
| Title / labels | 17.4 | 12.2 |
| Legend / hints | 8.9 | 6.9 |
| Control text | 15.7 | 13.5 |
| Close button | 4.5 | 8.2 |

- [ ] **Ctrl+, opens it**, with the caret in the editor and again with focus
      somewhere else (a tab, the toolbar, the preview).
- [ ] **File > Settings… opens the same dialog**, and shows `Ctrl+,` beside it.
- [ ] **Escape closes it. The Close button closes it.** There is no OK and no
      Apply, deliberately (SPEC §6.13).
- [ ] **The background is inert while it is up** — clicking the editor behind it
      does nothing, and Ctrl+S does not start a save behind the prompt.
- [ ] **Theme.** Change it in the dialog; the app retints at once, and View >
      Theme shows the same choice when you reopen the menu. Both directions:
      change it from the View menu, reopen the dialog, the dropdown agrees.
- [ ] **Accent colour.** Drag around the picker — the app retints live, and the
      file is written once you settle rather than on every movement.
- [ ] **Interface font size.** The chrome resizes as you type. Clear the field
      to retype it: the app must not jump to 14 and write it.
- [ ] **Close inside the first moment after a change** (pick a colour, press
      Escape immediately). Relaunch: the colour survived.
- [ ] **Look at it in dark mode.** Numbers above say it is legible; whether it
      looks right is yours to judge.

### For your judgement, not fixed

- **Input borders are below WCAG's 3:1 for non-text UI** — 2.17 light, 1.69
  dark. It is `--border-strong` against `--bg-elevated`, the same pair the
  confirm dialog's buttons already use, so it is an app-wide token question
  rather than something this one dialog should answer on its own.

## Checkpoint H.4b — the Editor group

Eight controls, in three kinds by who owns the value. That split is the thing
to poke at, because getting it wrong makes a control that looks like it works
and writes to the wrong place.

- **Typography** (font, size, line height) — CSS custom properties only.
- **Word wrap, line numbers, tab width, insert spaces** — a store field *and* a
  compartment on the running editor, so the open tab changes and the next tab
  is built the new way. Shared with the View menu through `settings/live.ts`.
- **New documents open in** — a store field, also written by the preview toggle.

Measured in `harness/settings.html`: 11 rows across two groups, every label at
one left edge and every control at one right edge, the dialog capped at 640px
with 113px scrolling inside the body.

- [ ] **Font, size, line height.** The editor retypesets as you type in each.
      Zoom (Ctrl+Plus) still works afterwards — the size tokens are
      `calc(Npx * var(--zoom))`, and overwriting them with a plain value
      disables zoom silently.
- [ ] **Change the font size, then the line height straight after.** Close and
      relaunch: *both* survived. Only the second used to — one pending write
      replaced the other inside the debounce window.
- [ ] **Word wrap and Line numbers.** The open tab changes immediately, and
      View > Word Wrap / Line Numbers show the same state. Toggle from the
      View menu instead, reopen the dialog: the checkboxes agree.
- [ ] **Tab width and Insert spaces.** Press Tab in the editor after each — the
      indent matches. Change the tab width and confirm line numbers did *not*
      turn off with it: the three share one object, and a partial change that
      rebuilt it instead of merging would reset its siblings.
- [ ] **New documents open in → Editor and preview.** Ctrl+N: the new tab has
      the preview. The tabs already open are unchanged — the mode is per
      document, so this only decides what the *next* one opens as.
- [ ] **Only two options in that dropdown.** There is no Live: the mode exists
      in the type and renders exactly like Source, so offering it would be a
      control wired to nothing.
- [ ] **The dialog scrolls** rather than growing past the window, and the
      Close button stays visible at the bottom while it does.
- [ ] **Clear any number field to retype it.** Nothing jumps to a default and
      nothing is written until you type a real value.

## Checkpoint H.4c — Files, Advanced, and Reset to default

The dialog is complete: four groups, 17 rows. Measured in
`harness/settings.html` — one label column, one control column, 527px of scroll
inside a body capped at 640px, and the actions row pinned below it so Close
never walks off the bottom. Reset and Close sit 296px apart.

Preview typography joined **Appearance** rather than getting a group of its own:
SPEC §6.13 names four groups and Preview is not one of them, and these are fonts
and sizes exactly like the three already there.

- [ ] **Preview font and size.** With the preview open, both change it live.
- [ ] **Image folder.** Change it, then paste an image into a saved document —
      it lands in the new folder. Go re-reads the setting on every image save,
      so this needs no restart.
- [ ] **Encoding for new documents.** Ctrl+N picks it up; a file you *open*
      keeps its own encoding, which is the whole point.
- [ ] **Maximum text width.** Type a number and the column narrows live; set it
      to **0** and the limit is gone. Zero has to be reachable from the spinner
      — it is the only way to say "no limit", and the capped column was reported
      as a defect twice.
- [ ] **Scroll the preview with the editor.** Turn it off, scroll the editor:
      the preview stays put. Turn it back on: it follows again.

### Reset to default

- [ ] **It asks first**, and **Cancel is the highlighted button** — the opposite
      of the other prompts in this app, because this one asks whether to throw
      work away rather than whether to keep it.
- [ ] **Cancel changes nothing.** Check `settings.json` is untouched.
- [ ] **Reset puts the running app back**: theme, accent, all four fonts, word
      wrap, line numbers, tab width, the content width, sync scroll, the status
      bar and the outline sidebar — without a restart. The dialog itself
      rebuilds, showing the defaults rather than what you just discarded.
- [ ] **Two things wait for the next launch**: the pinned toolbar buttons and
      the toolbar's visibility. Both are written to disk immediately; the
      toolbar seeds its list once at startup and nothing can re-seed it. The
      prompt says so.
- [ ] **The window size is reset on disk too** and applies next launch.

### For your judgement, still not fixed

- Input borders remain below WCAG's 3:1 for non-text UI (2.17 light, 1.69 dark),
  and the Reset button's border is the same token pair. Unchanged from H.4a: it
  is `--border-strong` on `--bg-elevated`, which the confirm dialog's buttons
  already use, so it is an app-wide token question.

## Checkpoint H.5 — autosave

SPEC §3.2: "off by default. Offer it in settings as an opt-in **for saved files
only** (never silently creates files)." That parenthesis is the whole design —
`saveDocument` falls back to Save As for a document with no path, so autosave
filters untitled documents out itself rather than trusting the save path to be
polite. A file picker on a timer is the worst thing this feature could do.

Debounced from the last edit, not run on an interval: `autosaveDelayMs` is named
for a delay. The trade is that continuous typing with no pause never saves.

Both controls are in the Files group, added now rather than with H.4c so they
never shipped wired to nothing.

- [ ] **Off by default.** A fresh install writes nothing on a timer.
- [ ] **Turn it on with a saved file open, type, and stop.** Two seconds later
      the dirty dot clears with no keypress. Check the file on disk.
- [ ] **Turn it on with an *untitled* tab.** Type and wait. **No save dialog
      appears**, ever, and the tab stays dirty. This is the one to be sure of.
- [ ] **Keep typing without pausing** for longer than the delay: nothing is
      written until you stop. Each keystroke pushes the write back.
- [ ] **Turn it on while a file is already dirty and you have stopped typing.**
      It saves within the delay — it must not wait for another keystroke.
- [ ] **Turn it off mid-countdown** (type, then untick within the delay).
      Nothing is written.
- [ ] **Edit a file, switch to another tab inside the delay.** The tab you left
      still gets saved — autosave covers every dirty saved document, not only
      the one in front.
- [ ] **Change the delay** and confirm the new one takes effect immediately,
      including shortening one that is already counting down.
- [ ] **Type below the floor** in the delay field (say `5`). It is corrected to
      200, and the field shows 200 rather than the number you typed.
- [ ] **Make a file read-only, edit it with autosave on.** The tab stays dirty
      and no dialog appears; the error goes to the log. Other tabs still save.
- [ ] **Autosave plus Reset to default** turns it back off, immediately.
- [ ] **Quit with autosave on and an untitled dirty tab.** You are still
      prompted — the prompt is what stands in for the save that cannot happen.

## Checkpoint H.6 — Autosave in the File menu

In File rather than View, where the app's other checkable toggles live: this one
changes what *saving* does, not what is on screen, and VS Code — the closest
analogue with the same four menus — puts it at File > Auto Save. Labelled
"Autosave" to match the settings dialog exactly; two names for one setting is
two things to look for.

- [ ] **File > Autosave ticks and unticks**, and the editor starts and stops
      saving on the timer to match.
- [ ] **It agrees with the settings dialog, both ways.** Toggle it in the menu,
      open Settings — the Files group's checkbox matches. Toggle it there,
      reopen the File menu — the tick matches.
- [ ] **It sits directly under Save As**, not at the bottom under Exit.
- [ ] **Reset to default unticks it**, immediately.

## Checkpoint H.7 — the Tabs menu

Thirteen tab commands out of View into a new **Tabs** menu between View and
Help: Next, Previous, Move Left, Move Right, Go to Tab 1–9. Command ids are
unchanged, so every keybinding and every route is untouched — this is purely
which menu they render in. Recorded as design §4.20, since SPEC §6.1 draws four
menus and there are now five.

Close Tab and Reopen Closed Tab stay in **File**: Ctrl+W there is a strong
enough Windows convention to outweigh the consistency argument.

Menu separators arrived with it. Measured in `harness/menus.html` (jsdom can
prove a `div[role=separator]` is in the right place and nothing about whether it
is visible): 1px, flush to the inside of the popup border, and

| | light | dark |
|---|---|---|
| `--border` (first attempt) | 1.48 | **1.18** |
| `--border-strong` (shipped) | 2.17 | 1.69 |

1.18:1 is not a divider, it is a rendering artefact — that's why the token
changed.

- [ ] **Tabs sits between View and Help**, and everything in it works from
      there: Next/Previous, Move Left/Right, and Go to Tab 1–9.
- [ ] **Every shortcut still works** unchanged — Ctrl+Tab, Ctrl+Shift+Tab,
      Ctrl+Shift+Left/Right, Ctrl+Alt+1…9. Moving the menu entry did not touch
      the keymap.
- [ ] **View is short again**: themes, then the display toggles, then zoom and
      full screen, in three groups with a line between each.
- [ ] **Close Tab and Reopen Closed Tab are still in File.**
- [ ] **Arrow keys skip the dividers.** Open Tabs, hold Down — focus never
      stops on a line, and it wraps from Go to Tab 9 back to Next Tab. Up from
      Next Tab goes straight to Go to Tab 9.
- [ ] **Left/Right still walks all five menus**, including in and out of Tabs.
- [ ] **Look at the dividers in dark mode.** They are the faintest thing added
      in this checkpoint; if they read as invisible to you, say so — the number
      says 1.69 and that is a judgement call, not a pass.

### For your judgement, still not fixed

- The divider's 1.69:1 in dark is the same `--border-strong` on `--bg-elevated`
  pair as the settings dialog's input borders, still below WCAG's 3:1 for
  non-text UI. One app-wide token decision, not three local ones.

## Checkpoint H.8 — pinning from the ⋯ overflow

Right-click already pinned from the toolbar *row* and had since Checkpoint G.
It was asked for in the `···` list, which is where the full set of
commands is — and so where you are when you decide you want one on the row.

**Left-click runs the command, right-click pins it**, on the same item. The
first design routed right-click to a *second* popup, on the grounds that
`PopupItem.checked` renders `role="menuitemcheckbox"` and announcing a checkbox
while the click runs a command lies to a screen reader. This was pushed back on —
two popups for one simple task is not intuitive — and was right: `popupmenu.ts`
already separates the visual tick from the semantics, they were only coupled in
one branch. A `marker` draws the tick, keeps `role="menuitem"`, and puts
"pinned to toolbar" in the accessible name instead.

- [ ] **Open ⋯.** The commands already on the toolbar are ticked and bold; the
      rest are plain.
- [ ] **Left-click one.** It runs, exactly as before. Nothing gets pinned.
- [ ] **Right-click one.** It appears on the toolbar, its tick fills in, **and
      the list stays open.** Right-click two more without reopening ⋯.
- [ ] **Right-click a ticked one.** It leaves the toolbar and unticks.
- [ ] **Right-click on the toolbar row still works** — that menu is unchanged.
      Right-click now means the same thing in both places.
- [ ] **Escape after pinning** closes the list and puts focus back on the ⋯
      button — not nowhere. The row is rebuilt under the popup each time you
      pin, so the button you started from no longer exists; the popup re-points
      itself at the new one.
- [ ] **Reopen the app.** The pins survived.
- [ ] **Shift+F10 or the Menu key** on a focused item does the same as
      right-click. That is how Windows context menus are reachable without a
      mouse, and the toolbar row already relied on it.

## Checkpoint H.9 — the asset handler's path checks

Nothing user-visible changed. The route that serves images to the preview swapped
a hand-rolled anchoring check for `filepath.IsLocal`, matching what `images.go`
already used, and gained the device-name tests it had none of.

Worth knowing rather than checking: the swap adds **no** protection. Measured
input by input, every path `IsLocal` rejects was already refused by another
layer — and a bare `NUL` was being refused by the *extension allow-list*, which
is why that list is load-bearing security rather than a content-type nicety.

- [ ] **Images still render in the preview** from a document's own folder and
      from a subfolder of it. That is the whole behavioural surface here.
- [ ] **A document saved at a drive root** (`C:\notes.md`) still shows its
      images — that path shape is what the anchoring check exists for.

## The three budgets (SPEC §1.3)

Binary under 25 MB, cold start under 500 ms, under 100 MB RAM with five tabs.
The RAM one is a **recorded miss** — see design §4.21. It is a Chromium floor,
not something this code can reduce; measured at 135.4 MB.

- [x] **Binary.** `build/bin/Hashpad.exe` under 25 MB. Was 12.7 MB at H.9.
      *Confirmed 2026-08-31, measured: 12.71 MB, half the budget. The portable
      exe is byte-for-byte the same size; the installer is 6.70 MB.*
- [ ] **RAM.** Open five tabs, then walk the process tree *down from
      `Hashpad.exe` by parent PID* — not by image name, because Windows runs its
      own `msedgewebview2` processes under `SharedWebView\EBWebView` and those
      are not ours. Sum `WorkingSetPrivate` from
      `Win32_PerfRawData_PerfProc_Process` across the tree. Compare against
      **135 MB, not 100**: the budget is a documented miss, and what matters now
      is that it has not grown.
- [ ] **Cold start.** Still unmeasured on the native side. The JS half is
      ~90–142 ms with IPC stubbed (+21 ms when the preview restores); process
      start and WebView2 init are not. Measure a **second** launch — a freshly
      downloaded unsigned exe pays a one-off Defender and SmartScreen cost of
      seconds that has nothing to do with the app.

## Checkpoint H.10 — one tab per file

Reported in testing: the same file could be opened repeatedly, each time
getting its own tab. Two tabs over one path are two buffers that drift apart,
and then whichever is saved second silently wins — so this was a data-loss
shape, not a tidiness one.

The existing tab is **focused** rather than the request being ignored. "Nothing
happens" is right only when that tab is already in front; when it is a
background tab, Open would otherwise appear to have done nothing at all.

- [ ] **Open a file, then open the same file again.** No second tab, and the
      first one comes to the front.
- [ ] **With that file in a background tab**, open it again from the dialog.
      It comes forward. This is the case where doing literally nothing would
      have looked broken.
- [ ] **Type into a file without saving, then open the same file again.** Your
      unsaved text is still there — the tab is left completely alone rather than
      re-read from disk. This is the one worth being sure of.
- [ ] **Re-open the file that is already in front.** Nothing moves, including
      the caret and the scroll position.
- [ ] **Drop the same file on the window twice.** Same behaviour as the dialog —
      both routes go through one guard.
- [ ] **Close a file, open it again from the dialog, then Ctrl+Shift+T.** No
      duplicate. Reopen-closed reaches the same guard.
- [ ] **Two different files still get two tabs.**

### Known ceiling, deliberate

The comparison is an exact string match on the path. The same file spelled
differently — `C:\A.md` against `C:\a.md`, or a path carrying `..` — would still
open twice. Every route in arrives with a path the OS produced (the file dialog,
a native drop, or a stored path that came from one of those), so a non-canonical
spelling cannot arise from the UI. If it ever can, the fix is Go's
`os.SameFile`, which compares file identity rather than text.

## Checkpoint I.1 — open-with and single instance

SPEC §6.4 asks that double-clicking a `.md` in Explorer open it in the running
Hashpad rather than launch a second one. Nothing implemented it: `main.go` never
read `os.Args`, so registering file associations in I.3 would have produced an
app that launched on a double-click and showed an empty untitled tab.

The file associations are not registered yet — that is I.2 and I.3 — so these
checks drive the same code from a terminal instead. Every route the association
will use goes through the same two calls.

Run these from the folder holding `Hashpad.exe`, with a `notes.md` and an
`other.md` somewhere handy.

### One launch

- [x] **`.\Hashpad.exe notes.md`** opens that file in a tab, not an untitled one.
      *Confirmed 2026-08-30, owner.*
- [ ] **`.\Hashpad.exe notes.md other.md`** opens both, in that order.
- [ ] **`.\Hashpad.exe C:\full\path\to\notes.md`** works the same as the relative
      form.
- [ ] **`.\Hashpad.exe`** with no argument still opens an untitled tab, as before.
- [ ] **`.\Hashpad.exe missing.md`** opens an untitled tab and does not hang or
      error — the path is dropped because there is no file there.
- [ ] **`.\Hashpad.exe some-folder`** does the same. Only regular files open.

### A second launch, while it is already running

This is the part SPEC §6.4 is actually about.

- [x] **With Hashpad open, run `.\Hashpad.exe other.md`.** No second window
      appears. `other.md` opens in the window already running, and that window
      comes to the front.
      *Confirmed 2026-08-30, owner: two launches with different files landed as
      two tabs in one window.*
- [ ] **Minimise Hashpad, then run `.\Hashpad.exe other.md`.** It restores rather
      than blinking on the taskbar. Both the unminimise and the show are needed —
      a minimised window is already "shown" as far as the show call is concerned.
- [ ] **With Hashpad open, run `.\Hashpad.exe` with no argument.** The window
      still comes forward. Launching Hashpad is a request to see Hashpad, even
      without a file.
- [ ] **Run `.\Hashpad.exe notes.md` twice while it is running.** The second one
      switches to the existing tab rather than opening a duplicate — H.10's rule,
      reached through this route too.
- [ ] **Type into a tab without saving, then launch again with that same file.**
      Your unsaved text is still there.
- [ ] **You can no longer open two Hashpad windows.** That is the point of the
      lock and what SPEC §6.4 asks for, but it is a change from every build
      before this one.

### The race worth trying

- [ ] **Double-click `Hashpad.exe`, and while it is still starting, launch it
      again with a file.** The file opens. This is the case the code goes out of
      its way to handle: Wails creates the window that receives a second launch's
      message at the *top* of its startup and tells our code the app has started
      at the *bottom*, with the whole of WebView2's initialisation in between. A
      launch landing in that gap has nowhere to send an event, so Go queues the
      paths and the frontend collects them when it comes up. Getting this wrong
      is not a lost file but a crash — the running app would panic on a context
      that does not exist yet.

### Known ceiling, deliberate

`Hashpad.exe --anything` treats the argument as a path, finds no file there, and
drops it. There are no command-line options, so there is nothing to confuse it
with; if options are ever added, they have to be parsed before this runs.

## Checkpoint I.2 — packaging metadata and file associations

Until now the executable shipped with no identity at all: `wails.json` had an
empty `author` block and no `info` section, so Explorer's Properties dialog was
blank in every field. It also built as `hashpad.exe`, where SPEC §9 asks for
`Hashpad.exe`.

The file associations are *declared* here and *registered* in I.3, so nothing in
Explorer changes yet — the installer does that.

- [x] **Right-click `Hashpad.exe` → Properties → Details.** It should read:
      Product name **Hashpad**, Product version **0.3.0**, File version
      **0.3.0.0**, Company **Hashpad**, Copyright **© 2026 Hashpad**, and File
      description **Hashpad**. Blank fields here mean the version resource did
      not link.
      *Confirmed 2026-08-31, measured: all six strings read back through
      `Shell.Application`'s `GetDetailsOf`, which is the reader the section
      below names as the one that agrees with Explorer. Still worth a human
      glance at the real dialog, since that is where a user meets it.*
- [x] **The file is named `Hashpad.exe`, capital H.** Windows does not care
      about the case when you type it, so the old `.\hashpad.exe` still runs it.
      *Confirmed 2026-08-31, measured: `build/bin/Hashpad.exe`, 12.71 MB.*
- [ ] **The icon still looks right** at the sizes Explorer uses — the icon
      resource is rebuilt by the same step that adds the version information, so
      a mistake there would show up here first.

### Worth knowing: what does *not* read this

Do not check this with PowerShell's `(Get-Item x).VersionInfo`, or with
`[System.Diagnostics.FileVersionInfo]`. Both report every string field as empty
for this binary even when the resource is correct and Explorer displays it
perfectly — verified by dumping the resource out of the executable, where all
six strings are present and well-formed under a valid `040904b0` block. The
reader that agrees with Explorer is the shell itself, via
`Shell.Application`'s `GetDetailsOf`.

That is a measurement trap, not a defect, and it cost a rebuild to find. The
same trap would make a future "the version info is broken" report a false alarm.

### Resolved in J.1: markdown files have their own icon

This section used to record a deliberate ceiling -- that associated files got the
*application* icon, because Hashpad had no document icon to give them. Reported
as unintuitive, which it was: every markdown file on the machine showed Hashpad's
"H", so the icon said "this is Hashpad" where it needed to say "this is a
markdown file".

`build/windows/mdicon.ico` now carries ".MD" on the same white rounded tile as
the application icon -- a family, told apart by the glyph. It is generated by
`scripts/make-icons.ps1` rather than hand-drawn, so it can be reviewed and
adjusted, and it renders **each size separately** rather than downscaling one
image: text hinted at 16px is legible in a way a shrunk 1024px tile is not.

Two things learned the hard way and worth knowing before touching it:

- **Wails needs `build/mdicon.png` as well**, and fails the build outright
  without it -- `iconName` in wails.json drives asset generation from a PNG. The
  installer nonetheless ships the hand-built `.ico`; `wails_tools.nsh` copies
  `..\mdicon.ico` into the install folder and registers *that*.
- **PowerShell unrolls a returned array.** `return $bytes` from the frame
  function emitted several hundred individual bytes, and the script wrote a
  structurally valid 142-byte icon -- correct header, no image data -- rather
  than failing. `return , $bytes` is the fix and the comment says so.

## Checkpoint I.3 — the portable build keeps to its own folder

Two executables now come out of one codebase, differing in a single link-time
marker: the portable one **creates** `settings.json` beside itself on first
launch, the installed one never does. Which file wins once one exists is the
same in both (SPEC §6.13), so dropping the file next to any copy by hand still
makes that copy portable.

**Put the two exes in separate folders for these checks.** In one folder they
would share the same `settings.json`, which is correct behaviour and a
confusing thing to test against.

### The portable build

- [ ] **Put `Hashpad-portable.exe` alone in an empty folder and run it.** A
      `settings.json` appears beside it, holding the full defaults — readable
      and hand-editable, not an empty stub.
- [ ] **Change a setting, close, reopen.** It persisted, and
      `%APPDATA%\Hashpad\` was never created.
      *Half confirmed 2026-08-30, owner: the persistence holds. Whether
      `%APPDATA%\Hashpad\` stayed absent was not looked at, and that is the
      half that says the portable build is really keeping to its own folder.*
- [ ] **Edit `settings.json` by hand — say set the theme to `"dark"` — then
      relaunch.** Your edit survives. This is the one worth being sure of:
      seeding runs on *every* launch, not just the first, so a version that
      wrote unconditionally would silently reset everything you had changed,
      every time you started the app.
- [ ] **Move the exe and its `settings.json` to another folder together.** Your
      settings come with it. That is the whole point.
- [ ] **Move only the exe, leaving `settings.json` behind.** It seeds a fresh
      one — the settings did not follow, which is the honest consequence of
      leaving them.

### The installed-style build

- [ ] **Put `Hashpad.exe` alone in a different empty folder and run it.** No
      `settings.json` appears beside it. Settings go to
      `%APPDATA%\Hashpad\settings.json` as before.
- [ ] **Copy a `settings.json` next to `Hashpad.exe` by hand and relaunch.** It
      uses that file instead. SPEC §6.13's escape hatch, and it is deliberately
      not conditional on which build you have.

### Awkward places

- [ ] **Run the portable exe from a read-only location** — a locked folder, or a
      CD/read-only share if you have one. It still starts. It stops being
      portable and falls back to `%APPDATA%`, which is the honest outcome rather
      than refusing to launch.

### Known ceiling, deliberate

Running the portable exe straight out of `Downloads\` drops a `settings.json`
into `Downloads\`. That is what portable means, and it is why the installed
build does not do it — but it will surprise someone who expected a program to
keep to itself. Giving it its own folder is the intended use.

## Checkpoint I.5 — the installer

`Hashpad-amd64-installer.exe`, 6.7 MB. **None of this is covered by any
automated test** — an installer is registry writes, shortcuts and shell state,
and the only way to know it works is to run it and then look at Windows.

Four deliberate departures from the Wails template, each required by SPEC §9:
the install scope is chosen at run time rather than fixed at build time, file
associations are opt-in, the uninstaller *offers* to remove settings instead of
deleting them silently, and the desktop shortcut is opt-in too.

**Do these on a machine you are willing to install on, and do the uninstall
checks as well** — a half-tested uninstaller is how a machine collects debris.

### Installing, per-user (the default)

- [x] **Run the installer.** UAC prompts immediately, before any page appears,
      and says "Publisher: Unknown". Both are expected: Windows fixes elevation
      before the program starts, so an installer that asked first and elevated
      afterwards is not possible without a third-party plugin.
      *Confirmed 2026-08-31, owner.*
- [x] **The options page appears after Welcome.** "Just me" is preselected, and
      both checkboxes are **unticked**. The associations checkbox being unticked
      by default is what makes SPEC §9's "never forced" true rather than merely
      available.
      *Confirmed 2026-08-31, owner: the page was reached and used. Whether the
      three defaults were exactly as described was not read back item by item.*
- [ ] **The directory page shows `%LOCALAPPDATA%\Programs\Hashpad`** — it should
      have followed the scope choice, not shown Program Files.
- [x] **Finish, with "Run Hashpad" ticked.** It launches.
      *Confirmed 2026-08-31, owner: the installed Hashpad ran.*
- [x] **Start menu has a Hashpad entry.** No desktop shortcut, because you left
      that unticked.
      *Confirmed 2026-08-31, owner.*
- [ ] **Settings → Apps → Installed apps lists Hashpad**, with a version of
      0.3.0 and a publisher of Hashpad.
      *The entry exists -- the uninstall below was reached through it. The
      version and publisher strings shown there were not read.*

### Installing, all users

- [ ] **Run it again and choose "All users on this computer".** The directory
      page now offers `C:\Program Files\Hashpad`.
- [x] **Tick the associations checkbox this time.**
      *Confirmed 2026-08-31, owner. Which install scope it was ticked under was
      not recorded.*
- [x] **After installing, a `.md` file in Explorer shows the Hashpad icon**, and
      double-clicking it opens that file in Hashpad — not an empty tab. This is
      the check that I.1 and I.2 were building toward, and the first time the
      whole chain is exercised.
      *Confirmed 2026-08-31, owner: a `.md` double-clicked from Explorer opened
      in Hashpad. The icon half was not separately reported; it is written by the
      same registry step as the association, and a missing one would be visible
      at a glance next time Explorer is open.*
- [ ] **Right-click a `.md` file → Open with.** Hashpad is listed.
- [ ] **`.markdown`, `.mdown` and `.mkd` behave the same.** All four were
      registered, or none were.
- [ ] **Double-click a second `.md` while Hashpad is open.** It opens as a tab
      in the existing window; no second Hashpad appears. This is the whole point
      of I.1, reached the way a real user reaches it.

### Uninstalling — the half that is usually untested

- [x] **Uninstall from Settings → Apps.** It asks whether to remove your
      settings, and **No is the highlighted default.** Choose **No**.
      *Confirmed 2026-08-31, owner: the uninstall ran from there and completed.
      Which button carried the default was not read back.*
- [ ] **`%APPDATA%\Hashpad\settings.json` still exists.** Keeping settings
      through a reinstall is the point; losing your theme and toolbar layout
      because you clicked through a dialog is not.
- [x] **The Start menu entry, the desktop shortcut and the install folder are
      gone.**
      *Confirmed 2026-08-31, owner: "installing and uninstalling works fine" --
      the machine was left clean.*
- [ ] **`.md` files went back to whatever opened them before** — not to nothing.
      The uninstaller restores the previous association rather than assuming
      Hashpad owned the extension.
- [x] **Hashpad no longer appears in Installed apps.**
      *Confirmed 2026-08-31, owner: the installer was run again afterwards and
      offered a fresh install rather than the maintenance page, which is the
      same registry key read back.*
- [ ] **Install and uninstall once more, this time answering Yes** to the
      settings question. `%APPDATA%\Hashpad` is gone.

### Known ceilings, deliberate

**The UAC prompt appears even for "Just me".** Windows decides a process's
elevation before it runs, so a single installer cannot ask first and elevate
only if needed without bundling a third-party plugin. Two separate installers
would avoid it; one installer that asks is the trade that was chosen.

**A machine-wide uninstall removes only the settings of the account running
it.** Settings live per-user under `%APPDATA%`, and reaching into other users'
profiles would be overreach rather than thoroughness.

**Upgrading over an existing install is untested.** Installing again to the same
directory should overwrite the executable, but nothing here has exercised it, and
NSIS does not do it for free.

## Checkpoint I.5a — the installer looks finished, and knows it is installed

Two reports from running the real installer.

**"It doesn't look finished."** The progress page stopped at 100% showing a
"Next" button and waited there, which reads as a step still to come rather than
a completed install. `MUI_FINISHPAGE_NOAUTOCLOSE` was doing that and has been
removed. The uninstaller was worse: it had **no completion page at all** and
ended on its progress page.

**"Running the installer again just installs it again."** It now detects the
existing installation and offers Repair, Change options, or Uninstall.

### The finish pages

- [x] **Install.** When the progress bar reaches 100% it moves to a finish page
      by itself, headed **"Hashpad is installed"** and saying so in a sentence.
      No stopping on the progress bar.
      *Confirmed 2026-08-31, owner: this was the reported defect, and the
      installer was run again after the fix without it being raised.*
- [ ] **That page's button reads "Finish"**, not "Next" or "Close".
- [ ] **"Run Hashpad now" is ticked.** Clicking Finish launches Hashpad and
      closes the installer.
- [ ] **Untick it and click Finish.** The installer closes and nothing launches.
- [ ] **Show details on the finish page still shows the install log** — removing
      the wait did not remove access to it.
- [x] **Uninstall.** It now ends on **"Hashpad has been removed"** with a Finish
      button, instead of stopping on the progress page.
      *Confirmed 2026-08-31, owner: run to completion during the I.5b uninstall
      check below.*

### Running the installer over an existing install

- [x] **With Hashpad installed, run the installer again.** After Welcome there is
      a new page saying Hashpad is already installed, showing the path it is
      installed at, with Repair selected.
      *Confirmed 2026-08-31, owner: "running installer after the program has
      been installed looks good now".*
- [ ] **The directory page does not appear.** Reinstalling somewhere else would
      leave the first copy behind with its own entry in Add/Remove Programs.
- [ ] **Repair.** Goes straight to installing, no options asked. Afterwards the
      file associations and desktop shortcut are **exactly as they were** — not
      reset to the defaults. This is the point of recording them at install time.
- [ ] **Change options.** The options page appears, with your previous choices
      already filled in rather than blank.
- [ ] **On that page the "Install for" radios are greyed out**, with a line
      explaining that uninstalling first is how you change it. Changing scope
      without moving the files would leave the registry in one hive and the
      program in another.
- [ ] **Change the association checkbox and finish.** The change takes effect —
      tick it and `.md` files open in Hashpad; untick it and they stop.
- [ ] **Uninstall from that page.** The existing uninstaller runs to completion,
      and the installer closes afterwards rather than carrying on to install.
- [ ] **With Hashpad *not* installed, run the installer.** The maintenance page
      does not appear at all; it goes Welcome → options → directory as before.

### Known ceiling, deliberate

**Add/Remove Programs still offers only Uninstall**, not Modify or Repair, and
that is deliberate rather than an omission. Its Modify button runs whatever the
`ModifyPath` registry value names — which would have to be the installer, and
the installer is not on disk after installing. Pointing it at `uninstall.exe`
instead would uninstall Hashpad when someone asked to modify it. So the entry
claims only what it can do, and repair lives in the installer, where it works.

## Checkpoint I.5b — the uninstall button, and mojibake in the labels

Two more from running the installer. Both were mine.

- [x] **Run the installer with Hashpad installed, choose Uninstall, click Next.**
      The uninstaller opens and removes Hashpad. Previously the installer just
      closed and nothing happened: the registry's `UninstallString` is stored
      *with its quotes included*, and quoting it again produced
      `""C:\...\uninstall.exe""`, which fails silently.
      *Confirmed 2026-08-31, owner, against the build that fixed it.*
- [ ] **The three options read as plain words** -- `Repair  --  install the same
      files again`, not `Repair  aE"  install...`. NSIS reads a `.nsi` file as
      Windows-1252 unless it has a UTF-8 BOM, so an em dash arrived as mojibake.
      The script is pure ASCII now, and a test enforces it.
      *Half confirmed 2026-08-31, owner: the mojibake is gone. The separator was
      then two dashes rather than one, and the one-dash build has not been run
      by anyone -- so this box is waiting on a look at the labels, nothing more.*
- [ ] **Rename or delete `uninstall.exe` in the install folder, then choose
      Uninstall.** A message says where it expected to find it and what to do
      instead, rather than closing silently. Silence was the original defect;
      this is the same situation handled visibly.

### Why no test covers the first one

`project.nsi` is not executed by anything either suite runs, so nothing could
have caught a bad `ExecWait` short of installing. The encoding half *is* now
covered -- `openwith.test.ts` reads the script and fails on any non-ASCII
character -- because that one is a property of the file rather than of its
behaviour, and a file can be read without being run.

## Checkpoint I.6 -- the Taskfile

SPEC 9's six targets, plus a few that fell out of them. Every one was run except
`dev`, which is a long-running server.

    task                    list every target
    task build              Hashpad.exe into build/bin
    task build:portable     the portable exe into build/bin/portable
    task build:installer    the NSIS installer
    task build:all          all three
    task test               both suites
    task lint               gofmt, go vet, tsc, eslint, prettier
    task measure            the SPEC 1.3 budget report

### The one that needs a person

- [x] **`task dev`.** Hot reload. It never exits on its own, so nothing
      automated can check it -- run it, confirm the window appears, edit
      something in `frontend/src`, confirm the change shows up without a
      rebuild, then Ctrl+C.
      *Confirmed 2026-08-31, owner: a one-word change to a menu label in
      `ui/menubar.ts` appeared in the running window with no rebuild and no
      action taken in the app. The edit was reverted afterwards.*

### Worth knowing

**`task build:installer` prepends NSIS to PATH itself.** NSIS installs to
`C:\Program Files (x86)\NSIS` and adds nothing to PATH, so `wails build -nsis`
otherwise fails with a "makensis not found" that reads like a missing install.
The task does it for that one command rather than changing the machine.

**`task build:portable` runs a test before it builds**, and will refuse to build
if that test fails. It is checking that the `-ldflags -X` symbol path actually
resolves -- the linker ignores one it cannot find, without a word, leaving an
executable that is simply not portable.

### Latest budget report

Measured with `task measure`, one empty document, on a VMware VM with a virtual
GPU, so the startup figure is pessimistic against real hardware.

| Budget | SPEC 1.3 | Measured | |
|---|---|---|---|
| Binary size | 25 MB | 12.71 MB | pass |
| Cold start | 500 ms | 46 ms median | pass, provisional |
| Memory | 100 MB | 182.8 MB private commit, 7 processes | see design 4.21 |

The cold-start verdict is marked provisional by the script itself:
`WaitForInputIdle` measures a message loop pumping, not first paint. The first
of the five runs was 1074 ms against a median of 46, which is the disk cache
filling rather than a real spread.

**`scripts/measure.ps1` still prints "Five-tab measurement lands with tabs at
Checkpoint C".** Tabs shipped long ago; the note is stale and the script has not
been taught to open five. The five-tab figure in design 4.21 was measured by
hand instead.

## Checkpoint J.1 — reading view, and the two view-mode settings

Phase 2's first checkpoint. A fourth `viewMode`, `'preview'`: the rendered pane
at full width with the editor still laid out underneath it but `inert`.

jsdom has no layout engine, so everything about how this *looks* is here rather
than in the suite. Two things it can see, unusually, and both are covered by
tests: the editor being made unreachable (`inert` is an attribute, not a
rendering) and the one-line outline offset (`defaultLineHeight` is non-zero under
jsdom where `clientHeight` is not).

**Reading view.**

- [ ] **View > Reading View** fills the window with the rendered document — no
      editor, no divider. Toggling it off returns to exactly where you were,
      caret and scroll position intact.
- [ ] **Press Tab repeatedly while in reading view.** Focus must never land in
      the hidden editor. This is what `inert` is for, and it is invisible to
      anyone using a mouse.
- [ ] **Narrator (Win+Ctrl+Enter) in reading view** does not read out the
      editor's contents. Same guard, the half a sighted check cannot see.
- [ ] **Ctrl+S, Ctrl+O, Ctrl+W and Ctrl+Tab still work** with no visible editor.
      G.2's shortcut forwarder is what makes this true and this is its hardest
      case.
- [ ] **Open the preview (Ctrl+Shift+P), drag the divider well off centre, then
      switch to reading view and back.** The divider returns where you left it.
- [ ] **Ctrl+Shift+P still means source↔split** and never cycles into reading
      view. Reading view has no chord, deliberately (design §4.27).

**The outline in reading view.**

- [ ] **Scroll the preview with the outline open.** The highlighted heading
      keeps up. Before J.1 it followed the editor, which in this mode is a pane
      you cannot see, so it sat frozen.
- [ ] **The offset feels right.** A heading one line below the top of the pane
      already counts as the current section — you should not have to land on it
      exactly. It must **not** skip a short section: with two headings a few
      lines apart, each should take its turn.
- [ ] **Click a heading in the outline.** *That* heading is marked, not the one
      after it. Worth trying on a heading whose section is empty (a `###`
      directly under a `##`), which is the case the offset gets wrong when the
      answer is derived rather than pinned.
- [ ] **Turn scroll sync off** (Settings > Scroll the preview with the editor).
      The outline must still follow the preview in reading view — they are two
      features sharing one event, not one feature.

**The two settings.** Settings > Editor.

- [ ] **"New documents open in" offers Editor only, Editor and preview, and Last
      used** — and no Reading view. A new document has nothing to read.
- [ ] **"Existing documents open in" offers all four**, Reading view included.
- [ ] **Set it to Reading view, then open a file every way there is**: Ctrl+O,
      File > Open, dropping one on the window, Ctrl+Shift+T, and a double-click
      in Explorer. All five arrive in reading view -- they are one question with
      one answer, and any route behaving differently is the bug.
- [ ] **Ctrl+N is unaffected** and opens in the editor. That is the distinction
      the two settings exist for.
- [ ] **With the preview never opened this session, open a file while
      "Existing documents open in" says Editor and preview.** The pane appears.
      The lazy chunk has to be fetched on demand here, and the document carrying
      the right mode over an editor with nothing beside it is what failure looks
      like.
- [ ] **Set "New documents open in" to Last used**, put a document in split,
      then File > New. The new tab is split. Now put one in reading view and
      File > New again: the new tab is **not** reading view — it falls back to
      the mode behind it in the history.
- [ ] **Double-click two `.md` files at once.** Both open in the launch mode, not
      just the one in front.

**The migration.** Settings version 2 → 3.

- [ ] **Your existing settings.json is translated, not reset.** After the first
      launch on this build, `editor.defaultViewMode` reads `"last"` and
      `editor.recentViewModes` holds what that field used to say. Everything
      else — theme, accent, fonts, window size, pinned toolbar — is untouched.
- [ ] **Opening a preview no longer rewrites `defaultViewMode`.** Choose
      "Editor only", toggle the preview a few times, reopen Settings: it still
      says Editor only. Before v3 the toggle overwrote it, which is why it could
      not be a preference.
- [ ] **A hand-edited `"defaultViewMode": "preview"`** falls back to the editor
      rather than opening a blank page you cannot type into.

**The document icon.** Needs an install with associations ticked.

- [ ] **`.md` files in Explorer show ".MD"**, not Hashpad's "H". Check at Large
      icons *and* at Details, which is the 16px frame and the one that decides
      whether rendering each size separately was worth it.
- [ ] **`.markdown`, `.mdown` and `.mkd` show it too** -- all four registered, or
      none did.
- [ ] **Hashpad.exe shows a leaning "H"**, not ".MD" and not Wails' "W". The two
      icons are meant to be a family, not the same picture; if the executable
      shows the document icon, the wrong file was wired up.

**The application icon.** Replaced in J.1 -- it had been Wails' own "W" since
`wails init`, shipped in every build and every installer, and nobody had noticed
because a stock logo looks like *a* logo.

**Upgrading is the case that matters here, not a first install.** The reported
defect was an installed Hashpad still showing the old icon after a reinstall, on
a machine where the executable on disk demonstrably carried the new one. The file
had been replaced; nothing had told the shell. `SHChangeNotify` sat inside the
file-associations branch, so an install that left associations alone notified
Windows of nothing at all. It is unconditional now, last in the install section.

- [ ] **The window's taskbar button and Alt+Tab entry show the H.** These read
      the executable's icon rather than the shortcut's, so they are the check
      that the resource really linked.
- [ ] **The Start menu entry and the desktop shortcut show it too.**
- [ ] **The installer's own window shows it** -- `project.nsi` points `MUI_ICON`
      at the same `icon.ico`.
- [ ] **Upgrade over an older install and the icon changes.** Install an older
      build, then run this installer and choose "Repair or update". The Start
      menu entry, the **desktop shortcut** and the executable in the install
      folder must all show the new icon **without clearing any cache by hand** --
      that is the whole point of the fix, and running a shell command to make it
      look right is what it exists to avoid.

      **How this is actually made to work, since two attempts did not.** The
      shortcuts point at `$INSTDIR\hashpad-icon-<buildstamp>.ico` rather than
      inheriting the executable's icon. Windows caches a shortcut's icon against
      the path it came from, and NSIS's own "Refresh shell icons" page documents
      that the SHChangeNotify trick "does not work" for this -- the ICO has to be
      *renamed*. An executable cannot be renamed, so the icon moved into a file
      that can be. The stamp is the build time, not the product version, because
      the icon can change without the version doing so.

      **The desktop shortcut is the one to look at hardest.** It is where this
      failed after the first attempt at the fix: Alt+Tab and the taskbar were
      already correct, because those read the icon out of the *running process*,
      while the shortcut drew a cached icon for the target path. Two different
      sources, and only one of them consults the cache -- so "the app icon is
      right" is not evidence that the shortcut is.
- [ ] **Repair with Hashpad still running.** The installer says Hashpad is
      running and offers Retry; closing the app and choosing Retry carries on.
      It must not report a successful install having left the old executable in
      place, which is what NSIS's own Ignore does.
**Associating `.txt`, added in 0.3.0.** A second checkbox directly under the
markdown one. `.txt` was already in `SUPPORTED_EXTENSIONS` and already opened
fine; only the registration was missing.

- [ ] **The options page shows two association checkboxes**, both unticked by
      default, with the `.txt` one directly under the markdown one and the
      explanation naming Notepad. Nothing is clipped -- the page grew by a row
      and the desktop shortcut moved down with it.
- [ ] **Tick only the markdown box.** `.md` opens in Hashpad; `.txt` still opens
      in whatever had it. The two must be genuinely independent, which is the
      whole reason `.txt` is registered outside wails.json.
- [ ] **Tick only the `.txt` box.** The reverse: `.txt` files show the ".TXT"
      icon and open in Hashpad, `.md` files are untouched.
- [ ] **A `.txt` file opens with its content intact**, and the status bar reports
      its encoding and line endings like any other file.
- [ ] **Uninstall gives `.txt` back to Notepad**, not to nothing. `APP_UNASSOCIATE`
      restores whichever file class held it before, and this is the check that
      the backup was actually taken -- taking Notepad's extension is only
      defensible because giving it back is automatic.
- [ ] **Repair remembers the choice.** Tick `.txt`, finish, run the installer
      again and choose "Change options": the box is still ticked. It is recorded
      as `TextAssociations` beside the other two.
- [ ] **Upgrading from 0.2.0 leaves `.txt` alone.** That install has no
      `TextAssociations` value at all, which must read as "not taken" rather than
      as an empty string doing something surprising.

- [ ] **Only one `hashpad-icon-*.ico` is in the install folder** after
      upgrading. They are stamped per build and the installer deletes the
      previous one; a folder collecting them means the wildcard delete broke.
- [ ] **A desktop shortcut you made yourself** -- dragged from the Start menu, or
      "Send to > Desktop" -- also picks up the new icon. It will not have been
      recreated by the installer, so this is the notification path rather than
      the stamped-icon path, and it is the commoner way a desktop shortcut
      exists.
- [ ] **The maintenance page's first option reads "Repair or update"**, and the
      paragraph under the three options is not clipped -- it grew, and nsDialogs
      silently draws only what fits.
- [ ] **The H leans, and is legible at 16px.** It is drawn as a sheared outline
      rather than as hinted text, which is the right trade for one large glyph
      and the wrong one for three small ones -- if it looks soft in a list view,
      that trade is what to revisit.
- [ ] **Uninstall, then check a `.md` file.** The icon goes back to whatever it
      was before, and `mdicon.ico` is gone from the install folder.

**Code blocks.**

- [ ] **A fenced block's tinted box hugs its widest line** rather than spanning
      the pane, with a comfortable margin of tint around the text. A long line
      still scrolls inside the block, and the pane itself never scrolls
      sideways.
