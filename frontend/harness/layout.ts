/**
 * The chrome layout, with real CSS and real class names but no app wiring.
 *
 * A sibling to `harness/main.ts`, which covers the editor's *colours*. This one
 * covers the *rows*: `#app` as a flex column, `.workspace` holding the outline
 * beside `.editor-split`, and `.editor-split` holding the editor beside the
 * preview. Those relationships are pure CSS, jsdom has no layout engine, and
 * G.3a changed them -- so this is the only place the question "does wide
 * content stay reachable" can actually be asked.
 *
 * It builds the DOM by hand rather than booting the app because the app needs
 * Wails bindings that do not exist in a plain browser, and because the bug
 * under investigation is in the stylesheet, not in any module.
 *
 * `window.layout.overflow()` reports, for every container that could scroll,
 * whether its content is wider than its box and whether it can be scrolled to.
 * A container where `overflowing` is true and `scrollable` is false is content
 * the user cannot reach.
 */
import '../src/styles/app.css';
import { mountWindowEdges } from '../src/ui/windowedges';

const root = document.querySelector<HTMLDivElement>('#app')!;

/** A single unbroken token, the shape a long URL or a hash takes. */
const LONG_WORD = 'x'.repeat(400);
const LONG_CODE = `const veryLongVariableName = ${'"chunk" + '.repeat(40)}"end";`;

function chrome(className: string, height: string, label: string): HTMLElement {
  const row = document.createElement('div');
  row.className = className;
  row.style.height = height;
  row.textContent = label;
  return row;
}

root.append(chrome('menubar', 'var(--h-menubar)', 'File  Edit  View  Help'));
root.append(chrome('tabbar', 'var(--h-tabbar)', 'notes.md'));
root.append(chrome('toolbar', 'var(--h-toolbar)', 'B  I  S'));

const workspace = document.createElement('div');
workspace.className = 'workspace';
root.append(workspace);

const outlineColumn = document.createElement('div');
outlineColumn.className = 'outline-column';
outlineColumn.style.flexBasis = '240px';
const outline = document.createElement('nav');
outline.className = 'outline';
outline.innerHTML =
  '<ul class="outline__list"><li><button class="outline__item">A heading with a very long title indeed</button></li></ul>';
const resizer = document.createElement('div');
resizer.className = 'outline-resizer';
outlineColumn.append(outline, resizer);
workspace.append(outlineColumn);

const editorSplit = document.createElement('div');
editorSplit.className = 'editor-split';
workspace.append(editorSplit);

const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
editorArea.textContent = 'editor';
editorSplit.append(editorArea);

const divider = document.createElement('div');
divider.className = 'preview-divider';
editorSplit.append(divider);

const pane = document.createElement('div');
pane.className = 'preview-pane';
pane.style.flexBasis = '50%';
// Three separate ways content can be wider than the pane. They are not the
// same case: a fence has its own `overflow-x`, a table has `max-width`, and an
// unbroken word has neither.
pane.innerHTML = [
  '<h1>Heading</h1>',
  `<p>An unbroken token: ${LONG_WORD}</p>`,
  `<pre><code>${LONG_CODE}</code></pre>`,
  '<table><tbody><tr>' +
    Array.from({ length: 14 }, (_, i) => `<td>cell ${i} with text</td>`).join('') +
    '</tr></tbody></table>',
  '<p>Ordinary prose that wraps normally and should never cause a scrollbar.</p>',
].join('');
editorSplit.append(pane);

// Mirrors main.ts: the frameless window's resize border, which has to sit above
// everything including the pane's scrollbar and the chrome buttons.
mountWindowEdges(root, null);

root.append(chrome('statusbar', 'var(--h-statusbar)', 'Ln 1, Col 1'));

// Enough content that the pane really scrolls: without a vertical scrollbar
// there is nothing at the right edge to be blocked by, and the question this
// page exists to answer does not arise.
for (let i = 0; i < 200; i++) {
  const filler = document.createElement('p');
  filler.textContent = `filler line ${i}`;
  pane.append(filler);
}

interface Report {
  selector: string;
  clientWidth: number;
  scrollWidth: number;
  overflowing: boolean;
  scrollable: boolean;
  overflowX: string;
}

/**
 * `scrollWidth > clientWidth` means the content does not fit. Whether the user
 * can *get* to it is a separate question, answered by actually trying to
 * scroll: an element with `overflow-x: hidden` (or a clipped ancestor) reports
 * the overflow and refuses to move.
 */
function measure(selector: string): Report {
  const element = document.querySelector<HTMLElement>(selector)!;
  const before = element.scrollLeft;
  element.scrollLeft = 9999;
  const scrollable = element.scrollLeft > before;
  element.scrollLeft = before;
  return {
    selector,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowing: element.scrollWidth > element.clientWidth,
    scrollable,
    overflowX: getComputedStyle(element).overflowX,
  };
}

/**
 * What the pointer would land on down the window's right edge, which is the
 * question behind "can I resize the window here". Wails arms a resize from a
 * `mousemove` -- and Chromium dispatches no mouse events over a native
 * scrollbar, so anything reporting the scroll container rather than the gutter
 * is an edge the window cannot be resized from.
 */
function rightEdge(): { y: number; at: string }[] {
  const w = window.innerWidth;
  return [3, 14, 40, 80, Math.round(window.innerHeight / 2), window.innerHeight - 3].map((y) => {
    const el = document.elementFromPoint(w - 3, y);
    return { y, at: el === null ? 'nothing' : el.className || el.tagName };
  });
}

/** The same question along the top and bottom, where the chrome buttons are. */
function otherEdges(): Record<string, string> {
  const at = (x: number, y: number): string => {
    const el = document.elementFromPoint(x, y);
    return el === null ? 'nothing' : el.className || el.tagName;
  };
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    topLeftOverMenuButton: at(30, 3),
    topRightOverWindowControls: at(w - 30, 3),
    bottomOverStatusBar: at(Math.round(w / 2), h - 3),
    leftMiddle: at(3, Math.round(h / 2)),
    cornerSE: at(w - 3, h - 3),
    cornerNW: at(3, 3),
  };
}

(
  window as unknown as {
    layout: { overflow(): Report[]; rightEdge: typeof rightEdge; otherEdges: typeof otherEdges };
  }
).layout = {
  rightEdge,
  otherEdges,
  overflow: () =>
    [
      'html',
      'body',
      '#app',
      '.workspace',
      '.editor-split',
      '.preview-pane',
      '.preview-pane pre',
      '.preview-pane table',
    ].map(measure),
};
