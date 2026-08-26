import { redo, undo } from '@codemirror/commands';
import './styles/app.css';
import { COMMAND_EVENT, mountMenuBar } from './ui/menubar';
import { EventsOn, Quit, WindowSetTitle } from '../wailsjs/runtime/runtime';
import {
  ConfirmQuit,
  LoadSettings,
  ResetSettings,
  SaveSettings,
  ShowWindow,
  SystemThemeIsDark,
} from '../wailsjs/go/app/App';
import type { app } from '../wailsjs/go/models';
import { createEditor } from './editor/editor';
import { COMMANDS, toEditorCommand, type CommandId } from './editor/commands';
import {
  publishActiveFormats,
  publishStatus,
  setEditorBehaviour,
  setWordWrap,
} from './editor/extensions';
import {
  openFiles,
  resolveDocumentsBeforeQuit,
  saveActive,
  saveActiveAs,
  saveDocument,
  windowTitle,
} from './files/fileops';
import { mountAutosave } from './files/autosave';
import {
  closeDocumentWithPrompt,
  makeUntitledDocument,
  reopenLastClosed,
  switchToDocument,
} from './files/documentops';
import { confirmSave } from './ui/confirmdialog';
import { mountTabBar, parseTabCommand } from './ui/tabbar';
import { openSearchPanel } from '@codemirror/search';
import { mountShortcuts } from './ui/shortcuts';
import { closeSettings, openSettings } from './ui/settingsdialog';
import { mountWindowEdges } from './ui/windowedges';
import { mountFileDrop } from './ui/filedrop';
import { isFullscreen, syncFullscreen, toggleFullscreen } from './ui/fullscreen';
import { applyTypography } from './settings/typography';
import {
  setBehaviourSetting,
  setDefaultViewModeSetting,
  setWordWrapSetting,
} from './settings/live';
import { mountOutline, type OutlineHandle } from './ui/outline';
import { mountStatusBar, parseStatusCommand } from './ui/statusbar';
import { DEFAULT_PINNED, mountToolbar, validatePinned } from './ui/toolbar';
import { store, setEditorView, getEditorView } from './state/appcontext';
import { mountZoom, zoomIn, zoomOut, zoomReset } from './ui/zoom';
import {
  activeDocument,
  addDocument,
  documentAtPosition,
  neighbourId,
  reorderDocument,
  setViewMode,
} from './state/documents';
import {
  clampOutlineWidth,
  clampSplitRatio,
  clampAutosaveDelay,
  clampTabSize,
  DEFAULT_BEHAVIOUR,
  createUntitledDocument,
  DEFAULT_OUTLINE_WIDTH,
  DEFAULT_SPLIT_RATIO,
  isDirty,
  isEncoding,
  isViewMode,
  previousViewModeFor,
  type Document,
  type Encoding,
} from './state/document';
// Type-only, so this does not pull preview/pane.ts (and with it markdown-it
// and DOMPurify) into the entry bundle -- `import type` is erased at compile
// time. The module itself only ever arrives through the dynamic import in
// `togglePreview` below.
import type { PreviewHandle } from './preview/pane';
import {
  applyAccent,
  applyTheme,
  isValidAccent,
  resolveIsDark,
  type ThemeMode,
} from './theme/theme';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

// The View menu shows which of its toggles are on (owner report: with word wrap
// enabled there was no way to tell short of resizing the window). Asked afresh
// each time a popup opens, because the truth for these lives in four different
// places and none of them is worth mirroring into a fifth.
//
// Reads `statusBarTeardown` and `outlineHandle`, both declared below. Safe, and
// worth saying so given this file's history: the callback only ever runs from a
// click, long after module evaluation, so neither is in its temporal dead zone
// -- unlike bootstrap's `finally`, which does run during evaluation.
mountMenuBar(root, (id) => {
  switch (id) {
    case 'theme.system':
    case 'theme.light':
    case 'theme.dark':
      return id === `theme.${themeMode}`;
    // Per *document*, not per window -- switch tabs and this legitimately
    // changes, which is exactly why it is read at open time.
    case 'view.preview':
      return activeDocument(store.getState())?.viewMode === 'split';
    // The handle doubles as the visibility flag for both of these; a separate
    // boolean beside it is a second source of truth that can disagree with the
    // DOM.
    case 'view.outline':
      return outlineHandle !== null;
    case 'view.statusBar':
      return statusBarTeardown !== null;
    case 'view.wordWrap':
      return store.getState().wordWrap;
    case 'view.lineNumbers':
      return store.getState().editorBehaviour.showLineNumbers;
    case 'view.fullscreen':
      return isFullscreen();
    default:
      return false;
  }
});
// Between the menu bar and the editor area, per SPEC §6.1's chrome layout --
// the window is frameless, so this row is the only place a filename appears.
mountTabBar(root);
// The toolbar mounts later, from bootstrap() below, once settings.toolbar is
// known: SPEC §6.13's `visible: false` means it must not appear at all, and
// that can only be decided once LoadSettings has resolved. Because that is
// after `editorArea` is already in the tree, bootstrap passes it as the node
// to insert before -- appending would drop the formatting row below the
// editor, at the bottom of the window, since #app is a plain flex column.
// Since Checkpoint F that node is the split row below, not the editor area
// inside it -- see the mountToolbar call for what goes wrong otherwise.

// The horizontal band between the toolbar and the status bar. Two nested rows,
// not one, and the nesting is what keeps the preview's split ratio meaningful:
// `.workspace` holds the outline sidebar beside everything else, and
// `.editor-split` holds the editor beside the preview. Flattening them would
// make `previewSplitRatio` a share of a row that includes the sidebar, so
// opening the outline would silently shrink the preview.
const workspace = document.createElement('div');
workspace.className = 'workspace';
root.append(workspace);

