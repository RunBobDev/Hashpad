import { describe, expect, it } from 'vitest';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { COMMANDS } from './commands';
import { applyCommand, testState } from './testdoc';

/** Lets the cases below name a command by id; the work is in testdoc.ts. */
const apply = (state: EditorState, id: keyof typeof COMMANDS) => applyCommand(state, COMMANDS[id]);

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

  // `format` used to own the whole prefix, and `toggleHeading` -- the one
  // caller that is not a blockPrefixAt wrapper -- returned it without the
  // indent, so every heading toggle silently deleted the line's leading
  // whitespace. The four sibling commands all preserved it, which is what
  // made the inconsistency easy to miss.
  it('keeps indentation when adding a level', () => {
    expect(apply(testState('  Title', 4), 'heading1')?.doc).toBe('  # Title');
  });

  it('keeps indentation when removing a level', () => {
    expect(apply(testState('  # Title', 6), 'heading1')?.doc).toBe('  Title');
  });

  // CommonMark allows up to three spaces before the hashes, so the editor's
  // own parser renders this as a heading. With headingLevelAt anchored at
  // column 0 it matched neither detect nor conflict, fell through to the
  // insert branch, and produced `# # Title` -- inserting a second marker
  // where it should have removed the first, which is the opposite of what
  // "toggle, don't just insert" requires.
  it('replaces rather than doubles the marker on an indented heading', () => {
    expect(apply(testState('  # Title', 6), 'heading3')?.doc).toBe('  ### Title');
  });

  // Four spaces makes the line an indented code block, which is why
  // headingLevelAt stops at three. Two guards then agree on the outcome for
  // different reasons: the marker is not a heading marker, and `inFencedCode`
  // matches CodeBlock (the indented variant) as well as FencedCode, so the
  // command declines outright rather than writing a `#` into someone's code.
  // Asserting the decline pins the stronger of the two.
  it('declines on a four-space-indented line, which is code, not a heading', () => {
    expect(apply(testState('    # Title', 8), 'heading1')).toBeNull();
  });

  it('keeps a list marker when making its line a heading', () => {
    expect(apply(testState('  - item', 6), 'heading1')?.doc).toBe('  # - item');
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

  // A task item is a bullet item with a checkbox, so removing the bullet has
  // to take the checkbox with it. Matching only `- ` left `[ ] item` behind
  // as literal text -- the button visibly did not do what it says.
  it('removes the whole marker from a task item, checkbox included', () => {
    expect(apply(testState('- [ ] item', 8), 'bulletList')?.doc).toBe('item');
  });

  // The other half of counting a task as a bullet. Over a mixed selection the
  // task line already qualifies, so it is left alone and only the plain line
  // gains a marker. Rewriting it as `- ` instead would destroy the user's
  // checked state -- losing data, not just tidying markup.
  it('keeps a checked task intact when bulleting the lines around it', () => {
    expect(apply(testState('- [x] done\nplain', 0, 16), 'bulletList')?.doc).toBe(
      '- [x] done\n- plain',
    );
  });

  // A plain bullet carries no state, and CommonMark reads a change of bullet
  // character as the start of a *new* list -- so leaving `*` alone here would
  // hand the user two adjacent one-item lists where they asked for one list
  // of two. This is the case that stops `regenerate` from being a blanket
  // "never rewrite".
  it('normalises a * bullet so the selection stays one list', () => {
    expect(apply(testState('* one\ntwo', 0, 9), 'bulletList')?.doc).toBe('- one\n- two');
  });

  it('normalises a + bullet the same way', () => {
    expect(apply(testState('+ one\ntwo', 0, 9), 'bulletList')?.doc).toBe('- one\n- two');
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

  // Named for what it actually pins. A mis-numbered list is still *a*
  // numbered list, so every line matches `detect`, so this takes the remove
  // path -- it does not exercise renumbering at all, despite the obvious
  // reading of "1. / 1. becomes correct". The renumbering tests are below.
  it('removes numbering from a mis-numbered list like any other', () => {
    expect(apply(testState('1. one\n1. two', 0, 13), 'numberedList')?.doc).toBe('one\ntwo');
  });

  // The regenerate branch with a number that genuinely has to change: the
  // first line already carries `3. `, and a correct list starts at 1. An
  // implementation that re-emitted each line's existing marker instead of
  // renumbering would leave `3. one` here and pass every other test in this
  // file, because every other case happens to regenerate 1 as 1.
  it('renumbers from one when an existing number is wrong', () => {
    expect(apply(testState('3. one\ntwo', 0, 10), 'numberedList')?.doc).toBe('1. one\n2. two');
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

// The remove path keeps the indent and deletes only the marker. Every remove
// test above uses a zero-indent document, so the mirror image of the add-path
// bug -- deleting the indent along with the marker -- would pass all of them.
describe('removing a prefix keeps the line indented', () => {
  it.each([
    ['bulletList', '  - item', 6, '  item'],
    ['numberedList', '  1. item', 7, '  item'],
    ['taskList', '  - [ ] item', 10, '  item'],
    ['blockquote', '  > quoted', 6, '  quoted'],
  ] as const)('%s', (id, doc, pos, expected) => {
    expect(apply(testState(doc, pos), id)?.doc).toBe(expected);
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

  // Replacing the whole occupied run -- indent plus the bullet being replaced
  // -- and writing the indent back is what keeps this single-width. Replacing
  // from the *end* of the existing indent instead would leave those characters
  // in place and then emit a second copy after them, doubling it to four
  // spaces. Only an indented case catches that: every case above has an empty
  // indent, where doubling zero characters is still zero characters.
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

/**
 * Where the caret lands when a marker is added. Reported by the owner: bold
 * and friends put the caret between the delimiters, ready to type, but the
 * block commands left it *before* the marker, so every list or heading needed
 * a manual arrow past the `- ` or `# ` before typing could start.
 *
 * The cause is CodeMirror's default change mapping: an insertion at exactly
 * the caret's position maps the caret to the near side. On an empty line the
 * caret is at column 0, which is exactly where the marker goes.
 */
describe('caret placement when adding a marker', () => {
  it.each([
    ['bulletList', '- ', 2],
    ['numberedList', '1. ', 3],
    ['taskList', '- [ ] ', 6],
    ['blockquote', '> ', 2],
    ['heading1', '# ', 2],
    ['heading3', '### ', 4],
  ] as const)('%s puts the caret after the marker on an empty line', (id, marker, at) => {
    const result = apply(testState('', 0), id);
    expect(result?.doc).toBe(marker);
    expect(result?.from).toBe(at);
    expect(result?.to).toBe(at);
  });

  it.each([
    ['bulletList', '- item', 2],
    ['numberedList', '1. item', 3],
    ['blockquote', '> item', 2],
    ['heading2', '## item', 3],
  ] as const)('%s keeps the caret before the first character of the text', (id, expected, at) => {
    const result = apply(testState('item', 0), id);
    expect(result?.doc).toBe(expected);
    expect(result?.from).toBe(at);
  });

  // Not a regression of the existing behaviour: a caret already inside the
  // text still travels with the character it was on.
  it('keeps the caret on the same character when it is mid-word', () => {
    const result = apply(testState('Title', 2), 'heading1');
    expect(result?.doc).toBe('# Title');
    expect(result?.from).toBe(4);
  });

  it('lands after the new marker when replacing a different one', () => {
    // '# Title' caret at 3 ('i'); '### Title' has 'i' at 5.
    const result = apply(testState('# Title', 3), 'heading3');
    expect(result?.doc).toBe('### Title');
    expect(result?.from).toBe(5);
  });

  it('preserves the indent and lands after the marker on an indented line', () => {
    const result = apply(testState('  ', 2), 'bulletList');
    expect(result?.doc).toBe('  - ');
    expect(result?.from).toBe(4);
  });

  // A real selection is left to CodeMirror's own change mapping, untouched by
  // the caret logic above -- so this pins pre-existing behaviour rather than a
  // new choice. Both ends shift past the marker inserted at their own
  // position, so the selection starts after the first line's marker.
  // Recorded so a later change to the caret handling cannot quietly alter the
  // selection case too.
  it('leaves a non-empty selection to the default mapping', () => {
    const result = apply(testState('one\ntwo', 0, 7), 'bulletList');
    expect(result?.doc).toBe('- one\n- two');
    expect(result?.from).toBe(2);
    expect(result?.to).toBe(11);
  });
});
