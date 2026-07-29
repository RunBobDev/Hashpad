import './styles/app.css';
import { mountMenuBar } from './ui/menubar';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app not found');

mountMenuBar(root);

const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
root.append(editorArea);
