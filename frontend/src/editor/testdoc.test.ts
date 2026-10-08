import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { testState } from './testdoc';

/**
 * `EditorState.create` parses for about 20 ms and keeps whatever it has. A long
 * document runs out of that budget every time; under a loaded, shuffled suite a
 * short one sometimes did too -- `inFencedCode` then reported a line inside a
 * fence as outside it. A test state has to carry the whole tree.
 */
describe('testState', () => {
  it('carries a tree covering the whole document, however long', () => {
    const doc = Array.from({ length: 4000 }, (_, i) => `- item ${String(i)} with *emphasis*`).join(
      '\n',
    );
    expect(syntaxTree(testState(doc)).length).toBe(doc.length);
  });
});
