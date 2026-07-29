import './styles/app.css';
import { COMMAND_EVENT, mountMenuBar } from './ui/menubar';
import { Quit } from '../wailsjs/runtime/runtime';
import { createEditor } from './editor/editor';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

mountMenuBar(root);

// Menu items dispatch commands rather than calling features directly
// (see ui/menubar.ts); this is where those commands get routed to effects.
document.addEventListener(COMMAND_EVENT, (event) => {
  const id = (event as CustomEvent<string>).detail;
  if (id === 'file.exit') Quit();
});

const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
root.append(editorArea);

createEditor(editorArea, '');
