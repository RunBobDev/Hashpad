/**
 * Live preview's decoration set (SPEC §7.1, checkpoint K.1).
 *
 * **What these tests can and cannot prove.** They assert which ranges get a
 * `replace` decoration, which is the whole of the logic. They say nothing about
 * whether the asterisks visibly disappear -- that is layout, jsdom has none,
 * and `harness/livepreview.html` is where that question gets asked in a real
 * browser. A green run here plus a broken screen is a reachable state.
 */
import { describe, expect, it } from 'vitest';
import type { EditorState } from '@codemirror/state';
import {
  BULLET,
  documentDir,
  headingLineDecorations,
  inlineMarkDecorations,
  monoBlockLines,
  tableAlignDecorations,
} from './livepreview';
import { testState } from './testdoc';

/** Every hidden range, as `[from, to]` pairs in document order. */
function hidden(state: EditorState): [number, number][] {
  const set = inlineMarkDecorations(state, [{ from: 0, to: state.doc.length }]);
  const out: [number, number][] = [];
  set.between(0, state.doc.length, (from, to) => {
    out.push([from, to]);
  });
  return out;
}

/**
 * The document with every decorated range resolved -- what the line looks
 * like. A range carrying a widget renders as `BULLET`, so a *substitution*
 * (K.2's list marker) is distinguishable from a *removal*; without that,
 * `- item` and `• item` would both read as ` item` and the bullet tests could
 * not fail.
 *
 * **The widget's own `toDOM` is deliberately not called here.** It needs a
 * document, and this file is one of the fast `node`-environment ones -- opting
 * the whole file into jsdom to render one character would slow every case in
 * it. What is asserted here is that the marker is replaced rather than
 * deleted, and where; that the glyph actually paints is
 * `harness/livepreview.html`'s job, in a real browser.
 */
function asShown(state: EditorState): string {
  const text = state.doc.toString();
  const set = inlineMarkDecorations(state, [{ from: 0, to: state.doc.length }]);
  let out = '';
  let at = 0;
  set.between(0, state.doc.length, (from, to, value) => {
    out += text.slice(at, from);
    if (value.spec.widget !== undefined) out += BULLET;
    at = to;
  });
  return out + text.slice(at);
}

