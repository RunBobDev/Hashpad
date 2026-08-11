# Checkpoint F — preview pane: design

**Written 2026-08-11, at commit `95c87d8` on `checkpoint-a`.**

Companion to `2026-07-27-hashpad-phase1-design.md`, which stays the master document.
This one covers only what Checkpoint F adds or decides. Where the phase-1 design
already settled something, this document points at it rather than restating it, and
where F contradicts or corrects it that is called out explicitly.

Requirements: SPEC §6.7 (the pane), §6.8 (markdown support), §6.13 (settings),
§6.14 (menu reachability).

---

## 1. What was already decided, and is simply being followed

None of these are reopened here. They are listed so the plan's tasks can cite them
and so a reader does not mistake silence for oversight.

| Decision | Where |
|---|---|
| `markdown-it`, `markdown-it-mark`, `markdown-it-footnote`, `dompurify` — and nothing else | SPEC §3, design §6.2 |
| `markdown-it-task-lists` and `js-yaml` declined; ~25 lines of our own instead | design §6.3 |
| Remote images are **never** fetched; muted placeholder showing the URL | design §3 |
| Front matter renders as a muted metadata card, not hidden | design §2.2 |
| Local images served through `AssetServer.Handler` on a dedicated route | design §5.7 |
| Code blocks bridge to CodeMirror's Lezer parsers, not highlight.js or Shiki | design §6.3 |
| The preview module is lazy-loaded (`import()`); the pane is off by default | design §2.4 |
| HTML comments are visible in the editor and absent from the preview | SPEC §6.8 |
| 150 ms debounce; never re-render per keystroke | SPEC §6.7 |

Three facts about the existing code that shape the work, each verified rather than
assumed:

- **The settings model is already complete for F.** `PreviewSettings{fontFamily,
  fontSize, syncScroll}` and `WindowSettings.PreviewSplitRatio` exist in
  `internal/app/settings.go`; `viewMode: 'source' | 'live' | 'split'` exists on the
  TypeScript document model. No settings type changes, therefore no
  `wails generate module` on that account — but see §3.1, which does need one for a
  different reason.
- **The menu entry already exists**, disabled: `ui/menubar.ts` carries
  `{ id: 'view.preview', label: 'Preview', shortcut: 'Ctrl+Shift+P', enabled: false }`.
  SPEC §6.14's reachability requirement is structurally satisfied; F flips `enabled`
  and wires the handler.
- **`Ctrl+Shift+P` collides with nothing** in the current keymap.

### 1.1 A correction to the phase-1 design

**Design §6.4 is stale and should be corrected while F is in this area.** It commits
to curating roughly twenty languages from `@codemirror/language-data`. Checkpoint D5
measured that and dropped it: Rollup follows the static `import()` sites inside
language-data's own module, so every grammar chunk is emitted regardless of what a
runtime `.filter()` keeps. Two builds — curated and uncurated — came out within four
bytes of each other. F's code-highlighting bridge sits directly on top of that table,
so the correction belongs with it.

---

## 2. Decisions taken for this checkpoint

### 2.1 Scroll sync is line-anchored, not proportional

SPEC §6.7 says "synchronized scrolling, proportional by position".

**Decision: anchor on source lines.**

Read literally, "proportional" means mapping the scroll *fraction* — at 50% of the
editor's pixels, scroll to 50% of the preview's. That is about five lines of code and
it is wrong on any document where rendered height diverges from source height, which
is most real documents: a tall image occupies one source line, a fenced block of
twenty lines may render shorter than its source, a table shorter still.

markdown-it gives every block-level token a `map: [startLine, endLine]`. A core rule
stamps `data-source-line` onto each rendered block; the renderer returns that list of
anchors alongside the HTML. Sync then maps the editor's top visible line to the two
anchors that bracket it and interpolates between their offsets.

Costs roughly fifty lines over the naive version. Two things buy it back: it is
correct on the documents where the naive version is visibly wrong, and the anchor map
is exactly the source-line index Checkpoint G's outline (SPEC §6.9) needs, so it is
built once rather than twice.

