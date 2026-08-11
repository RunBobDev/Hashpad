// @vitest-environment jsdom
import { highlightTree, tags, type Tag } from '@lezer/highlight';
import { NodeProp, type Tree } from '@lezer/common';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { LanguageDescription, defaultHighlightStyle, ensureSyntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { blockquoteLines } from './blockquote';
import { markdownHighlightStyle, markdownSupport } from './highlight';
import { highlightTag } from './highlightmark';
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

/**
 * Position of `.cls`'s rule across the document's sheets, in order. Equal
 * specificity everywhere here, so this is what decides which rule paints.
 */
function sheetIndexOf(cls: string): number {
  let index = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if ((rule as CSSStyleRule).selectorText === `.${cls}`) return index;
      index++;
    }
  }
  return -1;
}

/** The `color` `.cls` declares, verbatim -- e.g. `var(--syn-marker)`. */
function declaredColourFor(cls: string): string | null {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const styleRule = rule as CSSStyleRule;
      if (styleRule.selectorText !== `.${cls}`) continue;
      return styleRule.style.getPropertyValue('color') || null;
    }
  }
  return null;
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
  /**
   * `'Highlight/...'` is an inherit-mode style spec, so every descendant of a
   * `Highlight` node carries `highlightTag` *as well as* whatever its own node
   * type resolves to. An `&amp;` or `\*` inside `==marked==` therefore matches
   * two of our rules at once, and equal specificity means the later one in the
   * sheet paints.
   *
   * That ordering is load-bearing and was got wrong once: appending the
   * marker-ish rules below `highlightTag` flipped such a span's foreground from
   * `--syn-highlight-fg` to `--syn-marker`, which variables.css records at
   * **2.27:1** on the highlight wash -- the exact failure `--syn-highlight-marker`
   * was minted to avoid. The suite was green.
   *
   * Both facts are asserted, because the ordering only matters if the
   * double-classing is real: the span must carry both classes, and
   * `highlightTag`'s must come later.
   */
  it('keeps the highlight wash winning over the marker rules that overlap it', () => {
    const view = mount('x ==AT&amp;T and \\*lit\\*== y');
    const washClass = classFor(highlightTag);

    for (const [text, tag] of [
      ['&amp;', tags.character],
      ['\\*', tags.escape],
    ] as const) {
      const span = Array.from(view.contentDOM.querySelectorAll('span')).find(
        (el) => el.textContent === text,
      );
      expect(span, `no span for ${text}`).toBeDefined();
      const classes = span!.className.split(' ');
      expect(classes).toContain(washClass);
      expect(classes).toContain(classFor(tag));

      expect(sheetIndexOf(washClass)).toBeGreaterThan(sheetIndexOf(classFor(tag)));
    }

    view.destroy();
  });

  it('gives a horizontal rule our own marker class rather than leaving it to defaultHighlightStyle', () => {
    const view = mount('Above.\n\n---\n\nBelow.');
    const separatorClass = classFor(tags.contentSeparator);

    const el = view.contentDOM.querySelector(`.${separatorClass}`);
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('---');

    view.destroy();
  });

  /**
   * `defaultHighlightStyle`'s `tags.heading` entry sets
   * `text-decoration: underline`. Ours sets size, weight and colour but said
   * nothing about decoration, and the two styles union *per property* rather
   * than compete -- so every heading in the editor was underlined, as was
   * every GFM table header cell and the `|` around it. Nobody reported it
   * because an underlined heading looks deliberate.
   *
   * Both shapes are checked because they take different routes:
   * `ATXHeading1` resolves to our `tags.heading1` rule (which must carry
   * `textDecoration` itself, since `style()` returns only the most specific
   * match), while a table header has no specific rule and falls to our
   * `tags.heading` one. Fixing only the general rule leaves headings
   * underlined and this test red -- verified.
   */
  it.each([
    // The heading's text span keeps the space after `#` -- only the `#`
    // itself is split off as a HeaderMark.
    ['an ATX heading', '# Head\n', ' Head'],
    ['a GFM table header cell', '| A | B |\n| --- | --- |\n| c | d |\n', ' A '],
  ])('does not let defaultHighlightStyle underline %s', (_label, doc, text) => {
    const view = mount(doc);

    const span = Array.from(view.contentDOM.querySelectorAll('span')).find(
      (el) => el.textContent === text,
    );
    expect(span).toBeDefined();
    expect(window.getComputedStyle(span!).textDecoration).toBe('none');

    view.destroy();
  });

  /**
   * The test above is not enough on its own, and the reason is the whole
   * mechanism: for a tag *both* styles have an opinion on, the `---` span
   * carries **both** classes. They are single-class selectors of equal
   * specificity, so which colour paints is decided purely by their order in
   * the stylesheet -- and a class-presence assertion holds identically either
   * way. Three tags are in this position: `contentSeparator`, `url`, and
   * `processingInstruction` (via `meta`), i.e. horizontal rules, link URLs,
   * and every marker character in source mode.
   *
   * What puts ours last is `EditorView.mountStyles` doing
   * `styleModules.concat(baseTheme).reverse()`, so the *first*
   * `syntaxHighlighting(...)` listed in `markdownSupport` is the one whose
   * rules land latest and win. Nothing in the source says so, and swapping
   * those two lines silently repaints every rule, URL and marker in the editor
   * to CodeMirror's built-in colours with the whole suite green. This is the
   * assertion that stops that.
   *
   * Order, not colour: jsdom resolves `var(--syn-marker)` to the empty string
   * with no stylesheet loaded, so a computed-colour assertion here would pass
   * whatever the rules said.
   */
  it('registers our style after defaultHighlightStyle, so our rules win the ties', () => {
    const view = mount('Above.\n\n---\n\nBelow.');

    for (const tag of [tags.contentSeparator, tags.url, tags.processingInstruction]) {
      const ours = classFor(tag);
      const theirs = defaultHighlightStyle.style([tag]);
      // If this ever goes null the tag stopped being contested and the
      // ordering no longer decides it -- which is a change worth noticing,
      // not a reason to skip the row.
      expect(theirs).not.toBeNull();
      expect(ours).not.toBe(theirs);

      const oursAt = sheetIndexOf(ours);
      const theirsAt = sheetIndexOf(theirs!);
      expect(oursAt).toBeGreaterThan(-1);
      expect(theirsAt).toBeGreaterThan(-1);
      expect(oursAt).toBeGreaterThan(theirsAt);
    }

    view.destroy();
  });
});

