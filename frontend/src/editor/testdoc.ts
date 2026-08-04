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
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { markdownSupport } from './highlight';

export function testState(doc: string, anchor = 0, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    // `allowMultipleSelections` defaults to false, in which case any
    // transaction's selection is silently reduced with `.asSingle()` --
    // including the very transaction a test uses to construct a multi-range
    // selection in the first place. Task 2's commands operate on every range
    // in `state.selection.ranges`, so tests need to be able to build a state
    // that actually has more than one; the shipped editor (extensions.ts)
    // does not enable this, since nothing yet creates multiple cursors there.
    extensions: [...markdownSupport(), EditorState.allowMultipleSelections.of(true)],
  });
}

/**
 * Applies a command and returns the resulting document plus the primary
 * selection — the pair every command test asserts on, because a command that
 * produces the right text but leaves the cursor in the wrong place is still
 * wrong, and that is exactly the class of bug SPEC §10 expects these tests to
 * catch.
 *
 * Takes the command function rather than an id, and spells its type
 * structurally rather than importing `MarkdownCommand`, so this test helper
 * carries no dependency on `commands.ts`.
 */
export function applyCommand(
  state: EditorState,
  command: (state: EditorState) => TransactionSpec | null,
): { doc: string; from: number; to: number } | null {
  const spec = command(state);
  if (!spec) return null;
  const next = state.update(spec).state;
  const { from, to } = next.selection.main;
  return { doc: next.doc.toString(), from, to };
}
