# Hashpad — Requirements Specification

**Hashpad** is a lightweight markdown editor for Windows, designed from the
outset to be portable to Linux with minimal effort.

This document fixes what the application must do, what it must never do, and the
budgets it has to fit inside. It was written before any implementation existed
and was the reference for every decision that followed. It is preserved here as
written, so that the record of what was asked for stays separate from the record
of what was built.

Where the implementation departs from this specification — and it does, in
twenty-six places — each departure is recorded with its reasoning in
[`docs/design.md`](docs/design.md) §4.

**The requirements below have not been revised to match what was built.** Where
this document and the software disagree, that disagreement is the point: it is
what makes §4 a record rather than a rationalisation. A specification edited
after the fact to agree with its own implementation documents nothing.

---

## 1. Mission

**"Notepad, but for markdown."**

Every existing option fails in at least one way: bloated Electron apps, subscription paywalls, cloud sync nobody asked for, telemetry, or a UI so complex it's a second job to learn. Hashpad is the boring, fast, private alternative that opens instantly and gets out of the way.

Design north star: if a feature would make a first-time user pause and think "what does this do?", it belongs in a menu, not on screen.

---

## 2. Non-negotiable constraints

These are hard requirements. Where one conflicts with a feature, the constraint wins and the feature is what changes.

1. **Zero network activity.** No telemetry, no analytics, no crash reporting, no auto-update checks, no CDN-loaded assets, no remote fonts. The app must function identically with the network cable unplugged. Every dependency is bundled locally at build time. A Content Security Policy must enforce this at the webview level, not merely by convention.
2. **No cloud, no accounts, no sync.** Files live on disk. That is the entire storage model.
3. **Lightweight for real.** Budgets: binary under 25 MB, cold start under 500 ms on a mid-range machine, under 100 MB RAM with five tabs open. A dependency that threatens them is raised before it is added, not after.
4. **Cross-platform from the start.** Windows 10 (1809+) and Windows 11 now; Linux later. All OS-specific code lives behind Go interfaces (see §5.2). No Windows-only assumptions leak into shared code.
5. **No dependency is added without justification.** State what it does, its size, and why nothing lighter will do.
6. **Single-file documents.** No proprietary formats, no sidecar databases, no lock-in. A Hashpad document is a `.md` file that any other editor can open.

---

## 3. Technology stack

This stack is fixed. Departing from it needs a strong, specific objection, raised before work starts rather than discovered in the diff.

| Layer | Choice | Rationale |
|---|---|---|
| Shell | **Wails v2** | Native OS webview (WebView2 on Windows, WebKitGTK on Linux). Ships ~10–20 MB instead of Electron's 150 MB+. Cross-compiles from one Go codebase. |
| Backend | **Go 1.22+** | File I/O, dialogs, settings, window management, platform abstraction. |
| Frontend | **TypeScript + Vite**, no UI framework | The app is a handful of components. React/Svelte would add weight and indirection for no benefit. Use plain TS modules with a small event-bus or store pattern. |
| Editor core | **CodeMirror 6** | Small (~200 KB), fast on large files, and — critically — its decoration system is what makes Phase 2's live preview possible. This is the single most important technical choice in the project. Do not substitute Monaco: it is 5 MB and architecturally cannot hide syntax markers inline. |
| Markdown parsing (editor) | `@codemirror/lang-markdown` + `@lezer/markdown` | Incremental parsing for syntax highlighting and decorations. |
| Markdown rendering (preview) | **markdown-it** + plugins | Mature, fast, plugin ecosystem covers everything we need. |
| Sanitization | **DOMPurify** | Markdown permits raw HTML; all rendered output is sanitized before insertion. |

### 3.1 A note on where rendering happens

Preview rendering happens **in the frontend with markdown-it**, not in Go with goldmark. Rationale: the editor already needs a client-side parser (`@lezer/markdown`) for Phase 2's live preview, and having a third parser in Go would create a three-way consistency problem where the editor, preview, and export could disagree. One renderer, one source of truth. Go handles the filesystem and the OS; it does not touch markdown semantics.

### 3.2 Verify the API surface before building

