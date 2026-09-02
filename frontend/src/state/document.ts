import type { EditorState, StateEffect, Text } from '@codemirror/state';

/** Mirrors Go's `app.Encoding` (internal/app/textfile.go). */
export type Encoding = 'utf-8' | 'utf-8-bom' | 'utf-16le';

/** Mirrors Go's `app.LineEnding`. */
export type LineEnding = 'lf' | 'crlf';

/**
 * Dirty state is derived, never stored as a flag — that avoids an entire
 * category of bugs where the flag and reality drift apart. CodeMirror owns the
 * text; this model deliberately does not duplicate it.
 */
export interface Document {
  id: string;
  filePath: string | null;
  editorState: EditorState;
  savedDoc: Text;
  /**
   * `'preview'` is the rendered pane at full width with no editor beside it
   * (design §4.27). `'live'` remains reserved for SPEC §7.1 and still renders
   * identically to `'source'` -- filling that slot with preview-only would have
   * left Phase 2's headline feature nowhere to land.
   */
  viewMode: 'source' | 'live' | 'split' | 'preview';
  /**
   * The mode to return to when the preview is toggled off. A document opened
   * under `editor.defaultViewMode: "live"` must come back as `'live'` rather
   * than being silently downgraded to `'source'`.
   *
   * Narrower than `viewMode` on purpose: the two modes that *show* a pane are
   * not answers to "what was showing before the pane", so neither belongs here.
   */
  previousViewMode: 'source' | 'live';
  /**
   * How this document will be written (SPEC §3.1). Detected on open, changeable
   * from the status bar, and handed to Go's `WriteFile`, which owns the byte
   * round trip -- the editor's buffer is always UTF-16 JavaScript text with LF
   * separators regardless of what either of these says.
   */
  encoding: Encoding;
  lineEnding: LineEnding;
  /**
   * What is actually on disk, the metadata counterpart of `savedDoc`, and the
   * reason changing either of the two above is a *saveable* change rather than
   * a silent one.
   *
   * Without these, `isDirty` could only see text. Switching a file from CRLF to
   * LF would leave the document looking clean, Ctrl+S would have nothing to do,
   * and the choice would evaporate on close -- the user having been shown a
   * menu that did nothing. Storing a dirty *flag* instead was the alternative
   * and is the thing this model exists to avoid, so the fix is to widen what
   * "saved" means rather than to start tracking it by hand.
   *
   * Both are meaningless for a document that has never been saved, where
   * `filePath` is null and there is no disk state to differ from. They are
   * seeded to the same values as the live pair there, so an untitled document
   * starts clean.
   */
  savedEncoding: Encoding;
  savedLineEnding: LineEnding;
  /**
   * Whether the file as read used both CRLF and LF. Go reports it
   * (`app.FileContents.Mixed`) because saving flattens the whole file to one
   * convention, and a user who never chose that deserves to be told rather than
   * to find out from a diff. Surfaced as the line-ending segment's tooltip.
   *
   * False for an untitled document: nothing has been read, so nothing was mixed.
   */
  mixedLineEndings: boolean;
  /**
   * CodeMirror's scroll position, captured as a StateEffect when this document
   * is switched away from and replayed when it comes back. Design §4.4 dropped
   * a numeric scrollTop in favour of this — the effect survives document
   * changes that a raw pixel offset would not.
   */
  scrollSnapshot: StateEffect<unknown> | null;
}

/**
 * What the status bar says about the caret and the text (SPEC §6.11).
 *
 * Flat and primitive-valued deliberately: store.ts's `isEqual` compares one
 * level of own keys, so a selector returning this shape lets the status bar
 * sleep through every update that leaves all five fields identical. That
 * function's own doc comment uses `{ line, col, words }` as its worked example
 * -- this is the case the store was designed around.
 */
