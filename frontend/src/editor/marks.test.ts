import { describe, expect, it } from 'vitest';
import { syntaxTree } from '@codemirror/language';
import {
  activeFormats,
  blockPrefixAt,
  enclosingInlineMark,
  headingLevelAt,
  inFencedCode,
} from './marks';
import { testState } from './testdoc';

/** Collects every node name in the tree, for asserting the == grammar landed. */
function nodeNames(doc: string): string[] {
  const state = testState(doc);
  const names: string[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      names.push(node.name);
    },
  });
  return names;
}

describe('the ==highlight== grammar extension', () => {
  it('parses ==text== into Highlight and HighlightMark nodes', () => {
    const names = nodeNames('==marked==');
    expect(names).toContain('Highlight');
    expect(names).toContain('HighlightMark');
  });

  it('does not treat a single = as a delimiter', () => {
    expect(nodeNames('=notmarked=')).not.toContain('Highlight');
  });

  // A lone == with no closing run is ordinary text, not an unterminated mark.
  it('does not parse an unclosed == as a highlight', () => {
    expect(nodeNames('== dangling')).not.toContain('Highlight');
  });

  // The whole point of source mode (SPEC §6.6): the delimiters remain in the
  // document as real characters. A grammar that consumed them would break both
  // the round trip and every offset the commands compute.
  it('leaves the == characters in the document', () => {
    expect(testState('==marked==').doc.toString()).toBe('==marked==');
  });
});

describe('enclosingInlineMark', () => {
  it('finds bold around a cursor inside it', () => {
    const state = testState('a **bold** b');
    const span = enclosingInlineMark(state, 5, 'bold');
    expect(span).not.toBeNull();
    expect([span?.from, span?.to]).toEqual([2, 10]);
    expect([span?.openFrom, span?.openTo]).toEqual([2, 4]);
    expect([span?.closeFrom, span?.closeTo]).toEqual([8, 10]);
  });

  // `**` and `*` produce different Lezer nodes (StrongEmphasis vs Emphasis)
  // that share an EmphasisMark child type, so telling them apart is the one
  // place this module could silently confuse two marks.
  it('does not report italic for bold text', () => {
    const state = testState('a **bold** b');
    expect(enclosingInlineMark(state, 5, 'italic')).toBeNull();
  });

  it('finds italic around a cursor inside it', () => {
    const state = testState('a *soft* b');
    expect(enclosingInlineMark(state, 4, 'italic')).not.toBeNull();
  });

  it('finds bold when the cursor touches either edge', () => {
    const state = testState('**bold**');
    expect(enclosingInlineMark(state, 2, 'bold')).not.toBeNull();
    expect(enclosingInlineMark(state, 6, 'bold')).not.toBeNull();
    expect(enclosingInlineMark(state, 8, 'bold')).not.toBeNull();
  });

  it('returns null outside the mark', () => {
    const state = testState('a **bold** b');
    expect(enclosingInlineMark(state, 0, 'bold')).toBeNull();
    expect(enclosingInlineMark(state, 11, 'bold')).toBeNull();
  });

  it('finds nested bold inside italic', () => {
    const state = testState('*a **b** c*');
    expect(enclosingInlineMark(state, 6, 'bold')).not.toBeNull();
    expect(enclosingInlineMark(state, 6, 'italic')).not.toBeNull();
  });

  // The reason detection reads the tree rather than scanning text: inside a
  // code span the asterisks are literal characters, and a regex would call
  // this bold and then "unbold" it by deleting two characters of code.
  it('does not report bold for asterisks inside a code span', () => {
    const state = testState('`**not bold**`');
    expect(enclosingInlineMark(state, 6, 'bold')).toBeNull();
  });

  it.each([
    ['strikethrough', '~~gone~~'],
    ['highlight', '==marked=='],
    ['inlineCode', '`code`'],
  ] as const)('finds %s', (mark, doc) => {
    const state = testState(doc);
    expect(enclosingInlineMark(state, 3, mark)).not.toBeNull();
  });
});

