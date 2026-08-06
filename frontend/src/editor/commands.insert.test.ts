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

describe('blockInsert: already at the start of a line', () => {
  // The brief's own "separates itself" cases only prove the blank-line
  // prefix appears when it's needed (cursor mid-line). They don't prove it
  // is withheld when it isn't: a wrong implementation that always prefixes
  // `\n\n` would still pass the empty-document case in the verbatim block
  // above (an empty document's cursor is trivially "at the start of a
  // line"), but would fail here, where the cursor sits at the start of a
  // line that has real content above it.
  it('does not add a blank line when the cursor already starts a non-empty line', () => {
    expect(apply(testState('foo\nbar', 4), 'horizontalRule')?.doc).toBe('foo\n---\nbar');
  });
});