export interface EditorStatus {
  /** 1-based, as displayed. */
  line: number;
  /**
   * 1-based character offset into the line, counting UTF-16 code units -- so an
   * astral character (an emoji, say) advances it by two. That is what VS Code
   * reports too, and the alternative is walking grapheme clusters on the typing
   * path, which is the cost `countWords` argues against.
   */
  col: number;
  /**
   * Words and characters in the *selection* when there is one, and in the whole
   * document when there is not -- SPEC §6.11's "word count reflects the
   * selection when text is selected". `selection` is what tells the two apart,
   * so the bar can say which it means rather than silently changing subject.
   *
   * `chars` counts UTF-16 code units, exactly as `col` does and for the same
   * reason. It is also the *buffer's* length, not the file's: CodeMirror
   * normalises every line ending to a single LF on load and Go re-applies CRLF
   * on write, so a CRLF file is one byte per line longer on disk than this says.
   */
  words: number;
  chars: number;
  selection: boolean;
}

/**
 * The editor behaviours SPEC §6.13 makes configurable, as opposed to the
 * typography ones -- those are CSS custom properties (settings/typography.ts),
 * these are CodeMirror extensions and have to be reconfigured on the view.
 */
export interface EditorBehaviour {
  showLineNumbers: boolean;
  /** How wide a literal tab renders, and how many spaces one indent inserts. */
  tabSize: number;
  /** Whether Tab inserts spaces or a tab character. */
  insertSpaces: boolean;
}

/** Matches internal/app/settings.go's `DefaultSettings`. */
export const DEFAULT_BEHAVIOUR: EditorBehaviour = {
  showLineNumbers: false,
  tabSize: 2,
  insertSpaces: true,
};

/**
 * A tab width that will not wreck the editor.
 *
 * settings.json is hand-editable, and `LoadSettingsFrom` only guarantees that
 * it parsed. `0` would make an indent insert nothing, and a huge value would
 * push the first character of an indented line off the right of the window.
 * Non-integers are floored: half a column is not a thing.
 */
export function clampTabSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BEHAVIOUR.tabSize;
  return Math.min(Math.max(Math.floor(value), 1), 16);
}

/**
 * `settings.editor.defaultViewMode` arrives as a plain `string` -- Go declares
 * it as one, and the generated binding widens it the same way it widens the
 * encoding enums. Checked rather than cast, for the same reason the widths are
 * clamped: settings.json is hand-editable, and an unrecognised value would put
 * a mode nothing renders into every document the app opens.
 *
 * **Narrower than `Document['viewMode']`, and named for the setting rather than
 * for the union to say so.** It deliberately rejects `'preview'`, which is a
 * real mode (design §4.27) but not one a *new* document may open in: reading
 * mode has no editor, so `defaultViewMode: "preview"` would make File > New
 * hand you a blank page you cannot type into, and the startup tab the same.
 * The trap arrives through a hand-edited file rather than through the UI, which
 * is exactly the kind this function exists to stop. Reading mode is reached per
 * document, from the View menu, and is not a preference.
 */
export function isDefaultViewMode(value: string): value is Exclude<ViewModeSetting, 'preview'> {
  return value === 'source' || value === 'live' || value === 'split' || value === 'last';
}

/**
 * `settings.editor.openedViewMode` -- what a file that *launched* Hashpad
 * opens in (design §4.27).
 *
 * Wider than `isDefaultViewMode` by exactly one value, and that one value is the
 * point: a file arriving from Explorer has something to read, so `'preview'` is
 * legal here where it is refused for a new document. Two validators rather than
 * one with a flag, because the difference is a fact about each setting rather
 * than a decision a caller makes.
 */
export function isOpenedViewMode(value: string): value is ViewModeSetting {
  return isDefaultViewMode(value) || value === 'preview';
}

/**
 * Whether `mode` puts the rendered pane on screen.
 *
 * **The one question, asked in one place.** Three sites used to spell this
 * `viewMode === 'split'`: the subscription that mounts and unmounts the pane,
 * and the two guards in `preview/pane.ts` that skip work for a document not
 * showing one. With `'preview'` added (design §4.27) that equality became a
 * *wrong* question rather than an incomplete one -- and a wrong question copied
 * three times is how one copy gets missed. The symptom would be a pane that
 * mounts and renders nothing, or renders and never mounts.
 *
 * Named for what callers want to know rather than for the values it happens to
 * match, so adding a fifth mode is one edit here instead of a search.
 */
