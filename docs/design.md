# Hashpad Phase 1 — Design

**Date:** 2026-07-27
**Status:** Approved
**Scope:** Phase 1 (SPEC.md §6). Phase 2 is out of scope except where noted as a seam.

This document records the decisions made while planning against `SPEC.md`. `SPEC.md`
remains the authority on *what* Hashpad does. This document covers *how*, and records
every place the implementation deviates from the spec and why.

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

Raised by the owner after Checkpoint C: drag a tab out of the window to open it in a
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
is the owner's call to make.

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

### 6.4 Language mode curation

`@codemirror/language-data` references roughly 130 language packages. They are lazy at
runtime, but Vite embeds all of them in the binary.

**Decision:** curate approximately 20 common languages in a single exported array
(JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, C/C++, Java, C#, HTML, CSS, JSON,
YAML, XML, SQL, shell, PHP, Ruby, Markdown). Trivial to extend, meaningfully smaller
binary. Final list confirmed against what `language-data` actually offers.

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
