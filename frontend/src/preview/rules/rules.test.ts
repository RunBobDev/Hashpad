// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../render';
import { ASSET_ROUTE } from './images';
import { MATH_DISPLAY_CLASS, MATH_INLINE_CLASS } from './math';
import { DIAGRAM_CLASS } from './mermaid';

function render(markdown: string, documentDir: string | null = 'C:\\docs') {
  const html = renderMarkdown(markdown, { documentDir });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // The source lines actually present in the *sanitised* output. `renderMarkdown`
  // used to hand this back, computed by its own `anchorsIn` pass; nothing in the
  // app read it, so it went. Derived here from the document this helper already
  // parses, which costs nothing extra.
  //
  // Read back out of the finished HTML rather than from what the source-line
  // rule stamped, because those are not the same list: a comment is removed
  // entirely (SPEC §6.8's annotation mechanism, so routine rather than an edge
  // case), markdown-it's `html_block` renderer emits `token.content` verbatim
  // and drops the attribute, and DOMPurify strips `<style>`/`<script>` outright.
  const anchors = [
    ...new Set(
      [...doc.querySelectorAll('[data-source-line]')]
        .map((element) => Number(element.getAttribute('data-source-line')))
        .filter((line) => Number.isInteger(line) && line > 0),
    ),
  ].sort((a, b) => a - b);
  return { html, doc, anchors };
}

/** The query half of an asset URL, parsed the way Go's `r.URL.Query()` parses it. */
function assetParams(src: string): URLSearchParams {
  return new URLSearchParams(src.slice(src.indexOf('?') + 1));
}

describe('the cross-task and ordering contracts', () => {
  /**
   * The literal route, not the constant.
   *
   * Every other assertion in this file interpolates `ASSET_ROUTE`, which makes
   * them tautological about its value — changing it to `/WRONG/route` left the
   * whole suite green. Task 4's Go handler serves this exact path, and a
   * rename that compiles on both sides is how a cross-language contract breaks
   * silently.
   */
  it('serves images from the path Task 4 implements', () => {
    expect(ASSET_ROUTE).toBe('/__hashpad/asset');
  });

  /**
   * Percent-encoded exactly once.
   *
   * markdown-it's `normalizeLink` has already encoded the src before the image
   * rule sees it, so a second `encodeURIComponent` escapes the `%` itself and
   * the handler receives `assets/caf%C3%A9.png` as a literal filename — every
   * image in a document with a non-ASCII or spaced name 404s. Asserted on what
   * Go's `r.URL.Query().Get("path")` will actually yield, which is the thing
   * that has to be right.
   */
  it.each([
    ['an accented filename', '![a](assets/café.png)\n', 'assets/café.png'],
    ['a spaced filename', '![a](<assets/my pic.png>)\n', 'assets/my pic.png'],
    ['a plain filename', '![a](assets/pic.png)\n', 'assets/pic.png'],
  ])('encodes %s once, not twice', (_label, markdown, expected) => {
    const { doc } = render(markdown);
    const src = doc.querySelector('img')!.getAttribute('src')!;
    expect(assetParams(src).get('path')).toBe(expected);
  });

  /**
   * The sort in `sourceline.ts` is load-bearing, not decorative:
   * markdown-it-footnote moves a definition's tokens to the end of the stream,
   * so a document whose definition sits above its reference emits lines out of
   * order. Removing the sort survives every other test here.
   */
  it('returns anchors ascending even when footnotes reorder the token stream', () => {
    const { anchors } = render('Para A.\n\n[^1]: body\n\nPara B.[^1]\n');
    expect(anchors.length).toBeGreaterThan(1);
    expect(anchors).toEqual([...anchors].sort((a, b) => a - b));
  });

  /**
   * Every anchor must have an element behind it. Task 6 looks each one up with
   * `querySelector('[data-source-line="N"]')`, so a line with nothing behind
   * it is a `null` at the moment scroll sync needs a position. Three things
   * drop marks after the rule sets them: HTML comments (SPEC §6.8 removes
   * them), `html_block` (whose renderer emits raw content and discards the
   * attribute), and DOMPurify's FORBID_TAGS.
   */
  it('lists only lines that have a surviving element', () => {
    const { doc, anchors } = render(
      ['# One', '', '<!-- a comment -->', '', '<div>raw block</div>', '', 'Para.', ''].join('\n'),
    );
    const present = [...doc.querySelectorAll('[data-source-line]')].map((el) =>
      Number(el.getAttribute('data-source-line')),
    );
    expect(anchors).toEqual([...new Set(present)].sort((a, b) => a - b));
  });
});