/**
 * What a view-mode *setting* may say: any real mode, or `'last'` meaning "look
 * at what was used recently" (design §4.27).
 */
export type ViewModeSetting = Document['viewMode'] | 'last';

/**
 * How many modes are remembered, and **two is a correctness requirement rather
 * than a nicety.**
 *
 * With one, closing a document in reading mode would leave `'last'` with no
 * legal answer for the next new document, since a new document may not open in
 * reading mode. With two distinct entries at most one can be `'preview'`, so
 * there is always something behind it to fall back to.
 */
export const MAX_RECENT_VIEW_MODES = 2;

/**
 * Records `mode` as the most recently used, keeping the list distinct.
 *
 * The dedupe is what makes `MAX_RECENT_VIEW_MODES` mean "two different modes"
 * rather than "two entries" -- re-entering the mode already at the front would
 * otherwise push a duplicate and leave the fallback with nowhere to fall back to.
 */
export function pushRecentViewMode(
  recent: readonly string[],
  mode: Document['viewMode'],
): Document['viewMode'][] {
  const kept = recent.filter(
    (each): each is Document['viewMode'] => each !== mode && isViewMode(each),
  );
  return [mode, ...kept].slice(0, MAX_RECENT_VIEW_MODES);
}

/**
 * Every real mode, as opposed to the settings vocabulary that adds `'last'`.
 *
 * Not to be confused with `isDefaultViewMode`, which validates a *setting* and
 * is deliberately narrower -- this one is the union itself.
 */
export function isViewMode(value: string): value is Document['viewMode'] {
  return value === 'source' || value === 'live' || value === 'split' || value === 'preview';
}

/**
 * Turns a setting into the mode a document actually opens in.
 *
 * `allowPreview` is the difference between the two callers, and the reason this
 * is one function rather than two: a file being opened has something to read, a
 * brand-new empty document does not. Everything else about the resolution is
 * identical, and splitting it would mean the fallback rule existing twice.
 *
 * Never returns `'preview'` when `allowPreview` is false, whatever the setting
 * or the history says -- including a hand-edited `"preview"` that got past the
 * validator, because this is the last thing between a settings file and a blank
 * page nobody can type into.
 */
export function resolveViewMode(
  setting: string,
  recent: readonly string[],
  allowPreview: boolean,
): Document['viewMode'] {
  if (setting !== 'last') {
    if (!isViewMode(setting)) return 'source';
    return !allowPreview && setting === 'preview' ? 'source' : setting;
  }

  for (const mode of recent) {
    if (!isViewMode(mode)) continue;
    if (allowPreview || mode !== 'preview') return mode;
  }
  return 'source';
}

export function showsPreview(mode: Document['viewMode']): boolean {
  return mode === 'split' || mode === 'preview';
}

/**
 * What toggling the preview off should return to, for a document that opened
 * in `mode`.
 *
 * `'split'` and `'preview'` are the ones that need saying: a document that
 * opened straight into either has no earlier mode to go back to, so both fall
 * back to source. The other two are their own answer -- a document opened under
 * `defaultViewMode: "live"` must come back as `'live'`, not be silently
 * downgraded (see `previousViewMode`).
 *
 * Written as "the modes that show a pane" rather than as two equality checks,
 * because the return type is what actually forces it: `previousViewMode` cannot
 * hold `'preview'`, so a version that tested only `'split'` would not compile
 * rather than quietly returning a mode with no editor in it.
 */
export function previousViewModeFor(mode: Document['viewMode']): Document['previousViewMode'] {
  return mode === 'split' || mode === 'preview' ? 'source' : mode;
}

