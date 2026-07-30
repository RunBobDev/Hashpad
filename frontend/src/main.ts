import { redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import './styles/app.css';
import { COMMAND_EVENT, mountMenuBar } from './ui/menubar';
import { Quit, WindowSetTitle } from '../wailsjs/runtime/runtime';
import { createEditor } from './editor/editor';
import { newDocument, openFiles, saveActive, saveActiveAs, windowTitle } from './files/fileops';
import { createStore, type Store } from './state/store';
import { createUntitledDocument, isDirty, type AppState } from './state/document';

// Exported (rather than bare locals) so later checkpoints — the tab bar,
// status bar, persistence — and files/fileops.ts (which needs both to do
// anything) can `import { store, view } from './main'` instead of this file
// growing a second, competing place state gets created.
//
// Declared here and assigned inside the guard below, rather than initialised
// directly: files/fileops.ts imports these two bindings, which makes this
// module and fileops.ts mutually dependent. That is fine — ES module
// bindings are live references resolved when used, not when imported — but
// it does mean this file's top level runs the moment anything imports
// fileops.ts, including fileops.test.ts under Vitest's DOM-less `node`
// environment. The `typeof document` guard is what keeps that import from
// crashing there: in the real app `document` always exists, so the guard's
// body always runs and both bindings are assigned before anything (including
// the switch below) reads them.
export let store: Store<AppState>;
export let view: EditorView;

if (typeof document !== 'undefined') {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('#app not found');

  mountMenuBar(root);

  const editorArea = document.createElement('div');
  editorArea.className = 'editor-area';
  root.append(editorArea);

  // No system/manual theme detection yet (later checkpoint), so the editor and
  // the store both start from the same hard-coded light default.
  view = createEditor(editorArea, '', false);

  // Checkpoint A opens with exactly one untitled document; its EditorState is
  // the same instance the view above was constructed with, so the two do not
  // start out of sync.
  const initialDocument = createUntitledDocument(view.state);
  store = createStore<AppState>({
    documents: [initialDocument],
    activeDocumentId: initialDocument.id,
    isDark: false,
  });

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
}