describe('the marks each rule leaves for later tasks', () => {
  it('gives the front-matter card a source line, like every other block', () => {
    const { doc } = render('---\ntitle: A\n---\n\nBody\n');
    expect(doc.querySelector('.preview-frontmatter')?.getAttribute('data-source-line')).toBe('1');
  });

  // preview.css (Task 8) hangs `list-style: none` off this.
  it('marks a task item so the stylesheet can drop its bullet', () => {
    const { doc } = render('- [ ] todo\n');
    expect(doc.querySelector('li')?.classList.contains('preview-task-item')).toBe(true);
  });

  it('gives the image placeholder an accessible name carrying the author alt', () => {
    const { doc } = render('![the diagram](https://example.com/p.png)\n');
    const placeholder = doc.querySelector('.preview-image-placeholder')!;
    expect(placeholder.getAttribute('role')).toBe('img');
    expect(placeholder.getAttribute('aria-label')).toContain('the diagram');
  });
});

describe('front matter', () => {
  // `startLine === 0` means line 0 of the current tokenize pass, and
  // markdown-it re-enters at 0 for a blockquote's contents.
  it('leaves a --- pair inside a blockquote alone', () => {
    const { doc } = render('> ---\n> title: Secret\n> ---\n>\n> quoted\n');
    expect(doc.querySelector('.preview-frontmatter')).toBeNull();
    expect(doc.querySelector('blockquote')).not.toBeNull();
  });

  // Four spaces makes it an indented code block in CommonMark, and the rule's
  // own `.trim()` would otherwise discard the indent that says so.
  it('leaves an indented --- pair as code', () => {
    const { doc } = render('    ---\n    title: X\n    ---\n');
    expect(doc.querySelector('.preview-frontmatter')).toBeNull();
    expect(doc.querySelector('pre code')).not.toBeNull();
  });

  it('renders a metadata card rather than hiding the block', () => {
    const { doc } = render('---\ntitle: A Post\ndate: 2026-01-01\n---\n\nBody\n');
    const card = doc.querySelector('.preview-frontmatter');
    expect(card).not.toBeNull();
    const keys = Array.from(card!.querySelectorAll('dt')).map((el) => el.textContent);
    const values = Array.from(card!.querySelectorAll('dd')).map((el) => el.textContent);
    expect(keys).toEqual(['title', 'date']);
    expect(values).toEqual(['A Post', '2026-01-01']);
    expect(doc.querySelector('p')?.textContent).toBe('Body');
  });

  it('shows a line with no colon as its raw text', () => {
    const { doc } = render('---\njust a line\n---\n\nBody\n');
    const card = doc.querySelector('.preview-frontmatter');
    expect(card?.querySelector('dt')).toBeNull();
    expect(card?.textContent).toContain('just a line');
  });

  it('leaves a --- that is not at line 1 as a horizontal rule', () => {
    const { doc } = render('Text\n\n---\n\nMore\n');
    expect(doc.querySelector('.preview-frontmatter')).toBeNull();
    expect(doc.querySelector('hr')).not.toBeNull();
  });

  // The row above has no second `---`, so the front-matter rule already
  // returns false at its "did I find a closing fence" check regardless of
  // the startLine guard -- it doesn't actually exercise the guard.
  // A document with a real fence *pair* elsewhere is what proves the guard
  // matters: without it, this would render as a front-matter card instead
  // of the horizontal rule + setext-heading pair CommonMark gives it.
  it('leaves a fenced --- pair that starts past line 1 alone', () => {
    const { doc } = render('Text\n\n---\ntitle: X\n---\n\nMore\n');
    expect(doc.querySelector('.preview-frontmatter')).toBeNull();
    expect(doc.querySelector('hr')).not.toBeNull();
    expect(doc.querySelector('h2')?.textContent).toBe('title: X');
  });
});