// #app is a flex *column*, so the editor and the preview need a flex row of
// their own to sit side by side. Built at startup whether or not the preview
// is on: toggling it then only adds and removes two children of this row,
// rather than restructuring the tree around a live EditorView.
const editorSplit = document.createElement('div');
editorSplit.className = 'editor-split';
workspace.append(editorSplit);

const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
editorSplit.append(editorArea);

// Starts light; bootstrap() below replaces this the moment settings and the
// system preference are known, before the (still-hidden) window shows.
const view = createEditor(editorArea, '', false);
setEditorView(view);

// Checkpoint A opens with exactly one untitled document; its EditorState is
// the same instance the view above was constructed with, so the two do not
// start out of sync.
const initialDocument = createUntitledDocument(view.state);
store.setState((prev) => ({
  ...prev,
  documents: [initialDocument],
  activeDocumentId: initialDocument.id,
}));

// The mode currently in effect, tracked outside the store because the focus
// listener needs to know whether the *user's choice* is 'system' -- the
// store's `isDark` only ever holds the resolved boolean, which can't
// distinguish "system, currently resolving to light" from an explicit
// 'light' choice that must never be overridden by the OS.
let themeMode: ThemeMode = 'system';

/**
 * The mounted status bar's teardown, or `null` when the row is off. It doubles
 * as the visibility flag -- a separate boolean beside it is a second source of
 * truth that can disagree with the DOM, the same reasoning that keeps `isDirty`
 * derived rather than stored.
 *
 * Declared **above** `void bootstrap()` and not beside `setStatusBar`, which is
 * where it started. `bootstrap`'s `finally` reads it, and a `let` is in its
 * temporal dead zone until module evaluation reaches the declaration -- normally
 * irrelevant, because `await LoadSettings()` suspends and the module finishes
 * evaluating first. But the generated binding is a plain
 * `window['go']['app']['App']['LoadSettings']()`, which throws a TypeError
 * *synchronously* if Wails has not injected `window.go` yet. Nothing has awaited
 * at that point, so the `catch` and `finally` run inside module evaluation, and
 * `setStatusBar` would hit the dead zone and throw before reaching `ShowWindow`.
 * main.go uses `StartHidden`, so that is a permanently invisible window -- the
 * exact failure this whole block is built to prevent, and the one Checkpoint D
 * had to add a Go-side backstop for. `root`, `view` and `themeMode` are all
 * already declared above the call for the same reason.
 */
let statusBarTeardown: (() => void) | null = null;

/**
 * The mounted outline, or `null` when the sidebar is off -- the same
 * handle-doubles-as-flag arrangement as `statusBarTeardown` above, and declared
 * above `void bootstrap()` for the same temporal-dead-zone reason.
 */
let outlineHandle: OutlineHandle | null = null;