/**
 * SPEC §5.3 says variables.css is the only place colours are defined. The way
 * that gets broken is not by writing a literal into this file -- it is by
 * *omission*: `defaultHighlightStyle` is registered alongside ours to colour
 * fenced code, and any markdown tag we have no rule for silently falls to one
 * of its built-in colours instead. Those are tuned for a white page, so on
 * `--bg-editor` dark they land between 1.33:1 and 2.6:1.
 *
 * That is how horizontal rules shipped dark blue, and hunting the rest by hand
 * found six more. So this checks the invariant directly rather than naming the
 * constructs: **outside an embedded sub-language, `defaultHighlightStyle` may
 * not set any property we have not set ourselves.** A new grammar node, a new
 * GFM extension, or a dependency bump that adds a tag all fail here without
 * anyone remembering to look.
 *
 * *Properties*, not merely "did we colour this at all", and that distinction is
 * load-bearing. The two worst instances found so far were not colour gaps but
 * property unions on ranges we already coloured: `defaultHighlightStyle`'s
 * `tags.heading` rule underlining every heading, and its `tags.link` rule
 * underlining every inline link including the brackets. A presence check
 * reports both as clean.
 *
 * The exclusion is any range covered by a mounted sub-language, which is
 * exactly the set of places `defaultHighlightStyle` is registered *for*:
 * fenced-code contents, plus the HTML blocks and block comments `parseCode`
 * mounts. Keyed off `NodeProp.mounted` rather than the node name `CodeText`,
 * so it is the same predicate `@lezer/highlight` uses to decide the scope --
 * and so it covers the HTML case, which a `CodeText` check silently did not.
 */
