import { describe, expect, it } from 'vitest';
import { EditorSelection, type EditorState } from '@codemirror/state';
import { COMMANDS } from './commands';
import { applyCommand, testState } from './testdoc';

/** Lets the cases below name a command by id; the work is in testdoc.ts. */
const apply = (state: EditorState, id: keyof typeof COMMANDS) => applyCommand(state, COMMANDS[id]);

describe('bold', () => {
  it('wraps a selection and keeps it selected', () => {
    expect(apply(testState('hello world', 0, 5), 'bold')).toEqual({
      doc: '**hello** world',
      from: 2,
      to: 7,
    });
  });

  // SPEC §6.5: "No selection wraps the word under the cursor."
  it('wraps the word under a bare cursor', () => {
    expect(apply(testState('hello world', 3), 'bold')).toEqual({
      doc: '**hello** world',
      from: 2,
      to: 7,
    });
  });

  it('inserts empty markers with the cursor between them on whitespace', () => {
    expect(apply(testState('a  b', 2), 'bold')).toEqual({ doc: 'a **** b', from: 4, to: 4 });
  });

  // SPEC §6.5: "Toggle, don't just insert. Bold on already-bold text removes
  // the markers." This is the single most important behaviour in the file.
  it('removes the markers when the cursor is inside bold text', () => {
    expect(apply(testState('a **bold** b', 5), 'bold')).toEqual({
      doc: 'a bold b',
      from: 3,
      to: 3,
    });
  });

  it('removes the markers when the bold text is selected', () => {
    expect(apply(testState('a **bold** b', 4, 8), 'bold')).toEqual({
      doc: 'a bold b',
      from: 2,
      to: 6,
    });
  });

  it('wraps a multi-line selection as one span, not one per line', () => {
    expect(apply(testState('one\ntwo', 0, 7), 'bold')).toEqual({
      doc: '**one\ntwo**',
      from: 2,
      to: 9,
    });
  });

  it('bolds inside existing italic without disturbing it', () => {
    expect(apply(testState('*soft*', 1, 5), 'bold')).toEqual({
      doc: '***soft***',
      from: 3,
      to: 7,
    });
  });

  it('handles two cursors independently', () => {
    const state = testState('one two').update({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
    }).state;
    const spec = COMMANDS.bold(state);
    expect(spec).not.toBeNull();
    expect(state.update(spec!).state.doc.toString()).toBe('**one** **two**');
  });

  // The dedup case the brief flags as the one thing to get right: two cursors
  // in the same **bold** span must not delete its markers twice. Pins the
  // exact resulting doc and both cursor positions. Note: undeduped duplicate
  // delete ranges happen to collapse to a no-op under ChangeSet.of's own
  // sequential-composition fallback (verified directly against the library),
  // so this test alone can't fail a regression that only drops the dedup --
  // the dedup stays because the brief specifies it and because the code is
  // then obviously correct without leaning on that undocumented fallback.
  it('deletes the markers once when two cursors sit inside the same span', () => {
    const state = testState('a **bold** b').update({
      selection: EditorSelection.create([EditorSelection.cursor(5), EditorSelection.cursor(7)]),
    }).state;
    const spec = COMMANDS.bold(state);
    expect(spec).not.toBeNull();
    const next = state.update(spec!).state;
    expect(next.doc.toString()).toBe('a bold b');
    expect(next.selection.ranges.map((r) => [r.from, r.to])).toEqual([
      [3, 3],
      [5, 5],
    ]);
  });

  it('declines inside a fenced code block', () => {
    const doc = '```js\nlet x = 1;\n```';
    expect(apply(testState(doc, doc.indexOf('let')), 'bold')).toBeNull();
  });
});