function isThemeMode(value: string): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Settings arrive over IPC and CSP (`script-src 'self'`) forbids the inline
 * bootstrap script that would otherwise pick a theme before first paint, so
 * the window starts hidden (main.go's StartHidden) and this is what shows it.
 *
 * Named `bootstrap`, not `bootstrapTheme` -- Task 8 added the toolbar's
 * layout (its visibility and pinned set) to what a single settings load
 * resolves before the window shows, and the old name would mislead a reader
 * six months from now into thinking this is still theme-only.
 *
 * Wrapped in try/finally: a settings file that fails to load must still
 * result in a visible window, in the compiled-in default theme
 * (`resolveIsDark('system', null)`) and the compiled-in default toolbar
 * (visible, `DEFAULT_PINNED`), rather than an app that appears to hang on
 * launch or silently loses its formatting row over an IPC error.
 */
async function bootstrap(): Promise<void> {
  let toolbarVisible = true;
  let pinnedCommands: string[] = [...DEFAULT_PINNED];
  let splitRatio = DEFAULT_SPLIT_RATIO;
  // True is Go's default too (internal/app/settings.go's `DefaultSettings`), so
  // a settings load that fails leaves the same behaviour a fresh install has.
  let syncScroll = true;
  // SPEC §6.6's default, and Go's (`DefaultSettings`), so a failed settings load
  // leaves the same behaviour a fresh install has.
  let wordWrap = true;
  // Same again for SPEC §6.11's row.
  let statusBarVisible = true;
  // SPEC §6.9's sidebar is hidden by default, which is Go's default too.
  let outlineVisible = false;
  let outlineWidth = DEFAULT_OUTLINE_WIDTH;
  let editorBehaviour = DEFAULT_BEHAVIOUR;
  // Go's default is `"source"`, so a failed settings load opens in source mode
  // -- the same behaviour a fresh install has, like every local above.
  let defaultViewMode: Document['viewMode'] = 'source';
  // Go's default again. Worth being the fallback on its own merits and not only
  // for symmetry: UTF-8 with no BOM is what a document nobody has configured
  // should be written as.
  let defaultEncoding: Encoding = 'utf-8';
  // Off, per SPEC §3.2 and Go's default. The fallback matters more here than
  // for the others: a settings load that failed must not leave the app writing
  // the user's files on a timer they never switched on.
  let autosave = false;
  let autosaveDelayMs = 2000;

  try {
    const settings = await LoadSettings();
    themeMode = isThemeMode(settings.appearance.theme) ? settings.appearance.theme : 'system';

    let systemIsDark: boolean | null;
    try {
      systemIsDark = await SystemThemeIsDark();
    } catch {
      // Undeterminable is an expected, meaningful outcome (SPEC §6.12), not a
      // bug -- worth one log line at startup, but resolveIsDark's fallback to
      // the manual setting (light, here) handles it without further action.
      console.info('hashpad: system theme preference is undeterminable at startup; falling back');
      systemIsDark = null;
    }

    // A hand-edited settings.json can carry anything in accentColor; writing
    // it straight into --accent-base without validation is a CSS-injection
    // vector (theme.ts's isValidAccent), so an invalid value is skipped
    // rather than applied, leaving variables.css's own default in place.
    if (isValidAccent(settings.appearance.accentColor)) {
      applyAccent(settings.appearance.accentColor);
    }
    applyTheme(resolveIsDark(themeMode, systemIsDark));

    // Fonts, sizes and the content width, straight onto :root (SPEC §6.13).
    // Before the window is shown, like the theme and for the same reason: the
    // alternative is the user watching the text resize itself on every launch.
    // Every value is clamped inside -- see settings/typography.ts.
    applyTypography(settings);

    toolbarVisible = settings.toolbar.visible;
    // A hand-edited settings.json naming an unknown or renamed command must
    // not brick the toolbar (Task 8 brief, ambiguity #2) -- validatePinned
    // drops what it doesn't recognise and falls back to DEFAULT_PINNED only
    // when the value isn't even an array of strings.
    pinnedCommands = validatePinned(settings.toolbar.pinned);
    // Same treatment as the pinned list above, and for the same reason: this
    // is a hand-editable file, so the value is validated rather than trusted.
    // Read last in this block deliberately -- anything that threw here would
    // cost the theme and the toolbar their settings too.
    splitRatio = clampSplitRatio(settings.window.previewSplitRatio);
    // Taken as-is rather than validated the way the ratio above is, for the
    // same reason `toolbar.visible` is: Go unmarshals this field into a `bool`,
    // and `LoadSettingsFrom` replaces a file that fails to unmarshal with
    // defaults (internal/app/settings.go), so a hand-edited non-boolean never
    // reaches this side. Read last for the same reason the ratio is read late
    // -- a throw here must not cost the theme, the toolbar and the ratio theirs.
    syncScroll = settings.preview.syncScroll;
    wordWrap = settings.editor.wordWrap;
    // Taken as-is for the same reason `toolbar.visible` is -- see that comment.
    statusBarVisible = settings.window.statusBarVisible;
    outlineVisible = settings.window.outlineVisible;
    // Validated rather than trusted, the same as the split ratio: this is a
    // hand-editable file and the value goes straight into a CSS length.
    outlineWidth = clampOutlineWidth(settings.window.outlineWidth);
    // SPEC §6.13's editor behaviours. `tabSize` is clamped for the same reason
    // the widths above are -- it comes from a hand-editable file and a 0 would
    // make Tab insert nothing. The two booleans are taken as-is, like
    // `toolbar.visible`: Go unmarshals them into `bool`, and a file that fails
    // to unmarshal is replaced with defaults before it reaches here.
    editorBehaviour = {
      showLineNumbers: settings.editor.showLineNumbers,
      tabSize: clampTabSize(settings.editor.tabSize),
      insertSpaces: settings.editor.insertSpaces,
    };
    // Checked rather than taken as-is, unlike the booleans above: Go declares
    // this one as a `string`, so unmarshalling does not reject a hand-edited
    // value the way it rejects a non-boolean. See `isViewMode`.
    if (isViewMode(settings.editor.defaultViewMode)) {
      defaultViewMode = settings.editor.defaultViewMode;
    }
    // Checked for the same reason, and it matters more: this is what an
    // untitled document gets *written* as, so an unrecognised value would reach
    // Go's `WriteFile` the first time the user saved.
    if (isEncoding(settings.files.defaultEncoding)) {
      defaultEncoding = settings.files.defaultEncoding;
    }
    // Taken as-is, like the other booleans: Go unmarshals it into a `bool` and
    // a file that fails to unmarshal is replaced with defaults before it gets
    // here. The delay is clamped for the same reason `tabSize` is.
    autosave = settings.files.autosave;
    autosaveDelayMs = clampAutosaveDelay(settings.files.autosaveDelayMs);
  } catch (err) {
    console.error('hashpad: failed to load settings; starting with the default theme', err);
    applyTheme(false);
  } finally {
    store.setState((prev) => ({
      ...prev,
      pinnedToolbarCommands: pinnedCommands,
      previewSplitRatio: splitRatio,
      syncScroll,
      wordWrap,
      editorBehaviour,
      defaultViewMode,
      defaultEncoding,
      autosave,
      autosaveDelayMs,
      outlineWidth,
    }));
    // No View-menu toggle for this (Task 8 brief, ambiguity #3): that belongs
    // with Checkpoint H's settings dialog. (The checkmark support that comment
    // also cited now exists -- see `mountMenuBar`'s `isChecked` above -- but the
    // reason to keep it out of View stands: it is a settings-dialog concern.)
    // Guarded independently of the try above. This whole block exists to
    // guarantee ShowWindow runs, and main.go's StartHidden means a throw
    // between here and it leaves the window permanently invisible -- the
    // failure mode Checkpoint D hit and had to add a Go-side backstop for.
    // `insertBefore` throws NotFoundError if handed a node that is not a
    // child of `root`, so this one call is worth its own guard.
    try {
      // Inserted before `workspace`, the outermost of the three: `editorArea`
      // and `editorSplit` are both nested inside it now, and `insertBefore`
      // throws NotFoundError for a node that is not a child of `root` -- which
      // is precisely the throw the guard around this call was written for.
      if (toolbarVisible) mountToolbar(root!, pinnedCommands, workspace);
    } catch (err) {
      console.error('hashpad: failed to mount the toolbar; continuing without it', err);
    }

    // The initial document's state was installed straight into the view's
    // constructor, not through a transaction, so no updateListener has ever
    // run for it -- `activeFormats` would sit at its initial `''` until the
    // user first typed. A file opened from the command line with the caret
    // already inside `**bold**` would advertise no formatting at all.
    // The editor was constructed before LoadSettings resolved, so it is holding
    // the compiled-in default until here -- same reason the theme is applied in
    // this block rather than at construction.
    setWordWrap(view, wordWrap);
    // Same reasoning, and the same seam: the store alone would be a half-wired
    // setting, because the view already exists and only a reconfigure reaches
    // it. New tabs pick this up from the store instead (documentops.ts).
    setEditorBehaviour(view, editorBehaviour);
    // The window is about to be shown, and an editor nobody has clicked in yet
    // takes no typing at all -- focus sits on `<body>`. Notepad opens with a
    // caret in the document and so should this. `ui/shortcuts.ts` covers the
    // shortcuts once focus moves elsewhere; this covers the first keystroke.
    view.focus();
    publishActiveFormats(view.state);
    // Defensive symmetry with the line above rather than an observable fix: the
    // startup document is always empty, and `statusOf` of an empty document is
    // exactly `EMPTY_STATUS`, so today this publishes the value the store
    // already holds and `isEqual` drops the notification. It stays because it is
    // one line and it is what keeps this correct the day the startup document
    // stops being empty -- a file opened from the command line, say. Nothing
    // tests it, because there is no behaviour to assert.
    publishStatus(view.state);
    setStatusBar(statusBarVisible);
    setOutline(outlineVisible);
    // Same catching-up as `restoreViewMode` below, for the other document
    // default -- and unguarded because it is a plain store write with nothing
    // to throw, where that one awaits a dynamic import.
    applyDefaultEncoding(defaultEncoding);

    // The startup document was minted at module scope, before `LoadSettings`
    // resolved, so it is holding the compiled-in `'source'` -- the same
    // situation as the theme, the fonts and `editorBehaviour` above, and fixed
    // here for the same reason: applying it *before* the window appears is what
    // stops the user watching the pane slide in on every launch.
    //
    // Its own try/catch, like the toolbar mount above and for the same reason.
    // This one awaits a dynamic `import()`, and main.go's StartHidden means an
    // unguarded throw between here and `ShowWindow` leaves the window
    // permanently invisible -- the failure Checkpoint D had to add a Go-side
    // backstop for.
    try {
      await restoreViewMode(defaultViewMode);
    } catch (err) {
      // The store keeps the mode it was seeded with unless this failed, and a
      // `'split'` left in place with no pane mounted is worse than losing the
      // setting for one session: `openDocumentInNewTab` would mint split
      // documents the subscription cannot show, and View > Preview would sit
      // checked over an empty column.
      store.setState((prev) => ({ ...prev, defaultViewMode: 'source' }));
      console.error('hashpad: failed to restore the saved view mode; opening in source mode', err);
    }
    ShowWindow();
  }
}
void bootstrap();

// Window-level, not an editor command: zoom has to work with the caret in the
// editor, the focus in the preview, or nothing focused at all.
mountZoom();

// The same problem for every *other* shortcut, which unlike zoom are declared in
// the editor's keymap and so only fire while the editor has focus. This forwards
// them when it does not; see ui/shortcuts.ts.
mountShortcuts(view);

// The window is frameless, so it has no OS resize border -- these eight strips
// are it. Mounted on `#app` rather than the workspace row because they are
// fixed to the viewport and belong to the window, not to any row; see
// ui/windowedges.ts for the three separate ways the edge failed without them.
mountWindowEdges(root);

// SPEC §3.2's autosave. Mounted unconditionally and inert while the setting is
// off -- it subscribes to the setting as well as to the documents, so switching
// it on mid-session starts the countdown without waiting for a keystroke.
mountAutosave();

// Files dropped on the window open as tabs (SPEC §6.4). Whole-window, so it is
// mounted here rather than on any one region; see ui/filedrop.ts for why the
// paths have to come from Wails rather than the DOM `drop` event.
mountFileDrop();

// F11's state, read once from the window rather than assumed (ui/fullscreen.ts).
// Fire-and-forget with its own error handling inside: nothing downstream waits
// on it, and the flag it sets is already correct for every path that reaches
// here today.
void syncFullscreen();

/**
 * Routes a View > Theme menu choice. `themeMode` is updated first and
 * unconditionally -- it is the same module-local the focus listener below
 * reads to decide whether the OS may override the user's pick, so an
 * explicit Light or Dark choice must be visible there immediately, not just
 * reflected in the applied colours.
 *
 * SPEC §6.13 requires every setting to take effect immediately, so the new
 * theme is applied before anything async happens; `SaveSettings` runs after,
 * and a failed disk write (logged, not thrown) must not undo the repaint
 * that already happened.
 */
async function setThemeMode(mode: ThemeMode): Promise<void> {
  themeMode = mode;

  // Light/dark resolve without consulting the OS at all (resolveIsDark), so
  // only 'system' needs a fresh read -- picking it while Windows is light
  // must go light right away rather than waiting for the next focus event.
  let systemIsDark: boolean | null = null;
  if (mode === 'system') {
    try {
      systemIsDark = await SystemThemeIsDark();
    } catch {
      // Same fallback as bootstrap(): undeterminable is expected (SPEC
      // §6.12), worth one log line, and resolveIsDark's null handling covers
      // the rest without further action.
      console.info('hashpad: system theme preference is undeterminable; falling back');
      systemIsDark = null;
    }
  }
  applyTheme(resolveIsDark(mode, systemIsDark));

  try {
    const settings = await LoadSettings();
    settings.appearance.theme = mode;
    await SaveSettings(settings);
  } catch (err) {
    // The visible change above already happened; a settings round-trip that
    // fails here means the choice won't survive a restart, not that it
    // silently didn't apply.
    console.error('hashpad: failed to persist theme choice', err);
  }
}

/**
 * Persists a pin/unpin toggle from the toolbar's right-click menu
 * (ui/toolbar.ts's `choosePinItem`, routed here below as `toolbar.pin:<id>` /
 * `toolbar.unpin:<id>` on the shared `hashpad:command` bus -- the seam
 * mountToolbar's own header comment says Task 8 was always meant to use).
 *
 * The toolbar's own *visible* redraw does not wait for any of this: it
 * already happened, synchronously, through mountToolbar's `onTogglePin`
 * callback, by the time this function's caller even runs. What this does is
 * make the choice a real setting -- `pinnedToolbarCommands` is updated first
 * and unconditionally (SPEC §6.13's "every setting takes effect
 * immediately"), so the store reflects the change right away and so a second
 * toggle in the same session computes its diff against this one's result
 * rather than a stale settings-file snapshot. `SaveSettings` runs after, with
 * the same ordering and the same error handling `setThemeMode` above uses for
 * the theme: a failed write is logged, never thrown, because the choice
 * already took effect and a disk error must not silently un-toggle it.
 */
async function setToolbarPinned(commandId: string, pinned: boolean): Promise<void> {
  const current = store.getState().pinnedToolbarCommands;
  const next = pinned
    ? current.includes(commandId)
      ? [...current]
      : [...current, commandId]
    : current.filter((id) => id !== commandId);
  store.setState((prev) => ({ ...prev, pinnedToolbarCommands: next }));

  try {
    const settings = await LoadSettings();
    settings.toolbar.pinned = next;
    await SaveSettings(settings);
  } catch (err) {
    console.error('hashpad: failed to persist the toolbar layout', err);
  }
}

/**
 * The preview pane, once it has ever been asked for. Lazy per design §2.4: the
 * pane is off by default, so markdown-it, DOMPurify and everything under
 * `preview/` cost nothing at startup -- and the handle is cached so the second
 * Ctrl+Shift+P does not re-import.
 */
let previewHandle: PreviewHandle | null = null;

/**
 * `viewMode` is per *document*, so the one shared pane has to follow whichever
 * document is on screen -- not just whichever one was toggled. Without this,
 * switching from a split-mode tab to a source-mode one leaves the pane open
 * still showing the tab you just left: the pane's own render is skipped for a
 * document that is not in split mode (preview/pane.ts), so the outgoing
 * document's HTML simply stays there. The plan does not mention this; it falls
 * straight out of putting the mode on the document.
 *
 * Registered unconditionally at startup, but inert until the first
 * Ctrl+Shift+P has actually loaded the pane -- a `null` handle costs one
 * comparison per active-document change.
 */
store.subscribe(
  (state) => activeDocument(state)?.viewMode ?? null,
  (mode) => {
    if (previewHandle === null) return;
    if (mode === 'split') previewHandle.show();
    else previewHandle.hide();
  },
);

/**
 * Puts the active document into split mode, mounting the pane if this is the
 * first time.
 *
 * Split out of `togglePreview` so that bootstrap can reuse it *without* the
 * persistence: restoring the saved mode is reading the setting back, not the
 * user choosing it, and routing startup through the toggle would mean a
 * `LoadSettings`/`SaveSettings` round trip on every launch to write down the
 * value it had just read.
 *
 * `setViewMode` runs *before* `show()`, which is not arbitrary: it is the
 * store write above that opens the pane and renders it, and the explicit
 * `show()` that follows is then a no-op. Doing it the other way round would
 * show an empty pane -- the pane skips rendering a document that is not yet
 * in split mode -- until the user's next keystroke.
 */
async function showPreview(): Promise<void> {
  const active = activeDocument(store.getState());
  if (active === null || active.viewMode === 'split') return;

  // Copied into a local before the await below: TypeScript discards a
  // narrowing of `active.viewMode` across it, and this also pins the mode to
  // what it was when the toggle was pressed rather than whatever it is by the
  // time the dynamic import resolves.
  const mode = active.viewMode;

  // Imported before the state write, so the subscription has a handle to call
  // `show()` on when it fires.
  if (!previewHandle) {
    previewHandle = (await import('./preview/pane')).mountPreview(editorSplit, view);
  }
  store.setState((prev) => setViewMode(prev, active.id, 'split', mode));
}

/**
 * Ctrl+Shift+P / View > Preview.
 *
 * Neither branch calls `show()`/`hide()` itself. The subscription above is
 * registered at module load and reacts to exactly the `viewMode` write, so it
 * has already done it by the time `setState` returns -- and it is also what
 * handles the tab switches this function never sees. Calling it here as well
 * would be two paths owning the same effect, with the second a silent no-op
 * that reads as if it were doing the work.
 *
 * The outgoing mode is handed to `setViewMode` as `remember` only on the way in
 * (inside `showPreview`), so toggling off restores `'live'` for a document that
 * was in live mode rather than downgrading it to source.
 */
async function togglePreview(): Promise<void> {
  const active = activeDocument(store.getState());
  if (active === null) return;

  if (active.viewMode === 'split') {
    store.setState((prev) => setViewMode(prev, active.id, active.previousViewMode));
    void setDefaultViewModeSetting(active.previousViewMode);
    return;
  }

  await showPreview();
  void setDefaultViewModeSetting('split');
}

/**
 * Puts a document into the mode a previous session left the preview in.
 *
 * The `'split'` branch is the whole point, but the other modes go through here
 * too rather than being special-cased away: the startup document is minted
 * before settings load, so whatever `defaultViewMode` turns out to be, this is
 * the one place that catches it up with a new tab opened a second later.
 *
 * Deliberately not persisting -- see `showPreview`.
 */
async function restoreViewMode(mode: Document['viewMode']): Promise<void> {
  const active = activeDocument(store.getState());
  if (active === null || active.viewMode === mode) return;

  if (mode === 'split') {
    await showPreview();
    return;
  }
  store.setState((prev) => setViewMode(prev, active.id, mode, previousViewModeFor(mode)));
}

/**
 * File > Settings > Reset to default (SPEC §6.13).
 *
 * Go owns what "default" means -- `DefaultSettings()` is the one definition of
 * it, and a TypeScript copy would be a second one that drifts the first time a
 * default changes. `ResetSettings` writes it and hands it back, and everything
 * below re-applies exactly what is now on disk.
 *
 * **On failure, nothing happens at all.** Wails rejects the promise and
 * discards the value, so a failed write leaves both the file and the running
 * app as they were -- which is the right outcome: a reset that appeared to work
 * and quietly did not persist is worse than one that visibly did nothing.
 *
 * This lives in main.ts and not in the dialog because three of the things it
 * has to re-apply -- the theme, the status bar, the outline -- are owned by
 * module locals in this file, and a second writer would leave those behind.
 *
 * **Two settings do not come back until the next launch:** the toolbar's
 * visibility, which is decided once at bootstrap because nothing can toggle it
 * at runtime, and its pinned list, which `mountToolbar` seeds into a closure
 * rather than reading from the store. Both are on disk immediately. The confirm
 * says so rather than leaving the user to notice.
 */
async function resetSettings(): Promise<void> {
  let defaults: app.Settings;
  try {
    defaults = await ResetSettings();
  } catch (err) {
    console.error('hashpad: failed to reset the settings; nothing was changed', err);
    return;
  }

  // No validation on the way in, unlike bootstrap's read of the same fields.
  // This is Go's `DefaultSettings()`, not a hand-editable file -- there is no
  // trust boundary here, and `applyTypography` clamps its own inputs regardless.
  void setThemeMode('system');
  applyAccent(defaults.appearance.accentColor);
  applyTypography(defaults);

  const behaviour = {
    showLineNumbers: defaults.editor.showLineNumbers,
    tabSize: defaults.editor.tabSize,
    insertSpaces: defaults.editor.insertSpaces,
  };
  store.setState((prev) => ({
    ...prev,
    wordWrap: defaults.editor.wordWrap,
    editorBehaviour: behaviour,
    defaultViewMode: 'source',
    defaultEncoding: 'utf-8',
    syncScroll: defaults.preview.syncScroll,
    autosave: defaults.files.autosave,
    autosaveDelayMs: defaults.files.autosaveDelayMs,
    previewSplitRatio: defaults.window.previewSplitRatio,
    outlineWidth: defaults.window.outlineWidth,
    pinnedToolbarCommands: defaults.toolbar.pinned,
  }));
  // The store alone is half-wired for these two: the open editor is already
  // constructed, and only a reconfigure reaches it.
  setWordWrap(view, defaults.editor.wordWrap);
  setEditorBehaviour(view, behaviour);
  setStatusBar(defaults.window.statusBarVisible);
  setOutline(defaults.window.outlineVisible);

  // Rebuilt rather than updated in place: every control was populated when the
  // dialog was built, so re-reading them all here would be a second way of
  // writing what `buildSettingsDialog` already does.
  closeSettings();
  void openSettings();
}

/**
 * Puts the startup document on the saved `files.defaultEncoding`.
 *
 * Needed for the same reason `restoreViewMode` is: the document is minted at
 * module scope, before `LoadSettings` resolves, so it is always holding the
 * compiled-in `'utf-8'` when it is created. Without this, the tab the app opens
 * with would be written as UTF-8 while every tab opened a second later used the
 * configured encoding -- the two disagreeing over nothing but timing.
 *
 * `savedEncoding` moves with `encoding`, and that pairing is the trap here.
 * `isDirty` compares the two, so writing only the first would put a dirty dot
 * on an untouched document and prompt to save it on close.
 *
 * Only the untitled startup document is ever in `documents` at this point, so
 * there is no "is this a real file?" guard: an opened file's encoding is
 * detected and must never be overridden, but no opened file can exist yet.
 */
function applyDefaultEncoding(encoding: Encoding): void {
  const active = activeDocument(store.getState());
  if (active === null || active.encoding === encoding) return;

  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((doc) =>
      doc.id === active.id ? { ...doc, encoding, savedEncoding: encoding } : doc,
    ),
  }));
}