describe('hiding inline marks', () => {
  // The caret sits at 0 in all of these, which is inside the mark on a
  // single-line document -- so each puts the text on line 2 and leaves the
  // caret on line 1, out of the way.
  const away = (markup: string): EditorState => testState(`x\n${markup}`, 0);

  it('hides both runs of asterisks around bold', () => {
    expect(asShown(away('**bold**'))).toBe('x\nbold');
  });

  it('hides the delimiters of every inline mark, not only bold', () => {
    expect(asShown(away('*i* ~~s~~ ==h== `c`'))).toBe('x\ni s h c');
  });

  it('hides the outer and inner runs of nested emphasis', () => {
    expect(asShown(away('***both***'))).toBe('x\nboth');
  });

  it('leaves text with no marks completely alone', () => {
    expect(hidden(away('plain text'))).toEqual([]);
  });

  /**
   * The reveal rule is per *line*, so a caret anywhere on the line brings back
   * every marker on it -- not only the one it is inside. Both halves matter:
   * the first is the feature, and the second is what stops the text shuffling
   * sideways as the caret crosses each delimiter, which §7.1 calls out as
   * "visible reflow jitter".
   */
  it('reveals every mark on the line the caret is on', () => {
    // Caret at 0, one line: `**a**` and `*b*` are both on it.
    expect(hidden(testState('**a** *b*', 0))).toEqual([]);
  });

  it('reveals only the line the caret is on, not its neighbours', () => {
    // Line 1 is `**a**` (0-5), line 2 `**b**` (6-11). Caret on line 1.
    const state = testState('**a**\n**b**', 0);
    expect(asShown(state)).toBe('**a**\nb');
  });

  /**
   * §7.1: "Selection spanning a region reveals its markers." Falls out of
   * testing ranges by intersection rather than testing the cursor position, so
   * this is a guard on that choice rather than on separate code.
   */
  it('reveals a region a selection merely passes through', () => {
    // Anchor on line 1, head on line 3: line 2's marks are inside the span.
    const state = testState('a\n**b**\nc', 0, 9);
    expect(hidden(state)).toEqual([]);
  });

  /**
   * Emphasis may straddle a soft newline inside one paragraph. Revealing the
   * opening `**` while the closing one stayed hidden would read as a bug, so
   * the node is revealed as a whole from either of its lines.
   */
  it('reveals a mark that spans two lines from either of them', () => {
    const doc = 'x\n**bo\nld**\ny';
    // Caret on the mark's first line reveals all of it...
    expect(asShown(testState(doc, 3))).toBe(doc);
    // ...and so does the caret on its second.
    expect(asShown(testState(doc, 8))).toBe(doc);
    // With the caret on neither, both runs go.
    expect(asShown(testState(doc, 0))).toBe('x\nbo\nld\ny');
  });

  /**
   * A fenced block keeps its fence -- §7.1 is explicit that hiding it is
   * confusing, so this stays true through K.3 and beyond rather than being a
   * boundary that later moves.
   *
   * The caret sits on line 1, so no reveal is doing the work here.
   */
  it('never touches a fence', () => {
    const doc = 'x\n\n```js\ncode\n```';
    expect(asShown(testState(doc, 0))).toBe(doc);
  });

  /**
   * A code span's content is not markup. `**` inside backticks is two
   * asterisks, and the grammar agrees -- so nothing inside is hidden, and the
   * backticks themselves are.
   */
  it('does not hide markers inside a code span', () => {
    expect(asShown(away('`**not bold**`'))).toBe('x\n**not bold**');
  });

  /**
   * `RangeSetBuilder` throws on unsorted or overlapping input, so the sort and
   * the overlap guard in the builder are load-bearing rather than defensive.
   * Nesting emits parents before children -- descending order at one start
   * position -- which is precisely what it rejects.
   */
  it('emits ranges sorted and non-overlapping', () => {
    const ranges = hidden(away('***a*** **b** *c* ~~d~~'));
    expect(ranges.length).toBeGreaterThan(0);
    let end = -1;
    for (const [from, to] of ranges) {
      expect(from).toBeGreaterThanOrEqual(end);
      end = to;
    }
  });

  /**
   * The viewport limit is the performance story (§7.1's 5,000-line target), so
   * a walk that quietly ignored the range it was handed would pass every test
   * above and fail the only requirement they do not cover.
   */
  it('ignores marks outside the ranges it is given (K.1)', () => {
    // **The caret goes on the middle line, and that is the entire point.**
    // The first version of this test put it on line 1 and walked line 2 -- but
    // a caret on line 1 reveals line 1 anyway, so an unrestricted walk produced
    // an identical result and the test passed against a plugin that ignored its
    // ranges completely. Measured: it survived the mutation. Parked here on the
    // middle line, the two outcomes differ.
    const state = testState('**a**\nx\n**b**', 6);
    const set = inlineMarkDecorations(state, [{ from: 8, to: 13 }]);
    const out: [number, number][] = [];
    set.between(0, state.doc.length, (from, to) => {
      out.push([from, to]);
    });
    // Line 3's marks only. Line 1's are hidden by the reveal rule's reckoning
    // too, and appear here the moment the walk stops honouring its ranges.
    expect(out).toEqual([
      [8, 10],
      [11, 13],
    ]);
  });
});

/**
 * K.2: headings, links and list markers. The reveal rule is unchanged and is
 * not re-tested per node type -- what *is* tested per node type is the reveal
 * *scope*, because each of these picks its own and picking wrong is invisible
 * until you edit something long.
 */
