// @vitest-environment jsdom
/**
 * Export as HTML (SPEC §7.3): one file, nothing beside it.
 *
 * `fetch` is stubbed -- in the app it reaches Go's asset route and the bundled
 * KaTeX fonts, neither of which exists here. KaTeX's stylesheet is replaced by
 * a one-rule stand-in so the font-embedding path has something to embed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeHighlightStyle } from '../editor/codetheme';
import {
  documentTitle,
  embedLocalImages,
  inlineFontUrls,
  revealRemoteImages,
  standaloneHtml,
} from './html';

vi.mock('katex/dist/katex.min.css?inline', () => ({
  default:
    '@font-face{font-family:KaTeX_Main;src:url(/assets/KaTeX_Main-Regular.woff2) format("woff2")}',
}));

const fetchMock = vi.fn();

function answers(body: string, type: string): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob([body], { type })),
    }),
  );
}

function fails(status: number): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve({ ok: false, status, blob: () => Promise.resolve(new Blob([])) }),
  );
}

function rooted(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local images', () => {
  it('are embedded as data URIs', async () => {
    answers('png', 'image/png');
    const root = rooted('<p><img src="/__hashpad/asset?dir=D&amp;path=a.png" alt="a"></p>');

    await embedLocalImages(root);

    expect(root.querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  /**
   * The route's query carries the document's folder. An image that could not be
   * read shows its alt text; it must not put a local path into a file that is
   * about to be sent to somebody.
   */
  it('lose their address when they cannot be read, rather than leak the folder', async () => {
    fails(404);
    const root = rooted(
      '<p><img src="/__hashpad/asset?dir=C%3A%2Fdocs&amp;path=a.png" alt="a"></p>',
    );

    await embedLocalImages(root);

    const img = root.querySelector('img')!;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('alt')).toBe('a');
  });

  it('leave every other image alone', async () => {
    const root = rooted('<img src="data:image/gif;base64,R0lGOD">');
    await embedLocalImages(root);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('internet images', () => {
  it('become an <img> again, for the reader’s browser to load', () => {
    const root = rooted(
      '<span class="preview-image-placeholder" data-src="https://e.com/c.png" data-alt="cat">x</span>',
    );

    revealRemoteImages(root);

    const img = root.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://e.com/c.png');
    expect(img.getAttribute('alt')).toBe('cat');
    expect(root.querySelector('.preview-image-placeholder')).toBeNull();
  });

  it('stay placeholders when the address is not a web one', () => {
    const root = rooted(
      '<span class="preview-image-placeholder" data-src="file:///C:/x.png" data-alt="">x</span>',
    );
    revealRemoteImages(root);
    expect(root.querySelector('img')).toBeNull();
  });
});

describe('fonts', () => {
  it('are inlined as base64, every woff2 the stylesheet names', async () => {
    answers('font', 'font/woff2');

    const css = await inlineFontUrls('a{src:url(/assets/A.woff2)}b{src:url("/assets/B.woff2")}');

    expect(css).not.toContain('/assets/');
    expect(css.match(/data:font\/woff2;base64,/g)).toHaveLength(2);
  });
});

describe('the page', () => {
  it('is light, script-free and fenced by its own policy', async () => {
    const html = await standaloneHtml(rooted('<h1>T</h1><p>body</p>'), 'T');

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<main class="preview-pane"><h1>T</h1><p>body</p></main>');
    expect(html).not.toMatch(/<script/i);
  });

  /**
   * The code colours are not in any `.css` file: CodeMirror generates their
   * class names and injects the rules at runtime. The first real-exe export
   * came out with every code block in one colour.
   */
  it('carries the syntax colours, which live in no stylesheet file', async () => {
    const rules = codeHighlightStyle.module!.getRules();
    const html = await standaloneHtml(rooted('<pre><code>x</code></pre>'), 'T');
    expect(rules).toContain('var(--syn-code-keyword)');
    expect(html).toContain(rules);
  });

  it('escapes the title', async () => {
    const html = await standaloneHtml(rooted('<p>x</p>'), '<b>&');
    expect(html).toContain('<title>&lt;b&gt;&amp;</title>');
  });

  it('carries KaTeX’s stylesheet, fonts embedded, when there is math', async () => {
    answers('font', 'font/woff2');
    const html = await standaloneHtml(rooted('<p><span class="katex">x</span></p>'), 'T');
    expect(html).toContain('KaTeX_Main');
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).not.toContain('/assets/KaTeX_Main');
  });

  it('leaves KaTeX out, and fetches nothing, when there is none', async () => {
    const html = await standaloneHtml(rooted('<p>prose</p>'), 'T');
    expect(html).not.toContain('KaTeX_Main');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns placeholders back into images and embeds local ones', async () => {
    answers('png', 'image/png');
    const html = await standaloneHtml(
      rooted(
        '<span class="preview-image-placeholder" data-src="https://e.com/c.png" data-alt="cat">x</span>' +
          '<img src="/__hashpad/asset?dir=D&amp;path=a.png" alt="a">',
      ),
      'T',
    );
    expect(html).toContain('<img src="https://e.com/c.png" alt="cat">');
    expect(html).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="a">/);
  });

  it('does not touch the live element it was given', async () => {
    const root = rooted(
      '<span class="preview-image-placeholder" data-src="https://e.com/c.png">x</span>',
    );
    await standaloneHtml(root, 'T');
    expect(root.querySelector('.preview-image-placeholder')).not.toBeNull();
  });
});

describe('documentTitle', () => {
  it('takes the first heading, else the file name', () => {
    expect(documentTitle(rooted('<h1> Report </h1><h1>Two</h1>'), 'notes')).toBe('Report');
    expect(documentTitle(rooted('<p>x</p>'), 'notes')).toBe('notes');
    expect(documentTitle(rooted('<h1> </h1>'), 'notes')).toBe('notes');
  });
});