describe('task lists', () => {
  it('renders disabled checkboxes and drops the literal marker', () => {
    const { doc } = render('- [ ] todo\n- [x] done\n');
    const boxes = doc.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    for (const box of boxes) expect(box.hasAttribute('disabled')).toBe(true);
    // The `[ ]` must not survive as text beside the rendered control.
    expect(doc.body.textContent).not.toContain('[ ]');
    expect(doc.body.textContent).not.toContain('[x]');
    expect(doc.body.textContent).toContain('todo');
  });

  it('leaves an ordinary bullet alone', () => {
    const { doc } = render('- plain\n');
    expect(doc.querySelector('input')).toBeNull();
    expect(doc.querySelector('li')?.textContent?.trim()).toBe('plain');
  });
});

describe('images', () => {
  it('rewrites a relative path to the asset route', () => {
    const { doc } = render('![alt](assets/pic.png)\n');
    const img = doc.querySelector('img');
    expect(img?.getAttribute('src')).toBe(`${ASSET_ROUTE}?dir=C%3A%5Cdocs&path=assets%2Fpic.png`);
    expect(img?.getAttribute('alt')).toBe('alt');
  });

  /**
   * Two documents in different folders naming the same file must not share a
   * URL. When the directory lived in Go and the URL was just the filename they
   * did, and the webview cache could then hand one document the other's image
   * for the rest of the session.
   */
  it('gives the same filename in two folders two different URLs', () => {
    const here = render('![a](pic.png)\n', 'C:\\one').doc.querySelector('img')!.getAttribute('src');
    const there = render('![a](pic.png)\n', 'C:\\two')
      .doc.querySelector('img')!
      .getAttribute('src');
    expect(here).not.toBe(there);
  });

  /**
   * The `src` is the only attacker-controlled input on this path, and the
   * directory now rides in the same query string — so a document could try to
   * pick its own. It cannot: `encodeURIComponent` escapes `&` and `=`, so the
   * whole hostile string lands inside `path` as one value and `dir` stays the
   * real folder. The Go half (that what arrives is then refused) is
   * TestAssetHandlerRejectsAnInjectedDirectory in internal/app/assets_test.go.
   */
  it('cannot have its dir overridden by a hostile src', () => {
    // A *second* `dir` key is the only shape that could win -- Go's
    // `Query().Get` takes the first value of a repeated key, so appending to
    // `path` achieves nothing. Dropping the `encodeURIComponent` around the
    // path makes this exact assertion report
    // `[ 'C:\docs', 'C:\Windows' ]`; with it, `&` and `=` are escaped and the
    // whole string stays one `path` value.
    const attack = 'foo.png&dir=C:' + String.fromCharCode(92) + 'Windows&path=win.ini';
    const { doc } = render(`![x](<${attack}>)\n`);

    const params = assetParams(doc.querySelector('img')!.getAttribute('src')!);
    expect(params.getAll('dir')).toEqual(['C:\\docs']);
    expect(params.getAll('path')).toEqual([attack]);
  });

  it('replaces a remote image with a placeholder showing its URL', () => {
    const { doc } = render('![alt](https://example.com/p.png)\n');
    expect(doc.querySelector('img')).toBeNull();
    const placeholder = doc.querySelector('.preview-image-placeholder');
    expect(placeholder?.textContent).toContain('https://example.com/p.png');
  });

  it('replaces a relative image with a placeholder when the document is unsaved', () => {
    const { doc } = render('![alt](assets/pic.png)\n', null);
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('.preview-image-placeholder')?.textContent).toContain('save');
  });

  it('passes a data: image through untouched', () => {
    const src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    const { doc } = render(`![alt](${src})\n`);
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(src);
  });
});

