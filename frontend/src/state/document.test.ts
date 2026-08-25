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
  clampTabSize,
  DEFAULT_BEHAVIOUR,
  isEncoding,
  isViewMode,
  previousViewModeFor,
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

/**
 * SPEC §6.13's `tabSize`, from a hand-editable file. `LoadSettingsFrom` only
 * guarantees the JSON parsed -- never that the numbers in it make sense.
 */
describe('clampTabSize', () => {
  it.each([
    [2, 2],
    [4, 4],
    [16, 16],
  ])('keeps a sensible %s', (value, expected) => {
    expect(clampTabSize(value)).toBe(expected);
  });

  /** 0 would make Tab insert nothing at all; a huge one pushes text off-screen. */
  it.each([
    [0, 1],
    [-4, 1],
    [999, 16],
  ])('clamps %s to %s', (value, expected) => {
    expect(clampTabSize(value)).toBe(expected);
  });

  /** Half a column is not a thing. */
  it('floors a fractional width', () => {
    expect(clampTabSize(3.7)).toBe(3);
  });

  /**
   * JSON `null` and a hand-typed string both arrive as non-numbers, and NaN
   * fails every comparison silently -- `Math.min`/`Math.max` alone would carry
   * it straight into the editor's configuration.
   */
  it.each([[NaN], [Infinity], [null as unknown as number], [undefined as unknown as number]])(
    'falls back for %s',
    (value) => {
      expect(clampTabSize(value)).toBe(DEFAULT_BEHAVIOUR.tabSize);
    },
  );
});

/**
 * `settings.editor.defaultViewMode` is the one view-mode value that arrives
 * from outside the type system: Go declares it as a `string`, so unmarshalling
 * cannot reject a hand-edited value the way it rejects a non-boolean, and
 * `wailsjs/go/models.ts` widens it to `string` on this side too.
 */
describe('isViewMode', () => {
  it.each([['source'], ['live'], ['split']])('accepts %s', (value) => {
    expect(isViewMode(value)).toBe(true);
  });

  /**
   * `''` and the near-misses matter more than the obvious garbage: a settings
   * file written by hand is far likelier to say "preview" or "Split" than
   * something no one would type. Any of them reaching the store would put a
   * mode nothing renders on every document the app opens.
   */
  it.each([[''], ['preview'], ['Split'], ['SOURCE'], ['source '], ['null']])(
    'rejects %s',
    (value) => {
      expect(isViewMode(value)).toBe(false);
    },
  );

  /** A key missing from a hand-edited file reads as `undefined`, not as ''. */
  it('rejects a missing value', () => {
    expect(isViewMode(undefined as unknown as string)).toBe(false);
  });
});

describe('previousViewModeFor', () => {
  /**
   * Split has no earlier mode to remember, so a document that opened straight
   * into it falls back to source when the preview is toggled off.
   */
  it('sends split back to source', () => {
    expect(previousViewModeFor('split')).toBe('source');
  });

  /**
   * The reason `previousViewMode` exists: a document opened under
   * `defaultViewMode: "live"` must come back as `'live'`, not be silently
   * downgraded. Returning a hard-coded `'source'` for everything would pass the
   * split case above and fail exactly here.
   */
  it.each([['source'], ['live']] as const)('leaves %s alone', (mode) => {
    expect(previousViewModeFor(mode)).toBe(mode);
  });
});

describe('createUntitledDocument opens in the mode it is given', () => {
  /**
   * The default is what 29 existing call sites rely on, and it is also what
   * bootstrap falls back to when settings cannot be read.
   */
  it('defaults to source', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: '' }));

    expect(doc.viewMode).toBe('source');
    expect(doc.previousViewMode).toBe('source');
  });

  /**
   * The owner's report, at its smallest: with the preview showing, File > New
   * gave a tab with no preview, because this function spelled `'source'` into
   * every document it made.
   */
  it('carries a split default onto the document, remembering source', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: '' }), 'split');

    expect(doc.viewMode).toBe('split');
    expect(doc.previousViewMode).toBe('source');
  });

  /** `previousViewMode` is derived, not copied -- live is its own answer. */
  it('carries a live default onto both fields', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: '' }), 'live');

    expect(doc.viewMode).toBe('live');
    expect(doc.previousViewMode).toBe('live');
  });
});

/**
 * `settings.files.defaultEncoding`, from the same hand-editable file as
 * `defaultViewMode` -- and with more at stake. This value is what an untitled
 * document is *written* as, so an unrecognised one reaches Go's `WriteFile` at
 * the moment the user first saves.
 */
describe('isEncoding', () => {
  it.each([['utf-8'], ['utf-8-bom'], ['utf-16le']])('accepts %s', (value) => {
    expect(isEncoding(value)).toBe(true);
  });

  /**
   * The near-misses are the point. `"utf8"` and `"UTF-8"` are what someone
   * editing the file by hand actually types, and `"utf-16"` and `"utf-16be"`
   * are real encodings that this app does not write -- accepting either would
   * mean claiming a byte order the writer never produces.
   */
  it.each([[''], ['utf8'], ['UTF-8'], ['utf-16'], ['utf-16be'], ['ascii'], ['utf-8 ']])(
    'rejects %s',
    (value) => {
      expect(isEncoding(value)).toBe(false);
    },
  );

  it('rejects a missing value', () => {
    expect(isEncoding(undefined as unknown as string)).toBe(false);
  });
});

describe('createUntitledDocument opens in the encoding it is given', () => {
  it('defaults to utf-8, saved and current agreeing', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: '' }));

    expect(doc.encoding).toBe('utf-8');
    expect(doc.savedEncoding).toBe('utf-8');
  });

  /**
   * Both fields, or the document opens dirty. `isDirty` compares them, so a
   * version that set only `encoding` would put a dot on an untouched document
   * and prompt to save it on close -- which is why this asserts `isDirty`
   * rather than only reading the two fields back.
   */
  it('carries the encoding onto both fields, leaving the document clean', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: '' }), 'source', 'utf-16le');

    expect(doc.encoding).toBe('utf-16le');
    expect(doc.savedEncoding).toBe('utf-16le');
    expect(isDirty(doc)).toBe(false);
  });

  /** The two defaults are independent; neither may quietly reset the other. */
  it('takes a view mode and an encoding together', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: '' }), 'split', 'utf-8-bom');

    expect(doc.viewMode).toBe('split');
    expect(doc.encoding).toBe('utf-8-bom');
  });

  /**
   * There is no `defaultLineEnding` in SPEC §6.13's block, so a new document
   * stays on CRLF whatever the encoding says. Pinned so that wiring one later
   * is a deliberate act.
   */
  it('leaves the line ending on crlf', () => {
    const doc = createUntitledDocument(EditorState.create({ doc: '' }), 'source', 'utf-16le');

    expect(doc.lineEnding).toBe('crlf');
    expect(doc.savedLineEnding).toBe('crlf');
  });
});