/**
 * Mounts or tears down the outline sidebar (SPEC §6.9). Idempotent, like
 * `setStatusBar` below, and unmounting rather than hiding for the same reason
 * plus one more: the sidebar subscribes to the active document and rescans it
 * for headings on every edit, so a hidden one would keep paying for a list
 * nobody can see.
 */
function setOutline(visible: boolean): void {
  if (visible) {
    outlineHandle ??= mountOutline(workspace, view);
    return;
  }
  outlineHandle?.destroy();
  outlineHandle = null;
}

/**
 * View > Outline, Ctrl+Shift+O. Applied first, persisted after, a failed disk
 * write logged rather than thrown -- the same ordering and error handling as
 * `setWordWrapSetting` and `setStatusBarSetting`.
 */

async function setOutlineSetting(visible: boolean): Promise<void> {
  setOutline(visible);

  try {
    const settings = await LoadSettings();
    settings.window.outlineVisible = visible;
    await SaveSettings(settings);
  } catch (err) {
    console.error('hashpad: failed to persist the outline setting', err);
  }
}

/** Idempotent, so a call that repeats the current state mounts nothing twice. */
function setStatusBar(visible: boolean): void {
  if (visible) {
    statusBarTeardown ??= mountStatusBar(root!);
    return;
  }
  statusBarTeardown?.();
  statusBarTeardown = null;
}