describe('source-line anchors', () => {
  it('tags every block with its 1-based start line', () => {
    const markdown = ['# One', '', 'Para two.', '', '```js', 'code', '```', ''].join('\n');
    const { doc, anchors } = render(markdown);
    const tagged = Array.from(doc.querySelectorAll('[data-source-line]')).map((el) => [
      el.tagName.toLowerCase(),
      el.getAttribute('data-source-line'),
    ]);
    expect(tagged).toContainEqual(['h1', '1']);
    expect(tagged).toContainEqual(['p', '3']);
    // A fenced block anchors to its *opening* fence, line 5. The attribute
    // lands on <code>, not <pre>: markdown-it@15's default `fence` rule
    // (dist/markdown-it.mjs, `default_rules.fence`) renders the fence
    // token's own attributes -- ours included -- onto the inner <code>
    // element (`<pre><code${slf.renderAttrs(token)}>...`), not the outer
    // <pre>. Verified against the installed package; the original brief
    // assumed <pre>.
    expect(tagged).toContainEqual(['code', '5']);
    expect(anchors).toEqual([1, 3, 5]);
  });

  it('returns anchors ascending and unique', () => {
    const { anchors } = render('# A\n\n# B\n\n# C\n');
    expect(anchors).toEqual([1, 3, 5]);
    expect([...anchors].sort((a, b) => a - b)).toEqual(anchors);
  });
});

/* ---- L.1: math placeholders -------------------------------------------- */

/**
 * The parser's half of SPEC §7.2. Nothing here is typeset -- `rules/math.ts`
 * only finds math and marks it, and `preview/math.test.ts` covers what fills
 * the marks in.
 *
 * **These run through `renderMarkdown`, so every case is also a claim that the
 * placeholder survives DOMPurify.** That is the whole reason for the
 * placeholder, and asserting it against the raw renderer would prove the
 * opposite of what is needed.
 */
