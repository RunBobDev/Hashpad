// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LanguageDescription } from '@codemirror/language';
import { MARKDOWN_CODE_LANGUAGES } from '../editor/languages';
import { purifierForTests, renderMarkdown } from './render';

/** Parses the rendered HTML so assertions are about structure, not substrings. */
function render(markdown: string): Document {
  return new DOMParser().parseFromString(
    renderMarkdown(markdown, { documentDir: null }),
    'text/html',
  );
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

/**
 * Fenced code is coloured by `codehighlight.ts`, reached through markdown-it's
 * `highlight` constructor option. These two tests are here rather than only in
 * `codehighlight.test.ts` because that file exercises `highlightCode`
 * directly: deleting the `highlight` option from `render.ts` altogether leaves
 * it entirely green while the preview renders every fence colourless.
 */
describe('fenced code blocks', () => {
  it('leaves a language whose grammar has not loaded as escaped plain code', () => {
    // `brainfuck` is in language-data and nothing in this file loads it -- and
    // `<` and `>` happen to be two of its eight instructions, so the same
    // fence checks that the unhighlighted path still escapes.
    const doc = render('```brainfuck\n+<script>alert(1)</script>+\n```\n');
    const code = doc.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code!.querySelector('span')).toBeNull();
    expect(doc.querySelector('script')).toBeNull();
    expect(code!.textContent).toBe('+<script>alert(1)</script>+\n');
  });

  it('leaves a fence with no info string as escaped plain code', () => {
    // `highlight` is handed `''` for these, and `highlightCode` answers null
    // for it -- there is no separate guard in `render.ts`, so this is what
    // pins that behaviour.
    const doc = render('```\n<b>&amp;</b>\n```\n');
    const code = doc.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code!.querySelector('span')).toBeNull();
    expect(code!.querySelector('b')).toBeNull();
    expect(code!.textContent).toBe('<b>&amp;</b>\n');
  });

  it('colours a fence whose grammar has loaded', async () => {
    const javascript = LanguageDescription.matchLanguageName(
      MARKDOWN_CODE_LANGUAGES,
      'javascript',
      true,
    );
    expect(javascript).not.toBeNull();
    await javascript!.load();

    // `js` rather than `javascript`: the fence info string is what an author
    // actually types, and markdown-it hands it over verbatim.
    const doc = render("```js\nconst s = 'str';\n```\n");
    const code = doc.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code!.querySelectorAll('span').length).toBeGreaterThan(0);
    // Spans or not, the source survives byte for byte.
    expect(code!.textContent).toBe("const s = 'str';\n");
  });
});

/**
 * SPEC §6.8 lists autolinks in the GFM baseline. Off through Checkpoint F, turned
 * on by the owner once `preview/pane.ts` had a click handler -- until then every
 * link was a trap that navigated the webview off the app, and linkify's whole job
 * is to make more of them.
 */
describe('autolinks', () => {
  const NL = String.fromCharCode(10);
  it('linkifies a bare URL in prose', () => {
    const doc = render('see https://example.com/docs for more' + NL);
    const anchor = doc.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/docs');
    expect(anchor?.textContent).toBe('https://example.com/docs');
  });

  it('still renders a CommonMark autolink', () => {
    expect(render('<https://example.com/>' + NL).querySelector('a')).not.toBeNull();
  });

  // The thing linkify must not do: a filename with a dot in it is not a host.
  it('leaves an ordinary filename alone', () => {
    expect(render('open notes.md and read it' + NL).querySelector('a')).toBeNull();
  });
});