/**
 * The status bar's encoding and line-ending menus (SPEC §6.11).
 *
 * Writes the document and stops. Nothing is saved here and nothing should be:
 * `isDirty` now compares the encoding and line ending against their saved
 * counterparts, so the change shows up as a dirty tab immediately and reaches
 * the disk on the next Ctrl+S like any other edit. Writing the file behind the
 * user's back because they opened a dropdown would be the surprising choice,
 * and it is not available for an untitled document anyway.
 *
 * Untitled documents are deliberately *not* excluded. There is no file to
 * disagree with yet, so the pick simply becomes what Save As will write.
 */
function setDocumentEncoding(command: string): void {
  const parsed = parseStatusCommand(command);
  if (parsed === null) return;

  const id = store.getState().activeDocumentId;
  if (id === null) return;

  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((doc) =>
      doc.id === id
        ? parsed.kind === 'encoding'
          ? { ...doc, encoding: parsed.value }
          : { ...doc, lineEnding: parsed.value }
        : doc,
    ),
  }));
}

/**
 * View > Status Bar (SPEC §6.11). Applied first, persisted after, a failed disk
 * write logged rather than thrown -- the same ordering and error handling as
 * `setWordWrapSetting` above, and for the same reason.
 *
 * Unlike word wrap this needs no store field: nothing but this row reacts to
 * it, and the row's own presence in the DOM is the state.
 */
