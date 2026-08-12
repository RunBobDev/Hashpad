/**
 * A development harness, not part of the app and never bundled into it.
 *
 * It exists because jsdom cannot see the things this checkpoint is made of: it
 * has no layout, and it resolves `var(--syn-*)` to the empty string, so no
 * test in `src/` can assert a colour, a split position, or a divider. Three
 * times in this project the suite has been green while the running app was
 * visibly broken; on 2026-08-10 a throwaway version of this file found two
 * defects that 504 tests missed.
 *
 * Run the Vite dev server (`npm run dev` in `frontend/`) and
 * open `/harness/`. `window.harness` is the API to drive from the console or
 * from an automated browser session.
 */
import '../src/styles/app.css';
import { LanguageDescription } from '@codemirror/language';
import { createEditor } from '../src/editor/editor';
import { setEditorDark } from '../src/editor/theme';
import { MARKDOWN_CODE_LANGUAGES } from '../src/editor/languages';

const root = document.querySelector<HTMLDivElement>('#app')!;
const editorArea = document.createElement('div');
editorArea.className = 'editor-area';
root.append(editorArea);

const SAMPLE = [
  '# Heading',
  '',
  'Prose with **bold**, `code`, a [link](http://x) and an entity &amp;.',
  '',
  '```js',
  "const s = 'str'; // comment",
  'function f(x) { return x + 1; }',
  '```',
  '',
  '```python',
  'def f(x):  # comment',
  '    return "str"',
  '```',
  '',
  '```diff',
  '@@ -1,2 +1,2 @@',
  '-removed line',
  '+added line',
  '```',
  '',
  '```html',
  '<!DOCTYPE html>',
  '<div class="x">text</div>',
  '```',
  '',
].join('\n');

const LANGUAGES = ['javascript', 'python', 'diff', 'html'];

const view = createEditor(editorArea, SAMPLE, false);

interface Harness {
  /**
   * Every run of text in the document with the colour that actually paints it
   * — **including runs in no span at all**, which is the point.
   *
   * An earlier version enumerated `<span>` elements only. Unstyled text
   * produces no span, so it simply did not appear, and the Step 9 check was
   * "none of CodeMirror's built-in colours is present" — a search for *wrong*
   * colours, which *missing* colour passes trivially. A ```diff fence that had
   * lost all highlighting looked identical to a clean one. Walking text nodes
   * is what makes an absence visible.
   */
  runs(): { text: string; color: string; decoration: string; styled: boolean }[];
  /** The distinct colours in the document, and what takes each. Quick eyeball. */
  palette(): Record<string, string[]>;
  editorBg(): string;
  setTheme(theme: 'light' | 'dark'): void;
  setDoc(text: string): void;
}

function textRuns(): { text: string; color: string; decoration: string; styled: boolean }[] {
  const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
  const out: { text: string; color: string; decoration: string; styled: boolean }[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (text.trim() === '') continue;
    const parent = node.parentElement;
    if (!parent) continue;
    const style = getComputedStyle(parent);
    out.push({
      text,
      color: style.color,
      decoration: style.textDecorationLine,
      // `cm-line` means the run is bare text with no token span around it.
      styled: parent.tagName.toLowerCase() === 'span',
    });
  }
  return out;
}

(window as unknown as { harness: Harness }).harness = {
  runs: textRuns,
  palette: () => {
    const byColour: Record<string, string[]> = {};
    for (const run of textRuns()) (byColour[run.color] ??= []).push(run.text.slice(0, 24));
    return byColour;
  },
  editorBg: () => getComputedStyle(view.dom).backgroundColor,
  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    // The app does both (main.ts): the attribute drives the CSS variables, and
    // the compartment drives CodeMirror's own dark-mode behaviour. Flipping
    // only the attribute would make harness dark mode unlike the real thing.
    setEditorDark(view, theme === 'dark');
  },
  setDoc: (text) =>
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
};

// The grammars load lazily; pull the ones the sample uses so the fenced blocks
// show their real colours rather than one frame of plain text.
for (const name of LANGUAGES) {
  void LanguageDescription.matchLanguageName(MARKDOWN_CODE_LANGUAGES, name, true)?.load();
}