/**
 * `settings.files.defaultEncoding`, checked for the same reason `isViewMode`
 * above checks its value: Go declares the field as a `string`, so unmarshalling
 * cannot reject a hand-edited one.
 *
 * The consequence of letting a bad value through is worse here than for a view
 * mode. This is what an untitled document is *written* as, so a nonsense value
 * would reach Go's `WriteFile` at the moment the user first saves -- the point
 * at which being wrong costs them something.
 *
 * Deliberately not shared with `parseStatusCommand`'s check in ui/statusbar.ts,
 * which narrows against the label map it renders from. Same predicate, two
 * different jobs, and a UI module is the wrong direction for `state/` to import.
 */
export function isEncoding(value: string): value is Encoding {
  return value === 'utf-8' || value === 'utf-8-bom' || value === 'utf-16le';
}

/**
 * How long autosave waits after the last edit, in milliseconds.
 *
 * Clamped for the reason every hand-editable number here is. `0` would write
 * the file on every keystroke -- an IPC round trip and a disk write per
 * character -- and the upper bound stops a mistyped value turning the feature
 * silently off, which is worse than it being slow, because the user believes
 * their work is being saved.
 */
export function clampAutosaveDelay(value: number): number {
  if (!Number.isFinite(value)) return 2000;
  return Math.min(Math.max(Math.round(value), 200), 60_000);
}