async function setStatusBarSetting(visible: boolean): Promise<void> {
  setStatusBar(visible);

  try {
    const settings = await LoadSettings();
    settings.window.statusBarVisible = visible;
    await SaveSettings(settings);
  } catch (err) {
    console.error('hashpad: failed to persist the status-bar setting', err);
  }
}

// There is no OS-level watcher (see internal/app/theme.go), so this is how a
// theme changed mid-session gets picked up -- a registry read on focus costs
// microseconds, so polling it here is free.
window.addEventListener('focus', () => {
  // An explicit Light or Dark choice must never be overridden by the OS.
  if (themeMode !== 'system') return;

  void (async () => {
    let systemIsDark: boolean;
    try {
      systemIsDark = await SystemThemeIsDark();
    } catch {
      // Swallowed, not logged: unlike the one-shot startup read, this fires
      // on every focus, and a user whose registry key genuinely doesn't
      // exist would otherwise see it spammed on every alt-tab.
      return;
    }

    const resolved = resolveIsDark(themeMode, systemIsDark);
    // Alt-tabbing is frequent; repaint only when the resolved theme actually
    // changed rather than on every focus.
    if (resolved !== store.getState().isDark) applyTheme(resolved);
  })();
});

// Menu items and keyboard shortcuts (see editor/extensions.ts) both dispatch
// commands rather than calling features directly; this is where those
// commands get routed to effects.
document.addEventListener(COMMAND_EVENT, (event) => {
  const id = (event as CustomEvent<string>).detail;

  // Toolbar commands (ui/toolbar.ts) carry the command id after a 'format.'
  // prefix, so -- like the tab-bar commands just below -- they cannot be
  // matched by the plain-string switch. Routed through the same
  // toEditorCommand adapter the keymap uses (editor/extensions.ts), which is
  // what keeps a toolbar button and its keyboard shortcut running through
  // the exact same MarkdownCommand (SPEC §6.5's "one implementation, two
  // triggers") rather than the toolbar growing a second path into the
  // editor. The `in COMMANDS` guard is for `heading`, which is one button
  // standing for six commands and so has no entry of its own -- it opens a
  // level picker instead of emitting `format.heading`, and ui/toolbar.ts's
  // test suite pins that exemption. Every other toolbar id is bound to a real
  // command at compile time (`ToolbarCommand.id` is `CommandId | 'heading'`),
  // so this guard cannot quietly swallow a typo.
  if (id.startsWith('format.')) {
    const commandId = id.slice('format.'.length);
    if (commandId in COMMANDS) {
      toEditorCommand(COMMANDS[commandId as CommandId])(getEditorView());
    }
    return;
  }

  // The toolbar's right-click pin/unpin menu (ui/toolbar.ts's
  // choosePinItem) -- see setToolbarPinned's own comment for why the
  // toolbar's visible redraw does not wait for this; this is the persistence
  // half of that same toggle.
  if (id.startsWith('toolbar.pin:')) {
    void setToolbarPinned(id.slice('toolbar.pin:'.length), true);
    return;
  }
  if (id.startsWith('toolbar.unpin:')) {
    void setToolbarPinned(id.slice('toolbar.unpin:'.length), false);
    return;
  }

  // Carries the chosen value, so like the tab commands below it cannot be
  // matched by the plain-string switch. `parseStatusCommand` answers null for
  // anything that is not one of ours, including an id with our prefix and a
  // value no decoder knows.
  if (parseStatusCommand(id) !== null) {
    setDocumentEncoding(id);
    return;
  }

  // Tab-bar commands carry a document id (ui/tabbar.ts), so they cannot be
  // matched by the plain-string switch below -- handle them first and return.
  const tabCommand = parseTabCommand(id);
  if (tabCommand) {
    switch (tabCommand.kind) {
      case 'activate':
        switchToDocument(tabCommand.id);
        break;
      case 'close':
        void closeDocumentWithPrompt(tabCommand.id);
        break;
      case 'reorder':
        store.setState((prev) => reorderDocument(prev, tabCommand.id, tabCommand.toIndex));
        break;
    }
    return;
  }

  switch (id) {
    case 'file.exit':
      Quit();
      break;
    case 'file.new': {
      // Adds a tab rather than replacing anything -- Checkpoint C drops the
      // single-document assumption `newDocument` used to encode. Inlined
      // here rather than added as a new documentops.ts export because that
      // module's public surface (see Task 2's brief) is exactly the five
      // functions it already has; this is just their composition.
      const doc = makeUntitledDocument();
      store.setState((prev) => addDocument(prev, doc));
      switchToDocument(doc.id);
      break;
    }
    case 'file.open':
      void openFiles();
      break;
    case 'file.save':
      void saveActive();
      break;
    case 'file.saveAs':
      void saveActiveAs();
      break;
    case 'edit.undo':
      undo(view);
      break;
    case 'edit.redo':
      redo(view);
      break;
    case 'tab.close': {
      // No id is carried on this command (unlike tab-bar close, which names
      // its tab explicitly) -- Ctrl+W and File > Close Tab both always mean
      // "close whichever tab is on screen right now".
      const activeId = store.getState().activeDocumentId;
      if (activeId !== null) void closeDocumentWithPrompt(activeId);
      break;
    }
    case 'tab.reopen':
      void reopenLastClosed();
      break;
    case 'tab.moveLeft':
    case 'tab.moveRight': {
      // The keyboard equivalent of dragging a tab. Clamping lives in
      // reorderDocument, so moving past either end is a harmless no-op rather
      // than something this router has to special-case.
      const state = store.getState();
      const active = state.activeDocumentId;
      if (active === null) break;
      const from = state.documents.findIndex((d) => d.id === active);
      if (from === -1) break;
      store.setState((prev) =>
        reorderDocument(prev, active, from + (id === 'tab.moveLeft' ? -1 : 1)),
      );
      break;
    }
    case 'tab.next': {
      const nextId = neighbourId(store.getState(), 1);
      if (nextId !== null) switchToDocument(nextId);
      break;
    }
    case 'tab.previous': {
      const previousId = neighbourId(store.getState(), -1);
      if (previousId !== null) switchToDocument(previousId);
      break;
    }
    case 'view.preview':
      void togglePreview();
      break;
    case 'settings.open':
      void openSettings();
      break;
    case 'settings.reset':
      void resetSettings();
      break;
    case 'view.wordWrap':
      void setWordWrapSetting(!store.getState().wordWrap);
      break;
    case 'view.lineNumbers':
      void setBehaviourSetting({
        showLineNumbers: !store.getState().editorBehaviour.showLineNumbers,
      });
      break;
    case 'view.statusBar':
      void setStatusBarSetting(statusBarTeardown === null);
      break;
    // The menu's way in. The keymap binds `openSearchPanel` directly, so this is
    // the second trigger for the one implementation -- the same arrangement the
    // format commands use.
    case 'edit.find':
      openSearchPanel(getEditorView());
      break;
    case 'view.outline':
      void setOutlineSetting(outlineHandle === null);
      break;
    case 'view.fullscreen':
      toggleFullscreen();
      break;
    case 'view.zoomIn':
      zoomIn();
      break;
    case 'view.zoomOut':
      zoomOut();
      break;
    case 'view.zoomReset':
      zoomReset();
      break;
    case 'theme.system':
      void setThemeMode('system');
      break;
    case 'theme.light':
      void setThemeMode('light');
      break;
    case 'theme.dark':
      void setThemeMode('dark');
      break;
    // Nine literal ids rather than a single parameterised command (contrast
    // ui/tabbar.ts's `tab.activate:<id>`): the set is fixed at exactly 1..9,
    // so a case per id is plainer than inventing and parsing a second
    // command-id encoding for a checkpoint that will never need more than
    // nine of these.
    case 'tab.goto1':
    case 'tab.goto2':
    case 'tab.goto3':
    case 'tab.goto4':
    case 'tab.goto5':
    case 'tab.goto6':
    case 'tab.goto7':
    case 'tab.goto8':
    case 'tab.goto9': {
      const position = Number(id.slice('tab.goto'.length));
      const target = documentAtPosition(store.getState(), position);
      if (target) switchToDocument(target.id);
      break;
    }
    default:
      break;
  }
});

