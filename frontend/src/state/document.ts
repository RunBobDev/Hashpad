import type { EditorState, StateEffect, Text } from '@codemirror/state';

/**
 * Dirty state is derived (`!editorState.doc.eq(savedDoc)`), never stored as a
 * flag — that avoids an entire category of bugs where the flag and reality
 * drift apart. CodeMirror owns the text; this model deliberately does not
 * duplicate it.
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
  encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le';
  lineEnding: 'lf' | 'crlf';
  /**
   * CodeMirror's scroll position, captured as a StateEffect when this document
   * is switched away from and replayed when it comes back. Design §4.4 dropped
   * a numeric scrollTop in favour of this — the effect survives document
   * changes that a raw pixel offset would not.
   */
  scrollSnapshot: StateEffect<unknown> | null;
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
}

/**
 * How far the divider may travel. Not 0..1: a pane dragged to nothing is a
 * pane whose divider the user then has to hunt for, and an editor squeezed to
 * zero is worse.
 */
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

export function isDirty(doc: Document): boolean {
  return !doc.editorState.doc.eq(doc.savedDoc);
}

/** A never-saved, empty document — what the app opens with. */
export function createUntitledDocument(editorState: EditorState): Document {
  return {
    id: crypto.randomUUID(),
    filePath: null,
    editorState,
    savedDoc: editorState.doc,
    viewMode: 'source',
    previousViewMode: 'source',
    encoding: 'utf-8',
    lineEnding: 'crlf',
    scrollSnapshot: null,
  };
}
