import { redo, undo } from '@codemirror/commands';
import './styles/app.css';
import { COMMAND_EVENT, mountMenuBar } from './ui/menubar';
import { EventsOn, Quit, WindowSetTitle } from '../wailsjs/runtime/runtime';
import {
  ConfirmQuit,
  LoadSettings,
  SaveSettings,
  ShowWindow,
  SystemThemeIsDark,
} from '../wailsjs/go/app/App';
import { createEditor } from './editor/editor';
import { COMMANDS, toEditorCommand, type CommandId } from './editor/commands';
import { publishActiveFormats, publishStatus, setWordWrap } from './editor/extensions';
import {
  openFiles,
  resolveDocumentsBeforeQuit,
  saveActive,
  saveActiveAs,
  saveDocument,
  windowTitle,
} from './files/fileops';
import {
  closeDocumentWithPrompt,
  makeUntitledDocument,
  reopenLastClosed,
  switchToDocument,
} from './files/documentops';
import { confirmSave } from './ui/confirmdialog';
import { mountTabBar, parseTabCommand } from './ui/tabbar';
import { mountStatusBar } from './ui/statusbar';
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
  clampSplitRatio,
  createUntitledDocument,
  DEFAULT_SPLIT_RATIO,
  isDirty,
  type Document,
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

mountMenuBar(root);
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

// #app is a flex *column*, so the editor and the preview need a flex row of
// their own to sit side by side. Built at startup whether or not the preview
// is on: toggling it then only adds and removes two children of this row,
// rather than restructuring the tree around a live EditorView.
const editorSplit = document.createElement('div');
editorSplit.className = 'editor-split';
root.append(editorSplit);

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
    }));
    // No View-menu toggle for this (Task 8 brief, ambiguity #3): that belongs
    // with Checkpoint H's settings dialog, and MenuItem has no checkmark
    // support to render its state honestly in the meantime.
    // Guarded independently of the try above. This whole block exists to
    // guarantee ShowWindow runs, and main.go's StartHidden means a throw
    // between here and it leaves the window permanently invisible -- the
    // failure mode Checkpoint D hit and had to add a Go-side backstop for.
    // `insertBefore` throws NotFoundError if handed a node that is not a
    // child of `root`, so this one call is worth its own guard.
    try {
      // Inserted before `editorSplit`, not `editorArea`: the editor area is a
      // child of the split row now, and `insertBefore` throws NotFoundError
      // for a node that is not a child of `root` -- which is precisely the
      // throw the guard around this call was written for.
      if (toolbarVisible) mountToolbar(root!, pinnedCommands, editorSplit);
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
    ShowWindow();
  }
}
void bootstrap();

// Window-level, not an editor command: zoom has to work with the caret in the
// editor, the focus in the preview, or nothing focused at all.
mountZoom();

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
 * Ctrl+Shift+P / View > Preview.
 *
 * `setViewMode` runs *before* `show()`, which is not arbitrary: it is the
 * store write above that opens the pane and renders it, and the explicit
 * `show()` that follows is then a no-op. Doing it the other way round would
 * show an empty pane -- the pane skips rendering a document that is not yet
 * in split mode -- until the user's next keystroke.
 *
 * The outgoing mode is handed to `setViewMode` as `remember` only on the way
 * in, so toggling off restores `'live'` for a document that was in live mode
 * rather than downgrading it to source.
 */
async function togglePreview(): Promise<void> {
  const active = activeDocument(store.getState());
  if (active === null) return;

  // Copied into a local before the await below: TypeScript discards a
  // narrowing of `active.viewMode` across it, and this also pins the mode to
  // what it was when the toggle was pressed rather than whatever it is by the
  // time the dynamic import resolves.
  const mode = active.viewMode;

  // Neither branch calls `show()`/`hide()` itself. The subscription above is
  // registered at module load and reacts to exactly this `viewMode` write, so
  // it has already done it by the time `setState` returns -- and it is also
  // what handles the tab switches this function never sees. Calling it here as
  // well would be two paths owning the same effect, with the second a silent
  // no-op that reads as if it were doing the work.
  if (mode === 'split') {
    store.setState((prev) => setViewMode(prev, active.id, active.previousViewMode));
    return;
  }

  // Imported before the state write, so the subscription has a handle to call
  // `show()` on when it fires.
  if (!previewHandle) {
    previewHandle = (await import('./preview/pane')).mountPreview(editorSplit, view);
  }
  store.setState((prev) => setViewMode(prev, active.id, 'split', mode));
}

/**
 * Word wrap: applied to the view first, then persisted -- SPEC §6.13's "every
 * setting takes effect immediately", and the same ordering and error handling
 * `setThemeMode` and `setToolbarPinned` use. A failed disk write means the
 * choice will not survive a restart, not that it silently did not apply.
 *
 * The store is written as well as the view because a *new* document builds its
 * extensions from it -- without that, wrapping would revert on the next tab.
 */
async function setWordWrapSetting(wordWrap: boolean): Promise<void> {
  store.setState((prev) => ({ ...prev, wordWrap }));
  setWordWrap(getEditorView(), wordWrap);

  try {
    const settings = await LoadSettings();
    settings.editor.wordWrap = wordWrap;
    await SaveSettings(settings);
  } catch (err) {
    console.error('hashpad: failed to persist the word-wrap setting', err);
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
    case 'view.wordWrap':
      void setWordWrapSetting(!store.getState().wordWrap);
      break;
    case 'view.statusBar':
      void setStatusBarSetting(statusBarTeardown === null);
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