describe('sanitisation', () => {
  /**
   * Raw HTML is permitted (SPEC §6.7) but must never execute. Each row is a
   * different escape route, not five spellings of one.
   *
   * Two things about the shape of these rows, both of which were wrong first
   * time round and were caught in review:
   *
   * - **They are written as raw HTML, not as markdown links.** The markdown
   *   spellings `[x](javascript:…)` and `[x](data:text/html,…)` never reach
   *   DOMPurify at all: markdown-it's own `validateLink` rejects both schemes
   *   and emits them as literal text, so those rows passed with the sanitiser
   *   removed entirely. They were testing markdown-it. The markdown spellings
   *   are still worth pinning and get their own block below.
   * - **Each row asserts something survives.** Five bare "this is absent"
   *   assertions all hold for a renderer that returns the empty string, which
   *   is a perfect score on a security suite for producing nothing. The
   *   `keeps` column is what stops that.
   */
  it.each([
    ['a script element', '<script>window.pwned = 1</script>\n\nafter\n', 'script', 'after'],
    ['an inline handler', '<img src="x" onerror="window.pwned=1">\n', '[onerror]', null],
    [
      'a javascript: href',
      '<a href="javascript:window.pwned=1">link</a>\n',
      '[href^="javascript"]',
      'link',
    ],
    [
      'a data:text/html href',
      '<a href="data:text/html,<b>h</b>">link</a>\n',
      '[href^="data:text/html"]',
      'link',
    ],
    ['an iframe', '<iframe src="x"></iframe>\n\nafter\n', 'iframe', 'after'],
  ])('strips %s', (_label, markdown, selector, survives) => {
    const doc = render(markdown);
    expect(doc.querySelector(selector)).toBeNull();
    if (survives === null) {
      // The `<img>` itself is kept; only the handler is stripped.
      expect(doc.querySelector('img')).not.toBeNull();
    } else {
      expect(doc.body.textContent).toContain(survives);
    }
  });

  // The other half of the two link rows above: markdown-it refuses these
  // schemes before DOMPurify is reached, so both layers are pinned rather
  // than one standing in for the other.
  it.each([
    ['javascript:', '[x](javascript:window.pwned=1)\n'],
    ['data:text/html', '[x](data:text/html,<b>h</b>)\n'],
  ])("markdown-it's own link validator rejects %s", (_label, markdown) => {
    const doc = render(markdown);
    expect(doc.querySelector('a')).toBeNull();
    // Left as literal text rather than silently dropped.
    expect(doc.body.textContent).toContain('[x]');
  });

  it('keeps benign raw HTML', () => {
    const doc = render('<div class="note"><b>kept</b></div>\n');
    expect(doc.querySelector('div.note b')?.textContent).toBe('kept');
  });

  /**
   * The comment-stripping hook, pinned in the one configuration where it is
   * load-bearing.
   *
   * Under the shipped config DOMPurify's default ALLOWED_TAGS has no
   * `#comment`, so comments are dropped by the allowlist and the hook changes
   * nothing -- removing it fails no other test here. That makes the hook
   * unfalsifiable, which this project treats as a defect in its own right.
   * Overriding `ALLOWED_TAGS` disables the default and leaves the hook as the
   * only thing holding SPEC §6.8. Deleting the hook reddens this.
   */
  it('strips comments even when ALLOWED_TAGS would re-admit them', () => {
    const output = purifierForTests.sanitize('<p>a<!-- secret --></p>', {
      ALLOWED_TAGS: ['p', '#comment'],
    });
    expect(output).not.toContain('secret');
    expect(output).toContain('a');
  });
});

/**
 * SPEC §5.3: `variables.css` is the only file allowed to name a colour.
 *
 * Both shipped stylesheets are scanned, not only the new one. `app.css` is
 * clean today and the rule it obeys is the same rule; a check that covers one
 * file lets the next literal land in the other. `variables.css` is excluded by
 * definition -- it is the place the colours live.
 */
describe('the stylesheets name no colours', () => {
  it.each(['../styles/preview.css', '../styles/app.css'])('%s', (relative) => {
    const css = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    // Strip comments first: the explanatory ones cite hex values on purpose --
    // both files record measured contrast ratios against named colours.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // Guard: a path typo, or a regex that matched the whole file, would make
    // the assertion below vacuously true.
    expect(withoutComments).toContain('var(--');

    expect(withoutComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);

    // Hex was all this checked at first, which was too narrow to be worth much:
    // measured, `color: red; border-color: color-mix(in oklab, red 50%, white);
    // outline-color: oklch(70% 0.2 20)` left the test green. Enumerating the 148
    // named colours and every modern colour function would be its own
    // maintenance burden, so the rule is inverted instead: every declaration of
    // a colour-valued property must resolve through a token. That catches
    // anything nameable, in any syntax, and needs no list.
    //
    // Blacklisting the functions themselves was the first attempt and was wrong:
    // `app.css` composes two tokens with `color-mix(in oklab, var(--accent) 85%,
    // var(--fg-primary))`, which names no colour and is exactly the kind of
    // derivation this file should be free to do. Requiring `var(--)` in the value
    // permits that and still rejects a mix of literals.
    //
    // Deliberately only the properties whose entire value **is** a colour.
    // Shorthands (`border`, `outline`, `box-shadow`) are left out: their values
    // mix lengths, styles and keywords, so telling "names a colour" from "names
    // a width" needs a real CSS parser, and every attempt at a regex for it
    // produced false positives on the declarations already in these files
    // (`border: 0`, `border-bottom: 2px solid transparent`). Hex in a shorthand
    // is still caught by the check above; a *named* colour in one is the hole,
    // and it is stated here rather than papered over. Same for a literal mixed
    // with a token, as in `color-mix(in oklab, var(--accent) 50%, red)`.
    const COLOUR_PROPERTY =
      /(?:^|[;{]\s*)(color|background|background-color|border-color|outline-color|fill|stroke|caret-color|text-decoration-color)\s*:\s*([^;}]+)/g;
    /** Values that name no colour, so they need no token. */
    const COLOURLESS = /^(none|transparent|inherit|initial|unset|currentColor)$/i;
    const untokenised = [...withoutComments.matchAll(COLOUR_PROPERTY)]
      .map(([, property, value]) => [property!, value!.trim()] as const)
      .filter(([, value]) => !value.includes('var(--') && !COLOURLESS.test(value))
      .map(([property, value]) => `${property}: ${value}`);
    expect(untokenised).toEqual([]);
  });
});
