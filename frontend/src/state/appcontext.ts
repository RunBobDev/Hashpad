import type { EditorView } from '@codemirror/view';
import { createStore, type Store } from './store';
import {
  DEFAULT_OUTLINE_WIDTH,
  DEFAULT_SPLIT_RATIO,
  EMPTY_STATUS,
  type AppState,
  DEFAULT_BEHAVIOUR,
} from './document';

/**
 * The single central store (SPEC §5.1) and the one shared `EditorView` live
 * here, not in main.ts. main.ts's bootstrap needs both; files/fileops.ts's
 * open/save/save-as orchestration needs both; editor/extensions.ts's
 * update listener (which writes live edits back into the store) needs the
 * store. Splitting them into their own module — rather than main.ts owning
 * them and everyone else importing `from '../main'` — means none of those
 * three modules import each other: they all import this one instead. The
 * former arrangement made main.ts and fileops.ts mutually dependent, which
 * only worked because nothing touched the bindings at module-evaluation
 * time; it also meant fileops.test.ts (run under Vitest's DOM-less `node`
 * environment) transitively imported main.ts's DOM-touching bootstrap,
 * forcing a `typeof document !== 'undefined'` guard around all of it just
 * so the import wouldn't throw.
 *
 * Seeded with no documents: the real initial document can only be built once
 * the `EditorView` exists (its `EditorState` needs a mounted DOM element),
 * so main.ts's bootstrap calls `store.setState(...)` to populate `documents`
 * and `activeDocumentId` immediately after constructing the view. Nothing
 * in the real app runs before that first `setState` call.
 */
export const store: Store<AppState> = createStore<AppState>({
  documents: [],
  activeDocumentId: null,
  isDark: false,
  closedPaths: [],
  activeFormats: '',
  pinnedToolbarCommands: [],
  // Placeholder, like `pinnedToolbarCommands` above: main.ts's bootstrap
  // replaces it with the validated `window.previewSplitRatio` from settings.
  previewSplitRatio: DEFAULT_SPLIT_RATIO,
  // True to match Go's `DefaultSettings()` (internal/app/settings.go), which is
  // what a settings file that has never been edited carries.
  syncScroll: true,
  wordWrap: true,
  editorBehaviour: DEFAULT_BEHAVIOUR,
  // Go's `DefaultSettings()` value, like `syncScroll` above -- and also what
  // bootstrap leaves in place when the settings load throws, so a fresh install
  // and a broken settings file both open in source mode.
  defaultViewMode: 'source',
  // Go's `DefaultSettings()` again, and the encoding a new file gets when
  // settings cannot be read -- the safe answer, since UTF-8 without a BOM is
  // what the rest of the toolchain assumes.
  defaultEncoding: 'utf-8',
  // Off, per SPEC §3.2 and Go's `DefaultSettings()`. A settings load that fails
  // must not start writing the user's files behind them.
  autosave: false,
  autosaveDelayMs: 2000,
  // Also the value bootstrap republishes, as it happens: the startup document
  // is empty and `statusOf` of an empty document is exactly this. It stops
  // being a placeholder the first time the user types or a file is opened.
  status: EMPTY_STATUS,
  // Placeholder, like `previewSplitRatio` above: bootstrap replaces it with the
  // validated `window.outlineWidth` from settings.
  outlineWidth: DEFAULT_OUTLINE_WIDTH,
});

let editorView: EditorView | undefined;

/** Called once, from main.ts's bootstrap, right after the view is constructed. */
export function setEditorView(view: EditorView): void {
  editorView = view;
}

/**
 * The active `EditorView`. Throws rather than returning `undefined`: every
 * caller (fileops.ts's orchestration, extensions.ts's update listener) only
 * ever runs after the app has booted and `setEditorView` has already been
 * called, so a missing view means a real ordering bug. Surfacing that here
 * with a clear message beats letting `undefined` slip through and fail on
 * some unrelated `.state` access later.
 */
export function getEditorView(): EditorView {
  if (!editorView) {
    throw new Error(
      'getEditorView() called before the editor view was created -- setEditorView() must run during bootstrap first',
    );
  }
  return editorView;
}
