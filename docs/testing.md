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
the owner running exactly these checks against the G.2b build and kept because
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
eight strips (`ui/windowedges.ts`) after the owner found three more places the
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
      right and bottom edges especially -- that is where the owner saw it.
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
top of it, at the owner's request -- the spec's drop bullet (§6.4) only opens
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

- portable: `settings.json` in the same folder as `hashpad.exe`
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
- [ ] **`editor.maxContentWidth`** caps the text column in **both** panes.
      Maximise the window to see it. The text still **starts at the left**, one
      `--pad-editor` in -- the cap bounds how far a line runs, it does not move
      where it begins. An earlier version centred the column and the owner
      reported the editor's text starting a third of the way across the window.
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