This is a deviation from SPEC's wording and is recorded in the phase-1 design's §4
deviation list.

Rejected: proportional as written — see above. Rejected: proportional in F and
line-anchored in G — writing the sync twice and living with visible drift in between,
to save fifty lines.

### 2.2 Fenced code gets its own `--syn-code-*` palette

`markdownSupport()` registers `defaultHighlightStyle` to colour the contents of fenced
code blocks. That is CodeMirror's built-in palette, tuned for a white page, and it is
what colours code in **both** themes: measured against `--bg-editor` dark (`#1a1a1a`)
its values run from about 1.33:1 to 2.6:1. Dark-mode fenced code is largely
illegible today, and the preview is about to render the same code in a second pane.

**Decision: define a `--syn-code-*` token set in `variables.css`, both themes, every
value contrast-measured, and drive one `HighlightStyle` from it that the editor and
the preview both use.**

Roughly eight tokens — keyword, string, literal, comment, function, type, variable,
invalid. That keeps the richness light mode has today (where CodeMirror's defaults
happen to measure fine) while fixing dark, and it puts fenced-code colour under
SPEC §5.3's rule that variables.css is the only place colours are defined, which it
currently is not.

Sharing one `HighlightStyle` between the two panes is not a convenience: it is the
argument design §6.3 already made for bridging to Lezer instead of adding
highlight.js. Editor and preview agree by construction rather than by two palettes
being maintained in step.

Rejected: a minimal four-token palette. Less to tune, but light mode would visibly
lose colour it has today, so it trades a working theme for a broken one. Rejected:
deferring to Checkpoint H — the problem becomes twice as visible the moment the
preview ships, and H has enough of its own.

Note that this does **not** close the whole gap. `HTMLBlock`, `HTMLTag` and
block-level `CommentBlock` are mounted HTML sub-trees, outside
`markdownHighlightStyle`'s `markdownLanguage` scope, and keep CodeMirror's colours.
So do `<?xml …?>` and `<?php` inside fences. Those remain open.

### 2.3 GitHub's conventions, Hashpad's palette

SPEC §6.7 asks for "GitHub-flavoured styling, adapted to the active theme".

**Decision: every colour from `variables.css`; GitHub's structural conventions on
top.** Headings 1 and 2 with a bottom rule, blockquotes with a left bar, bordered
tables with zebra rows, tinted rounded code blocks, generous block spacing. Honours
`preview.fontFamily` and `preview.fontSize`.

Rejected: matching GitHub's actual colours. It needs a hard-coded palette beside
variables.css, breaking SPEC §5.3, and stops the preview following the user's accent.
Rejected: plain and unornamented — quieter, but not what SPEC asks for.

### 2.4 The pane is per document; the divider is per window

Not a new decision so much as reading the existing model, recorded because it is the
kind of thing that gets re-litigated. `editor.defaultViewMode` is meaningless unless
each document has its own mode, and `previewSplitRatio` sits in the `window` block,
not `preview`. So `Ctrl+Shift+P` toggles the **current tab**, and switching tabs can
change the layout; the divider position is one window-level preference shared by all
tabs.

Toggling the pane **on** sets the document's `viewMode` to `'split'`. Toggling it
**off** restores whatever the mode was before, not a hard-coded `'source'` — a
document opened under `editor.defaultViewMode: "live"` must come back as `'live'`
rather than being silently downgraded. `'live'` renders identically to `'source'`
until Phase 2 (design §2.3), so this costs one remembered value and no behaviour.

The renderer does no work while the pane is closed: both triggers in §4 return early
unless the active document's `viewMode` is `'split'`.

The **sync-scroll toggle** SPEC §6.7 asks for is the `preview.syncScroll` setting,
which F reads and honours. Its *user interface* is Checkpoint H's settings dialog,
which is where SPEC §6.13 puts every setting anyway; F adds no menu item or button
for it. If that turns out to be too buried in practice, a View-menu checkbox is a
one-line addition later.

