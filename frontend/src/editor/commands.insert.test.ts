import { describe, expect, it } from 'vitest';
import type { EditorState } from '@codemirror/state';
import { COMMANDS } from './commands';
import { applyCommand, testState } from './testdoc';

/** Lets the cases below name a command by id; the work is in testdoc.ts. */
const apply = (state: EditorState, id: keyof typeof COMMANDS) => applyCommand(state, COMMANDS[id]);

describe('link', () => {
  it('uses the selection as the link text and selects the url placeholder', () => {
    const result = apply(testState('click here', 0, 5), 'link');
    expect(result?.doc).toBe('[click](url) here');
    // 'url' must come out selected so typing replaces it.
    expect(result?.doc.slice(result.from, result.to)).toBe('url');
  });

  it('uses the word under a bare cursor', () => {
    expect(apply(testState('click here', 2), 'link')?.doc).toBe('[click](url) here');
  });

  it('selects the text placeholder when there is no word', () => {
    const result = apply(testState('', 0), 'link');
    expect(result?.doc).toBe('[text](url)');
    expect(result?.doc.slice(result.from, result.to)).toBe('text');
  });
});

describe('image', () => {
  it('wraps the selection as alt text', () => {
    const result = apply(testState('a cat', 2, 5), 'image');
    expect(result?.doc).toBe('a ![cat](path)');
    expect(result?.doc.slice(result.from, result.to)).toBe('path');
  });

  it('inserts placeholders on an empty document', () => {
    expect(apply(testState('', 0), 'image')?.doc).toBe('![alt](path)');
  });
});

describe('table', () => {
  it('inserts a 3x3 GFM skeleton', () => {
    expect(apply(testState('', 0), 'table')?.doc).toBe(
      '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n',
    );
  });

  // Inserting a block construct in the middle of a paragraph must not glue
  // itself onto the surrounding text, or the markdown simply does not parse.
  it('separates itself from surrounding text with blank lines', () => {
    const result = apply(testState('before', 6), 'table');
    expect(result?.doc.startsWith('before\n\n|')).toBe(true);
  });
});

describe('horizontalRule', () => {
  it('inserts --- on its own line', () => {
    expect(apply(testState('', 0), 'horizontalRule')?.doc).toBe('---\n');
  });

  it('separates itself from surrounding text', () => {
    expect(apply(testState('before', 6), 'horizontalRule')?.doc).toBe('before\n\n---\n');
  });
});

describe('footnote', () => {
  it('inserts a reference and a definition at the end of the document', () => {
    const result = apply(testState('text', 4), 'footnote');
    expect(result?.doc).toBe('text[^1]\n\n[^1]: \n');
  });

  // Numbering must not collide, or two footnotes render as one.
  it('numbers past the highest existing footnote', () => {
    const result = apply(testState('a[^1] b[^3] c', 13), 'footnote');
    expect(result?.doc).toContain('[^4]');
    expect(result?.doc).toContain('[^4]: ');
  });

  it('puts the cursor on the definition so you can type it', () => {
    const result = apply(testState('text', 4), 'footnote');
    // Non-null, not just optional-chained: `result?.doc.indexOf(...) + n`
    // types as `number | undefined` under strict mode, so the arithmetic
    // itself needs the narrowed, definitely-a-string `result!.doc`.
    expect(result).not.toBeNull();
    expect(result!.from).toBe(result!.doc.indexOf('[^1]: ') + '[^1]: '.length);
  });
});

describe('codeBlock', () => {
  // The owner's decision, recorded in the plan: no modal prompt. The cursor
  // lands on the info string so typing the language is the next keystroke.
  it('leaves the cursor on the info string', () => {
    const result = apply(testState('', 0), 'codeBlock');
    expect(result?.doc).toBe('```\n\n```\n');
    expect(result?.from).toBe(3);
  });

  it('wraps a selection in the fence', () => {
    expect(apply(testState('let x = 1;', 0, 10), 'codeBlock')?.doc).toBe('```\nlet x = 1;\n```\n');
  });
});

/**
 * Step 3 of the brief states this in prose but the verbatim test block above
 * (also from the brief) never exercises it: every insert command declines
 * inside a fenced code block except `codeBlock` itself, which is the one
 * command `activeFormats` still reports there. A command that forgot this
 * guard would insert literal `[text](url)` or a stray `---` into someone's
 * code sample.
 */
