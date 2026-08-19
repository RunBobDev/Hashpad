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
  hashpad.exe working set    : 26.8 MB
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
  open. This run resolved 7 processes (1 `hashpad.exe` + 6 `msedgewebview2.exe`),
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
running `build/bin/hashpad.exe`. **Nothing in this section has been ticked by an
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

Reported by the owner: "when I open Hashpad and press Ctrl+Shift+P nothing
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
