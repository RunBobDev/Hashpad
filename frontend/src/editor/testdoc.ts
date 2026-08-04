/**
 * Test-only. Builds an `EditorState` carrying the real markdown language, so
 * `syntaxTree(state)` returns the same tree the running editor sees. Nothing
 * in the shipped app imports this, so Rollup never reaches it from main.ts and
 * it costs no bundle size.
 *
 * `markdownSupport()` rather than a bare `markdown()` call: the commands and
 * the detection module must be tested against the exact grammar configuration
 * the app runs (GFM base, our == extension, the code-language table), not a
 * simplified stand-in that would let a grammar mismatch pass.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdownSupport } from './highlight';

export function testState(doc: string, anchor = 0, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: markdownSupport(),
  });
}