describe('hiding block and link syntax', () => {
  const away = (markup: string): EditorState => testState(`x\n${markup}`, 0);

  it('hides a heading hash and the space after it', () => {
    expect(asShown(away('# Heading'))).toBe('x\nHeading');
  });

  it('hides all six heading levels', () => {
    expect(asShown(away('###### Six'))).toBe('x\nSix');
  });

  /**
   * CommonMark allows `## Title ##`. Hiding only the opening run leaves
   * `Title ##` on screen, which is worse than leaving the line alone -- so
   * both runs go, each taking the spaces on its inner side.
   */
  it('hides a closing sequence too, and the space before it', () => {
    expect(asShown(away('## Title ##'))).toBe('x\nTitle');
  });

  it('restores the hash when the caret is on the heading', () => {
    expect(asShown(testState('# Heading', 4))).toBe('# Heading');
  });

  /**
   * A Setext heading underlines its text on a line of its own, and hiding that
   * line's content would leave a blank line rather than tidying anything.
   * Pinned so the omission is a decision on the record rather than a gap.
   */
  it('leaves a Setext underline alone', () => {
    expect(asShown(away('Title\n====='))).toBe('x\nTitle\n=====');
  });

  it('shows a link as its text alone', () => {
    expect(asShown(away('See [the docs](https://example.com).'))).toBe('x\nSee the docs.');
  });

  it('hides a link title as well as the URL', () => {
    expect(asShown(away('[t](http://a.b "Title")'))).toBe('x\nt');
  });

  it('restores the whole link when the caret is on its line', () => {
    const doc = '[t](http://a.b)';
    expect(asShown(testState(doc, 1))).toBe(doc);
  });

  /**
   * A reference link has no `URL` child. Hiding its brackets alone would run
   * the label into the text and show `textref`, so it is left whole -- the
   * `URL` test in the handler is what excludes it.
   */
  it('leaves a reference link alone', () => {
    expect(asShown(away('[text][ref]'))).toBe('x\n[text][ref]');
  });

  /**
   * `![alt](url)` parses as `Image`, not `Link`, so it is excluded for free.
   * Inline thumbnails are K.3; until then an image must look exactly as it
   * does in source mode rather than collapsing to its alt text.
   */
  it('leaves an image alone', () => {
    expect(asShown(away('![alt](pic.png)'))).toBe('x\n![alt](pic.png)');
  });

  it('replaces a bullet marker rather than deleting it', () => {
    expect(asShown(away('- one'))).toBe(`x\n${BULLET} one`);
  });

  it('replaces every bullet character markdown allows', () => {
    expect(asShown(away('* a\n\n+ b'))).toBe(`x\n${BULLET} a\n\n${BULLET} b`);
  });

  /**
   * An ordered marker is already the glyph it should be, and replacing it
   * would throw the number away. §7.1 asks for `-` only.
   */
  it('leaves an ordered list marker alone', () => {
    expect(asShown(away('1. one'))).toBe('x\n1. one');
  });

  it('restores the marker when the caret is on the item line', () => {
    expect(asShown(testState('- one', 3))).toBe('- one');
  });

  /**
   * **The scope test, and the reason list markers do not ask about their
   * node.** `ListItem` spans every line of a multi-line item, so a whole-node
   * reveal would put the `-` back while the caret sat three lines below it --
   * the marker flickering between glyph and hyphen as you typed in a long
   * bullet. The handler asks about the marker's line instead.
   */
  it('keeps the bullet while the caret is elsewhere in a long item', () => {
    // The item runs to line 3; the caret is on line 3, the marker on line 1.
    const doc = '- one\n  still one\n  and still one';
    expect(asShown(testState(doc, doc.length))).toBe(`${BULLET} one\n  still one\n  and still one`);
  });

  /**
   * The same scope question for headings, where the answer differs: a heading
   * is one line, so its mark and its node agree. Pinned anyway, because
   * `# a` followed by body text is the shape where a node-scoped test would
   * quietly start revealing from the paragraph below.
   */
  it('keeps a heading hidden while the caret is in the text below it', () => {
    expect(asShown(testState('# Heading\n\nbody', 12))).toBe('Heading\n\nbody');
  });
});

/**
 * Which lines live mode holds at fixed pitch. The typography itself -- what
 * font actually paints -- is not testable here: jsdom resolves `var(--…)` to
 * the empty string and measures nothing. What *is* testable, and is where the
 * bugs would be, is which lines get the class.
 */
