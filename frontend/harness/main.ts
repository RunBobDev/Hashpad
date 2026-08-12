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
].join('\n');

const view = createEditor(editorArea, SAMPLE, false);

interface Harness {
  /** Every rendered span with the colour and decoration that actually paint. */
  spans(): { text: string; color: string; decoration: string }[];
  editorBg(): string;
  setTheme(theme: 'light' | 'dark'): void;
}

(window as unknown as { harness: Harness }).harness = {
  spans: () =>
    Array.from(view.contentDOM.querySelectorAll('span')).map((el) => {
      const style = getComputedStyle(el);
      return {
        text: el.textContent ?? '',
        color: style.color,
        decoration: style.textDecorationLine,
      };
    }),
  editorBg: () => getComputedStyle(view.dom).backgroundColor,
  setTheme: (theme) => document.documentElement.setAttribute('data-theme', theme),
};

// The grammars load lazily; pull the two the sample uses so the fenced blocks
// show their real colours rather than one frame of plain text.
for (const name of ['javascript', 'python']) {
  void LanguageDescription.matchLanguageName(MARKDOWN_CODE_LANGUAGES, name, true)?.load();
}
