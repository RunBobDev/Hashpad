import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  clampSplitRatio,
  createUntitledDocument,
  DEFAULT_SPLIT_RATIO,
  isDirty,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
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