describe('math', () => {
  /** The placeholders in document order, as `[class, expression]`. */
  function maths(markdown: string): [string, string][] {
    const { doc } = render(markdown);
    return [...doc.querySelectorAll(`.${MATH_INLINE_CLASS}, .${MATH_DISPLAY_CLASS}`)].map(
      (element) => [element.className, element.textContent ?? ''],
    );
  }

  it('marks inline math and keeps the expression as text', () => {
    expect(maths('Einstein said $E = mc^2$ once.')).toEqual([[MATH_INLINE_CLASS, 'E = mc^2']]);
  });

  it('marks a display block', () => {
    expect(maths('before\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\nafter')).toEqual([
      [MATH_DISPLAY_CLASS, '\\sum_{i=1}^{n} i'],
    ]);
  });

  it('marks a one-line display block', () => {
    expect(maths('$$ x = 1 $$')).toEqual([[MATH_DISPLAY_CLASS, 'x = 1']]);
  });

  /**
   * `$$x$$` inside a sentence keeps the display *size* but not the block
   * layout: a `<div>` inside a `<p>` is invalid HTML and the browser closes the
   * paragraph around it, splitting the sentence in two.
   */
  it('keeps inline display math inside its paragraph', () => {
    const { doc } = render('text $$x$$ more');
    const element = doc.querySelector(`.${MATH_DISPLAY_CLASS}`)!;
    expect(element.tagName).toBe('SPAN');
    expect(element.closest('p')).not.toBeNull();
  });

  /**
   * **The case this rule exists to get right.** Two prices in a sentence are
   * two dollar signs with text between them, which is a perfectly good math
   * span as far as the delimiters go. The guard is that a closing `$` may not
   * be followed by a digit.
   */
  it('leaves prices alone', () => {
    expect(maths('I paid $5 and $10 for it.')).toEqual([]);
    expect(maths('It costs $20.')).toEqual([]);
  });

  /**
   * **The case the digit guard is actually for**, and it is not the one above.
   *
   * `$5 and $10` is already rejected by the *whitespace* rule -- the closing `$`
   * has a space in front of it -- so removing the digit guard leaves that test
   * green, which is what the mutation run showed. Here the second `$` is tight
   * against a word, so whitespace says nothing and only "a closing delimiter is
   * not followed by a digit" rejects it.
   */
  it('leaves a price that is tight against a word alone', () => {
    expect(maths('was $5 but now costs$10 more')).toEqual([]);
  });

  it('needs the opening delimiter tight against the expression', () => {
    expect(maths('a $ x$ b')).toEqual([]);
    expect(maths('a $x $ b')).toEqual([]);
  });

  it('honours a backslash escape', () => {
    expect(maths('\\$5 and \\$10')).toEqual([]);
  });

  /**
   * `\\` is an escaped *backslash*, so the `$` after it is live. Counting the
   * run rather than looking at one character is what gets this right; without
   * it, math silently stops working after any line ending in a backslash.
   */
  it('counts the backslash run rather than looking at one', () => {
    expect(maths('a \\\\$x$ b')).toEqual([[MATH_INLINE_CLASS, 'x']]);
  });

  it('does not match a lone dollar', () => {
    expect(maths('a $ b')).toEqual([]);
  });

  /**
   * An unterminated `$$` is what a display equation looks like for the whole
   * time you are typing it. Claiming it would swallow the rest of the document
   * on every keystroke until the closing pair arrived.
   */
  it('leaves an unterminated display block as text', () => {
    expect(maths('$$\n\\sum x\n\nmore text\n')).toEqual([]);
  });

  /**
   * **The case the short fixtures above could not show.** An unterminated `$$`
   * does not just fail to close -- it goes looking for the next `$$` anywhere in
   * the document, and in a document that already contains equations it finds
   * one. Everything in between becomes a single display block.
   *
   * Found by writing a nine-section demonstration file and discovering that one
   * stray `$$` in section 2 had eaten seven diagrams, eight code fences and six
   * headings on its way to section 8. The test above passes because its document
   * has no later `$$` to find; this is the same case with a document shaped like
   * a real one.
   */
  it('stops an unterminated block at the blank line, not at the next equation', () => {
    const doc = [
      '$$',
      'x = 1',
      '',
      '## A heading that must survive',
      '',
      '```js',
      'const survives = true;',
      '```',
      '',
      '$$',
      'y = 2',
      '$$',
      '',
    ].join('\n');
    const { doc: rendered } = render(doc);

    // The stray `$$` claimed nothing.
    expect(maths(doc)).toEqual([[MATH_DISPLAY_CLASS, 'y = 2']]);
    // And everything it used to swallow is still here.
    expect(rendered.querySelector('h2')?.textContent).toBe('A heading that must survive');
    expect(rendered.querySelector('pre > code')?.textContent).toContain('const survives = true;');
  });

  /** A legitimate multi-line block is unaffected -- it has no blank line in it. */
  it('still claims a well-formed multi-line block', () => {
    expect(maths('$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$')).toEqual([
      [MATH_DISPLAY_CLASS, '\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}'],
    ]);
  });

  /**
   * A `$$` open is never closed by a single `$`.
   *
   * What happens to `$$x$ y` instead is worth pinning rather than glossing:
   * the `$$` span fails, markdown-it moves on one character, and the *second*
   * dollar opens a perfectly ordinary `$x$`. So the leading `$` is literal text
   * and `x` is inline math -- **not** display math, which is the half that
   * matters. Pinned as the real behaviour because it is what someone sees
   * halfway through typing a display equation.
   */
  it('does not let a single dollar close a double', () => {
    expect(maths('$$x$ y')).toEqual([[MATH_INLINE_CLASS, 'x']]);
    expect(render('$$x$ y').doc.querySelector(`.${MATH_DISPLAY_CLASS}`)).toBeNull();
    expect(render('$$x$ y').doc.querySelector('p')?.textContent).toBe('$x y');
  });

  /**
   * Inline rules never run inside a code span or a fence, so this needs no
   * guard of its own -- but a future change to rule ordering could break it
   * invisibly, and `$` in a shell snippet is extremely common.
   */
  it('leaves math delimiters alone inside code', () => {
    expect(maths('`$PATH$` and a fence')).toEqual([]);
    expect(maths('```sh\necho $HOME$\n```')).toEqual([]);
  });

  /**
   * The expression goes in as text, which markdown-it escapes -- so `<` cannot
   * become a tag, and DOMPurify has nothing to strip. Reading it back with
   * `textContent` returns the original, which is what `preview/math.ts` does.
   */
  it('escapes an expression that looks like markup', () => {
    expect(maths('$a < b$')).toEqual([[MATH_INLINE_CLASS, 'a < b']]);
    expect(maths('$x <script>y</script>$')).toEqual([[MATH_INLINE_CLASS, 'x <script>y</script>']]);
  });

  it('leaves the rest of the sentence intact', () => {
    const { doc } = render('before $x$ after');
    expect(doc.querySelector('p')?.textContent).toBe('before x after');
  });
});

