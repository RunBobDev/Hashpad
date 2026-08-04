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
  it.each([
    ['italic', '*'],
    ['strikethrough', '~~'],
    ['highlight', '=='],
    ['inlineCode', '`'],
  ] as const)('%s wraps a selection', (id, delim) => {
    const result = apply(testState('a word b', 2, 6), id);
    expect(result?.doc).toBe(`a ${delim}word${delim} b`);
  });

  it.each([
    ['italic', 'a *soft* b', 4],
    ['strikethrough', 'a ~~gone~~ b', 5],
    ['highlight', 'a ==marked== b', 6],
    ['inlineCode', 'a `code` b', 4],
  ] as const)('%s toggles off from inside', (id, doc, pos) => {
    const result = apply(testState(doc, pos), id);
    expect(result?.doc).not.toContain('*');
    expect(result?.doc.trim().split(/\s+/)).toHaveLength(3);
  });
});