describe('blockPrefixAt', () => {
  it.each([
    ['- item', 'bulletList', '', '- '],
    ['  * item', 'bulletList', '  ', '* '],
    ['+ item', 'bulletList', '', '+ '],
    ['1. item', 'numberedList', '', '1. '],
    ['  12. item', 'numberedList', '  ', '12. '],
    ['- [ ] task', 'taskList', '', '- [ ] '],
    ['- [x] done', 'taskList', '', '- [x] '],
    ['> quoted', 'blockquote', '', '> '],
  ] as const)('matches %s as %s', (line, prefix, indent, marker) => {
    expect(blockPrefixAt(line, prefix)).toEqual({ indent, marker });
  });

  it('returns null when the prefix is absent', () => {
    expect(blockPrefixAt('plain text', 'bulletList')).toBeNull();
    expect(blockPrefixAt('-nospace', 'bulletList')).toBeNull();
  });

  // A task item is also a bullet item; the reverse is not true. Both commands
  // need to agree on that or Ctrl+Shift+8 on a task would produce `- - [ ]`.
  it('treats a task item as a bullet item too', () => {
    expect(blockPrefixAt('- [ ] task', 'bulletList')).toEqual({ indent: '', marker: '- ' });
    expect(blockPrefixAt('- plain', 'taskList')).toBeNull();
  });
});

describe('headingLevelAt', () => {
  it.each([
    ['# one', 1],
    ['### three', 3],
    ['###### six', 6],
  ] as const)('reads %s as level %i', (line, level) => {
    expect(headingLevelAt(line)).toBe(level);
  });

  it('rejects non-headings', () => {
    expect(headingLevelAt('plain')).toBeNull();
    expect(headingLevelAt('#nospace')).toBeNull();
    // Seven hashes is not a heading in CommonMark.
    expect(headingLevelAt('####### seven')).toBeNull();
  });

  // An empty ATX heading is legal CommonMark, and Ctrl+1 on an empty line
  // produces exactly this, so the toggle must be able to see it.
  it('accepts a heading with no text', () => {
    expect(headingLevelAt('#')).toBe(1);
    expect(headingLevelAt('## ')).toBe(2);
  });
});

describe('inFencedCode', () => {
  it('is true inside a fence and false outside', () => {
    const doc = 'before\n```js\nlet x = 1;\n```\nafter';
    const state = testState(doc);
    expect(inFencedCode(state, doc.indexOf('let x'))).toBe(true);
    expect(inFencedCode(state, doc.indexOf('before'))).toBe(false);
    expect(inFencedCode(state, doc.indexOf('after'))).toBe(false);
  });
});

describe('activeFormats', () => {
  it('reports nothing in plain text', () => {
    expect(activeFormats(testState('plain', 2))).toEqual([]);
  });

  it('reports the inline mark the cursor sits in', () => {
    expect(activeFormats(testState('**bold**', 4))).toEqual(['bold']);
  });

  it('reports nested marks together, sorted', () => {
    expect(activeFormats(testState('*a **b** c*', 6))).toEqual(['bold', 'italic']);
  });

  it('reports the heading level as a command id', () => {
    expect(activeFormats(testState('## two', 4))).toEqual(['heading2']);
  });

  it('reports list and quote prefixes', () => {
    expect(activeFormats(testState('- item', 3))).toEqual(['bulletList']);
    expect(activeFormats(testState('- [ ] task', 8))).toEqual(['bulletList', 'taskList']);
    expect(activeFormats(testState('> quoted', 4))).toEqual(['blockquote']);
    expect(activeFormats(testState('1. one', 4))).toEqual(['numberedList']);
  });

  it('reports codeBlock inside a fence', () => {
    const doc = '```\nx\n```';
    expect(activeFormats(testState(doc, doc.indexOf('x')))).toContain('codeBlock');
  });
});