describe('no markdown construct is left to defaultHighlightStyle', () => {
  const FIXTURE = [
    '# ATX heading',
    '',
    'Text with **bold**, *italic*, ~~struck~~, ==marked==, `code`,',
    'an entity &amp;, an escape \\*not italic\\*, an <https://auto.link>,',
    'a [link](http://x "inline title"), a [ref][label], an ![image](p.png),',
    'an inline <!-- comment --> and an inline <b>tag</b>.',
    '',
    '[label]: http://y "definition title"',
    '',
    '<!-- a block comment -->',
    '',
    '<div class="html-block">block</div>',
    '',
    '> quoted',
    '',
    '- bullet',
    '1. numbered',
    '- [ ] unchecked',
    '- [x] checked',
    '',
    '| Head A | Head B |',
    '| --- | --- |',
    '| a | b |',
    '',
    '---',
    '',
    '```js',
    'const s = 1;',
    '```',
    '',
    'Setext',
    '======',
    '',
  ].join('\n');

  /**
   * The CSS property names each generated class declares, read from the
   * stylesheet CodeMirror actually injected. `highlightTree` hands back class
   * names; this turns them back into the properties that decide the pixels.
   * Read from the live sheet rather than the `HighlightStyle` object, so the
   * comparison is against what ships rather than what the spec object says.
   */
  function propertiesByClass(): Map<string, Set<string>> {
    const byClass = new Map<string, Set<string>>();
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        const selector = (rule as CSSStyleRule).selectorText;
        // Single-class selectors only -- the shape `HighlightStyle` emits.
        // Anything more complex belongs to a theme, not to a token.
        if (!selector || !/^\.[^\s.,:>[]+$/.test(selector)) continue;
        byClass.set(selector.slice(1), new Set(Array.from((rule as CSSStyleRule).style)));
      }
    }
    return byClass;
  }

  /** Every CSS property `style` applies at each position of the document. */
  function propertiesByPosition(
    style: typeof defaultHighlightStyle,
    tree: Tree,
    length: number,
    byClass: Map<string, Set<string>>,
  ): Set<string>[] {
    const byPosition: Set<string>[] = Array.from({ length }, () => new Set<string>());
    highlightTree(tree, style, (from, to, classes) => {
      for (const cls of classes.split(' ')) {
        for (const property of byClass.get(cls) ?? []) {
          for (let pos = from; pos < to; pos++) byPosition[pos]!.add(property);
        }
      }
    });
    return byPosition;
  }

  it('sets every property CodeMirror would, outside embedded sub-languages', () => {
    // Mounted rather than a bare state: injecting the stylesheet is what makes
    // the per-class property lookup possible at all.
    const view = mount(FIXTURE);
    const state = view.state;
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(tree).not.toBeNull();
    expect(tree!.length).toBe(state.doc.length);

    const length = state.doc.length;
    const byClass = propertiesByClass();
    // Guard: an unreadable sheet would leave this empty and make every
    // comparison below vacuously clean.
    expect(byClass.size).toBeGreaterThan(0);
    const ours = propertiesByPosition(markdownHighlightStyle, tree!, length, byClass);
    const theirs = propertiesByPosition(defaultHighlightStyle, tree!, length, byClass);

    // Wherever another language is mounted, defaultHighlightStyle is the one
    // doing the work on purpose. Same predicate @lezer/highlight scopes by.
    const embedded = new Uint8Array(length);
    tree!.iterate({
      enter: (node) => {
        if (node.node.tree?.prop(NodeProp.mounted)) embedded.fill(1, node.from, node.to);
      },
    });
    // Guard: the fixture must actually contain embedded regions, or this
    // exclusion is silently doing nothing and the test is weaker than it looks.
    expect(embedded.includes(1)).toBe(true);

    // Reported as offending text plus the property, so a failure names the
    // construct and what leaked without anyone re-deriving it.
    const leaked = new Set<string>();
    for (let pos = 0; pos < length; pos++) {
      if (embedded[pos]) continue;
      for (const property of theirs[pos]!) {
        if (ours[pos]!.has(property)) continue;
        const line = state.doc.lineAt(pos);
        leaked.add(`${property} on ${JSON.stringify(line.text.trim().slice(0, 40))}`);
      }
    }

    expect([...leaked]).toEqual([]);
    view.destroy();
  });

  /**
   * The rules above pick a *token* per construct, and the leak check cannot
   * see which one -- `--syn-marker` and `--syn-link` are both "we styled it".
   *
   * Asserted as the custom property that ends up winning the cascade, not as a
   * class. A first attempt compared the span's classes against
   * `markdownHighlightStyle.style([tag])` and could not fail: `style()` falls
   * back to the nearest ancestor tag's rule, so deleting the rule under test
   * just moved the *expected* class too. `tags.character` is the sharp case --
   * it descends from `tags.string`, so dropping its rule leaves `&amp;` styled,
   * merely link-coloured instead of marker-coloured. Reading the declared value
   * breaks that circularity: the expectation is a literal token name, written
   * out, that the implementation cannot move.
   *
   * jsdom keeps `var(--syn-marker)` verbatim in `cssRules` (checked), so this
   * compares tokens rather than resolved colours -- which is all that is
   * available here, and is the thing actually being chosen.
   */
  it.each([
    ['a fence info string', '```js\nx\n```\n', 'js', 'var(--syn-marker)'],
    ['a reference label', '[label]: http://y\n', '[label]', 'var(--syn-marker)'],
    ['a task marker', '- [x] done\n', '[x]', 'var(--syn-marker)'],
    ['an entity', 'an &amp; here\n', '&amp;', 'var(--syn-marker)'],
    ['an escape', 'an \\*escape\\* here\n', '\\*', 'var(--syn-marker)'],
    ['an inline comment', 'text <!-- c --> more\n', '<!-- c -->', 'var(--syn-marker)'],
    ['a reference title', '[label]: http://y "the title"\n', '"the title"', 'var(--syn-link)'],
  ])('paints %s with %s', (_label, doc, text, expected) => {
    const view = mount(doc);

    const span = Array.from(view.contentDOM.querySelectorAll('span')).find(
      (el) => el.textContent === text,
    );
    expect(span, `no span rendered for ${JSON.stringify(text)}`).toBeDefined();

    // The colour that actually paints: among the span's classes, the one whose
    // rule sits latest in the sheet and declares a colour.
    let winningIndex = -1;
    let painted: string | null = null;
    for (const cls of span!.className.split(' ')) {
      const declared = declaredColourFor(cls);
      if (!declared) continue;
      const index = sheetIndexOf(cls);
      if (index > winningIndex) {
        winningIndex = index;
        painted = declared;
      }
    }

    expect(painted).toBe(expected);

    view.destroy();
  });

  /**
   * The other direction, and the reason `markdownHighlightStyle` carries
   * `scope: markdownLanguage`. Several rules above name generic tags --
   * `string`, `atom`, `labelName`, `escape` -- that every nested code grammar
   * emits too, and ours is registered to win the ties. Unscoped, the rule that
   * makes a link title `--syn-link` would repaint every string literal inside
   * every fenced block. Removing the scope leaves the test above green and
   * fails this one.
   */
  it('does not reach inside a fenced block, where defaultHighlightStyle does the work', async () => {
    const js = LanguageDescription.matchLanguageName(MARKDOWN_CODE_LANGUAGES, 'javascript', true);
    expect(js).not.toBeNull();
    await js!.load();

    const doc = 'A [ref]: http://y "title"\n\n```javascript\nconst s = \'str\';\n```\n';
    const state = EditorState.create({ doc, extensions: markdownSupport() });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(tree).not.toBeNull();

    const stringStart = doc.indexOf("'str'");
    let classesOnCodeString: string | null = null;
    highlightTree(tree!, [markdownHighlightStyle, defaultHighlightStyle], (from, to, classes) => {
      if (from === stringStart && doc.slice(from, to) === "'str'") classesOnCodeString = classes;
    });

    expect(classesOnCodeString).not.toBeNull();
    // Split rather than substring-matched: CM6 mints class names from one
    // counter (`ͼ5`..`ͼz`, then `ͼ10`..), so `ͼ1` is a substring of `ͼ18` and
    // `toContain` on the raw string would start lying as the counter grows.
    const classList = (classesOnCodeString as unknown as string).split(' ');
    expect(classList).toContain(defaultHighlightStyle.style([tags.string]));
    expect(classList).not.toContain(markdownHighlightStyle.style([tags.string]));
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
