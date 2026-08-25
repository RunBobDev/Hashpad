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
  viewMode: 'source' | 'live' | 'split';
  /**
   * The mode to return to when the preview is toggled off. A document opened
   * under `editor.defaultViewMode: "live"` must come back as `'live'` rather
   * than being silently downgraded to `'source'`.
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
 */
export function isViewMode(value: string): value is Document['viewMode'] {
  return value === 'source' || value === 'live' || value === 'split';
}

/**
 * What toggling the preview off should return to, for a document that opened
 * in `mode`.
 *
 * `'split'` is the one that needs saying: a document that opened straight into
 * split has no earlier mode to go back to, so it falls back to source. The
 * other two are their own answer -- a document opened under
 * `defaultViewMode: "live"` must come back as `'live'`, not be silently
 * downgraded (see `previousViewMode`).
 */
export function previousViewModeFor(mode: Document['viewMode']): Document['previousViewMode'] {
  return mode === 'split' ? 'source' : mode;
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
   */
  defaultViewMode: Document['viewMode'];
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
 * `viewMode` defaults to `'source'` rather than being required: every test that
 * mints a document is indifferent to it, and `'source'` is both Go's
 * `DefaultSettings` value and what the app falls back to when settings cannot
 * be read. The two production callers -- main.ts's startup document and
 * documentops.ts's `makeUntitledDocument` -- pass `defaultViewMode` from the
 * store.
 */
export function createUntitledDocument(
  editorState: EditorState,
  viewMode: Document['viewMode'] = 'source',
): Document {
  return {
    id: crypto.randomUUID(),
    filePath: null,
    editorState,
    savedDoc: editorState.doc,
    viewMode,
    previousViewMode: previousViewModeFor(viewMode),
    encoding: 'utf-8',
    lineEnding: 'crlf',
    savedEncoding: 'utf-8',
    savedLineEnding: 'crlf',
    mixedLineEndings: false,
    scrollSnapshot: null,
  };
}