describe('marking fixed-pitch lines', () => {
  const lineNumbers = (state: EditorState): number[] => {
    const set = monoBlockLines(state, [{ from: 0, to: state.doc.length }]);
    const out: number[] = [];
    set.between(0, state.doc.length, (from) => {
      out.push(state.doc.lineAt(from).number);
    });
    return out;
  };

  it('marks every line of a fenced block, fences included', () => {
    // 1 prose, 2 blank, 3 ```js, 4 code, 5 ```
    expect(lineNumbers(testState('x\n\n```js\ncode\n```'))).toEqual([3, 4, 5]);
  });

  it('marks every row of a table', () => {
    const doc = 'x\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    expect(lineNumbers(testState(doc))).toEqual([3, 4, 5]);
  });

  it('marks nothing in ordinary prose', () => {
    expect(lineNumbers(testState('just **text** here\n\nand more'))).toEqual([]);
  });

  /**
   * The clip, which only bites on a block taller than the viewport: a fenced
   * block that starts above the visible range and ends below it must
   * contribute the lines in between rather than throwing at `lineAt` on a
   * position outside the range it was given.
   */
  it('clips a block to the range it was given', () => {
    const doc = '```js\na\nb\nc\nd\n```';
    const state = testState(doc);
    // Ask for the middle only: lines 3 and 4.
    const set = monoBlockLines(state, [{ from: state.doc.line(3).from, to: state.doc.line(4).to }]);
    const out: number[] = [];
    set.between(0, state.doc.length, (from) => {
      out.push(state.doc.lineAt(from).number);
    });
    expect(out).toEqual([3, 4]);
  });

  /**
   * `RangeSetBuilder` throws on a repeated position, and two visible ranges
   * either side of a fold can each enter the same block. Deduplicated in the
   * builder loop; this is what says so.
   */
  it('emits each line once when two ranges cover the same block', () => {
    const state = testState('```js\na\nb\n```');
    const set = monoBlockLines(state, [
      { from: 0, to: state.doc.length },
      { from: 0, to: state.doc.length },
    ]);
    const out: number[] = [];
    set.between(0, state.doc.length, (from) => {
      out.push(state.doc.lineAt(from).number);
    });
    expect(out).toEqual([1, 2, 3, 4]);
  });
});

/**
 * The h1/h2 rule and the Setext collapse. Both are line decorations carrying a
 * class, so what they *look* like is `harness/livepreview.html`'s question --
 * these pin which lines get which class, which is where the logic is.
 */
describe('heading line decorations', () => {
  const classesByLine = (state: EditorState): Record<number, string> => {
    const set = headingLineDecorations(state, [{ from: 0, to: state.doc.length }]);
    const out: Record<number, string> = {};
    set.between(0, state.doc.length, (from, _to, value) => {
      const line = state.doc.lineAt(from).number;
      const name = String(value.spec.class);
      out[line] = out[line] === undefined ? name : `${out[line]} ${name}`;
    });
    return out;
  };

  /**
   * Two classes doing two jobs, and the split matters.
   *
   * `cm-live-heading` goes on **every** level and carries `line-height: 1.25`,
   * which `preview.css` sets on all six. Without it the editor's 1.6 leaves
   * leading below the text, and the rule sat 11px under the heading against
   * reading view's 6px -- reported as "a tiny bit farther away".
   *
   * `cm-live-heading-rule` is added only for h1 and h2, which are the levels
   * reading view rules.
   */
  it('draws the rule under h1 and h2 only, and tightens the leading on all of them', () => {
    const doc = '# one\n\n## two\n\n### three\n\n#### four';
    expect(classesByLine(testState(doc, doc.length))).toEqual({
      1: 'cm-live-heading cm-live-heading-rule',
      3: 'cm-live-heading cm-live-heading-rule',
      5: 'cm-live-heading',
      7: 'cm-live-heading',
    });
  });

  it('tightens the leading on h5 and h6 too', () => {
    const doc = '##### five\n\n###### six';
    expect(classesByLine(testState(doc, doc.length))).toEqual({
      1: 'cm-live-heading',
      3: 'cm-live-heading',
    });
  });

  /**
   * The rule is not a marker, so it does not follow the reveal rule: it is
   * drawn whether or not the caret is on the heading. A section break that
   * blinked on and off as the caret crossed it would be worse than either
   * state.
   */
  it('draws the rule even with the caret on the heading', () => {
    expect(classesByLine(testState('# one', 2))).toEqual({
      1: 'cm-live-heading cm-live-heading-rule',
    });
  });

  /**
   * **The Setext collapse, and why K.2 was wrong to give up on it.** The
   * objection was that hiding `=====` leaves an empty line -- true, but an h1
   * with a rule under it is what `Title` over `=====` was drawing in ASCII, so
   * the underline is promoted rather than deleted: the text line takes the
   * rule, and the characters go.
   */
  it('rules the Setext text line and hides its underline', () => {
    // Caret on line 4, away from the heading on lines 1-2.
    expect(classesByLine(testState('Title\n=====\n\nbody', 13))).toEqual({
      1: 'cm-live-heading cm-live-heading-rule',
      2: 'cm-live-setext-hidden',
    });
  });

  it('hides a Setext h2 underline too', () => {
    expect(classesByLine(testState('Title\n-----\n\nbody', 13))).toEqual({
      1: 'cm-live-heading cm-live-heading-rule',
      2: 'cm-live-setext-hidden',
    });
  });

  /**
   * The underline has to stay reachable, or it could never be edited or
   * deleted. Revealed from either of the heading's two lines, like any other
   * marker -- and measured in the browser harness: the caret does land on the
   * hidden line when arrowing down, rather than stepping over it.
   */
  it('reveals the underline from either line of the heading', () => {
    expect(classesByLine(testState('Title\n=====\n\nbody', 0))).toEqual({
      1: 'cm-live-heading cm-live-heading-rule',
    });
    expect(classesByLine(testState('Title\n=====\n\nbody', 7))).toEqual({
      1: 'cm-live-heading cm-live-heading-rule',
    });
  });
});