export interface AppState {
  documents: Document[];
  activeDocumentId: string | null;
  /** Resolved light/dark, whatever the source (manual or system). */
  isDark: boolean;
  /**
   * File paths of recently closed documents, most recent first, for
   * Ctrl+Shift+T. Only paths — never buffers. Reopening re-reads from disk, so
   * a tab closed with Don't Save cannot resurrect the discarded text, which
   * SPEC §6.3 requires to be gone.
   */
  closedPaths: string[];
  /**
   * Which formatting commands apply at the main selection's head, for the
   * toolbar's active-button state (SPEC §6.5) — sorted command ids joined by
   * `|`, `''` when none apply. Published by editor/extensions.ts's
   * `syncActiveFormats`. A string rather than a `Set`/array: see that
   * function's doc comment for why (store.ts's `isEqual` and the toolbar
   * rebuilding on every keystroke otherwise).
   */
  activeFormats: string;
  /**
   * The commands currently pinned to the toolbar row (SPEC §6.13), kept in
   * sync with `settings.toolbar.pinned` by main.ts's `hashpad:command`
   * routing of `toolbar.pin:<id>`/`toolbar.unpin:<id>` -- see that file's
   * `setToolbarPinned`. Starts empty: the real value is only known once
   * main.ts's bootstrap has loaded and validated settings (ui/toolbar.ts's
   * `validatePinned`), the same reason `documents` starts empty above.
   * `ui/toolbar.ts`'s `mountToolbar` does not read this reactively -- it is
   * seeded once, from a plain argument, at the moment main.ts mounts it, so
   * this field's role is bootstrap seeding and persistence bookkeeping, not
   * driving the toolbar's own re-render (that stays local, via its
   * `onTogglePin` callback -- see that function's header comment for why).
   */
  pinnedToolbarCommands: readonly string[];
  /**
   * The share of the editor/preview row given to the *preview* pane, 0..1 --
   * SPEC §6.13's `window.previewSplitRatio`. Same seed-then-persist
   * arrangement as `pinnedToolbarCommands` above: main.ts's bootstrap seeds it
   * from settings, and preview/pane.ts's divider writes it back through
   * `SaveSettings`. It lives here rather than inside the pane so the width
   * survives a pane that is hidden and shown again, and so the startup path
   * can hold the value without importing the lazily loaded preview module.
   */
  previewSplitRatio: number;
  /**
   * SPEC §6.13's `preview.syncScroll`, seeded by main.ts's bootstrap the same
   * way `previewSplitRatio` above is. It lives in the store rather than being
   * read from settings at the moment it is needed because both scroll handlers
   * in preview/pane.ts consult it on every scroll event, and neither can await
   * an IPC round trip; keeping it here also means a future settings dialog
   * takes effect immediately (SPEC §6.13) with no re-mount.
   *
   * Nothing writes it back yet -- there is no UI for the toggle until
   * Checkpoint H's settings dialog, so hand-editing settings.json is the only
   * way to turn it off today.
   */
  syncScroll: boolean;
  /**
   * SPEC §6.6's word wrap: on by default, toggled from the View menu, and
   * persisted to `settings.editor.wordWrap`. Seed-then-persist, the same shape
   * as `previewSplitRatio` -- `bootstrap()` reads it, the toggle writes it back.
   *
   * Zoom is deliberately *not* here beside it. SPEC makes zoom per session
   * rather than persisted, nothing outside `ui/zoom.ts` reacts to it, and a
   * store field nobody reads is a field that goes stale.
   */
  wordWrap: boolean;
  /**
   * SPEC §6.13's `showLineNumbers`, `tabSize` and `insertSpaces`.
   *
   * In the store rather than read from settings at each use, because
   * `documentops.ts` needs it when it builds the `EditorState` for a *new* tab
   * -- the same reason `wordWrap` above lives here. One object rather than
   * three fields: they arrive together, are applied together through a single
   * compartment, and store.ts's `isEqual` compares one level of own keys, so a
   * selector over this notifies only when one of them actually changes.
   */
  editorBehaviour: EditorBehaviour;
  /**
   * The mode a document opens in -- SPEC §6.13's `editor.defaultViewMode`.
   *
   * Seed-then-persist like `wordWrap` above, and in the store rather than read
   * from settings at the moment it is needed for the same reason:
   * `documentops.ts` needs it while building the `Document` for a new tab, and
   * cannot await an IPC round trip there.
   *
   * View > Preview writes it, which is what makes the pane stick. The owner
   * reported the opposite -- open the preview, then open a file or restart the
   * app, and it was gone. Both creation sites minted documents with a
   * hard-coded `'source'`, and this setting was dead on both sides of the
   * bridge (see .superpowers/sdd/progress.md's dead-field list).
   *
   * **The raw setting, not a resolved mode** (design §4.27). It may say
   * `'last'`, which only means something together with `recentViewModes` and
   * with knowing whether the document being built is new or opened -- so
   * resolution happens at each creation site through `resolveViewMode`, not
   * here. Storing a resolved value instead would have to pick one of those
   * answers at load time and be wrong for the other.
   */
  defaultViewMode: ViewModeSetting;
  /**
   * What a file that *launched* Hashpad opens in -- double-click, "Open with",
   * or a path on the command line. Ctrl+O and drag-drop deliberately use
   * `defaultViewMode` instead: you are already in the app and already working,
   * and landing in a view you cannot type into is a surprise there in a way it
   * is not when opening a document is the whole reason the app started.
   */
  openedViewMode: ViewModeSetting;
  /**
   * The last two *distinct* modes used, most recent first -- what `'last'`
   * resolves against. Written by the view-mode toggles, never by the dropdowns.
   */
  recentViewModes: Document['viewMode'][];
  /**
   * SPEC §6.13's `files.defaultEncoding` — what a document that has never been
   * read from disk is written as.
   *
   * Only ever reaches *untitled* documents. An opened file's encoding is
   * detected (SPEC §3.1) and preserved on save, and a default that overrode
   * detection would silently transcode the user's files, so the two never meet.
   *
   * Nothing writes it back, unlike `defaultViewMode` beside it. The status
   * bar's encoding menu is a per-file choice -- picking UTF-16 for one document
   * must not change what every future document gets -- so this stays a settings
   * value until H.4's dialog gives it a control.
   */
  defaultEncoding: Encoding;
  /**
   * SPEC §6.13's `files.autosave`, and §3.2's "off by default, opt-in **for
   * saved files only** (never silently creates files)".
   *
   * That parenthesis is the whole design of `files/autosave.ts`: an untitled
   * document is never written, because writing one means choosing a path, and
   * choosing a path means a dialog nobody asked for on a timer.
   */
  autosave: boolean;
  /** Milliseconds after the last edit. See `clampAutosaveDelay`. */
  autosaveDelayMs: number;
  /**
   * The caret and the counts, published by editor/extensions.ts's `syncStatus`
   * on every document or selection change. Here rather than read from the view
   * on demand for the same reason `activeFormats` is: the status bar is a
   * store subscriber like everything else in `ui/`, and a component reaching
   * into `getEditorView()` to re-derive state on a timer is the arrangement
   * SPEC §5.1 exists to prevent.
   */
  status: EditorStatus;
  /**
   * The outline sidebar's width in CSS pixels (SPEC §6.9), seeded from
   * `settings.window.outlineWidth` and written back by the resizer -- the same
   * seed-then-persist arrangement as `previewSplitRatio`.
   *
   * A width rather than a ratio, unlike the preview's split. The sidebar holds
   * text at a fixed size, so what the user is choosing is how many characters of
   * a heading they can read; a share of the window would change that every time
   * the window resized.
   */
  outlineWidth: number;
}

