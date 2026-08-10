// @vitest-environment jsdom
import { tags, type Tag } from '@lezer/highlight';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LanguageDescription } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { blockquoteLines } from './blockquote';
import { markdownHighlightStyle, markdownSupport } from './highlight';
import { MARKDOWN_CODE_LANGUAGES } from './languages';

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

  /**
   * A horizontal rule is `tags.contentSeparator`, not `processingInstruction`,
   * so it needs its own entry -- and a tag this style has no opinion on does
   * not fall through to the document's foreground: `defaultHighlightStyle` is
   * registered alongside us (see `markdownSupport`) and claims
   * `contentSeparator` with a hard-coded `#219`. That shipped, and rendered
   * every `---` dark blue in both themes -- 1.34:1 against the dark editor
   * background, i.e. invisible.
   *
   * Asserted as "our class is present", the same way every test above does it,
   * rather than as a computed colour: jsdom resolves `var(--syn-marker)` to
   * the empty string with no stylesheet loaded, so a colour assertion here
   * would pass whatever the rule said.
   */
  it('gives a horizontal rule our own marker class rather than leaving it to defaultHighlightStyle', () => {
    const view = mount('Above.\n\n---\n\nBelow.');
    const separatorClass = classFor(tags.contentSeparator);

    const el = view.contentDOM.querySelector(`.${separatorClass}`);
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('---');

    view.destroy();
  });
});

describe('fenced code block highlighting (task 5)', () => {
  it('keeps the fence markers visible and marker-styled on a fenced block that names a language', () => {
    // No load() awaited here on purpose: marker rendering is provided by the
    // *outer* markdown grammar's own CodeMark node (see highlight.ts's module
    // comment), not by whichever nested grammar the info string selects, so
    // it must not depend on that grammar having finished loading.
    const view = mount('```python\ndef f():\n    pass\n```');
    const markerClass = classFor(tags.processingInstruction);

    const markers = view.contentDOM.querySelectorAll(`.${markerClass}`);
    // One CodeMark for the opening fence, one for the closing fence.
    expect(markers.length).toBe(2);
    for (const marker of markers) expect(marker.textContent).toBe('```');

    view.destroy();
  });

  /**
   * `codeLanguages` resolves a fenced block's info string to a
   * `LanguageDescription` that lazily `import()`s its grammar (see
   * languages.ts) -- CodeMirror's own async-reparse-on-load scheduling means
   * a document mounted the instant a *new* language is first requested can
   * legitimately render one frame of plain text before that import settles.
   * Awaiting `load()` up front replicates the steady state of an actual
   * editing session (the grammar already loaded, whether from this document
   * or an earlier one) without asserting anything about that scheduling
   * timing itself, which belongs to CodeMirror internals, not this task.
   */
  it('colours fenced code content with the loaded grammar, distinctly from the fence markers', async () => {
    const found = LanguageDescription.matchLanguageName(MARKDOWN_CODE_LANGUAGES, 'python', true);
    expect(found).not.toBeNull();
    await found!.load();

    const view = mount('```python\ndef f():\n    pass\n```');
    const markerClass = classFor(tags.processingInstruction);

    const codeLine = Array.from(view.contentDOM.querySelectorAll('.cm-line')).find((line) =>
      line.textContent?.includes('def'),
    );
    expect(codeLine).toBeDefined();

    // The Python grammar's own `def` keyword must land in some highlighted
    // span -- i.e. not just bare text, the way it rendered before this task
    // (verified directly: without `codeLanguages`, this same line is plain
    // text with zero child spans) -- and that span must carry a different
    // class than the fence markers, since `def` is a `keyword`
    // (`defaultHighlightStyle`'s fallback), not a `CodeMark`
    // (`markdownHighlightStyle`'s `processingInstruction`).
    const spans = codeLine!.querySelectorAll('span');
    expect(spans.length).toBeGreaterThan(0);
    const keywordSpan = Array.from(spans).find((s) => s.textContent === 'def');
    expect(keywordSpan).toBeDefined();
    expect(keywordSpan!.className).not.toBe(markerClass);

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