---

## 3. Architecture

```
frontend/src/preview/
  render.ts           pure: (markdown, ctx) -> { html, anchors }
  rules/frontmatter.ts     the muted metadata card
  rules/tasklist.ts        GFM checkboxes, ~25 lines
  rules/images.ts          local -> asset route, remote -> placeholder
  rules/sourceline.ts      data-source-line on every block token
  codehighlight.ts    the Lezer bridge
  scrollsync.ts       pure: (anchors, topLine, offsets) -> scrollTop
  pane.ts             impure: mounts, splits, debounces, drives sync
frontend/src/styles/preview.css
internal/app/assets.go   the http.Handler and its traversal rejection
```

The split follows the convention the codebase already uses — a pure core with a thin
impure wrapper, the way `commands.ts` sits under `toolbar.ts`. `render.ts` touches no
application state, so its tests need neither store nor editor. It does need a
`window` for DOMPurify, so that test file opts into jsdom.

The four markdown-it rules get their own files rather than living in `render.ts`.
`commands.ts` reached ~590 lines in Checkpoint E and the reviewer's read was that it
was at its ceiling; four independent rules in one renderer file would arrive there
immediately.

### 3.1 Two named risks

**F does need `wails generate module` after all.** Not for settings — for the image
route. Design §5.7's handler resolves a relative path against *the active document's
directory*, and Go has no idea what that is. A bound method the frontend calls on open
and on tab switch is the clean fix, and it changes the binding surface. The
alternative, encoding the base directory in the URL, makes the traversal check
meaningless: a crafted document would supply the base it is then checked against.
Regeneration goes on that task's checklist explicitly — Checkpoint D shipped a task
without it and the new method was simply uncallable from TypeScript for a whole task.