/* ---- L.2: diagram placeholders ----------------------------------------- */

/**
 * The parser's half of Mermaid support. Nothing here draws -- `rules/mermaid.ts`
 * only marks the fence and holds its source, and `preview/diagrams.test.ts`
 * covers what fills the mark in.
 *
 * Run through `renderMarkdown`, so every case is also a claim that the
 * placeholder survives DOMPurify.
 */
describe('mermaid fences', () => {
  const FENCE = '```';

  function diagrams(markdown: string): string[] {
    return [...render(markdown).doc.querySelectorAll(`.${DIAGRAM_CLASS}`)].map(
      (element) => element.textContent ?? '',
    );
  }

  it('turns a mermaid fence into a placeholder holding its source', () => {
    expect(diagrams(`${FENCE}mermaid\ngraph TD;\n  A-->B;\n${FENCE}`)).toEqual([
      'graph TD;\n  A-->B;\n',
    ]);
  });

  /**
   * **The reason this wraps the fence renderer rather than replacing it.**
   * `render.ts` configures markdown-it's `highlight` hook, which only the
   * *default* fence renderer calls; replacing the rule outright would silently
   * turn off syntax highlighting for every other language in the document.
   */
  it('leaves every other fence to the renderer it replaced', () => {
    const { doc } = render(`${FENCE}js\nconst x = 1;\n${FENCE}`);

    expect(doc.querySelector(`.${DIAGRAM_CLASS}`)).toBeNull();
    // **The `language-js` class, not the highlighter's spans.** The first
    // version asserted on spans and failed under `--sequence.shuffle`: grammars
    // load lazily (`codehighlight.ts`), so whether `js` has arrived by the time
    // this case runs depends on what ran before it. The class is what the
    // *default fence renderer* emits, which is the thing being delegated to,
    // and it is there whether or not the grammar has landed.
    const code = doc.querySelector('pre > code');
    expect(code?.className).toContain('language-js');
    expect(code?.textContent).toContain('const x = 1;');
  });

  it('leaves an infoless fence alone', () => {
    const { doc } = render(`${FENCE}\nplain\n${FENCE}`);
    expect(doc.querySelector(`.${DIAGRAM_CLASS}`)).toBeNull();
    expect(doc.querySelector('pre > code')?.textContent).toBe('plain\n');
  });

  /** Only the first word, which is all markdown-it hands the highlight hook. */
  it('matches the first word of the info string, case-insensitively', () => {
    expect(diagrams(`${FENCE}Mermaid\ngraph TD;\n${FENCE}`)).toEqual(['graph TD;\n']);
    expect(diagrams(`${FENCE}mermaid theme=dark\ngraph TD;\n${FENCE}`)).toEqual(['graph TD;\n']);
    expect(diagrams(`${FENCE}mermaidish\ngraph TD;\n${FENCE}`)).toEqual([]);
  });

  /**
   * **`data-source-line` has to be copied across by hand.** `rules/sourceline.ts`
   * stamps it on the token, and markdown-it renders a token's attributes for
   * you -- but a rule that writes its own HTML string does that rendering
   * itself and drops everything it does not mention. Without this a document's
   * diagrams are holes in the scroll-sync map.
   */
  it('keeps the source-line anchor the scroll map needs', () => {
    const { doc, anchors } = render(`# Title\n\n${FENCE}mermaid\ngraph TD;\n${FENCE}`);
    const element = doc.querySelector(`.${DIAGRAM_CLASS}`)!;

    expect(element.getAttribute('data-source-line')).toBe('3');
    expect(anchors).toContain(3);
  });

  /**
   * The source goes in as text, which markdown-it escapes -- so a label
   * containing markup cannot become a tag, and DOMPurify has nothing to strip.
   * Reading it back with `textContent` returns the original, which is what
   * `preview/diagrams.ts` hands to Mermaid.
   */
  it('escapes a diagram that looks like markup', () => {
    expect(diagrams(`${FENCE}mermaid\ngraph TD;\n  A["<img src=x>"];\n${FENCE}`)).toEqual([
      'graph TD;\n  A["<img src=x>"];\n',
    ]);
    expect(
      render(`${FENCE}mermaid\nA["<script>x</script>"]\n${FENCE}`).doc.querySelector('script'),
    ).toBeNull();
  });

  it('handles two diagrams in one document', () => {
    expect(
      diagrams(`${FENCE}mermaid\nfirst\n${FENCE}\n\ntext\n\n${FENCE}mermaid\nsecond\n${FENCE}`),
    ).toEqual(['first\n', 'second\n']);
  });
});

