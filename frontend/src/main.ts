import { redo, undo } from '@codemirror/commands';
import './styles/app.css';
import { COMMAND_EVENT, mountMenuBar } from './ui/menubar';
import { Quit } from '../wailsjs/runtime/runtime';
import { createEditor } from './editor/editor';
import { createStore } from './state/store';
import { createUntitledDocument, type AppState } from './state/document';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

mountMenuBar(root);

const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
root.append(editorArea);

// No system/manual theme detection yet (later checkpoint), so the editor and
// the store both start from the same hard-coded light default.
const view = createEditor(editorArea, '', false);

// The store is the single source of truth for app state (SPEC §5.1).
// Checkpoint A opens with exactly one untitled document; its EditorState is
// the same instance the view above was constructed with, so the two do not
// start out of sync. main.ts keeps this reference so later checkpoints (tabs,
// persistence) can read and update the store from here rather than each
// feature inventing its own state.
const initialDocument = createUntitledDocument(view.state);
// Exported (rather than a bare local) so later checkpoints — the tab bar,
// status bar, persistence — can `import { store } from './main'` instead of
// this file growing a second, competing place state gets created.
export const store = createStore<AppState>({
  documents: [initialDocument],
  activeDocumentId: initialDocument.id,
  isDark: false,
});

// Menu items dispatch commands rather than calling features directly
// (see ui/menubar.ts); this is where those commands get routed to effects.
document.addEventListener(COMMAND_EVENT, (event) => {
  const id = (event as CustomEvent<string>).detail;
  switch (id) {
    case 'file.exit':
      Quit();
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