**Preview code highlighting is asynchronous and markdown-it's `highlight` hook is
not.** CodeMirror's grammars arrive by dynamic import, so the first render of a
` ```python ` block has no parser available. `codehighlight.ts` keeps a cache of
loaded languages; on a miss it renders plain escaped code, starts the load, and
triggers a re-render when it settles. The pane's render is already debounced, so it
hooks in there. This is a behaviour, not a defect: **a code block flashes
unhighlighted once per language per session.** Recorded so it is not filed as a bug.

---

## 4. Data flow

Two triggers, both selecting primitives, both existing seams:

1. `EditorView.updateListener` → `if (update.docChanged) scheduleRender()`. The same
   seam `syncActiveFormats` uses.
2. `store.subscribe((s) => s.activeDocumentId, renderNow)` for tab switches. Rendered
   immediately rather than debounced — the preview should match the tab you just
   landed on.

The pane reads the text from `getEditorView().state.doc` *after* the debounce, so
`toString()` runs once per render rather than once per keystroke.

**Why not subscribe to the active document's `editorState`.** It would work today and
only by accident. `store.ts`'s `isEqual` tries `Object.is` and then falls back to
comparing own enumerable keys — and an object with no own keys compares **equal**. It
happens that `EditorState` assigns `doc`, `selection` and others as own properties, so
the comparison currently discriminates. If a future CodeMirror moved them to the
prototype, the pane would silently stop updating with the whole suite green. Two
primitive-valued triggers avoid the question entirely, and need no new store field and
no new `publish*` seam function. (`activeFormats` needed one because it is derived
from the view rather than stored; the preview's source is stored.)

Rendering assigns `container.innerHTML = sanitised`. This is the only `innerHTML` in
the codebase fed by document content rather than compile-time constants — `ui/toolbar.ts`'s
is our own icon strings — and DOMPurify is the entire reason it is safe. It earns a
comment at the call site and its own tests.

Scroll sync is **bidirectional**, with an `applying` flag cleared on the next
animation frame to break the feedback loop. Editor → preview goes through
`lineBlockAtHeight` to a line number, then anchor interpolation; preview → editor is
the inverse. One-way was considered: it needs no guard, but scrolling the preview and
having it snap back on the next keystroke is worse than the guard.

---

## 5. Error handling

| Case | Behaviour |
|---|---|
| Render throws | An error card **replacing** the content, carrying the message. Not a stale last-good render: a preview that quietly stops updating is worse than one that is visibly broken. |
| Front-matter line with no colon | The raw line, shown in the card (design §6.3). |
| Local image in an unsaved document | Muted placeholder — "save the document to load local images". Nothing in SPEC or the phase-1 design covers this, and an Untitled buffer has no directory to resolve against. |
| Local image missing on disk | Handler returns 404; CSS reveals the `alt` text. |
| Path traversal, or a path outside the document's directory | Handler returns 403 with no body. Covered by a Go table test. |
| Grammar not yet loaded | Plain escaped code. Not an error state — see §3.1. |

---

## 6. Testing

**Assert on the parsed output, not on substrings.** Checkpoint E's command tests all
pinned the *string* a command produced and none asked what that string meant to the
parser, which is how three separate defects shipped while 504 tests stayed green —
fixed in `587ad7f`. Preview tests parse the rendered HTML and assert structure and
attributes.

- `render.test.ts` (jsdom, for DOMPurify): one case per construct.
- Sanitiser, its own set: `<script>`, `onerror=`, a `javascript:` href, `<iframe>`,
  and a `data:text/html` href.
- Anchors: asserted against a known document, including that a fenced block anchors to
  its **opening fence** line.
- `scrollsync.test.ts`: pure, node environment, synthetic anchors — including the
  divergent-height case that motivated §2.1.
- Go `assets_test.go`: `..` traversal, absolute paths, outside-directory, missing file,
  a valid nested path, and the Windows-specific shapes (`..\`, `C:foo`, UNC). Windows
  path handling is its own trap and the handler is the one place traversal is rejected.
- Every new test mutation-verified: break the behaviour, confirm red.

**The browser harness is committed this time, as task 1.** jsdom has no layout and
resolves `var(--syn-*)` to the empty string, so no jsdom test can see the split, the
divider, or a single colour. Three times in this project the suite has been green
while the running app was visibly broken; twice in one session on 2026-08-10 a
throwaway harness found what 504 tests missed. F is a rendering feature and should not
be built without one.

---

## 7. Task breakdown

| # | Task |
|---|---|
| 1 | `--syn-code-*` palette, shared `HighlightStyle`, committed browser harness |
| 2 | markdown-it + DOMPurify + `render.ts` |
| 3 | The four rules: front matter, task list, images, source lines |
| 4 | Go asset handler, bound method, `wails generate module`, traversal tests |
| 5 | Lezer code-highlighting bridge |
| 6 | The pane: mount, split, draggable divider, persistence, Ctrl+Shift+P, menu entry |
| 7 | Bidirectional scroll sync and its toggle |
| 8 | `preview.css`, and the manual checks in `docs/testing.md` |

Eight tasks, comparable in size to the toolbar phase. Each is implemented, then
reviewed independently against its brief, then has the findings applied.

---

## 8. Deviations to record in the phase-1 design's §4

- **§4.17** — scroll sync is line-anchored, not proportional (this document, §2.1).
- **§4.18** — fenced code gets a `--syn-code-*` palette shared by editor and preview
  (§2.2), and design §6.4's language curation is corrected as never having shipped
  (§1.1).

## 9. Carried forward, not solved here

- Mounted HTML sub-trees (`HTMLBlock`, `HTMLTag`, block `CommentBlock`) and
  `<?xml`/`<?php` inside fences keep CodeMirror's built-in colours; §2.2 does not
  reach them.
- `src/main.toolbarHidden.test.ts` times out at 5 s under CPU contention — the wait is
  `await import('./main')`, which pulls the whole app graph. Not caused by any recent
  change (verified by a controlled A/B) but it will bite in CI. One-line fix when it
  does: a longer `timeout` on that `it`.