describe('the fenced-code guard', () => {
  const doc = '```js\nlet x = 1;\n```';
  const pos = doc.indexOf('let');

  it.each(['link', 'image', 'table', 'horizontalRule', 'footnote'] as const)(
    '%s declines inside a fenced code block',
    (id) => {
      expect(apply(testState(doc, pos), id)).toBeNull();
    },
  );

  // The one exception, and worth pinning explicitly rather than leaving it
  // implied by the absence of a decline test.
  it('codeBlock does not decline inside a fenced code block', () => {
    expect(apply(testState(doc, pos), 'codeBlock')).not.toBeNull();
  });
});

describe('footnote with the cursor mid-document', () => {
  // Both footnote cases in the brief's own block put the cursor at the very
  // end of the document, where the reference and definition insertion points
  // coincide (`pos === state.doc.length`). A plausible wrong implementation
  // hard-codes that coincidence -- e.g. computing the definition's landing
  // position from the cursor position instead of from the *original*
  // document length -- and would only be caught by a case where the two
  // points differ.
  it('inserts the reference at the cursor and the definition at the true document end', () => {
    const result = apply(testState('note here', 4), 'footnote');
    expect(result?.doc).toBe('note[^1] here\n\n[^1]: \n');
    expect(result).not.toBeNull();
    expect(result!.from).toBe(result!.doc.indexOf('[^1]: ') + '[^1]: '.length);
  });
});

// A block construct needs a blank line on each side, not merely a line of its
// own. Getting that wrong does not produce ugly markdown, it produces
// *different* markdown -- each case below was checked against this project's
// own parser, and the wrong output parses as the wrong construct.
describe('blockInsert surrounds the construct with blank lines', () => {
  // The original rule keyed off column zero and emitted `foo\n---\nbar`,
  // which @lezer/markdown parses as SetextHeading2: the rule underlines
  // `foo` and turns it into a heading. The user asked for a horizontal rule
  // and got an H2.
  it('opens a blank line above when inserting at the start of a line under text', () => {
    expect(apply(testState('foo\nbar', 4), 'horizontalRule')?.doc).toBe('foo\n\n---\n\nbar');
  });

  it('adds no blank line where one already exists', () => {
    expect(apply(testState('foo\n\nbar', 5), 'horizontalRule')?.doc).toBe('foo\n\n---\n\nbar');
  });

  // Only one trailing newline let the following line be swallowed as a table
  // row, since a table's rows are simply the lines beneath it.
  it('closes a blank line below so the next line is not absorbed', () => {
    const doc = apply(testState('foo\nbar', 4), 'table')?.doc ?? '';
    expect(doc.endsWith('\n\nbar')).toBe(true);
  });

  it('adds no leading blank line at the very start of the document', () => {
    expect(apply(testState('bar', 0), 'horizontalRule')?.doc).toBe('---\n\nbar');
  });

  // The most common position of all -- cursor at the end of a line with more
  // document below -- and the easiest to over-count, because the document
  // already supplies the newline that ends the line. Emitting two more here
  // leaves a stray empty line between the rule and the next paragraph.
  it('does not double the newline the document already has at end of line', () => {
    expect(apply(testState('foo\nbar', 3), 'horizontalRule')?.doc).toBe('foo\n\n---\n\nbar');
  });

  it('adds nothing below when a blank line already follows', () => {
    expect(apply(testState('foo\n\nbar', 3), 'horizontalRule')?.doc).toBe('foo\n\n---\n\nbar');
  });
});

// `codeBlock` consumes the selection -- that is the feature. The other two
// have no use for it, and replacing the range deleted whatever the user had
// selected: a toolbar click that silently ate a paragraph.
describe('table and horizontalRule leave a selection intact', () => {
  // Full-document equality rather than `toContain`: `toContain` would also
  // pass for an implementation that inserted the rule *before* the selection,
  // which preserves the text but is still the wrong edit.
  it('horizontalRule does not delete the selected text', () => {
    expect(apply(testState('keep this text', 0, 14), 'horizontalRule')?.doc).toBe(
      'keep this text\n\n---\n',
    );
  });

  it('table does not delete the selected text', () => {
    const doc = apply(testState('keep this text', 0, 14), 'table')?.doc ?? '';
    expect(doc.startsWith('keep this text\n\n| Column 1 |')).toBe(true);
  });

  it('codeBlock still consumes the selection, because it wraps it', () => {
    expect(apply(testState('let x = 1;', 0, 10), 'codeBlock')?.doc).toBe('```\nlet x = 1;\n```\n');
  });
});

describe('table places the cursor ready to type', () => {
  // A bare cursor before "Column 1" made typing produce `| NameColumn 1 |`.
  // Selecting the placeholder means the first keystroke replaces it, the same
  // convention link and image already follow.
  it('selects the first column heading', () => {
    const result = apply(testState('', 0), 'table');
    expect(result?.doc.slice(result.from, result.to)).toBe('Column 1');
  });
});
