// @vitest-environment jsdom
/**
 * Front matter in the editor (design §4.38). The editor's parser read it as a
 * horizontal rule and a two-line Setext heading, so live preview styled
 * `title:`/`author:` as a heading and hid the closing `---` as its underline
 * (owner's report). It is a `FrontMatter` block now, decided by the reading
 * view's own rule, and live preview shows the reading view's card for it while
 * the cursor is elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { renderMarkdown } from '../preview/render';
import { livePreview } from './livepreview';
import { testState } from './testdoc';

const NL = String.fromCharCode(10);
const lines = (...each: string[]): string => each.join(NL) + NL;

const CASES: [string, string, boolean][] = [
  ['closed', lines('---', 'title: A', 'author: B', '---', '', 'Body'), true],
  ['empty', lines('---', '---', 'Body'), true],
  ['closed by --- with spaces round it', lines('---', 'title: A', '  ---  ', 'Body'), true],
  ['opened three spaces in', lines('   ---', 'title: A', '---'), true],
  ['never closed', lines('---', 'title: A', '', 'Body'), false],
  ['indented four, which is code', lines('    ---', '    title: X', '    ---'), false],
  ['inside a blockquote', lines('> ---', '> title: Secret', '> ---'), false],
  ['not on line 1', lines('Text', '', '---', 'title: X', '---'), false],
];

describe('the editor reads front matter as the reading view does', () => {
  it.each(CASES)('%s', (_name, doc, isFrontMatter) => {
    const first = syntaxTree(testState(doc)).topNode.firstChild;

    expect(first?.name === 'FrontMatter').toBe(isFrontMatter);
    expect(renderMarkdown(doc, { documentDir: null }).includes('preview-frontmatter')).toBe(
      isFrontMatter,
    );
  });

  it('ends at the closing --- and leaves what follows to markdown', () => {
    const doc = lines('---', 'title: A', '---', '', '# After');
    const first = syntaxTree(testState(doc)).topNode.firstChild!;

    expect(doc.slice(first.from, first.to)).toBe(['---', 'title: A', '---'].join(NL));
    expect(first.nextSibling?.name).toBe('ATXHeading1');
  });
});

describe('live preview shows front matter as a card', () => {
  const DOC = lines('---', 'title: Export check', 'author: Hashpad', '---', '', 'Body');

  function viewWith(anchor: number, live = true): EditorView {
    return new EditorView({
      state: testState(DOC, anchor, anchor, live ? [livePreview] : []),
      parent: document.body,
    });
  }

  it('as the reading view draws it, while the cursor is elsewhere', () => {
    const view = viewWith(DOC.length);
    const card = view.contentDOM.querySelector('.preview-frontmatter');

    expect([...card!.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
      'title',
      'author',
    ]);
    expect([...card!.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual([
      'Export check',
      'Hashpad',
    ]);
    expect(view.contentDOM.textContent).not.toContain('---');
    view.destroy();
  });

  it('as text, while the cursor is inside it', () => {
    const view = viewWith(DOC.length);

    view.dispatch({ selection: EditorSelection.cursor(DOC.indexOf('title')) });

    expect(view.contentDOM.querySelector('.preview-frontmatter')).toBeNull();
    expect(view.contentDOM.textContent).toContain('title: Export check');
    view.destroy();
  });

  it('only in live preview', () => {
    const view = viewWith(DOC.length, false);

    expect(view.contentDOM.querySelector('.preview-frontmatter')).toBeNull();
    view.destroy();
  });
});
