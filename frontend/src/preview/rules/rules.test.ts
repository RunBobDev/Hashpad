// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../render';
import { ASSET_ROUTE } from './images';

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