Published examples for both libraries are frequently out of date. The current Wails v2 documentation and the current CodeMirror 6 API are to be checked before scaffolding. CodeMirror 6 differs substantially from CodeMirror 5, and the difference is easy to miss: code shaped like `CodeMirror(document.body, {...})` is the v5 API and does not apply here.

### 3.3 Prior art

`https://github.com/alecdotdev/Markpad` is a well-executed editor in the same space (Tauri + Svelte + Monaco, BSD-3). Worth reading for UX ideas — particularly its settings layout and its handling of pasted images.

**No code is to be copied from it.** It is BSD-3 licensed and this project is MIT; mixing the two creates attribution obligations this project does not want. Ideas only.

Note also what it *doesn't* do, because these are Hashpad's differentiators: it has no live preview mode (Monaco can't do it) and no formatting toolbar. Those two features are the reason this project exists.

---

## 4. Repository layout

```
hashpad/
├── main.go                     # Wails entry point, app lifecycle
├── wails.json
├── go.mod
├── LICENSE                     # MIT
├── README.md
├── internal/
│   ├── app/
│   │   ├── app.go              # Bound methods exposed to the frontend
│   │   ├── files.go            # Open, save, save-as, recent paths
│   │   ├── settings.go         # Load/persist settings.json
│   │   └── watcher.go          # External file-change detection (Phase 2)
│   └── platform/
│       ├── platform.go         # Interface definitions — the porting seam
│       ├── platform_windows.go
│       └── platform_linux.go   # Stubbed initially; keeps the port honest
├── frontend/
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   └── src/
│       ├── main.ts             # Bootstrap
│       ├── state/
│       │   ├── store.ts        # Central app state, subscription-based
│       │   └── document.ts     # Document model
│       ├── editor/
│       │   ├── editor.ts       # CodeMirror instance setup
│       │   ├── extensions.ts   # Assembled CM6 extension list
│       │   ├── commands.ts     # Markdown formatting commands
│       │   ├── theme.ts        # CM6 theme bound to CSS variables
│       │   └── livepreview.ts  # Phase 2
│       ├── preview/
│       │   ├── renderer.ts     # markdown-it configuration
│       │   └── preview.ts      # Preview pane component
│       ├── ui/
│       │   ├── tabbar.ts
│       │   ├── toolbar.ts
│       │   ├── menubar.ts
│       │   ├── statusbar.ts
│       │   ├── findreplace.ts
│       │   ├── outline.ts
│       │   └── settings.ts
│       └── styles/
│           ├── variables.css   # Theme tokens — the ONLY place colours are defined
│           ├── app.css
│           └── preview.css
└── build/
    └── windows/                # Icons, NSIS installer config
```

---

## 5. Architecture principles

### 5.1 State model

A single central store holds application state. UI components subscribe to it; they never hold authoritative state themselves.

```typescript
interface AppState {
  documents: Document[];
  activeDocumentId: string | null;
  settings: Settings;
}

interface Document {
  id: string;              // UUID, stable for the tab's lifetime
  filePath: string | null; // null = never saved
  content: string;
  savedContent: string;    // For dirty comparison — compare strings, don't track a flag
  viewMode: 'source' | 'live' | 'split';
  cursorPos: number;
  scrollTop: number;
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le';
  lineEnding: 'lf' | 'crlf';
}
```

Dirty state is derived (`content !== savedContent`), never stored. This avoids an entire category of bugs where the flag and reality drift apart.

### 5.2 The platform seam

Every OS-specific behaviour goes behind an interface in `internal/platform/platform.go`. When Linux support arrives, the work is implementing one file, not auditing the codebase.

```go
type Platform interface {
    OpenFileDialog(opts DialogOptions) (string, error)
    SaveFileDialog(opts DialogOptions) (string, error)
    ConfigDir() (string, error)
    ReadClipboardImage() ([]byte, error)   // Behaviour differs meaningfully across platforms
    PrintToPDF(html string, outPath string) error
    SystemThemeIsDark() (bool, error)      // Best-effort; return an error if undeterminable
    ShowInFileManager(path string) error
}
```

Known divergences to design around now, not later:
- **Clipboard images**: WebView2 and WebKitGTK expose pasted image data differently. Isolate this completely.
- **Print to PDF**: solid in WebView2, weaker and more variable in WebKitGTK. The Linux implementation may need a different strategy entirely — leave room for that.
- **System theme detection**: straightforward on Windows via the registry; on Linux it depends on the desktop environment and may be undeterminable. Return an error rather than guessing, and fall back to the user's manual setting.

Write `platform_linux.go` as compiling stubs that return `ErrNotImplemented` from the beginning. This forces the interface to stay honest and makes the eventual port a matter of filling in bodies.

### 5.3 Theming

All colours are CSS custom properties defined in `variables.css`. No hard-coded colour appears anywhere else — not in a component, not in the CodeMirror theme, not in preview styles. The CodeMirror 6 theme reads from these variables so the editor and chrome always match.

This is what makes the accent-colour picker a five-line feature instead of a refactor.

---

## 6. Phase 1 — the working app

Phase 1 ships before Phase 2 begins. It must be genuinely usable on its own — an editor worth choosing over Notepad for daily writing.

### 6.1 Window and layout

```
┌────────────────────────────────────────────────────────────┐
│ File  Edit  View  Help                            ─  □  ✕  │  Menu bar (28px)
├────────────────────────────────────────────────────────────┤
│ ▸ notes.md ×  │ todo.md • ×  │  +                          │  Tab bar (34px)
├────────────────────────────────────────────────────────────┤
│ B  I  S  ✎  <>  ⌗▾ │ •≡  1≡  ☑≡ │ ❝  🔗  🖼  ⊞  ─  ···    │  Toolbar (34px)
├────────────────────────────────────────────────────────────┤
│                                                            │
│                      Editor area                           │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ Ln 12, Col 4   1,247 words   6,891 chars   UTF-8   Source  │  Status bar (24px)
└────────────────────────────────────────────────────────────┘
```

Visual direction: Windows 11 Notepad's proportions and restraint, Windows 10 Notepad's flat opacity. Specifically:

- Flat, opaque backgrounds. **No Mica, no acrylic, no translucency** — it's Windows 11-only, inconsistent on Windows 10, and compositor-dependent on Linux. It would directly undermine the goal of looking the same everywhere.
- 4px border radius on interactive elements. Subtle, not rounded-bubble.
- UI font: Segoe UI Variable on Win11, Segoe UI on Win10, system sans-serif on Linux.
- Editor font default: Cascadia Mono, falling back to Consolas, then any monospace.
- Toolbar icons: a minimal inline SVG set, 16×16, `currentColor` fill. No icon-font dependency.
- Generous editor padding — roughly 24px horizontal — with an optional max content width so long lines stay readable on wide monitors.

### 6.2 Tabs

- New tab (Ctrl+N), close tab (Ctrl+W), reopen closed tab (Ctrl+Shift+T), switch with Ctrl+Tab and Ctrl+1…9.
- Unsaved changes shown as a dot before the filename; the × appears on hover and replaces the dot.
- Middle-click closes. Drag to reorder.
- Tabs shrink as they multiply down to a minimum width, then scroll horizontally.
- Tooltip on hover shows the full file path.

### 6.3 Save behaviour — Windows 10 style, explicitly

The classic model, not Windows 11's silent session restore:

- Closing a dirty tab prompts **Save / Don't Save / Cancel**.
- Quitting with multiple dirty tabs prompts once per tab, in order, with Cancel aborting the entire quit.
- No unsaved-content cache on disk. When you close without saving, it's gone — same as Notepad has always worked.
- Autosave is off by default. Offer it in settings as an opt-in for saved files only (never silently creates files).

### 6.4 File handling

- Recognized extensions: `.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`, `.qmd`, `.rmd`, `.txt`. All are treated as markdown text. **`.mdx` is edited as text only** — no attempt to parse or render its JSX component syntax.
- Encoding: detect UTF-8, UTF-8 with BOM, and UTF-16LE on open; preserve on save. Show the detected encoding in the status bar.
- Line endings: detect CRLF vs LF, preserve on save, display in the status bar. Never silently convert.
- Drag and drop a file onto the window opens it in a new tab. Dropping multiple files opens multiple tabs.
- Double-clicking a `.md` file in Explorer opens it in the running instance rather than launching a second one (Wails single-instance lock, with the file path passed to the existing process).

### 6.5 Toolbar — customizable

All sixteen commands are available. The user right-clicks the toolbar to pin or unpin any of them; unpinned commands live in the `···` overflow menu, which always contains the full set. Layout persists to settings.

| Command | Shortcut | Inserts |
|---|---|---|
| Bold | Ctrl+B | `**text**` |
| Italic | Ctrl+I | `*text*` |
| Strikethrough | Ctrl+Shift+X | `~~text~~` |
| Highlight | Ctrl+Shift+H | `==text==` |
| Inline code | Ctrl+` | `` `text` `` |
| Code block | Ctrl+Shift+K | fenced block, language prompt |
| Heading | Ctrl+1…6 | `#`…`######` — dropdown in the toolbar |
| Bullet list | Ctrl+Shift+8 | `- ` |
| Numbered list | Ctrl+Shift+7 | `1. ` |
| Task list | Ctrl+Shift+9 | `- [ ] ` |
| Blockquote | Ctrl+Shift+. | `> ` |
| Link | Ctrl+K | `[text](url)` |
| Image | Ctrl+Shift+I | `![alt](path)` |
| Table | Ctrl+Shift+T | 3×3 GFM table skeleton |
| Horizontal rule | Ctrl+Shift+- | `---` |
| Footnote | Ctrl+Shift+F | `[^1]` plus definition at document end |

Behavioural requirements for all formatting commands:

- **Toggle, don't just insert.** Bold on already-bold text removes the markers.
- **Respect selection.** No selection wraps the word under the cursor; a selection wraps the selection; a multi-line selection applies block formatting per line.
- **Show active state.** Toolbar buttons highlight when the cursor sits inside matching formatting.
- Every command is a CodeMirror 6 command function in `editor/commands.ts`, bound identically to the toolbar button and the keyboard shortcut. One implementation, two triggers.

### 6.6 Editing features

- **Syntax highlighting in source mode**: headings render at larger sizes, bold renders bold, italic renders italic, code in monospace with a tinted background, links coloured, blockquotes with a left border. The markers stay visible — this is source mode. Fenced code blocks get language-specific highlighting via `@codemirror/language-data`.
- **Smart lists**: Enter on a list item continues the list; Enter on an empty item ends it; Tab and Shift+Tab indent and outdent; ordered lists renumber automatically.
- **Smart pairs**: typing `*`, `_`, `` ` ``, `(`, `[` with a selection wraps it rather than replacing it.
- **Find and replace** (Ctrl+F / Ctrl+H): case-sensitive toggle, whole-word toggle, regex toggle, match count, replace all. Use `@codemirror/search`, styled to match the app rather than left at its defaults.
- **Zoom**: Ctrl+scroll and Ctrl+Plus/Minus, Ctrl+0 to reset. Zooms editor and preview content only — never the UI chrome. Persists per session, not per document.
- **Word wrap**: on by default, toggle in View menu, persisted.
- **Undo/redo**: CodeMirror's history, per document, unbounded within reason.

### 6.7 Preview pane

- Toggle with Ctrl+Shift+P; splits the editor area vertically with a draggable divider (position persisted).
- Debounced re-render at 150 ms — never re-render on every keystroke.
- Synchronized scrolling, proportional by position, with a toggle to disable.
- GitHub-flavoured styling, adapted to the active theme. Both light and dark preview styles must be readable and match the app's palette.
- **Remote images are blocked by default.** A markdown file containing `![](https://…)` would otherwise make a network request, violating constraint #1. Show a placeholder with a per-document "Load remote images" button, and a global setting for people who want it always on. Local relative-path images always load.
- All rendered HTML passes through DOMPurify. Raw HTML in markdown is permitted but sanitized; scripts never execute.

### 6.8 Markdown support

GitHub Flavored Markdown as the baseline: tables, task lists, strikethrough, fenced code, autolinks. Plus:

- `==highlight==` (via `markdown-it-mark`)
- Footnotes (via `markdown-it-footnote`)
- YAML front matter — the `---` block at the top of a file used by static site generators and Obsidian. Parsed, syntax-highlighted distinctly in the editor, and either hidden in preview or rendered as a small metadata card. Your call, but be consistent.
- HTML comments `<!-- … -->` — visible in the editor, absent from the preview. This is our "annotation" mechanism.

### 6.9 Document outline

Collapsible left sidebar (Ctrl+Shift+O), hidden by default. Lists all headings, indented by level, clicking scrolls to that heading, current section highlighted as you scroll. Width persisted.

### 6.10 Pasted images

Ctrl+V with image data on the clipboard:

1. If the document is unsaved, prompt to save first — we need a location to write next to.
2. Write the image as PNG to a subfolder alongside the document (default `assets/`, configurable, and creatable on demand).
3. Name it `image-YYYYMMDD-HHMMSS.png`.
4. Insert `![](assets/image-….png)` at the cursor.

This is one of the two or three features that decides whether markdown feels pleasant or feels like a chore. Get it right.

### 6.11 Status bar

Line and column, word count, character count, encoding, line ending, current view mode. Word count reflects the selection when text is selected. Clicking a segment where it makes sense (encoding, line ending) opens a menu to change it. Toggleable in View.

### 6.12 Themes

- **Light** and **Dark**, both hand-tuned — dark is not an inverted light theme.
- **Follow system**: on by default where detectable. Windows via registry with live change detection; Linux best-effort; silently falls back to the manual setting when undeterminable.
- **Accent colour picker**: a colour input that sets `--accent`, affecting links, selection, focus rings, active tab indicator, and toolbar active states. Ship 6–8 presets plus a custom picker.
- Theme switching is instant, with no flash of unstyled content.

### 6.13 Settings

A modal dialog (Ctrl+,), not a separate window. Grouped into Appearance, Editor, Files, Advanced. Every setting takes effect immediately — no Apply button, no restart.

```json
{
  "version": 1,
  "appearance": {
    "theme": "system",
    "accentColor": "#0078d4",
    "uiFontSize": 14
  },
  "editor": {
    "fontFamily": "Cascadia Mono",
    "fontSize": 14,
    "lineHeight": 1.6,
    "wordWrap": true,
    "maxContentWidth": 900,
    "showLineNumbers": false,
    "tabSize": 2,
    "insertSpaces": true,
    "defaultViewMode": "source"
  },
  "preview": {
    "fontFamily": "Segoe UI",
    "fontSize": 15,
    "syncScroll": true,
    "loadRemoteImages": false
  },
  "files": {
    "autosave": false,
    "autosaveDelayMs": 2000,
    "assetFolder": "assets",
    "defaultEncoding": "utf-8"
  },
  "toolbar": {
    "visible": true,
    "pinned": ["bold", "italic", "strikethrough", "inlineCode", "heading",
               "bulletList", "numberedList", "taskList", "link", "table"]
  },
  "window": {
    "width": 1000, "height": 700, "maximized": false,
    "outlineVisible": false, "statusBarVisible": true,
    "previewSplitRatio": 0.5
  }
}
```

Storage: `os.UserConfigDir()/Hashpad/settings.json`. **Portable mode**: if a `settings.json` exists in the same directory as the executable, use that instead — this makes the portable build genuinely portable, leaving no trace on the host machine.

Malformed settings must not brick the app: log, fall back to defaults, and back up the bad file rather than overwriting it.

### 6.14 Keyboard shortcuts

Match Notepad and general Windows conventions wherever one exists. Full list beyond the formatting commands: Ctrl+N/O/S/Shift+S/W/Shift+T, Ctrl+Tab, Ctrl+1…9 (tab switching where not overridden by heading levels — this collision is to be resolved deliberately and the choice documented), Ctrl+F/H/G, Ctrl+Z/Y, Ctrl+Plus/Minus/0, Ctrl+Shift+P (preview), Ctrl+Shift+O (outline), Ctrl+, (settings), F11 (fullscreen), Esc (dismiss find/replace).

Every shortcut must also be reachable through a menu, with the shortcut displayed beside it.

---

## 7. Phase 2 — after Phase 1 ships

### 7.1 Live preview mode

The headline feature. Markdown syntax markers hide themselves except on the line where the cursor sits.

Type `**bold**` — while the cursor is on that line, you see the asterisks. Move away, and the asterisks vanish; the word simply appears bold. Click back into the line and they return, so the formatting stays editable.

Implementation: a CodeMirror 6 `ViewPlugin` maintaining a `DecorationSet`, using the `@lezer/markdown` syntax tree to locate markers, applying `Decoration.replace()` to hide them, and recomputing on cursor movement and document change.

Requirements:
- Cursor movement into a formatted region reveals its markers immediately, with no visible reflow jitter.
- Selection spanning a region reveals its markers.
- Handle these cases explicitly, as they're where naive implementations break: nested emphasis, links (show the text, hide the URL until focused), images (render inline thumbnails), tables (align columns visually), fenced code blocks (keep the fence visible — hiding it is confusing), headings (hide `#` but keep the size change), and list markers (replace `-` with a bullet glyph).
- Performance target: no perceptible input lag in a 5,000-line document. Only decorate the visible viewport.

The three modes — source, live, split — must be switchable at any time without losing cursor position or scroll.

Budget realistically: this is a few hundred lines of subtle logic and the hardest part of the project. Build it incrementally, starting with bold and italic only, and expand once the foundation is proven.

### 7.2 Math and diagrams

- **KaTeX** for `$inline$` and `$$block$$` math.
- **Mermaid** for ```` ```mermaid ```` fenced blocks.

Both bundled locally — no CDN, ever. Both **lazy-loaded**: dynamic `import()` triggered only when a document actually contains math or a diagram, so normal notes never pay their cost. Mermaid in particular is large; verify it doesn't regress cold-start time for ordinary documents.

Render in the preview pane. Live-preview rendering of math is a stretch goal, not a requirement.

### 7.3 Export

- **HTML**: single self-contained file with CSS inlined and local images base64-embedded, so it opens correctly anywhere.
- **PDF**: render to HTML, then hand off to the system print dialog via the webview's print API. Provides "Save as PDF" without bundling a PDF library. Expect this path to differ on Linux — hence the platform interface.
- **Plain text**: markdown syntax stripped, structure preserved via indentation.
- **Copy as rich text**: put both `text/html` and `text/plain` on the clipboard so pasting into Word, LibreOffice, Google Docs, or an email client arrives fully formatted. This is deliberately our substitute for DOCX and ODT export — it covers the realistic need without shipping a document-format writer.

### 7.4 External change detection

Watch open files with `fsnotify`. If a file changes on disk and the buffer is clean, reload silently. If dirty, show a non-blocking bar: "This file changed on disk. Reload / Keep mine / Compare."

---

## 8. Explicitly out of scope

Documented decisions, not oversights. These are not to be added; a case that one has become necessary is raised rather than acted on.

- DOCX and ODT export — `copy as rich text` covers it, and Pandoc exists for real conversion work
- Spell check
- Vim/Emacs keybindings
- Plugin system
- Cloud sync, accounts, collaboration
- Auto-update
- Multi-window (tabs are sufficient)
- Rendering `.mdx` JSX components
- Mica, acrylic, or any translucency
- macOS support (nothing should *preclude* it, but don't build or test for it)

---

## 9. Build and distribution

Two Windows artifacts from one build:

1. **Portable** — a single `Hashpad.exe` that runs from anywhere and writes nothing outside its own folder when a local `settings.json` is present.
2. **Installer** — NSIS via `wails build -nsis`, registering file associations for `.md` and `.markdown` (opt-in checkbox during install, never forced), a Start Menu entry, and a clean uninstaller that offers to remove settings but doesn't do so silently.

Build with `-ldflags "-s -w"` and UPX compression if it doesn't trip antivirus heuristics — test this, as UPX-packed binaries sometimes do.

Provide a `Taskfile.yml` or `Makefile` with: `dev`, `build`, `build:portable`, `build:installer`, `test`, `lint`.

Also provide a GitHub Actions workflow building both artifacts on tag push and attaching them to a release. No signing certificate for now; note in the README that Windows SmartScreen will warn on first run, and explain why.

---

## 10. Code quality

- **Go**: standard project idioms, `golangci-lint` clean, errors wrapped with context, no panics in normal operation. Unit tests for encoding detection, line-ending detection, settings load/migrate, and path resolution.
- **TypeScript**: strict mode, no `any` without a comment justifying it, ESLint + Prettier. Vitest unit tests for every formatting command in `commands.ts` — these have fiddly edge cases around selection and toggling, and are where tests pay for themselves.
- **Comments**: explain *why*, not *what*. Non-obvious CodeMirror decoration logic in particular deserves prose explanation, since it's the code most likely to confuse someone six months later.
- **Accessibility**: full keyboard navigability, visible focus indicators, ARIA labels on all icon-only buttons, WCAG AA contrast in both themes.
- **Manual test checklist** in `docs/testing.md`, covering the flows automated tests won't reach — dirty-close prompts, drag-and-drop, encoding round-trips, external file changes.

---

## 11. Delivery approach

The code is meant to be read and modified by hand after delivery, so clarity
beats cleverness everywhere.

1. **A written plan precedes implementation**, covering the order of work and any
   point where the plan disagrees with this specification. Disagreements are
   resolved before work starts, not discovered afterwards.
2. **Work proceeds in phases**, in roughly this order, each one stopping to be
   run and evaluated before the next begins:
   - **A.** Wails scaffold, window, menu bar, CodeMirror mounted, type-and-see-text works
   - **B.** File open/save/save-as, encoding and line-ending detection, dirty tracking, save prompts
   - **C.** Tabs
   - **D.** Syntax highlighting and the theme system with light/dark/accent
   - **E.** Toolbar with all commands and their tests
   - **F.** Preview pane with markdown-it and DOMPurify
   - **G.** Find/replace, zoom, word wrap, status bar, outline, drag-and-drop, pasted images
   - **H.** Settings dialog and persistence
   - **I.** Build pipeline, portable exe, installer
   - Then, separately: Phase 2.
3. **No dependency is added without justification.** Name it, size it, and say
   what it earns against the budget in §2.5.
4. **No silent deviation from this specification.** Where a requirement here is
   wrong or impractical, it is raised and an alternative proposed. That
   conversation is cheaper than discovering the difference later, and the
   resulting record is [`docs/design.md`](docs/design.md) §4.
5. **Platform-specific code is flagged where it is written**, so the porting
   surface is visible rather than archaeological.
6. **Readable beats clever.** Where code needs a comment to be understood, the
   comment gets written — but simpler code that needs none is considered first.
7. **Tests are written alongside the code**, particularly for the formatting
   commands, whose edge cases around selection and toggling are where testing
   pays for itself.

## 12. Definition of done for Phase 1

A `.md` file opens by double-clicking it in Explorer. Text can be written
comfortably with real syntax highlighting, formatted from toolbar buttons and
keyboard shortcuts, and previewed in a live-updating pane. Light and dark themes
switch cleanly. Settings persist across restarts. Ctrl+S saves; closing a
modified tab produces a proper Save / Don't Save / Cancel prompt. The
application starts in under half a second, sits under 100 MB of RAM, and never
touches the network.

The bar it has to clear: an editor worth choosing over Notepad without thinking
about it.

---

## 13. Questions left open

These four were deliberately not decided here. Each was to be settled during
design, with its reasoning written down rather than resolved by whoever happened
to reach the code first. All four are answered in
[`docs/design.md`](docs/design.md) §2.

1. **Ctrl+1…9 collision** — heading levels versus tab switching. Both are
   conventional; only one can have the binding.
2. **Front matter in preview** — hidden entirely, or rendered as a metadata card?
3. **Live preview mode in Phase 1** — this specification defers it to Phase 2 to
   de-risk Phase 1. Whether the foundation can safely be built earlier is an
   open question, not a settled exclusion.
4. **Vite bundle strategy** — a single bundle or code-split? Startup time is the
   metric that decides it.
