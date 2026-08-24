/**
 * Does the preview reach its bottom when the editor reaches its bottom?
 *
 * Owner report: with a very tall image at the end of a document, scrolling the
 * editor all the way down leaves the preview short of its own end. He remembers
 * it working, so this is a regression hunt, not a new feature.
 *
 * jsdom cannot answer it: it reports every scroll dimension as 0, which is why
 * `endpoints()` bails there and the whole clamp is unreachable in the unit
 * tests. The clamp is the thing under suspicion, so it has to be a browser.
 *
 * The image is a data URI of a known height, so the case is reproducible and
 * needs no network (the CSP forbids one anyway).
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from '../src/editor/extensions';
import { createUntitledDocument } from '../src/state/document';
import { setEditorView, store } from '../src/state/appcontext';
import { activeDocument, setViewMode } from '../src/state/documents';
import { mountPreview } from '../src/preview/pane';
import '../src/styles/app.css';

/**
 * A real 200x2400 PNG served by the dev server, referenced by a **short** URL.
 *
 * Both halves matter, and the harness got each wrong once before landing here:
 *
 * - A 1x1 pixel sized by CSS gave the image its height synchronously, so it
 *   never exercised the path the code calls the headline case -- an image
 *   reserves no height until it decodes, and everything below shifts when it
 *   arrives.
 * - A data URI fixed that and broke something else: the URI is thousands of
 *   characters, so with word wrap on it became a hundred visual lines in the
 *   *editor*, which is nothing like `![](assets/pic.png)` and made the editor's
 *   geometry the outlier instead of the preview's.
 */
const IMAGE = './tall.png';

/**
 * A raw `<img>`, not markdown image syntax.
 *
 * `preview/rules/images.ts` rewrites a *markdown* relative path to the Go asset
 * route, and renders a placeholder when the document has no directory -- which
 * an untitled harness document never does, so the first attempt measured a
 * placeholder and reported a preview 1802px tall. Raw HTML is deliberately left
 * alone by that rule (its header says so), which is exactly the escape hatch
 * this needs: a real image, decoded asynchronously, without standing up the Go
 * asset server to serve it.
 */
const IMAGE_MARKUP = `<img src="${IMAGE}" alt="tall">`;

function documentText(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 60; i++) lines.push(`Line ${i} of ordinary paragraph text.`, '');
  lines.push(IMAGE_MARKUP);
  return lines.join('\n');
}

const app = document.querySelector<HTMLElement>('#app')!;
app.style.cssText = 'display:flex;flex-direction:column;height:100vh';

const split = document.createElement('div');
split.className = 'editor-split';
split.style.cssText = 'flex:1 1 auto;min-height:0';
app.append(split);

const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
split.append(editorArea);

const view = new EditorView({
  state: EditorState.create({ doc: documentText(), extensions: buildExtensions(false, true) }),
  parent: editorArea,
});
setEditorView(view);

const doc = createUntitledDocument(view.state);
store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));

const handle = mountPreview(split, view);
store.setState((prev) => setViewMode(prev, doc.id, 'split'));
handle.show();

// No CSS height: the image carries its own, and only once it has decoded.
// That asynchronous arrival is the thing under test.

interface Report {
  editorTop: number;
  editorMax: number;
  editorAtEnd: boolean;
  paneTop: number;
  paneMax: number;
  paneAtEnd: boolean;
  shortBy: number;
  syncScroll: boolean;
  viewMode: string;
}

declare global {
  interface Window {
    sync: {
      report: () => Report;
      toBottom: () => Promise<Report>;
    };
  }
}

function measure(): Report {
  const scroller = view.scrollDOM;
  const pane = document.querySelector<HTMLElement>('.preview-pane')!;
  const editorMax = scroller.scrollHeight - scroller.clientHeight;
  const paneMax = pane.scrollHeight - pane.clientHeight;
  return {
    editorTop: Math.round(scroller.scrollTop),
    editorMax: Math.round(editorMax),
    editorAtEnd: Math.abs(scroller.scrollTop - editorMax) < 2,
    paneTop: Math.round(pane.scrollTop),
    paneMax: Math.round(paneMax),
    paneAtEnd: Math.abs(pane.scrollTop - paneMax) < 2,
    shortBy: Math.round(paneMax - pane.scrollTop),
    syncScroll: store.getState().syncScroll,
    viewMode: activeDocument(store.getState())?.viewMode ?? 'none',
  };
}

window.sync = {
  report: measure,
  toBottom: async () => {
    const scroller = view.scrollDOM;
    scroller.scrollTop = scroller.scrollHeight;
    // The sync runs off a real scroll event, which the browser fires
    // asynchronously after the assignment.
    await new Promise((resolve) => setTimeout(resolve, 300));
    return measure();
  },
};
