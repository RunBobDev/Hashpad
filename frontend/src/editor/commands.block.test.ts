import { describe, expect, it } from 'vitest';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { COMMANDS } from './commands';
import { applyCommand, testState } from './testdoc';

/** Lets the cases below name a command by id; the work is in testdoc.ts. */
const apply = (state: EditorState, id: keyof typeof COMMANDS) =>
  applyCommand(state, COMMANDS[id]);

describe('heading', () => {
  it('adds the level to a plain line', () => {
    expect(apply(testState('Title', 2), 'heading1')?.doc).toBe('# Title');
  });

  it('removes the level when it already matches', () => {
    expect(apply(testState('# Title', 3), 'heading1')?.doc).toBe('Title');
  });

  it('replaces a different level', () => {
    expect(apply(testState('# Title', 3), 'heading3')?.doc).toBe('### Title');
  });

  it('applies to every line of a multi-line selection', () => {
    expect(apply(testState('one\ntwo', 0, 7), 'heading2')?.doc).toBe('## one\n## two');
  });

  it('keeps the cursor on the same word after the prefix changes', () => {
    // 'Title' starts at 0 before, at 2 after: the cursor must move with it.
    const result = apply(testState('Title', 2), 'heading1');
    expect(result?.from).toBe(4);
  });
});

describe('bulletList', () => {
  it('adds a marker', () => {
    expect(apply(testState('item', 2), 'bulletList')?.doc).toBe('- item');
  });

  it('removes the marker when every selected line has one', () => {
    expect(apply(testState('- one\n- two', 0, 11), 'bulletList')?.doc).toBe('one\ntwo');
  });

  // Mixed selections normalise rather than alternate: alternating would mean
  // the command has no stable meaning on a mixed selection at all.
  it('adds to every line when only some have the marker', () => {
    expect(apply(testState('- one\ntwo', 0, 9), 'bulletList')?.doc).toBe('- one\n- two');
  });

  it('preserves indentation', () => {
    expect(apply(testState('  item', 4), 'bulletList')?.doc).toBe('  - item');
  });
});

describe('numberedList', () => {
  it('numbers the selected lines from one', () => {
    expect(apply(testState('one\ntwo\nthree', 0, 13), 'numberedList')?.doc).toBe(
      '1. one\n2. two\n3. three',
    );
  });

  it('removes numbering when every line has it', () => {
    expect(apply(testState('1. one\n2. two', 0, 13), 'numberedList')?.doc).toBe('one\ntwo');
  });

  // SPEC §6.6 requires ordered lists to renumber automatically; converting a
  // mis-numbered list must produce a correct one, not preserve the mistake.
  it('renumbers a mis-numbered list', () => {
    expect(apply(testState('1. one\n1. two', 0, 13), 'numberedList')?.doc).toBe('one\ntwo');
  });

  // A mixed selection regenerates the line that already had a number (so it
  // can be renumbered) rather than leaving it untouched -- and must do so
  // without disturbing its indent. Same class of bug as the taskList case
  // above: replacing after the indent instead of from the start of the line
  // would double it to four spaces.
  it('keeps indentation when regenerating an already-numbered line', () => {
    expect(apply(testState('  1. one\ntwo', 0, 12), 'numberedList')?.doc).toBe('  1. one\n2. two');
  });
});

describe('taskList', () => {
  it('adds an unchecked box', () => {
    expect(apply(testState('item', 2), 'taskList')?.doc).toBe('- [ ] item');
  });

  it('removes the box and its bullet', () => {
    expect(apply(testState('- [ ] item', 8), 'taskList')?.doc).toBe('item');
  });

  it('removes a checked box too', () => {
    expect(apply(testState('- [x] item', 8), 'taskList')?.doc).toBe('item');
  });

  it('converts a plain bullet into a task', () => {
    expect(apply(testState('- item', 4), 'taskList')?.doc).toBe('- [ ] item');
  });

  // `format` returns indent+marker together; replacing from the *end* of the
  // existing indent (rather than from the start of the line) would keep the
  // original indent characters in place and then insert format's own copy of
  // them right after, doubling it to four spaces. Only an indented case can
  // catch that -- every case above has an empty indent, where the bug is
  // invisible because doubling zero characters is still zero characters.
  it('replaces an indented bullet, keeping the indent single-width', () => {
    expect(apply(testState('  - item', 6), 'taskList')?.doc).toBe('  - [ ] item');
  });
});

describe('blockquote', () => {
  it('adds and removes the marker', () => {
    expect(apply(testState('quoted', 2), 'blockquote')?.doc).toBe('> quoted');
    expect(apply(testState('> quoted', 4), 'blockquote')?.doc).toBe('quoted');
  });

  it('applies per line across a selection', () => {
    expect(apply(testState('one\ntwo', 0, 7), 'blockquote')?.doc).toBe('> one\n> two');
  });
});

/**
 * `allowMultipleSelections` is live in the shipped editor (Alt+click adds a
 * cursor), and per-line block formatting is exactly where a multi-range bug
 * corrupts a document: two ranges resolving to the same line must not apply
 * the prefix twice, and two ranges on different lines must each get it.
 * Built the way commands.inline.test.ts's two-cursor test does it, since
 * `testState` itself only accepts a single range.
 */
describe('multiple cursors', () => {
  it('toggles a line once when two cursors sit on it', () => {
    const state = testState('item').update({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]),
    }).state;
    const spec = COMMANDS.bulletList(state);
    expect(spec).not.toBeNull();
    // A missing dedup would insert the marker twice at the same spot --
    // '- - item' rather than '- item'.
    expect(state.update(spec!).state.doc.toString()).toBe('- item');
  });

  it('toggles every line when cursors sit on different lines', () => {
    const state = testState('one\ntwo\nthree').update({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(5)]),
    }).state;
    const spec = COMMANDS.bulletList(state);
    expect(spec).not.toBeNull();
    // Line 3 has no cursor on it and must be left untouched.
    expect(state.update(spec!).state.doc.toString()).toBe('- one\n- two\nthree');
  });
});
