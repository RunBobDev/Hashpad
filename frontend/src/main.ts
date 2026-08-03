import { redo, undo } from '@codemirror/commands';
import './styles/app.css';
import { COMMAND_EVENT, mountMenuBar } from './ui/menubar';
import { EventsOn, Quit, WindowSetTitle, WindowShow } from '../wailsjs/runtime/runtime';
import { ConfirmQuit, LoadSettings, SystemThemeIsDark } from '../wailsjs/go/app/App';
import { createEditor } from './editor/editor';
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
import { store, setEditorView } from './state/appcontext';
import { addDocument, documentAtPosition, neighbourId, reorderDocument } from './state/documents';
import { createUntitledDocument, isDirty, type Document } from './state/document';
import { applyAccent, applyTheme, isValidAccent, resolveIsDark, type ThemeMode } from './theme/theme';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

mountMenuBar(root);
// Between the menu bar and the editor area, per SPEC §6.1's chrome layout --
// the window is frameless, so this row is the only place a filename appears.
mountTabBar(root);

const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
root.append(editorArea);

// Starts light; bootstrapTheme() below replaces this the moment settings and
// the system preference are known, before the (still-hidden) window shows.
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

function isThemeMode(value: string): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Settings arrive over IPC and CSP (`script-src 'self'`) forbids the inline
 * bootstrap script that would otherwise pick a theme before first paint, so
 * the window starts hidden (main.go's StartHidden) and this is what shows it.
 *
 * Wrapped in try/finally: a settings file that fails to load must still
 * result in a visible window, in the compiled-in default theme (light --
 * `resolveIsDark('system', null)`), rather than an app that appears to hang
 * on launch.
 */
async function bootstrapTheme(): Promise<void> {
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
  } catch (err) {
    console.error('hashpad: failed to load settings; starting with the default theme', err);
    applyTheme(false);
  } finally {
    WindowShow();
  }
}
void bootstrapTheme();

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
