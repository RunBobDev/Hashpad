// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../render';
import { ASSET_ROUTE } from './images';

function render(markdown: string, documentDir: string | null = 'C:\\docs') {
  const result = renderMarkdown(markdown, { documentDir });
  return {
    ...result,
    doc: new DOMParser().parseFromString(result.html, 'text/html'),
  };
}

describe('front matter', () => {
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
    expect(img?.getAttribute('src')).toBe(`${ASSET_ROUTE}?path=assets%2Fpic.png`);
    expect(img?.getAttribute('alt')).toBe('alt');
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