// The window title is the only dirty-state feedback the user gets until the
// tab bar lands at Checkpoint C. Selecting the filename/dirty pair (rather
// than the whole document) means an edit that doesn't change either — there
// isn't one yet, but future metadata-only updates might — will not re-set
// the title needlessly.
store.subscribe(
  (state) => {
    const doc = state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
    return doc ? { filePath: doc.filePath, dirty: isDirty(doc) } : null;
  },
  () => {
    const state = store.getState();
    const doc = state.documents.find((d) => d.id === state.activeDocumentId) ?? null;
    WindowSetTitle(windowTitle(doc));
  },
);
WindowSetTitle(windowTitle(initialDocument));

/**
 * Saves the exact document `resolveDocumentsBeforeQuit` is currently
 * prompting about, by id -- not whatever the store happens to consider
 * active. An earlier version of this adapter called `saveActive()` here,
 * which saved the *active* document regardless of `doc`; that was safe only
 * while Checkpoint B guaranteed exactly one document. The moment tabs exist,
 * quitting with two dirty tabs would prompt about tab A and then write tab
 * B's contents over tab A's file -- silent data corruption. `saveDocument`
 * (files/fileops.ts) takes the id and reads from the right buffer for it
 * (the live view if it's active, that document's own stored `editorState`
 * otherwise), so this adapter now genuinely saves what it was asked to.
 */
