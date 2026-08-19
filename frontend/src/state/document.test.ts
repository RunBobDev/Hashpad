import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  clampSplitRatio,
  createUntitledDocument,
  DEFAULT_SPLIT_RATIO,
  isDirty,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  statusOf,
} from './document';

describe('isDirty', () => {
  it('is false for a freshly created document', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: 'hello' }));

    expect(isDirty(doc)).toBe(false);
  });

  it('is true once the editor state diverges from the saved doc', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: 'hello' }));
    const changed = doc.editorState.update({ changes: { from: 5, insert: '!' } }).state;
    const edited = { ...doc, editorState: changed };

    expect(isDirty(edited)).toBe(true);
  });

  it('is false again once savedDoc is updated to match the edited text', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: 'hello' }));
    const changed = doc.editorState.update({ changes: { from: 5, insert: '!' } }).state;
    const edited = { ...doc, editorState: changed };
    const saved = { ...edited, savedDoc: changed.doc };

    expect(isDirty(saved)).toBe(false);
  });
});

/**
 * settings.json is hand-editable, so this is a trust boundary, not a
 * formality — the value it guards ends up in an inline `flex-basis`.
 */
describe('clampSplitRatio', () => {
  it('passes an in-range ratio through untouched', () => {
    expect(clampSplitRatio(0.42)).toBeCloseTo(0.42);
  });

  it('clamps a ratio that would collapse either side', () => {
    expect(clampSplitRatio(0)).toBeCloseTo(MIN_SPLIT_RATIO);
    expect(clampSplitRatio(1)).toBeCloseTo(MAX_SPLIT_RATIO);
    // Someone thinking in percent. Clamping (rather than rejecting) reads it
    // as "as far over as it goes", which is what they meant.
    expect(clampSplitRatio(40)).toBeCloseTo(MAX_SPLIT_RATIO);
  });

  // Clamping "half" would be meaningless, so anything non-numeric falls back
  // to the compiled-in default instead.
  // `Infinity` is deliberately here rather than with the clamped values above:
  // "as far over as it goes" is a reading `40` supports and `Infinity` does
  // not -- it is what a corrupted file or a division by zero produces, not
  // something a person typed, so the default is the safer answer.
  it.each([['half'], [NaN], [null], [undefined], [{}], [Infinity], [-Infinity], [true]])(
    'falls back to the default for %s',
    (value) => {
      expect(clampSplitRatio(value)).toBeCloseTo(DEFAULT_SPLIT_RATIO);
    },
  );
});

/**
 * The counting rules behind SPEC 6.11's status bar. No DOM here on purpose --
 * `statusOf` is a pure function of an `EditorState`, and what the row does with
 * the numbers is `ui/statusbar.test.ts`'s problem.
 */
describe('statusOf', () => {
  const NL = String.fromCharCode(10);

  // Two calls rather than one with `selection: undefined`:
  // `exactOptionalPropertyTypes` is on, so an explicitly-undefined optional is
  // a type error even though it behaves identically at runtime.
  function stateOf(doc: string, anchor?: number, head?: number): EditorState {
    if (anchor === undefined) return EditorState.create({ doc });
    return EditorState.create({ doc, selection: { anchor, head: head ?? anchor } });
  }

  it('reports a 1-based line and column', () => {
    // 'first' is 0..4 and the break is 5, so line 2 starts at 6; offset 10 puts
    // the caret after 'seco'.
    const status = statusOf(stateOf('first' + NL + 'second', 10));

    expect(status.line).toBe(2);
    expect(status.col).toBe(5);
  });

  it('starts at Ln 1, Col 1 in an empty document', () => {
    expect(statusOf(stateOf(''))).toEqual({
      line: 1,
      col: 1,
      words: 0,
      chars: 0,
      selection: false,
    });
  });

  it('counts words and characters across the whole document', () => {
    const status = statusOf(stateOf('one two' + NL + 'three  four'));

    expect(status.words).toBe(4);
    // Every character in the *buffer*, line break included. Not the file's byte
    // count: CodeMirror normalises every line ending to a single LF on load and
    // Go re-applies CRLF on write, so a CRLF file is a byte per line longer on
    // disk than this. Counting the buffer is what VS Code does too.
    expect(status.chars).toBe(19);
    expect(status.selection).toBe(false);
  });

  /**
   * Runs of whitespace are one separator, and leading or trailing whitespace is
   * not a word. A naive `split(' ').length` gets all three of these wrong.
   */
  it('treats runs of mixed whitespace as one separator', () => {
    const tab = String.fromCharCode(9);
    const doc = '  one' + tab + tab + 'two' + NL + NL + 'three  ';

    expect(statusOf(stateOf(doc)).words).toBe(3);
  });

  /**
   * A line break separates words even with no space around it -- the chunk
   * boundary in `Text.iter()` falls exactly there, so a counter that only looked
   * inside chunks would join the two into one word.
   */
  it('separates words across a line break', () => {
    expect(statusOf(stateOf('one' + NL + 'two')).words).toBe(2);
  });

  it('counts the selection instead when there is one', () => {
    // 'one two three four', selecting 'two three'.
    const status = statusOf(stateOf('one two three four', 4, 13));

    expect(status.words).toBe(2);
    expect(status.chars).toBe(9);
    expect(status.selection).toBe(true);
  });

  /**
   * A selection made right-to-left has `head` before `anchor`. The counts must
   * come off the range, not off the two ends in the order they were given, or a
   * backwards selection reports a negative length.
   */
  it('handles a selection made backwards', () => {
    const forwards = statusOf(stateOf('one two three four', 4, 13));
    const backwards = statusOf(stateOf('one two three four', 13, 4));

    expect(backwards.words).toBe(forwards.words);
    expect(backwards.chars).toBe(forwards.chars);
    // The caret is at the *head*, which is where the user's cursor actually is.
    expect(backwards.col).toBe(5);
    expect(forwards.col).toBe(14);
  });

  it('reports the whole document again when the selection collapses', () => {
    expect(statusOf(stateOf('one two three four', 4, 4)).selection).toBe(false);
    expect(statusOf(stateOf('one two three four', 4, 4)).words).toBe(4);
  });
});
