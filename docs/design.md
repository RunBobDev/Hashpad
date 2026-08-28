# Hashpad Phase 1 — Design

**Date:** 2026-07-27
**Status:** Approved
**Scope:** Phase 1 (SPEC.md §6). Phase 2 is out of scope except where noted as a seam.

This document records the decisions made while planning against
[`SPEC.md`](../SPEC.md). The specification remains the authority on *what* Hashpad
does; this document covers *how*, and records every place the implementation
deviates from the specification, and why. §4 is that list — twenty-four entries,
including several where the specification turned out to be wrong, and several
recording ideas that were investigated and rejected so they are not proposed again.

The preview pane has its own companion document,
[`design-preview.md`](design-preview.md); this one stays the master.

---

## 1. Stack verification (SPEC §3.2)

Checked before planning, because §3.2 warns that training data may be stale:

| Item | Finding |
|---|---|
| Wails v2 | Current and actively maintained — v2.13.0 (2026-07-06). Correct choice. |
| Wails v3 | Still alpha (v3.0.0-alpha.73, Feb 2026). Not suitable. Staying on v2. |
| CodeMirror 6 | API confirmed: `new EditorView({doc, extensions, parent})`, `StateField.define`, immutable state, `Prec` for extension ordering. Writing v6, not v5. |
| `SingleInstanceLock` | Exists in Wails v2 with `UniqueId` + `OnSecondInstanceLaunch(SecondInstanceData{Args, WorkingDir})`. Supports SPEC §6.4. Does **not** raise the window — needs explicit `WindowUnminimise` + `Show`. |
| `AssetServer.Handler` | Exists. Catches GET requests the bundled assets cannot serve. This is how local document images are served (see §5.7). |

---

## 2. Resolved open questions (SPEC §13)

### 2.1 Ctrl+1…9 collision

**Ctrl+1–6 applies heading levels. Ctrl+Alt+1–9 switches tabs.**

Hashpad is a writing app: headings are applied constantly, jumping to tab 7 almost never.
Matches Typora and Obsidian. `Ctrl+Tab` / `Ctrl+Shift+Tab` and the mouse already cover tab
switching well. `Ctrl+7/8/9` stay unbound; `Ctrl+Shift+7/8/9` remain the list commands per
SPEC §6.5. Both bindings appear in the menus with their shortcuts displayed, per SPEC §6.14.

### 2.2 Front matter in preview

**Rendered as a muted metadata card**, not hidden.

Silently dropping visible editor content breaks the preview's honesty and makes scroll sync
lie about position. The card is styled distinctly (muted, bordered, smaller than body text)
so it reads as metadata rather than content. Parsed with a naive split on the first colon —
see §6.3 for why not `js-yaml`.

### 2.3 Live preview in Phase 1

**No. Phase 2, but Phase 1 builds the seams.**

Two structural choices in Phase 1 so Phase 2 fills in logic rather than restructuring:

1. SPEC §6.6 syntax highlighting is implemented as **viewport-limited decorations derived
   from the Lezer tree** — the same machinery live preview needs.
2. `viewMode: 'source' | 'live' | 'split'` is a real field in the document model from day
   one. `'live'` is selectable and renders identically to `'source'` until Phase 2.

Live preview is where the project's risk concentrates. Phase 1's definition of done
(SPEC §12) is a Notepad replacement and is independently shippable. Mixing them risks
neither landing.

### 2.4 Vite bundle strategy

**Single core bundle**, with dynamic `import()` reserved for genuinely optional weight.

Assets load from Wails' embedded handler, so there is no HTTP waterfall to amortise and
parse/execute cost dominates. A single bundle avoids per-chunk overhead entirely.

Lazy-loaded: the preview module (the pane is off by default), CodeMirror language modes
(`@codemirror/language-data` is a table of dynamic imports by design), and in Phase 2
KaTeX and Mermaid.

---

## 3. Resolved spec conflict: zero network vs. remote images

SPEC §2.1 (zero network activity, CSP-enforced, functions identically with the cable
unplugged) and SPEC §6.7 (opt-in remote image loading, per-document button plus global
setting) cannot both hold. SPEC §2 states the constraint wins.

**Decision: the constraint wins. Remote images are never fetched.**

- The CSP omits `https:` from `img-src` permanently, so remote images *cannot* load even
  if a bug tried to make them. §2.1 is enforced structurally, not by convention.
- A remote `![](https://…)` renders as a muted placeholder showing the URL, with a
  click-to-open-in-system-browser affordance.
- **No HTTP client is compiled into the binary.** The zero-network claim is provable
  rather than promised.
- SPEC §6.7's per-document "Load remote images" button and the
  `preview.loadRemoteImages` setting are **removed**.

Local images are unaffected — see §5.7.

### 3.1 Note on local images

Local images are **path references, not embedded data**. `![](assets/pic.png)` points at a
separate file resolved relative to the `.md`. Moving the `.md` without its `assets/` folder
breaks the reference. This is standard markdown behaviour and is what SPEC §2.6 requires.

Inline base64 embedding (`![](data:image/png;base64,…)`) was considered and rejected: one
pasted screenshot becomes 150–400 KB of base64 on a single line, wrecking editing
performance, diffs, and file size.

SPEC §7.3's HTML export already covers the share-a-single-file case by base64-embedding
local images at export time. That is the right place for it.

---

## 4. Deviations from SPEC

Every deviation, with rationale. Nothing here is a silent change (SPEC §11.4).

### 4.1 The `Platform` interface is slimmed from seven methods to three

SPEC §5.2 specifies seven methods. Three of them are not platform-divergent:

| Dropped | Why |
|---|---|
| `OpenFileDialog` / `SaveFileDialog` | Wails v2 already abstracts these cross-platform (native on Windows, GTK on Linux). Wrapping them adds a maintained layer that returns nothing. |
| `ReadClipboardImage` | The DOM `paste` event exposes `e.clipboardData.files` in both WebView2 and WebKitGTK. The frontend already holds the bytes; Go's job is `os.WriteFile`. Routing clipboard access through Go means solving the hard WebKitGTK clipboard problem for no reason. |
| `PrintToPDF` | `window.print()` works in WebView2, and export is Phase 2 regardless. Revisit when Phase 2 proves WebKitGTK needs a different strategy. |

The interface ships as:

```go
type Platform interface {
    SystemThemeIsDark() (bool, error)
    OnSystemThemeChange(fn func(isDark bool)) (stop func(), err error)
    ShowInFileManager(path string) error
}
```