/* ---- L: the scroll-sync anchors both new rules nearly lost --------------- */

/**
 * **A rule that writes its own HTML string drops the token's attributes**, and
 * both of L's rules do write their own. `rules/sourceline.ts` stamps
 * `data-source-line` on every block token with a `map`, and markdown-it renders
 * a token's attributes only for tokens it renders itself.
 *
 * `rules/mermaid.ts` was written with the anchor copied across; `rules/math.ts`
 * was not, and shipped every `$$` block as a hole in the scroll-sync map --
 * found by being asked whether the checkpoint was actually finished, not by any
 * check here. Both now share `sourceLineAttr`, and this is what stops either
 * losing it again.
 *
 * The anchors matter most for exactly these two blocks: a display equation and
 * a diagram are the tallest things a document contains, so a missing anchor
 * there is the largest possible error in the mapping.
 */
describe('block-level anchors for math and diagrams', () => {
  const FENCE = '```';

  it('anchors a display equation to its own line', () => {
    const { doc, anchors } = render('# T\n\npara\n\n$$\nx = 1\n$$\n\nafter\n');

    expect(doc.querySelector(`.${MATH_DISPLAY_CLASS}`)?.getAttribute('data-source-line')).toBe('5');
    expect(anchors).toContain(5);
  });

  it('anchors a one-line display equation too', () => {
    const { doc } = render('para\n\n$$ x = 1 $$\n\nafter\n');
    expect(doc.querySelector(`.${MATH_DISPLAY_CLASS}`)?.getAttribute('data-source-line')).toBe('3');
  });

  it('anchors a diagram to its fence', () => {
    const { doc, anchors } = render(`# T\n\npara\n\n${FENCE}mermaid\ngraph TD;\n${FENCE}\n`);

    expect(doc.querySelector(`.${DIAGRAM_CLASS}`)?.getAttribute('data-source-line')).toBe('5');
    expect(anchors).toContain(5);
  });

  /**
   * Inline math is *inside* a paragraph, and only the paragraph carries a map.
   * So it has no anchor of its own and should not have one -- the paragraph is
   * the block the mapping is about.
   */
  it('does not anchor inline math, which belongs to its paragraph', () => {
    const { doc } = render('a paragraph with $x$ in it\n');

    expect(doc.querySelector(`.${MATH_INLINE_CLASS}`)?.hasAttribute('data-source-line')).toBe(
      false,
    );
    expect(doc.querySelector('p')?.getAttribute('data-source-line')).toBe('1');
  });

  /** Every block in a document of nothing but these two still maps. */
  it('leaves no gaps in a document of equations and diagrams', () => {
    const { anchors } = render(`$$\na\n$$\n\n${FENCE}mermaid\ngraph TD;\n${FENCE}\n\n$$\nb\n$$\n`);

    expect(anchors).toEqual([1, 5, 9]);
  });
});