/**
 * How far the divider may travel. Not 0..1: a pane dragged to nothing is a
 * pane whose divider the user then has to hunt for, and an editor squeezed to
 * zero is worse.
 */
export const MIN_OUTLINE_WIDTH = 140;
export const MAX_OUTLINE_WIDTH = 600;
export const DEFAULT_OUTLINE_WIDTH = 240;

export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;
export const DEFAULT_SPLIT_RATIO = 0.5;

/**
 * settings.json is hand-editable, so `window.previewSplitRatio` can arrive as
 * a string, a NaN, or `40` from someone thinking in percent. A non-number
 * falls back to the compiled-in default -- clamping `"half"` would be
 * meaningless -- while a finite number out of range is clamped, because `40`
 * plainly means "as far over as it goes". Same shape of guard as
 * ui/toolbar.ts's `validatePinned` and theme.ts's `isValidAccent`, and it
 * lives in this DOM-free model module so main.ts can validate the setting at
 * bootstrap without pulling in preview/pane.ts (and with it markdown-it).
 */
export function clampSplitRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

/**
 * Same guard as `clampSplitRatio`, for the same reason: settings.json is
 * hand-editable, so this can arrive as a string or a NaN. A non-number falls
 * back to the default; a finite number out of range is clamped, because someone
 * who typed 5000 plainly meant "as wide as it goes".
 *
 * The floor is not zero. A sidebar dragged to nothing is a sidebar the user then
 * has to find the edge of again, and the resizer would sit under the editor's
 * own left edge.
 */
export function clampOutlineWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_OUTLINE_WIDTH;
  return Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, value));
}

/**
 * Text *or* metadata. The encoding and line ending are part of what a save
 * writes, so a document whose text is untouched but whose line ending the user
 * just changed has genuinely unsaved changes -- and the close prompt, the tab's
 * dirty dot and Ctrl+S all key off this one function.
 */
export function isDirty(doc: Document): boolean {
  return (
    !doc.editorState.doc.eq(doc.savedDoc) ||
    doc.encoding !== doc.savedEncoding ||
    doc.lineEnding !== doc.savedLineEnding
  );
}

/**
 * Whitespace for the purpose of "what separates two words".
 *
 * Character codes and inline comparisons rather than `/\s/` or a `Set`,
 * because this runs once per character of the document on every keystroke --
 * see `countWords`. 9..13 is tab, LF, vertical tab, form feed and CR; 32 is
 * space and 0xa0 is NBSP. CR cannot actually reach here -- CodeMirror splits on
 * `/
?|
/` when it builds the `Text`, so a lone CR is already a line
 * break -- but a range check that stops at 12 to exclude one unreachable value
 * is a puzzle for the next reader rather than a saving. Not the full Unicode `\s` class: the ones missing
 * (ideographic space, the en/em quad family) would each need their own decision
 * about whether they even separate words in the script that uses them, and
 * guessing at that in a codepoint table is worse than not guessing.
 */