function saveDocumentForQuit(doc: Document): Promise<boolean> {
  return saveDocument(doc.id);
}

// See internal/app/app.go's OnBeforeClose for why this dance exists: Wails'
// close hook is synchronous and returns a bool, but the save prompts are
// async, so Go vetoes the first close request and emits this event instead of
// deciding on its own.
//
// quitPromptInFlight guards against re-entrancy: every close attempt that
// arrives while quitApproved is still false on the Go side (another click on
// the window's close button, the menu's Exit, Alt+F4, the taskbar's close --
// anything that calls Quit()) is vetoed again and re-emits this same event.
// Without the guard, a second click landing while the first prompt sequence
// is still awaiting the user's answer would kick off a second sequence over
// the same documents, stacking a second confirm dialog underneath the first.
let quitPromptInFlight = false;
EventsOn('app:close-requested', () => {
  if (quitPromptInFlight) return;
  quitPromptInFlight = true;

  void (async () => {
    let canQuit = false;
    try {
      canQuit = await resolveDocumentsBeforeQuit(
        store.getState().documents,
        confirmSave,
        saveDocumentForQuit,
      );
      // Only ever call ConfirmQuit on a true result: resolveDocumentsBeforeQuit
      // already folds Cancel and a failed/cancelled Save into false, so this
      // is the single point where "safe to quit" turns into actually quitting.
      //
      // Awaited, not fire-and-forget: Go does not set its approval flag until
      // this IPC call lands, so releasing the guard first leaves a window where
      // another close request is still vetoed and re-emitted, restarting the
      // whole sequence. A document just dismissed with Don't Save is still
      // dirty by design, so it would be prompted for a second time.
      if (canQuit) await ConfirmQuit();
    } finally {
      // Stay latched once the quit is confirmed. The window is on its way down,
      // and no further close request should be able to restart the prompts.
      // Released only when the user aborted, or something threw — both of which
      // leave the app running and needing to accept a future close.
      if (!canQuit) quitPromptInFlight = false;
    }
  })();
});
