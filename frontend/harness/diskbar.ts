/**
 * What SPEC §7.4's bar looks like, in both themes, in the row it lives in.
 *
 * `diskbar.test.ts` covers what the bar does. It cannot say whether the tint
 * reads as a notice, whether the text is legible on it, or whether the row sits
 * where it should between the toolbar and the workspace: jsdom paints nothing
 * and every dimension is zero.
 *
 * The theme moves on `document.documentElement`, for the reason about.ts gives:
 * the palette is defined on `:root[data-theme]`, so a theme on any inner element
 * selects nothing.
 */
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { setEditorView, store } from '../src/state/appcontext';
import { createUntitledDocument, type Document } from '../src/state/document';
import { mountDiskBar } from '../src/ui/diskbar';
import '../src/styles/app.css';

const app = document.querySelector<HTMLElement>('#app')!;

// Stand-ins for the rows either side, with the real classes so the real
// borders and heights apply.
const toolbar = document.createElement('div');
toolbar.className = 'toolbar';
toolbar.textContent = 'toolbar';
const workspace = document.createElement('div');
workspace.className = 'workspace';
workspace.style.padding = '12px';
workspace.textContent = 'The editor and the preview live in this row.';
app.append(toolbar, workspace);

// The bar's buttons hand focus back to the editor; nothing here needs one.
setEditorView({ focus: () => {} } as unknown as EditorView);

const doc: Document = {
  ...createUntitledDocument(EditorState.create({ doc: '' })),
  id: 'harness',
  filePath: 'C:\\notes\\harness.md',
};
store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));
mountDiskBar(app, workspace);

declare global {
  interface Window {
    setTheme: (theme: 'light' | 'dark') => string;
    setChange: (change: 'changed' | 'deleted' | null) => void;
    measure: () => Record<string, string>;
  }
}

window.setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  return theme;
};

window.setChange = (change) => {
  const diskChange =
    change === 'changed'
      ? ({ content: 'theirs', encoding: 'utf-8', lineEnding: 'crlf', mixed: false } as const)
      : change;
  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((d) => ({ ...d, diskChange })),
  }));
};

/** sRGB channels of a computed colour, composited over `under` when translucent. */
function rgb(color: string, under: number[] = [255, 255, 255]): number[] {
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.fillStyle = `rgb(${under.join(',')})`;
  probe.fillRect(0, 0, 1, 1);
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

function luminance([r, g, b]: number[]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function contrast(a: number[], b: number[]): string {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi! + 0.05) / (lo! + 0.05)).toFixed(2);
}

/**
 * The bar's text against its painted background. The background is a
 * translucent accent tint, so it is composited over the app's own background on
 * a canvas -- the colour that actually reaches the screen, not the token.
 */
window.measure = () => {
  const bar = document.querySelector<HTMLElement>('.disk-bar')!;
  const button = bar.querySelector<HTMLElement>('.disk-bar__button')!;
  const appBg = rgb(getComputedStyle(document.body).backgroundColor);
  const barBg = rgb(getComputedStyle(bar).backgroundColor, appBg);
  const text = rgb(getComputedStyle(bar).color, barBg);
  const buttonBg = rgb(getComputedStyle(button).backgroundColor, barBg);
  const buttonText = rgb(getComputedStyle(button).color, buttonBg);
  return {
    hidden: String(bar.hidden),
    height: `${String(Math.round(bar.getBoundingClientRect().height))}px`,
    barBg: barBg.join(','),
    textContrast: contrast(text, barBg),
    buttonContrast: contrast(buttonText, buttonBg),
    order: [...app.children].map((c) => c.className).join(' > '),
  };
};