`OnSystemThemeChange` is an **addition** — SPEC §6.12 requires live system theme change
detection, which §5.2's interface has no method for.

`platform_linux.go` still ships as compiling stubs returning `ErrNotImplemented`, per
SPEC §5.2. The interface grows when Phase 2 proves a need.

### 4.2 The store does not hold document text

SPEC §5.1 defines `Document.content: string`. Holding the text in the store *and* in
CodeMirror's `EditorState` is two sources of truth that will drift, and keeping them in
sync requires an `O(n)` `doc.toString()` on every keystroke.

**CodeMirror owns the text.** Each `Document` carries its own `EditorState`, swapped into
a single `EditorView` on tab switch. This is exactly what CM6's serializable state is for,
and it carries selection and undo history for free.

### 4.3 `savedContent: string` becomes `savedDoc: Text`

SPEC §5.1's principle — dirty state is derived, never stored as a flag — is preserved and
is the reason for the change. Dirty becomes `!editorState.doc.eq(savedDoc)` rather than a
string comparison. When nothing has changed the rope is reference-equal, so the check is
O(1) instead of O(n), which makes it affordable to call on every render.

After a successful save, `savedDoc = editorState.doc`.

### 4.4 `cursorPos` and `scrollTop` are dropped from `Document`

`EditorState` already tracks selection, and CodeMirror 6 provides `scrollSnapshot()` for
scroll restoration. Duplicating them invites the same drift §5.1 warns about.

### 4.5 The resulting document model

```typescript
interface Document {
  id: string;                 // crypto.randomUUID() — no uuid dependency
  filePath: string | null;    // null = never saved
  editorState: EditorState;   // text, selection, undo history
  savedDoc: Text;             // dirty = !editorState.doc.eq(savedDoc)
  viewMode: 'source' | 'live' | 'split';
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le';
  lineEnding: 'lf' | 'crlf';
}
```

### 4.6 The editor buffer is always LF

Go normalizes CRLF to LF when reading and restores the file's original ending on write.
SPEC §6.4's "never silently convert" is honoured at the file level — the file round-trips
unchanged — but the in-memory buffer is uniformly LF.

Rationale: mixing CRLF into a CodeMirror buffer makes column counts and every formatting
command's offset arithmetic subtly wrong.

### 4.7 Settings persistence moves earlier than Checkpoint H

SPEC §11.2 places settings at Checkpoint H, but Checkpoints D (theme, accent), E (toolbar
pinning), and G (zoom, word wrap, outline width) all need to persist. The settings
**model** — defaults, load, save, migration, portable-mode lookup, malformed-file backup —
moves to Checkpoint B, beside the file I/O it shares machinery with. The settings
**dialog** stays at Checkpoint H.

Similarly, `variables.css` is established in Checkpoint A rather than D. SPEC §5.3's
"the ONLY place colours are defined" is cheap to establish from the first line of CSS and
expensive to retrofit.

### 4.8 Mixed line endings

SPEC §6.4 does not cover files containing both CRLF and LF. **Decision:** detect the first
ending found, preserve it uniformly on save, and surface "mixed" in the status bar tooltip
so the flattening is visible rather than silent.

### 4.9 GitHub Actions workflow deferred

SPEC §9 asks for a release workflow. There is no repository yet, so this is deferred by
agreement. Checkpoint I still produces the portable exe and the NSIS installer.

### 4.10 The save prompt is an in-app modal, not a native dialog

**Added during Checkpoint B planning. Supersedes the note in §5.1.**

SPEC §6.3 requires a three-button **Save / Don't Save / Cancel** prompt, with Cancel
aborting an entire quit. §5.1 originally planned to get this from Wails'
`runtime.MessageDialog`. Reading the Wails v2.13.0 Windows implementation shows that is
impossible:

```go
case frontend.QuestionDialog:
    flags = windows.MB_YESNO      // two buttons; no Cancel
```

Wails ignores the `Buttons` field entirely on Windows, mapping `DialogType` to fixed Win32
button sets. `MB_YESNOCANCEL` is never used, so no three-button dialog is reachable — and
Cancel is the button §6.3 depends on most.

**Decision: build the prompt in the frontend using the native `<dialog>` element.**

- It is the only route to the exact Save / Don't Save / Cancel wording §6.3 names.
- `<dialog>` supplies real modal semantics, focus trapping, and Escape handling.
- It styles from `variables.css`, so it matches the theme instead of ignoring it.
- It is cross-platform by construction and needs **no platform-seam method at all**.
- The window is already frameless with fully custom chrome, so a system dialog would look
  more foreign here than a themed one.

Cost: it is not an OS dialog and will not inherit future OS styling changes. Accepted.

The rejected alternative was calling Win32 `MB_YESNOCANCEL` by syscall, which yields
Yes / No / Cancel — precisely the wording §6.3 avoids — and adds Windows-only code plus a
Linux equivalent for a dialog the app can render itself.

### 4.11 Tab tear-off to a second window: considered and declined

Raised in review after Checkpoint C: drag a tab out of the window to open it in a
second instance, and drag it back to close that instance. Investigated and declined —
recorded here so it does not resurface as an open question.

**Wails v2 supports exactly one window per application.** Multi-window is a Wails v3
feature, and v3 is still alpha (§1). So "another window" necessarily means another
*process*.

The two halves differ sharply:

- **Dragging out** is possible but conflicts with two spec decisions. SPEC §6.4 requires a
  single-instance lock so an Explorer double-click reuses the running app; that cannot
  coexist with spawning processes on demand. And transferring a tab with unsaved changes
  requires writing that content somewhere for the new process to read, which SPEC §6.3
  forbids outright.
- **Dragging back in cannot be done.** HTML5 drag-and-drop does not cross process
  boundaries — a webview cannot detect a drag that originated in another application.
  Chrome and VS Code implement tear-off with native OS window handling and mouse capture,
  owning the windowing layer. Here it would mean bespoke Win32 code, then a second
  implementation for WebKitGTK, against SPEC §2.4 — for a feature SPEC §8 lists as
  explicitly out of scope ("Multi-window — tabs are sufficient").

**The achievable subset, if it is ever wanted:** a tab context-menu "Open in New Window"
for **saved** files only, launching a second instance with that path. No unsaved-content
transfer, no cross-process dragging. The single-instance lock would need a launch flag so
a deliberate second window bypasses it while Explorer double-clicks still route to the
primary. Deferred by agreement; it would overturn SPEC §8's multi-window decision, which
is a product decision rather than a technical one.