function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xa0;
}

/**
 * Words in a run of chunks, counted as whitespace-to-text transitions.
 *
 * Takes an iterator rather than a string so both callers -- the whole document
 * and a selected range -- share one implementation without either of them
 * materialising a copy. `Text.iter()` hands back the rope's own chunks and
 * yields line breaks as their own values, which `isSpace` already treats as
 * separators, so nothing has to special-case them.
 *
 * Measured on a 5,000-line document (405 KB, 80,000 words), which is SPEC
 * §7.1's stated bar for "no perceptible input lag": 2.05 ms. The obvious
 * `doc.toString().match(/\S+/g)` is 6.33 ms for the same answer -- three times
 * the cost, all of it allocating a 405 KB string and an 80,000-element array
 * that is then thrown away for its `.length`.
 *
 * 2 ms is an eighth of a frame and it is on the typing path, so it is worth
 * knowing where the ceiling is: this is linear in document size, and a document
 * large enough for it to matter wants the count debounced (the 150 ms
 * `preview/pane.ts` uses) rather than a cleverer counter. Nothing needs that
 * today.
 */
function countWords(chunks: Iterable<string>): number {
  let words = 0;
  let inWord = false;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      if (isSpace(chunk.charCodeAt(i))) {
        inWord = false;
      } else if (!inWord) {
        inWord = true;
        words++;
      }
    }
  }
  return words;
}

/**
 * The status bar's view of an `EditorState` (SPEC §6.11).
 *
 * Pure, and here in the model module rather than in `ui/statusbar.ts`, so the
 * counting rules are testable without a DOM and so the bar stays what every
 * other component in `ui/` is: a renderer of state it was handed.
 *
 * Only the **main** range, and that is a real choice rather than a simplifying
 * assumption: `buildExtensions` turns multi-cursor on
 * (`allowMultipleSelections` plus `clickAddsSelectionRange` on Alt+click), so
 * Alt+clicking twice genuinely produces two ranges and the bar counts one of
 * them. It matches what `activeFormats` already does, which also reads
 * `selection.main`. Summing instead is a one-line change to `countWords`'s
 * argument if it ever turns out to matter; picking the main range silently was
 * the part worth not doing.
 */
export function statusOf(state: EditorState): EditorStatus {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  const selection = !range.empty;
  return {
    line: line.number,
    col: range.head - line.from + 1,
    words: countWords(selection ? state.doc.iterRange(range.from, range.to) : state.doc.iter()),
    chars: selection ? range.to - range.from : state.doc.length,
    selection,
  };
}

/** What the status bar shows before the first document exists. */
export const EMPTY_STATUS: EditorStatus = {
  line: 1,
  col: 1,
  words: 0,
  chars: 0,
  selection: false,
};

/**
 * A never-saved, empty document — what the app opens with.
 *
 * Both defaults are optional rather than required: every test that mints a
 * document is indifferent to them, and `'source'`/`'utf-8'` are Go's
 * `DefaultSettings` values as well as what the app falls back to when settings
 * cannot be read. The two production callers -- main.ts's startup document and
 * documentops.ts's `makeUntitledDocument` -- pass the store's.
 *
 * `encoding` and `savedEncoding` are set together and must stay that way.
 * `isDirty` compares them, so a document minted with the two disagreeing would
 * open with a dirty dot and prompt on close, having been edited by nobody.
 */
export function createUntitledDocument(
  editorState: EditorState,
  viewMode: Document['viewMode'] = 'source',
  encoding: Encoding = 'utf-8',
): Document {
  return {
    id: crypto.randomUUID(),
    filePath: null,
    editorState,
    savedDoc: editorState.doc,
    viewMode,
    previousViewMode: previousViewModeFor(viewMode),
    encoding,
    lineEnding: 'crlf',
    savedEncoding: encoding,
    savedLineEnding: 'crlf',
    mixedLineEndings: false,
    scrollSnapshot: null,
  };
}