/* ---- K.3: images ------------------------------------------------------- */

/** A state whose document has been saved into `dir`. */
function saved(doc: string, anchor = 0, dir = 'C:\\notes'): EditorState {
  return testState(doc, anchor, anchor, [documentDir.of(dir)]);
}

/**
 * The `ImageWidget` a range was replaced with, or `null` if it was not.
 *
 * Reads the widget's own fields rather than rendering it: `toDOM` needs a
 * `document` and this file runs in the fast `node` environment. What a real
 * `<img>` looks like on screen is `harness/livepreview.html`'s question.
 */
function thumbnail(state: EditorState): { src: string; alt: string } | null {
  const set = inlineMarkDecorations(state, [{ from: 0, to: state.doc.length }]);
  let found: { src: string; alt: string } | null = null;
  set.between(0, state.doc.length, (_from, _to, value) => {
    const widget = value.spec.widget as { src?: unknown; alt?: unknown } | undefined;
    if (typeof widget?.src === 'string' && typeof widget.alt === 'string') {
      found = { src: widget.src, alt: widget.alt };
    }
  });
  return found;
}

describe('images as inline thumbnails', () => {
  /**
   * The whole node, alt text included -- the alt is what you read *instead of*
   * the picture, so leaving it beside the picture would show it twice.
   */
  it('replaces the whole image node', () => {
    // Caret parked on line 1, away from the image on line 2.
    expect(hidden(saved('x\n![alt](pic.png)'))).toEqual([[2, 17]]);
  });

  it('resolves a relative path against the document folder', () => {
    expect(thumbnail(saved('x\n![alt](sub/pic.png)'))).toEqual({
      src: '/__hashpad/asset?dir=C%3A%5Cnotes&path=sub%2Fpic.png',
      alt: 'alt',
    });
  });

  /**
   * Both halves are encoded separately, which is what stops a `src` from
   * smuggling in its own `dir` -- the same property `rules.test.ts` pins for
   * the preview, and the Go handler's `assets_test.go` for the other end.
   */
  it('escapes a path trying to smuggle in its own dir', () => {
    expect(thumbnail(saved('x\n![a](p.png&dir=C:\\evil)'))?.src).toBe(
      '/__hashpad/asset?dir=C%3A%5Cnotes&path=p.png%26dir%3DC%3A%5Cevil',
    );
  });

  it('passes a data: URI through untouched', () => {
    const src = 'data:image/gif;base64,R0lGOD';
    expect(thumbnail(saved(`x\n![a](${src})`))?.src).toBe(src);
  });

  /**
   * **Remote images are never fetched** (design §3 beats SPEC §6.7), so there
   * is no thumbnail to draw -- and the markdown is left visible rather than
   * replaced by an empty box, because the URL is the useful thing to show.
   */
  it('leaves a remote image as markdown', () => {
    expect(hidden(saved('x\n![a](https://example.com/p.png)'))).toEqual([]);
  });

  it('leaves a local image alone in a document that has never been saved', () => {
    expect(hidden(testState('x\n![a](pic.png)', 0))).toEqual([]);
  });

  /** A Windows absolute path is a path, not a `c:` URL -- see `REMOTE`. */
  it('treats a drive-letter path as local', () => {
    expect(thumbnail(saved('x\n![a](C:/pics/p.png)'))?.src).toContain('path=C%3A%2Fpics%2Fp.png');
  });

  it('leaves a reference image alone, having no URL to resolve', () => {
    expect(hidden(saved('x\n![a][ref]\n\n[ref]: p.png'))).toEqual([]);
  });

  it('reveals the markdown when the caret is on its line', () => {
    expect(hidden(saved('x\n![alt](pic.png)', 2))).toEqual([]);
  });

  /**
   * CommonMark allows whitespace after the `(`, which is what makes the alt
   * text worth taking from the marks rather than by arithmetic off the URL:
   * an offset-based slice reads `a]` here.
   */
  it('reads the alt text when the URL is not where arithmetic expects it', () => {
    expect(thumbnail(saved('x\n![a](  pic.png)'))?.alt).toBe('a');
  });

  it('strips the pointy brackets CommonMark allows around a URL', () => {
    expect(thumbnail(saved('x\n![a](<my pic.png>)'))?.src).toContain('path=my%20pic.png');
  });

  /**
   * `![**a**](p.png)` contributes two overlapping spans -- the image over the
   * whole node, and the `StrongEmphasis` inside its alt. The builder's overlap
   * pass keeps the image, which starts first, and the emphasis marks go with
   * it rather than being hidden twice.
   */
  /**
   * **CodeMirror throws on a replacement that crosses a line break** when it
   * comes from a `ViewPlugin`, so this is a crash rather than a cosmetic
   * defect: typing a wrapped alt text broke the editor outright. Found in the
   * browser harness -- a decoration set built in `node` is only a description,
   * and nothing rejects it until CodeMirror applies it.
   */
  it('leaves an image whose alt text wraps as markdown', () => {
    expect(hidden(saved('x\n![alt\ntext](p.png)'))).toEqual([]);
  });

  /**
   * The sibling of the case above, and **reachable since K.2**: CommonMark
   * allows a line break between a link's destination and its title, so
   * `[t](/url\n"Title")` asks for exactly the same forbidden span. Found by
   * looking for it rather than by hitting it.
   */
  it('leaves a link whose title is on the next line as markdown', () => {
    expect(hidden(saved('x\n[t](/url\n"Title")'))).toEqual([]);
  });

  it('wins over an inline mark inside its own alt text', () => {
    expect(hidden(saved('x\n![**a**](p.png)'))).toEqual([[2, 17]]);
  });
});

