// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './render';

/** Parses the rendered HTML so assertions are about structure, not substrings. */
function render(markdown: string): Document {
  const { html } = renderMarkdown(markdown, { documentDir: null });
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('renderMarkdown', () => {
  it('renders GFM basics', () => {
    const doc = render('# Title\n\nText with **bold** and `code`.\n');
    expect(doc.querySelector('h1')?.textContent).toBe('Title');
    expect(doc.querySelector('strong')?.textContent).toBe('bold');
    expect(doc.querySelector('code')?.textContent).toBe('code');
  });

  it('renders a GFM table', () => {
    const doc = render('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    expect(doc.querySelectorAll('th')).toHaveLength(2);
    expect(doc.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('renders ==highlight== through markdown-it-mark', () => {
    const doc = render('a ==marked== b\n');
    expect(doc.querySelector('mark')?.textContent).toBe('marked');
  });

  it('renders footnotes through markdown-it-footnote', () => {
    const doc = render('Text[^1]\n\n[^1]: The note\n');
    expect(doc.querySelector('.footnotes')).not.toBeNull();
    // markdown-it-footnote@4.0.0 puts the `footnote-ref` class on the <sup>
    // wrapper, not the <a> -- verified against the installed package's
    // output, not assumed from the plan.
    expect(doc.querySelector('sup.footnote-ref a')).not.toBeNull();
  });

  // SPEC §6.8: HTML comments are our annotation mechanism -- visible in the
  // editor, absent from the preview.
  it('drops HTML comments', () => {
    const doc = render('before <!-- secret --> after\n');
    expect(doc.body.innerHTML).not.toContain('secret');
    expect(doc.body.textContent).toContain('before');
    expect(doc.body.textContent).toContain('after');
  });
});

describe('sanitisation', () => {
  // Raw HTML is permitted (SPEC §6.7) but must never execute. Each row is a
  // different escape route, not five spellings of the same one.
  it.each([
    ['a script element', '<script>window.pwned = 1</script>\n', 'script'],
    ['an inline handler', '<img src="x" onerror="window.pwned=1">\n', '[onerror]'],
    ['a javascript: href', '[x](javascript:window.pwned=1)\n', '[href^="javascript"]'],
    ['a data:text/html href', '[x](data:text/html,<b>h</b>)\n', '[href^="data:text/html"]'],
    ['an iframe', '<iframe src="x"></iframe>\n', 'iframe'],
  ])('strips %s', (_label, markdown, selector) => {
    const doc = render(markdown);
    expect(doc.querySelector(selector)).toBeNull();
  });

  it('keeps benign raw HTML', () => {
    const doc = render('<div class="note"><b>kept</b></div>\n');
    expect(doc.querySelector('div.note b')?.textContent).toBe('kept');
  });
});