### 4.12 Table is Ctrl+Alt+T, not Ctrl+Shift+T

**Added during Checkpoint E planning. SPEC collides with itself here.**

SPEC §6.5's command table gives Table the shortcut **Ctrl+Shift+T**. SPEC §6.2 and
§6.14 give that same chord to **Reopen Closed Tab**, which shipped in Checkpoint C and
is bound in `editor/extensions.ts` today.

**Decision: Reopen Closed Tab keeps Ctrl+Shift+T. Table moves to Ctrl+Alt+T.**

Reopen-tab wins because it is universal muscle memory — every browser and every editor
binds it — and because reassigning a working, shipped binding to a command a user
invokes far less often is the worse trade. `Ctrl+Alt` is already this project's
secondary namespace: §2.1 put tab positions on `Ctrl+Alt+1`…`Ctrl+Alt+9` for exactly
this kind of reason, and `Alt+T` was free, so Table keeps its `T` mnemonic.

Rejected: giving Table no shortcut at all. SPEC §6.5 lists a chord for every one of the
sixteen commands, and silently dropping one is the kind of quiet deviation §11.4 exists
to prevent.

**Known limitation, recorded rather than fixed:** `@codemirror/view` deliberately skips
its base-layout fallback when `windows && ctrlKey && altKey` (an AltGr guard), so this
chord matches only via `event.key === 't'`. On a layout where AltGr+T produces a
different character it will not fire. This is the same exposure the pre-existing
`Ctrl+Alt+1`…`9` bindings already carry, and it is on the manual-check list.

### 4.13 The code block command does not prompt for a language

SPEC §6.5 says the Code block command inserts a "fenced block, language prompt".

**Decision: no prompt. The fence is inserted with the cursor on the info string.**

Typing the language is then the natural next keystroke, and Enter or Down moves into the
block. A modal interrupting a formatting keystroke is worse than the friction it removes:
Bold does not stop to ask anything, and Code block is reached the same way, from the same
row, in the middle of the same sentence.

An earlier draft of this section justified the decision partly on jsdom being unable to
test a `<dialog>` at all. That was wrong and is corrected here rather than left standing:
jsdom implements `<dialog>` as a bare element without `close()`, which is partial rather
than absent, and Checkpoint B ships a real `<dialog>` save prompt whose builder was split
out from `confirmSave` precisely so it *is* testable under jsdom (see
`frontend/src/ui/confirmdialog.ts`). Testability is a mild argument here, not the reason.

Rejected: a dropdown of the languages `@codemirror/language-data` can highlight. That is
roughly 140 entries and would need filtering and search — a lot of UI for one command,
and it would still interrupt the keystroke.

### 4.14 SPEC §6.14's menu-reachability is satisfied by the overflow menu

SPEC §6.14 requires every keyboard shortcut to be reachable through a menu with the
shortcut displayed beside it. The sixteen formatting commands all have shortcuts.

**Decision: the `···` overflow menu is that menu.**

It is a menu, SPEC §6.5 already requires it to contain the full set of sixteen, it
displays each command's shortcut, and it is where a user looks for formatting. The
alternative — sixteen more entries in the Edit menu — would take that menu from four
flat items to twenty, in a bar SPEC §6.1 fixes at exactly four menus and which
`ui/menubar.ts` gives no submenu support.

Rejected: putting them in both places. Two surfaces to keep in sync, and the Edit menu
still ends up with twenty flat items.

### 4.15 An inline mark with nothing to wrap inserts a named placeholder

SPEC §6.5's Inserts column spells all five inline marks with the same filler word:
`**text**`, `*text*`, `~~text~~`, `==text==`, `` `text` ``.

**Decision: the placeholder names the construct, not the slot — `**bold**`,
`*italic*`, `~~strikethrough~~`, `==highlight==`, `` `code` `` — and comes out
selected.**

This started as a bug fix, not a preference. The command used to insert the two
delimiters back to back with the caret between them, which is what most editors do,
and it is wrong for markdown: block parsing runs before inline parsing, so a run of
delimiters alone on a line is claimed by the block grammar. `****` became a
`HorizontalRule`, `====` a `SetextHeading1` that promoted the line above it, and
`~~~~` an **unclosed fenced code block** that swallowed the rest of the document —
after which `inFencedCode` was true below it and every command but `codeBlock`
silently declined. Reported from the running app; see commit `587ad7f`.

A placeholder cannot be read as a block construct at any position, which is the
property being bought. Naming the construct rather than the slot is the smaller,
separate call: five identical `text`s in one paragraph would be unreadable, and the
word doubles as a label for what the button just did. The mechanism — insert a
placeholder, select it, let the first keystroke replace it — is already what `link`,
`image` and `table` do, so "press the button, then type" still costs one keystroke.

Rejected: declining when there is nothing to wrap. That removes the "turn bold on,
then type" workflow every editor supports, to fix a problem the placeholder fixes
without cost.

Rejected: keeping bare delimiters everywhere they are provably harmless and falling
back to a placeholder only on a line of their own. It preserves current feel exactly,
but at the price of a per-mark rule that has to stay correct as marks are added — and
the marks whose delimiters spell a block construct are not a fixed set.

### 4.16 Our highlight style is scoped to markdown; CodeMirror's styles embedded code

`markdownSupport` registers two highlight styles: ours, and CodeMirror's
`defaultHighlightStyle`, which exists to colour the contents of fenced code blocks
(§6.3). They share one stylesheet, and ours is registered so as to win any tie.

**Decision: `markdownHighlightStyle` carries `scope: markdownLanguage`.**

Without it the division of labour is only a convention, and it breaks in both
directions. Markdown tags our style had no rule for — `labelName`, `atom`, `escape`,
`character`, `comment`, `string`, `contentSeparator` — silently fell through to
`defaultHighlightStyle`'s built-in palette, which is tuned for a white page. Measured
against `--bg-editor`: five of the seven land between 1.33:1 and 2.64:1 on the dark
theme, and `escape`'s `#e40` inverts the problem, clearing dark at 4.54:1 while
failing *light* at 3.84:1. And the rules that close that gap name *generic* tags
every nested code grammar emits too, so unscoped they would repaint the string
literals inside every fenced block.

`@lezer/highlight` applies the scope filter at `type.isTop` and again at each mounted
sub-language (`highlightRange`), so it reaches every node of the markdown tree and
stops at any embedded grammar. Both directions are pinned by tests.

Three consequences, all measured rather than assumed:

- `parseCode` mounts only `HTMLBlock`, `HTMLTag` and `CommentBlock`. Those keep
  `defaultHighlightStyle`'s colours. An *inline* `<!-- comment -->` is a plain
  `Comment` node with no mount, so a scoped `tags.comment` rule does reach it — which
  is the only reason that rule can exist without also recolouring the comments inside
  every fenced code block. An earlier draft of this section said inline comments were
  mounted and used that to justify having no rule at all; that was wrong, and the
  inline comment was leaking `#940` at 2.64:1 as a result.
- Every language `@codemirror/lang-markdown`'s `mkLang` builds shares one
  module-level `data` facet, and the filter is `h.scope(mounted.tree.type)`. So a
  mounted *markdown* sub-tree — a ```` ```markdown ```` fence — passes the filter and
  is still fully styled by us, headings sized and all. Unchanged from before the
  scope, and arguably right, but this does not "stop at every embedded grammar".
- Two things lose our styling and gain CodeMirror's, both inside fenced code:
  `<?xml …?>` and `<?php` / `?>` carry `tags.meta`, so they go from `--syn-marker` to
  `#404740` (1.82:1 dark). Booked under the open problem below rather than fixed.

The same property-union hazard as the heading underline (§4.16's sibling case) also
applied to **links**: `defaultHighlightStyle`'s `tags.link` rule sets
`text-decoration: underline`, and ours set only a colour, so every inline `[t](u)`
and `![alt](u)` was underlined — brackets, parens and title included — while
`<autolink>` and `[label]: url` were not, since those carry `url` without `link`.
Ours now sets `textDecoration: 'none'` explicitly. Links remain distinguished by
`--syn-link`, and source mode shows the bracket syntax regardless.

**Closed by §4.18, and it was larger than this decision:** `defaultHighlightStyle` is
CodeMirror's *light* palette, and it used to colour all fenced code in both themes. On
`#1a1a1a` its values run from about 1.33:1 to 2.6:1 — dark-mode fenced code was largely
illegible, and fixing it meant a dark code palette, not another rule. Checkpoint F built
one; §4.18 records it. Everything above still describes the division of labour
correctly, but the style our rules now share the stylesheet with is
`codeHighlightStyle`, not `defaultHighlightStyle`, and the `#404740` and `#940` leaks
named above are gone with it.

### 4.17 Preview scroll sync is line-anchored, not proportional by pixel

SPEC §6.7 says the two panes scroll "proportional by position". The literal reading is
a pixel fraction: `preview.scrollTop = editor.scrollTop / editorMax * previewMax`. Five
lines, no state, and wrong the moment rendered height diverges from source height —
which is the normal case, not the edge one. A tall image is *one* source line and
several hundred rendered pixels. A twenty-line fenced block often renders *shorter*
than its source. Front matter is a dozen source lines and one small card. In a document
with any of those, a pixel fraction puts the panes visibly out of step in the middle
while agreeing perfectly at both ends, which reads as a bug that comes and goes.

**Decision: every block element carries `data-source-line`, and sync interpolates
between the two anchors bracketing the top visible line.** Owner's call, taken
2026-08-11.

Rejected alternatives:

- **Pixel fraction** (above). Cheapest, and the plain reading of the spec. Rejected on
  the divergence cases, which are the cases the preview exists for.
- **Sync only editor → preview.** Needs no re-entrancy guard at all, which is the whole
  cost of bidirectional sync. Rejected because scrolling the preview and having it snap
  back on the next keystroke is a worse experience than the guard is a maintenance
  burden. The guard is an `applying` flag cleared on the next animation frame; the
  browser fires `scroll` asynchronously after `scrollTop` is assigned, so it cannot be
  cleared synchronously.
- **Sync by caret rather than by scroll position.** Simpler mapping (one line number,
  no interpolation), but it only updates when the caret moves, so scrolling with the
  wheel or the scrollbar — the common case — would not move the other pane.

Two things make the price lower than it looks. The anchor map is exactly the structure
Checkpoint G's document outline needs, so it is built once rather than twice. And
`data-source-line` is emitted by one small markdown-it rule
(`preview/rules/sourceline.ts`), not threaded through the renderer.

**The residual inaccuracy is known and recorded rather than fixed:** a fenced block's
`data-source-line` lands on the inner `<code>`, not the `<pre>`, so its measured top is
the top of the first line box — one padding below the block's real top. Small, and
`docs/testing.md`'s scroll-sync checks ask a human whether it is visible.

### 4.18 Fenced code takes its own `--syn-code-*` palette, shared by both panes

Until Checkpoint F, fenced code in both the editor and (about to be) the preview was
coloured by CodeMirror's `defaultHighlightStyle`. That is a *light* palette with
hard-coded values; against the dark `--bg-editor` its colours measured 1.33:1 to 2.6:1
(§4.16). It also violates SPEC §5.3 by construction — those colours are defined in a
node module, not in `variables.css` — which is not a technicality here, because it is
why they could not follow the theme.

**Decision: ten `--syn-code-*` tokens per theme in `variables.css`, driving one
`HighlightStyle` (`editor/codetheme.ts`) registered by both the editor and the
preview's markdown-it `highlight` hook.** Owner's call, taken 2026-08-11. Starting
values are adapted from GitHub's Primer palettes, which are themselves contrast-tuned;
every one is asserted at 4.5:1 or better in both themes by `editor/codetheme.test.ts`,
which reads the token list out of the emitted CSS rather than from a hand-written list,
so a renamed or added token cannot slip past it.

**The assertion is against every surface the tokens are composited over, not just
`--bg-editor`, and that distinction caught a shipped failure.** Code tokens are never
painted on the plain editor background: `editor/highlight.ts` gives `tags.monospace` a
`--syn-code-bg` background and `styles/preview.css` gives `pre` and inline `code` the
same tint. An earlier version of this section — and of the test — named `--bg-editor`
alone, under which `--syn-code-keyword` `#8250df` measured 5.05:1 and passed, while
rendering at **4.43:1** on the tint. That is every keyword in every light-theme fence,
below AA. Retuned to `#6f42c1` (5.71:1 on the tint), and the test now iterates both
surfaces. `variables.css`'s own header had already stated the rule the test was
breaking: check every surface a token lands on, not the one the file happens to name.

Rejected alternatives:

- **Keep `defaultHighlightStyle` and override only the worst tokens.** Smaller diff.
  Rejected because the overrides would live wherever we put them while the base
  palette stayed in a dependency: the next CodeMirror release could reintroduce the
  problem silently, and SPEC §5.3's "one place colours are defined" would be false in a
  way no test could state.
- **A separate palette for the preview.** The preview is HTML and could have taken plain
  CSS classes. Rejected on §6.3's own argument for bridging to Lezer in the first place:
  the point of reusing the editor's parsers is that the two panes agree by construction.
  Two palettes would let them disagree, and the same fence would be two different
  colours a pane apart.
- **A third-party highlighter for the preview** (highlight.js, Shiki). Already declined
  in §6.3 on dependency weight; a second palette to maintain is a further reason.

Two consequences worth naming. `codeHighlightStyle` had to take over every tag
`defaultHighlightStyle` used to cover, and the first draft dropped `inserted`, `deleted`
and `meta` — a ```` ```diff ```` fence rendered with zero spans, which reads as
deliberate rather than broken; `codetheme.test.ts` now asserts coverage positively, on
real fences. And in the dark theme `inserted` deliberately repeats `type` and `deleted`
repeats `invalid`: neither pair co-occurs in a way a reader would need to tell apart,
and separate token names keep them independently retunable. Both are noted in
`variables.css` so they do not read as oversights.

### 4.19 The max content width ships off, not at 900

SPEC §6.13's settings block shows `"maxContentWidth": 900`. SPEC §6.1's prose, in the
same document, describes "an **optional** max content width so long lines stay
readable on wide monitors".

**Decision: the setting exists and works; its default is `0`, meaning no limit.**

Checkpoint H.1 shipped it at 900 and the result was reported twice, from two
angles. First the column was centred, so the editor's text began about a third of the
way across a maximised window -- fixed by left-aligning it. Then, left-aligned, the
complaint was the other half of the same thing: the text "scales great until some
point, from which it just stops scaling and it has a big gap on the right".

Both reports are the cap being visible by default. A measure is a reading preference,
and on a 1080p-or-wider display a 900px cap is off by enough to look like a layout
bug rather than a choice. Nothing else about Hashpad's default look asks the window
to be partly empty: SPEC §6.1's own layout sketch shows the editor filling its area,
and its "roughly 24px horizontal" padding describes a full-width column.

Kept, not removed: the setting is real, it is honoured in both panes, and Checkpoint
H.4's dialog will expose it. `0` is the only way settings.json can spell "no limit" --
there is no null and every positive number is a width -- and it maps to the CSS
keyword `none`, so no stylesheet needs a special case.

Rejected: keeping 900 and letting the user turn it off. That makes the first launch
the worst one, for a feature most users will not know exists or think to look for.

Pinned by `TestDefaultContentWidthIsUnlimited` (Go) and "leaves the width uncapped on
the shipped defaults" (`settings/typography.test.ts`), because a default is exactly
the kind of value that a round-trip test will happily carry whatever it is set to.

---

## 5. Architecture

### 5.1 The Go↔TS boundary

Narrow and markdown-ignorant. Go handles the filesystem and the OS and never parses
markdown, per SPEC §3.1.

Bound methods on `App`:

```
ReadFile(path)                          -> {content, encoding, lineEnding, path}
WriteFile(path, content, enc, ending)   -> error
OpenFileDialog()                        -> []path      (multi-select)
SaveFileDialog(suggestedName)           -> path
WriteAsset(docPath, data, ext)          -> relPath     (pasted images)
ShowInFileManager(path)                 -> error
LoadSettings()                          -> Settings
SaveSettings(settings)                  -> error
ConfirmClose(filename)                  -> "save" | "dontsave" | "cancel"
SystemThemeIsDark()                     -> bool
```

Events Go→TS:

```
file:open-requested     // single-instance launch args, CLI args
theme:system-changed
app:close-requested     // from OnBeforeClose
```

**Superseded during Checkpoint B — see §4.10.** This section originally specified a
`ConfirmClose` bound method using Wails' native message dialog. That is not achievable on
Wails v2, and the prompt is now built in the frontend instead. `ConfirmClose` is therefore
**not** part of the bound-method surface.

### 5.2 Encoding and line endings

Go owns the bytes↔string conversion entirely. It detects UTF-8, UTF-8 with BOM, and
UTF-16LE, returns a normalized UTF-8 string plus `{encoding, lineEnding}` metadata, and
re-encodes on write. The frontend never sees bytes.

This makes SPEC §10's required tests pure Go table tests with no webview involved.

### 5.3 State store

`state/store.ts` — plain TypeScript, no framework, per SPEC §3.

```typescript
createStore<AppState>(initial) -> { getState, setState, subscribe }
```

Subscription takes a selector plus a shallow-equality check, so the status bar does not
re-render on a theme change. Components subscribe on mount and return their unsubscribe.
Components never hold authoritative state (SPEC §5.1).

### 5.4 Formatting commands

`editor/commands.ts` exports pure functions:

```typescript
(state: EditorState) => TransactionSpec | null
```

A thin adapter wraps each into a CodeMirror `Command` for keymap and toolbar binding — one
implementation, two triggers, per SPEC §6.5.

The purity is deliberate: SPEC §10 requires Vitest coverage of every command's selection
and toggle edge cases, and pure functions make those fast and DOM-free rather than
requiring jsdom plus a real `EditorView`.

Toolbar active state is computed by reading the Lezer syntax tree at the cursor and
publishing the result to the store on selection change.

### 5.5 Theming

`styles/variables.css` holds every colour token. The CodeMirror theme and `HighlightStyle`
are built with `var(--…)` references.

Consequence: switching themes is one `data-theme` attribute on `<html>`, and the accent
picker is one inline `--accent` on `:root`. **No CodeMirror reconfiguration, no
re-instantiation, no flash of unstyled content** — which is what makes SPEC §5.3's
"five-line feature" claim literally true.

### 5.6 Content Security Policy

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
base-uri 'none';
form-action 'none';
```

`img-src` omits `https:`, enforcing SPEC §2.1 structurally.

**Known relaxation:** `style-src` requires `'unsafe-inline'` because CodeMirror's
`style-mod` injects `<style>` elements at runtime and nonces do not apply reliably to
dynamically created ones. This permits no network access and no script execution;
combined with DOMPurify stripping `style` attributes the residual risk is narrow, but it
is not zero and is recorded here rather than buried.

### 5.7 Serving local document images

`<img src="assets/pic.png">` in the preview resolves against the webview origin
(`http://wails.localhost`), not the document's directory. Local images therefore do not
load without help.

Preview rendering rewrites relative image paths to a dedicated route. Wails'
`AssetServer.Handler` catches those GETs (the bundled assets cannot serve them) and a Go
handler reads the file from the **active document's directory**.

Two properties this buys: requests stay same-origin so `img-src 'self'` covers them with
no CSP relaxation, and there is exactly one place to reject path traversal outside the
document's folder.

---

## 6. Dependency budget (SPEC §2.5)

**No dependency outside those SPEC §3 and §6.8 already name is being added.**

### 6.1 Go — Phase 1

`github.com/wailsapp/wails/v2`. That is the entire list.

Deliberately avoided:

- `golang.org/x/text` for UTF-16LE — stdlib `unicode/utf16` + `encoding/binary` does it in
  roughly 30 lines, and SPEC §10 requires those tests regardless.
- `github.com/google/uuid` — `crypto.randomUUID()` exists in both target webviews.

Phase 2 adds `github.com/fsnotify/fsnotify` for SPEC §7.4, as specified.

### 6.2 Frontend — shipped in the binary

CodeMirror 6: `@codemirror/state`, `/view`, `/commands`, `/language`, `/search`,
`/lang-markdown`, `/language-data`, plus the `@lezer/*` and `style-mod` packages they pull
in transitively.

Markdown: `markdown-it`, `markdown-it-mark`, `markdown-it-footnote`, `dompurify`.

Sizes are to be measured, not estimated — a per-package bundle report is produced at
Checkpoint A.

### 6.2.1 `==highlight==` in the editor: an addition, at no dependency cost

Added during Checkpoint E. SPEC §6.8 lists `==highlight==` as supported markdown and
§6.5 gives it a toolbar button and a shortcut, but `@lezer/markdown` has no node for it —
CommonMark and GFM both stop at `~~`. Without one, the editor could not style it and the
Highlight button could not show active state the way the other four inline marks do.

**Roughly 25 lines of our own code** against `@lezer/markdown`'s public `MarkdownConfig`
API, modelled on that package's own `Strikethrough` extension. **No package added** —
which is precisely why no `markdown-it-mark` equivalent appears on the editor side; the
preview will use the real plugin at Checkpoint F, but the editor's grammar is ours.

Three packages were promoted from transitive to direct dependencies at the same time
(`@codemirror/language`, `@lezer/markdown`, `@lezer/highlight`). All three were already
bundled — the promotion makes an existing dependency explicit and costs zero bytes,
the same situation as `golang.org/x/sys` in Checkpoint D.

### 6.3 Dependencies declined

| Need | Off-the-shelf option | Decision |
|---|---|---|
| GFM task list checkboxes (SPEC §6.8) — markdown-it does not render these natively | `markdown-it-task-lists`, small but effectively unmaintained | ~25 lines of custom markdown-it rule |
| YAML front matter for the metadata card (SPEC §6.8) | `js-yaml`, ~60 KB | Naive split on the first colon; covers title/date/tags/author, i.e. essentially all real front matter. Shows the raw line if it does not split. |
| Syntax highlighting inside preview code blocks (SPEC §6.7 is silent) | highlight.js, Shiki — both heavy | Bridge to CodeMirror's own Lezer parsers and `HighlightStyle`. Zero new dependencies, and editor and preview agree by construction, per SPEC §3.1's one-source-of-truth reasoning. |

### 6.4 Language mode curation — measured, and abandoned

**This section described a decision that does not work. It is corrected rather than
deleted, because the assumption behind it is an easy one to make again.**

The original decision was: `@codemirror/language-data` references roughly 130 language
packages, they are lazy at runtime but Vite embeds all of them in the binary, so curate
about 20 common languages in a single exported array — trivial to extend, meaningfully
smaller binary.

**Checkpoint D task 5 implemented it, measured it, and removed it.** A build with the
21-name filter and a build passing `languages` through unfiltered came out **within 4
bytes of each other**, in the main entry chunk and in the total `dist/` output alike.
Rollup's code splitting follows the *static* `import()` call sites in language-data's own
module — one per language, all ~140 always present in that one file — not which array
elements survive a `.filter()` at runtime. Every grammar chunk is emitted regardless of
whether our code ever references that particular `LanguageDescription`; filtering the
array we hold a reference to cannot un-emit a chunk Rollup already decided to build from
the dependency's source. The full comparison is in that task's report.

With the size rationale gone, the filter cost complexity — a hand-maintained list that
has to track upstream renames — for a strictly worse result: fewer fenced-code languages
highlight, for a build that is the same size either way.

**Decision, as shipped:** `frontend/src/editor/languages.ts` exports
`@codemirror/language-data`'s `languages` unmodified. Its header comment carries the same
reasoning at the call site, since that is where someone would next think of trimming it.
A smaller binary from this direction needs a build-time change — a Rollup plugin, or
vendoring a trimmed `language-data` — not a runtime filter.

### 6.5 Dev dependencies — never shipped

`vite`, `typescript`, `vitest`, `eslint` + `@typescript-eslint`, `prettier`. On the Go
side, `golangci-lint`.

---

## 7. Making SPEC §2.3's budgets enforceable

The three budgets are binary under 25 MB, cold start under 500 ms, and under 100 MB RAM
with five tabs open.

Honest assessment: **binary size is very controllable, cold start is tight, and the 100 MB
RAM figure may not survive contact with WebView2.** WebView2 runs a multi-process browser.
Whether Hashpad lands under 100 MB depends substantially on whether the figure counts our
executable's private working set, the private total across the WebView2 process tree, or
total commit.

Rather than promise a number now or discover the answer at Checkpoint I, Checkpoint A
delivers a standalone `scripts/measure.ps1` (Checkpoint I wraps it as a `Taskfile.yml`
target, once a task runner is installed) that reports:

- release binary size
- time to first paint, averaged over N runs (a `performance.now()` mark the frontend
  reports to Go)
- working-set samples across the whole process tree with five files open, reported as
  **all three memory figures**

The numbers are then reproducible and comparable across every subsequent checkpoint. If
the honest total exceeds the budget, that is a conversation at the first checkpoint rather
than a surprise at the last.

Levers if we are over: `-ldflags "-s -w"`, the curated language set, deferring the preview
module, and UPX (tested against antivirus heuristics per SPEC §9).

---

## 8. Testing

**Go table tests** for the areas SPEC §10 names, including edge cases decided here: empty
files, BOM-only files, byte sequences that resemble UTF-16 but are not, mixed line endings
(§4.8), settings load/migrate/malformed/backup, and asset path resolution including
traversal rejection.

**Vitest on `commands.ts`**, written test-first at Checkpoint E. The toggle-and-selection
edge cases SPEC §10 calls out are where test-first pays for itself, and the pure-function
command design (§5.4) makes the tests fast and DOM-free.

**`docs/testing.md`** manual checklist for the flows automation will not reach —
dirty-close prompts, drag-and-drop, encoding round-trips, external file changes.

---

## 9. Platform-specific surface (SPEC §11.5)

Four locations, each flagged in code with a `// PLATFORM:` comment:

1. `internal/platform/platform_windows.go` — registry theme read, `WM_SETTINGCHANGE` live
   detection, `explorer.exe /select,` for reveal-in-file-manager
2. `main.go` — `SingleInstanceLock` unique ID, plus the `WindowUnminimise` + `Show`
   follow-up the Wails documentation warns is required
3. `wails.json` and `build/windows/` — NSIS configuration, icons, file associations
4. `styles/variables.css` — the UI font stack (Segoe UI Variable → Segoe UI → system sans)

---

## 10. Checkpoint sequence

Per SPEC §11.2, with the amendments in §4.7. Each checkpoint stops for the user to run it
and give feedback.

| # | Checkpoint | Contents |
|---|---|---|
| **0** | Toolchain | Install Go, Node, Wails CLI. `LICENSE` (MIT), `README.md`, directory skeleton. |
| **A** | Scaffold | Wails window, menu bar, CodeMirror mounted, type-and-see-text. Plus: `variables.css` token set, the store, the CSP, and `scripts/measure.ps1` (§7). |
| **B** | Files | Open / save / save-as, encoding and line-ending detection, dirty tracking, Save/Don't Save/Cancel prompts. Plus the settings model (§4.7). |
| **C** | Tabs | New, close, reopen, switch, reorder, middle-click, overflow scroll, path tooltips. |
| **D** | Highlighting & theme | Viewport-limited Lezer decorations (§2.3), light/dark themes, accent picker, system theme following. |
| **E** | Toolbar | All sixteen commands, test-first. Pinning, overflow menu, active state. |
| **F** | Preview | markdown-it, DOMPurify, front matter card, remote-image placeholders, local image serving, sync scroll. |
| **G** | Editing features | Find/replace, zoom, word wrap, status bar, outline, drag-and-drop, pasted images. |
| **H** | Settings dialog | The modal. Model already exists from B. |
| **I** | Build | Portable exe, NSIS installer, `Taskfile.yml`. GitHub Actions deferred (§4.9). |

Phase 2 is planned separately after Phase 1 ships.

### 4.20 The menu bar has five menus, not four

SPEC §6.1 draws the bar as `File  Edit  View  Help`. Hashpad ships a fifth,
**Tabs**, between View and Help.

**Why.** Every tab command lived in View: Next Tab, Previous Tab, Move Tab Left,
Move Tab Right, and Go to Tab 1 through 9 — thirteen entries, more than half the
menu, sitting above the theme radios. SPEC §6.14 is what put nine of them there
("every shortcut must also be reachable through a menu, with the shortcut
displayed beside it"), and that requirement is not negotiable: a single summary
line would show the chord without being invocable. So the choice was never
"thirteen items or fewer", it was "thirteen items in View, or thirteen items
somewhere sensible".

`menubar.ts` used to carry a comment justifying the first: *"SPEC §6.1 fixes the
bar at exactly four menus, so tab management has to live inside one of those."*
That is reasoning from the constraint rather than from the result, and the
result was a View menu you had to scroll past to reach the theme.

**Scope of the deviation.** One extra top-level menu. No command ids changed, so
every keybinding and every route in `main.ts` is untouched — this is purely
which menu the items render in. §6.14 is still satisfied: all thirteen are still
menu-reachable with their shortcuts displayed.

**What did not move.** Close Tab (Ctrl+W) and Reopen Closed Tab stay in File.
They are tab commands, so consistency argues for moving them, but Ctrl+W under
File is a strong enough Windows convention that the tidiness is not worth it.

**Named Tabs, not Macros.** "Macros" was the alternative proposed. Tabs describes what the
items are, and leaves that word free for recorded or scripted macros, which is
what it means in every other editor.

Menu separators were added alongside, which is the other half of why thirteen
items in one list had been uncomfortable — `menubar.ts` had carried a comment
apologising for their absence since Checkpoint A.

### 4.21 The 100 MB RAM budget is missed, at 135 MB

SPEC §1.3 sets three budgets: binary under 25 MB, cold start under 500 ms, and
**under 100 MB RAM with five tabs open**. The first is met with room to spare
(12.7 MB). The third is not, and this records the measurement rather than the
estimate that stood in for it.

**Measured 2026-08-27**, release build, five tabs open, on the development machine.
Seven processes, all rooted at `hashpad.exe`:

| Process | Working set | Private |
|---|---|---|
| `hashpad.exe` (Go) | 99.3 MB | 63.3 MB |
| webview2 main | 119.1 MB | 38.3 MB |
| renderer | 106.0 MB | 48.9 MB |
| gpu-process | 58.0 MB | 18.9 MB |
| utility ×2 | 56.9 MB | 20.9 MB |
| crashpad-handler | 11.5 MB | 2.9 MB |

**"RAM used" is not one number**, which is half of why this was deferred rather
than answered:

- **450.8 MB** — sum of working sets. Overstates badly: Chromium shares pages
  between its processes and this counts them once per process.
- **193.2 MB** — sum of private bytes (commit).
- **135.4 MB** — sum of *active private working set*. This is the figure Task
  Manager reports, it is the fairest of the three, and it is the one this
  deviation is written against.

**Why it is a floor rather than a defect.** The overshoot is fixed cost, not
per-tab. Five tabs of markdown is a few kilobytes of text; the renderer's
48.9 MB private is approximately what an *empty* Chromium renderer costs, and
the GPU process, the two utility processes and the crashpad handler exist
identically with one tab open. There is no per-tab growth to optimise away.

**One lever exists and was declined.** Wails can start WebView2 with the GPU
process disabled, which is the 58 MB / 18.9 MB row. It costs scrolling
smoothness in an editor — the one interaction the app is for — and even taking
it would land around 116 MB, still over. Rejected on both counts.

**What the budget was really arguing against.** §1.3's own table justifies Wails
as "~10–20 MB instead of Electron's 150 MB+". That is the *binary*, and it holds:
12.7 MB against a 25 MB budget. The RAM figure was written in the same breath,
but Electron and WebView2 are both Chromium underneath, so the runtime saving
was never going to be proportional to the download saving. Hashpad genuinely is
lighter than an Electron equivalent — by roughly the binary difference, not by
the runtime one.

**What stays a gate.** Binary size and cold start remain real, checkable
budgets. This deviation is scoped to the RAM figure alone, and the number is
recorded so a future regression is visible against 135 MB rather than against a
budget nothing has ever met.

**How to re-measure.** Walk the process tree down from `hashpad.exe` by
`ParentProcessId` — not by image name, because Windows runs its own
`msedgewebview2` processes under `SharedWebView\EBWebView` and those are not
ours — then sum `WorkingSetPrivate` from
`Win32_PerfRawData_PerfProc_Process` across the tree. docs/testing.md carries
the procedure as a checklist item.

### 4.22 UPX compression is skipped

SPEC §9 says to build with UPX "if it doesn't trip antivirus heuristics — test
this". The decision, 2026-08-27, is to skip it. It was not measured;
the argument below did not depend on the measurement.

**What UPX would buy.** Go binaries typically compress 55–65%, so 12.7 MB would
land somewhere near 5 MB. Estimated, not measured.

**Why that is worth nothing here.** SPEC §1.3's binary budget is 25 MB and the
build sits at 12.7 MB, winning by 12 MB. The other two budgets are the ones
under pressure, and UPX works against both:

- **Cold start.** UPX prepends a stub that decompresses the entire image into
  memory before `main` runs, on every launch. §7 called cold start the tight
  budget of the three.
- **RAM.** The decompressed image is private dirty memory rather than a
  file-backed mapping Windows can drop under pressure. §4.21 already records
  that budget missed at 135 MB.

So the trade is to spend the two budgets being lost to improve the one being
won comfortably.

**On the antivirus question**, which is what SPEC asked to test. UPX is a
runtime unpacker, which is structurally what packed malware uses to hide a
payload from a static scanner, and it is the commonest packer in commodity
malware — so heuristics weight it heavily. The tells are concrete: `UPX0`/`UPX1`
section names, an import table holding little more than `LoadLibraryA` and
`GetProcAddress`, an entry point in a section with no raw data, near-maximum
entropy. There is no way to have those and not look like a packer.

**SmartScreen is a separate thing and is not about packing at all.** It is
reputation, keyed on the exact binary hash, and an unsigned build starts at zero
every time it is rebuilt. That is what was observed as a slow first launch
during Checkpoint H. The fix for it is a code-signing certificate, which SPEC §9
already rules out for now; a certificate would also soften the heuristic
question, but a signed packed binary is still a packed binary.

Testing this honestly would mean testing against real antivirus engines rather
than one, which is not something this project can do. Skipping is recorded here
rather than left as an untested build flag.

### 4.23 Four file associations, not two

SPEC §9 says the installer registers `.md` and `.markdown`. It registers four:
`.md`, `.markdown`, `.mdown`, `.mkd`. Decided 2026-08-27.

SPEC §6.4 lists eight extensions Hashpad *opens*. That list and the list it
*claims from Explorer* are different questions, and the eight split cleanly:

| | Extensions | Claimed? |
|---|---|---|
| The same format under different names | `.md`, `.markdown`, `.mdown`, `.mkd` | **Yes** |
| Markdown plus something Hashpad cannot run | `.mdx` (JSX), `.qmd` (Quarto), `.rmd` (R Markdown) | No |
| Not markdown at all | `.txt` | No |

The first four are interchangeable — rename a file between them and nothing
about its content changes — and **nothing else on Windows claims any of them**,
so registering all four takes no file type away from another program and means
an old `.mkd` from some 2012 project opens on a double-click like any other.

The last four all have real owners. `.txt` is Notepad's. `.mdx` is normally a
code editor's. `.qmd` and `.rmd` belong to Quarto and RStudio, and Hashpad
cannot execute the code chunks that are the entire point of those formats —
claiming them would be actively wrong, not merely presumptuous.

Registration stays **opt-in at install time** either way, as SPEC §9 requires.

The gap this opens is that `wails.json` and `ui/filedrop.ts` now hold two
different lists that must stay compatible: an extension registered but not
opened would launch Hashpad on a double-click and then silently do nothing.
`files/openwith.test.ts` reads `wails.json` and asserts every associated
extension is one the frontend accepts.

### 4.24 Two executables from one codebase, differing by one link-time marker

SPEC §9's portable artifact "writes nothing outside its own folder **when a
local settings.json is present**", and SPEC §6.13 makes that file's presence the
switch. Neither says who creates it. Shipping a zip with a seed file would
satisfy both, and was the plan until a better one was asked for,
2026-08-27: **one bare exe that is portable from its first launch**, with the
installer as a separate download.

So the portable build creates the file. The installed build does not. That is
the entire difference between the two binaries:

```
-ldflags "-X hashpad/internal/app.portableBuild=true"
```

**Why not make it runtime behaviour.** Deciding portability by asking whether
the executable's folder is writable would need no build flag, and it is wrong
in the case that matters: a per-user install lands in
`%LOCALAPPDATA%\Programs\Hashpad`, which *is* writable, so an installed copy
would quietly go portable. Under a machine-wide install the same rule would put
one shared settings file where a second user cannot write it. The build knows
which artifact it is; the runtime can only guess.

**Why the marker is a string.** `-X` sets nothing else. `portableBuild == "true"`
reads oddly next to a real bool, and the alternative — a build tag — would mean
two compilation paths and a whole file that ordinary `go test` never sees.

**The failure mode this creates, and the guard for it.** `-X` against a symbol
path that does not exist is **not an error**. The linker ignores it, the build
succeeds, and the result is an executable that is simply not portable, with no
diagnostic anywhere. Measured, not assumed: a deliberately misspelled package
path produced `"false"` and printed nothing. `TestPortableMarkerMatchesTheBuild`
runs under the portable build's own ldflags with `HASHPAD_EXPECT_PORTABLE=true`
and fails loudly when the path is wrong; an ordinary `go test` skips it. The
portable build task runs it before building.

**What remains shared.** Which settings file wins once one exists is identical
in both builds, so SPEC §6.13's escape hatch — drop a `settings.json` beside any
Hashpad.exe to make that copy portable — still works on the installed binary.

**The cost, stated.** Run the portable exe straight out of `Downloads\` and a
`settings.json` lands in `Downloads\`. That is what portable means; it is also
why the installed build does not do it.