/* ---- K.3: table alignment ---------------------------------------------- */

/** The document with every pad widget expanded -- the table as it renders. */
function padded(state: EditorState): string {
  const text = state.doc.toString();
  const set = tableAlignDecorations(state, [{ from: 0, to: state.doc.length }]);
  let out = '';
  let at = 0;
  set.between(0, state.doc.length, (from, to, value) => {
    out += text.slice(at, from);
    const widget = value.spec.widget as { count: number; fill: string };
    out += widget.fill.repeat(widget.count);
    at = to;
  });
  return out + text.slice(at);
}

/** Where the pads landed, for the cases that count them rather than read them. */
function padPositions(state: EditorState, ranges: { from: number; to: number }[]): number[] {
  const out: number[] = [];
  tableAlignDecorations(state, ranges).between(0, state.doc.length, (from) => {
    out.push(from);
  });
  return out;
}

describe('aligning table columns', () => {
  it('pads every cell to the width of its column', () => {
    expect(padded(testState('|a|bb|\n|-|-|\n|ccc|d|\n'))).toBe('|a  |bb|\n|---|--|\n|ccc|d |\n');
  });

  /**
   * The delimiter row is filled with dashes rather than spaces: aligned blanks
   * are aligned but look broken, and lengthening the dashes is what a person
   * padding this by hand would do.
   */
  it('lengthens the delimiter row rather than blanking it', () => {
    expect(padded(testState('|heading|\n|-|\n|x|\n'))).toBe('|heading|\n|-------|\n|x      |\n');
  });

  /**
   * **The fill goes after the last dash**, so a trailing `:` stays put.
   * Appending to `:--:` gives `:--:---`, which silently turns a centred column
   * into a left-aligned one.
   */
  it('keeps a trailing alignment colon at the end of its run', () => {
    expect(padded(testState('|abcdef|\n|:--:|\n|x|\n'))).toBe('|abcdef|\n|:----:|\n|x     |\n');
  });

  /**
   * An empty cell produces no `TableCell` node at all, which is why columns are
   * measured between delimiters instead. Measuring cells drops this column and
   * misaligns every one after it.
   */
  it('keeps a column whose cell is empty', () => {
    expect(padded(testState('|a||bbb|\n|-|-|-|\n|c|d|e|\n'))).toBe(
      '|a| |bbb|\n|-|-|---|\n|c|d|e  |\n',
    );
  });

  /** GFM makes the outer pipes optional, and `a | b` is a valid row. */
  it('aligns a table written without outer pipes', () => {
    expect(padded(testState('a | bb\n--- | ---\nccc | d\n'))).toBe(
      'a   | bb \n--- | ---\nccc | d  \n',
    );
  });

  /**
   * **The case `trimEdges` exists for**, and the only one that can tell it is
   * working: when every row is written the same way, the empty segment a
   * leading `|` produces is present in every row and shifts them all equally,
   * so leaving it in changes nothing. Mix the two styles in one table and it
   * becomes column zero of some rows and not others.
   *
   * The pipes still do not line up across the two styles -- a leading `|` takes
   * a screen column that a row without one does not have, and no amount of
   * padding inside the cells can fix that. What is claimed here is that the
   * *cells* are sized as one table rather than as two.
   */
  it('sizes columns as one table when only some rows have outer pipes', () => {
    expect(padded(testState('| a | bb |\n|---|---|\nc | d\n'))).toBe(
      '| a | bb |\n|---|----|\nc  | d  \n',
    );
  });

  /**
   * **The one walk not clipped to the viewport.** A column width measured from
   * the visible rows alone changes as the table scrolls, and the columns would
   * shuffle -- so a range covering only the header must still produce the pads
   * for every row below it.
   */
  it('measures the whole table even when only part of it is visible', () => {
    const state = testState('|a|bb|\n|-|-|\n|cccc|d|\n');
    const clipped = padPositions(state, [{ from: 0, to: 6 }]);

    expect(clipped).toEqual(padPositions(state, [{ from: 0, to: state.doc.length }]));
    // Would be 1 (the header's own cell) if the walk stopped at the range.
    expect(clipped.length).toBe(4);
  });

  /** Two visible ranges either side of a fold must not pad the table twice. */
  it('pads a table entered from two ranges once', () => {
    const state = testState('|a|bb|\n|-|-|\n|cccc|d|\n');
    expect(
      padPositions(state, [
        { from: 0, to: 6 },
        { from: 12, to: state.doc.length },
      ]),
    ).toEqual(padPositions(state, [{ from: 0, to: state.doc.length }]));
    expect(padded(state)).toBe('|a   |bb|\n|----|--|\n|cccc|d |\n');
  });

  it('leaves a document with no table alone', () => {
    expect(padded(testState('just **text**\n'))).toBe('just **text**\n');
  });

  /**
   * Padding hides nothing, so unlike every other decoration here it does not
   * answer to the caret. The alternative would be a table that jumped out of
   * alignment the moment you clicked into it.
   */
  it('pads the line the caret is on, like every other', () => {
    expect(padded(testState('|a|bb|\n|-|-|\n|ccc|d|\n', 1))).toBe('|a  |bb|\n|---|--|\n|ccc|d |\n');
  });
});
