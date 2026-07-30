import { redo, undo } from '@codemirror/commands';
import './styles/app.css';
import { COMMAND_EVENT, mountMenuBar } from './ui/menubar';
import { EventsOn, Quit, WindowSetTitle } from '../wailsjs/runtime/runtime';
import { ConfirmQuit } from '../wailsjs/go/app/App';
import { createEditor } from './editor/editor';
import {
  newDocument,
  openFiles,
  resolveDocumentsBeforeQuit,
  saveActive,
  saveActiveAs,
  windowTitle,
} from './files/fileops';
import { confirmSave } from './ui/confirmdialog';
import { store, setEditorView } from './state/appcontext';
import { createUntitledDocument, isDirty, type Document } from './state/document';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

mountMenuBar(root);

const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
root.append(editorArea);

// No system/manual theme detection yet (later checkpoint), so the editor and
// the store both start from the same hard-coded light default.
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

// Menu items and keyboard shortcuts (see editor/extensions.ts) both dispatch
// commands rather than calling features directly; this is where those
// commands get routed to effects.
document.addEventListener(COMMAND_EVENT, (event) => {
  const id = (event as CustomEvent<string>).detail;
  switch (id) {
    case 'file.exit':
      Quit();
      break;
    case 'file.new':
      void newDocument();
      break;
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
 * `saveActive` (files/fileops.ts) always saves whichever document the store
 * currently considers active, not whatever it's handed -- Checkpoint B has
 * exactly one document and it is always the active one, so the two coincide.
 * `resolveDocumentsBeforeQuit` takes a `(doc) => Promise<boolean>` collaborator
 * so it stays correct once Checkpoint C adds tabs and per-document saving;
 * only this adapter will need to change then.
 */
function saveDocumentForQuit(_doc: Document): Promise<boolean> {
  return saveActive();
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
    try {
      const canQuit = await resolveDocumentsBeforeQuit(
        store.getState().documents,
        confirmSave,
        saveDocumentForQuit,
      );
      // Only ever call ConfirmQuit on a true result: resolveDocumentsBeforeQuit
      // already folds Cancel and a failed/cancelled Save into false, so this
      // is the single point where "safe to quit" turns into actually quitting.
      if (canQuit) void ConfirmQuit();
    } finally {
      quitPromptInFlight = false;
    }
  })();
});