describe('the other four inline marks', () => {
  // Full `{ doc, from, to }` triples, not just the wrapped text: an assertion
  // that stops at `doc` can't tell a correct wrap from one that inserted the
  // right characters but left the selection outside its new markers.
  it.each([
    ['italic', 'a *word* b', 3, 7],
    ['strikethrough', 'a ~~word~~ b', 4, 8],
    ['highlight', 'a ==word== b', 4, 8],
    ['inlineCode', 'a `word` b', 3, 7],
  ] as const)('%s wraps a selection', (id, doc, from, to) => {
    expect(apply(testState('a word b', 2, 6), id)).toEqual({ doc, from, to });
  });

  // Each row's expected doc is asserted exactly (`toEqual`, not
  // `not.toContain`): strikethrough and highlight both use multi-character
  // delimiters, and a remove that deletes one character per side instead of
  // two -- e.g. leaving `a ~gone~ b` -- would satisfy `not.toContain('*')`
  // and a three-token split just as well as a correct removal. Only pinning
  // the exact resulting doc (and, per the file's own `applyCommand` doc
  // comment, the exact cursor position) catches that.
  it.each([
    ['italic', 'a *soft* b', 4, 'a soft b', 3],
    ['strikethrough', 'a ~~gone~~ b', 5, 'a gone b', 3],
    ['highlight', 'a ==marked== b', 6, 'a marked b', 4],
    ['inlineCode', 'a `code` b', 4, 'a code b', 3],
  ] as const)('%s toggles off from inside', (id, doc, pos, expectedDoc, expectedPos) => {
    expect(apply(testState(doc, pos), id)).toEqual({
      doc: expectedDoc,
      from: expectedPos,
      to: expectedPos,
    });
  });

  it('declines inlineCode inside a fenced code block', () => {
    // The fenced-code guard lives in toggleInlineMark itself, ahead of the
    // per-mark logic, so all five commands share it -- but backticks are the
    // one delimiter that also appears in the fence markers themselves, which
    // makes inlineCode the natural paranoid case for it, distinct from the
    // guard test already covering bold.
    const doc = '```js\nlet x = 1;\n```';
    expect(apply(testState(doc, doc.indexOf('let')), 'inlineCode')).toBeNull();
  });
});

/**
 * The remove path (commands.ts) deletes `[span.openFrom, span.openTo)` and
 * `[span.closeFrom, span.closeTo)` -- the *measured* delimiter runs
 * `enclosingInlineMark` found in the tree -- rather than deriving offsets
 * from `INLINE_MARK_DELIMITERS[mark].length`. Every test above happens to use
 * a document where the two agree (a bold span is always exactly `**`, etc.),
 * so a regression to `{ from: span.openFrom, to: span.openFrom +
 * delimiter.length }` would pass every one of them while quietly eating or
 * leaving behind a character on a real document. These two documents are
 * where the measured run and the constant provably diverge, or -- for the
 * second case -- where getting the *node* boundaries wrong under nesting
 * would show up in the output; see task-2-report.md's "Fix pass" section for
 * the grammar dump backing both.
 */
describe('remove path uses the measured delimiter run, not the constant length', () => {
  it('removes a double-backtick code span (CodeMark is 2 chars wide; the inlineCode constant is 1)', () => {
    // `a ``code`` b` parses to InlineCode[2,10) with CodeMark[2,4) and
    // CodeMark[8,10) -- each backtick run is 2 characters, unlike the
    // single-backtick case every other inlineCode test uses. Deriving the
    // delete range from the constant's length (1) instead of the measured
    // run would delete only one backtick per side, leaving `a `code` b`
    // instead of removing the span cleanly.
    const doc = 'a ``code`` b';
    expect(apply(testState(doc, 5), 'inlineCode')).toEqual({
      doc: 'a code b',
      from: 3,
      to: 3,
    });
  });

  it('removes the inner bold from ***soft*** without disturbing the outer italic', () => {
    // ***soft*** parses to Emphasis[0,10) (outer, 1-char marks at [0,1) and
    // [9,10)) wrapping StrongEmphasis[1,9) (inner, 2-char marks at [1,3) and
    // [7,9)). Both widths happen to equal their own mark's constant here --
    // @lezer/markdown's emphasis parser only ever emits 1-char Emphasis marks
    // or 2-char StrongEmphasis marks, so this document does not actually
    // discriminate the measured-vs-constant bug the way the backtick case
    // above does. What it does pin down is that removing bold reaches for
    // the *inner* node's own measured marks and stops there, rather than
    // reading past them into the outer italic's `*` -- a real way to get
    // "boundaries" wrong that has nothing to do with delimiter width.
    const doc = '***soft***';
    expect(apply(testState(doc, 5), 'bold')).toEqual({
      doc: '*soft*',
      from: 3,
      to: 3,
    });
  });

  it('removes the outer italic from ***soft*** without disturbing the inner bold', () => {
    // Same document, the other mark: the cursor sits inside the innermost
    // node (StrongEmphasis), so this also exercises walking *up* to the
    // enclosing Emphasis rather than stopping at the first node found.
    const doc = '***soft***';
    expect(apply(testState(doc, 5), 'italic')).toEqual({
      doc: '**soft**',
      from: 4,
      to: 4,
    });
  });
});
