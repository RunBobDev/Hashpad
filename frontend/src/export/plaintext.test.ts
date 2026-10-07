// @vitest-environment jsdom
/**
 * Export as Plain Text (SPEC §7.3): markdown syntax gone, structure kept by
 * indentation. Each case is a document and the exact text it becomes, so a
 * failure reads as a diff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShowExportDialog, WriteFile } from '../../wailsjs/go/app/App';
import { activeSource } from './build';
import { exportActiveAsText, markdownToPlainText } from './plaintext';

vi.mock('../../wailsjs/go/app/App', () => ({
  ShowExportDialog: vi.fn(),
  WriteFile: vi.fn(() => Promise.resolve()),
}));

vi.mock('./build', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./build')>()),
  activeSource: vi.fn(),
}));

describe('markdownToPlainText', () => {
  it.each([
    ['headings and paragraphs', '# Title\n\nPara one\nline two', 'Title\n\nPara one\nline two\n'],
    ['heading levels alike', '# T\n\n## U', 'T\n\nU\n'],
    ['a bullet list, nested by two spaces', '- a\n- b\n  - c', '- a\n- b\n  - c\n'],
    ['an ordered list from its own start', '3. x\n4. y', '3. x\n4. y\n'],
    ['task items', '- [x] done\n- [ ] todo', '- [x] done\n- [ ] todo\n'],
    ['a quote, indented four', '> quoted\n> more', '    quoted\n    more\n'],
    ['a list inside a quote', '> - a\n> - b', '    - a\n    - b\n'],
    ['code, indented four', '```js\nlet a;\nlet b;\n```', '    let a;\n    let b;\n'],
    [
      'a table, padded into columns',
      '| A | Bee |\n|---|---|\n| 1 | 2 |',
      'A  Bee\n-  ---\n1  2\n',
    ],
    [
      'links as text and address, bare ones once',
      '[x](https://e.com) and https://f.com',
      'x (https://e.com) and https://f.com\n',
    ],
    ['a mail autolink once', '<a@b.co>', 'a@b.co\n'],
    ['an image as its alt', '![cat](https://e.com/c.png)', '[image: cat]\n'],
    ['an image with no alt', '![](https://e.com/c.png)', '[image]\n'],
    ['inline math as its source', 'Inline $x^2$ here', 'Inline x^2 here\n'],
    ['display math as its source, indented', '$$\n\\alpha\n$$', '    \\alpha\n'],
    ['a diagram as its source, indented', '```mermaid\ngraph TD;\n  A-->B;\n```', '    graph TD;\n      A-->B;\n'],
    ['a hard break as a line break', 'a  \nb', 'a\nb\n'],
    ['front matter as key: value', '---\ntitle: X\n---\n\nBody', 'title: X\n\nBody\n'],
    ['a footnote, without its back-link', 'Note[^1]\n\n[^1]: Foot', 'Note[1]\n\n---\n\n1. Foot\n'],
    ['a rule', 'a\n\n***\n\nb', 'a\n\n---\n\nb\n'],
    ['nothing as nothing', '', ''],
  ])('%s', (_name, markdown, text) => {
    expect(markdownToPlainText(markdown)).toBe(text);
  });
});

describe('exportActiveAsText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** WriteFile turns LF into the line ending it is given, so it gets the document's. */
  it('writes UTF-8 in the document’s own line ending, after the dialog', async () => {
    vi.mocked(activeSource).mockReturnValue({
      text: '# Hi',
      documentDir: null,
      stem: 'notes',
      lineEnding: 'crlf',
    });
    vi.mocked(ShowExportDialog).mockResolvedValue('C:\\out\\notes.txt');

    await exportActiveAsText();

    expect(ShowExportDialog).toHaveBeenCalledWith('notes.txt', 'text');
    expect(WriteFile).toHaveBeenCalledWith('C:\\out\\notes.txt', 'Hi\n', 'utf-8', 'crlf');
  });

  it('writes nothing when the dialog is cancelled', async () => {
    vi.mocked(activeSource).mockReturnValue({
      text: '# Hi',
      documentDir: null,
      stem: 'notes',
      lineEnding: 'lf',
    });
    vi.mocked(ShowExportDialog).mockResolvedValue('');

    await exportActiveAsText();

    expect(WriteFile).not.toHaveBeenCalled();
  });
});
