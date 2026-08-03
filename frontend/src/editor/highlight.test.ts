// @vitest-environment jsdom
import { tags, type Tag } from '@lezer/highlight';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { blockquoteLines } from './blockquote';
import { markdownHighlightStyle, markdownSupport } from './highlight';

/**
 * `HighlightStyle` and the blockquote `ViewPlugin` both need a real
 * `EditorView` to produce anything -- there's no tree, no decoration, no DOM
 * without one. CodeMirror constructs fine under jsdom (established in
 * Checkpoint B's extensions.test.ts), so this mounts a real view rather than
 * asserting only that the right tags were passed to `HighlightStyle.define`.
 */
function mount(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [markdownSupport(), blockquoteLines] }),
    parent: document.createElement('div'),
  });
}

/**
 * `HighlightStyle.style([tag])` returns the exact CSS class(es) our style
 * assigns to a tag -- using it here means these tests check the DOM for the
 * class `markdownHighlightStyle` actually emits, not a guessed-at generated
 * name (CM6 mints these per-`HighlightStyle` instance, e.g. `"͸o"`, so
 * hard-coding one would be both unreadable and liable to shift the moment
 * the style's tag list changes).
 */
function classFor(tag: Tag): string {
  const cls = markdownHighlightStyle.style([tag]);
  expect(cls).not.toBeNull();
  return cls as string;
}

describe('markdownHighlightStyle', () => {
  it('gives a # heading line an element carrying the heading1 style class', () => {
    const view = mount('# Heading');
    const headingClass = classFor(tags.heading1);

    expect(view.contentDOM.querySelector(`.${headingClass}`)).not.toBeNull();

    view.destroy();
  });

  it('renders **bold** as a bold-styled span while keeping the ** markers in the text', () => {
    const view = mount('**bold**');
    const strongClass = classFor(tags.strong);

    expect(view.contentDOM.querySelector(`.${strongClass}`)).not.toBeNull();
    // The defining property of source mode (see highlight.ts's module
    // comment): styling a marker is not the same as removing it. If this
    // regresses to hiding `**`, live preview (Phase 2) has nothing left to
    // reveal contextually -- source mode would already be gone.
    expect(view.contentDOM.textContent).toContain('**');

    view.destroy();
  });

  it('keeps marker characters styled but present, never hidden, via tags.processingInstruction', () => {
    const view = mount('# Heading');
    const markerClass = classFor(tags.processingInstruction);

    const markerEl = view.contentDOM.querySelector(`.${markerClass}`);
    expect(markerEl).not.toBeNull();
    expect(markerEl!.textContent).toBe('#');
    // Recessive, not invisible -- display/visibility are never touched by
    // markdownHighlightStyle, only colour.
    const computed = window.getComputedStyle(markerEl as Element);
    expect(computed.display).not.toBe('none');
    expect(computed.visibility).not.toBe('hidden');

    view.destroy();
  });
});

describe('blockquoteLines', () => {
  it('gives a > quoted line the .cm-blockquote line class', () => {
    const view = mount('> quoted');

    const line = view.contentDOM.querySelector('.cm-line');
    expect(line).not.toBeNull();
    expect(line!.classList.contains('cm-blockquote')).toBe(true);

    view.destroy();
  });

  /**
   * The test that matters most (per the task brief): prove the decoration
   * set stays bounded by the visible viewport in a document far longer than
   * it, rather than growing with the document itself.
   *
   * Whether this is meaningful under jsdom is not obvious up front --
   * jsdom reports 0 for every layout measurement (getBoundingClientRect,
   * clientHeight, ...), so there was a real risk CodeMirror would fall back
   * to "can't measure a viewport, so treat the whole document as visible",
   * which would make this test pass on a broken (whole-document)
   * implementation just as easily as a correct one. Checked empirically before writing this
   * assertion: on a 5,000-line document, `view.visibleRanges` under jsdom
   * still comes back as one small range (not the whole doc), so CodeMirror's
   * own fallback estimate is bounded even without real measurements. That
   * means this test can and does exercise the real mechanism -- it does not
   * merely assert against a hand-picked small number.
   *
   * The assertion is built two ways from the same visibleRanges the plugin
   * itself reads, rather than a hard-coded expected count:
   *   1. decoration count equals the number of *distinct visible lines* --
   *      this fails (decorations would balloon to ~documentLineCount) if
   *      `blockquoteDecorations` (blockquote.ts) ever regressed to walking
   *      `syntaxTree(state).iterate({})` over the whole document instead of
   *      the passed-in ranges.
   *   2. that count is far below the document's line count -- the actual
   *      "no perceptible lag in a 5,000-line document" property SPEC §6.6
   *      asks for.
   */
  it('decorates only the visible viewport in a document far longer than it', () => {
    const lineCount = 5000;
    // Every line is inside one large Blockquote node (CommonMark treats
    // consecutive `>` lines with no blank line between them as a single
    // blockquote), so this also exercises the clipping logic in
    // blockquoteDecorations: a node whose own range spans the entire
    // document must still only contribute decorations for the slice that
    // overlaps the visible range.
    const doc = Array.from({ length: lineCount }, (_, i) => `> quoted line ${i}`).join('\n');
    const view = mount(doc);

    const plugin = view.plugin(blockquoteLines);
    expect(plugin).not.toBeNull();

    const visibleLines = new Set<number>();
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; pos = view.state.doc.lineAt(pos).to + 1) {
        visibleLines.add(view.state.doc.lineAt(pos).number);
      }
    }

    expect(plugin!.decorations.size).toBe(visibleLines.size);
    expect(plugin!.decorations.size).toBeLessThan(lineCount / 10);

    view.destroy();
  });
});
