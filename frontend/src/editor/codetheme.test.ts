import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LanguageDescription } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { codeHighlightStyle } from './codetheme';
import { MARKDOWN_CODE_LANGUAGES } from './languages';

/**
 * The palette is only worth having if it is legible, and "legible" is a number.
 * This parses variables.css rather than importing a JS copy of the values,
 * because the CSS file is what ships -- a JS mirror could drift from it and
 * this test would happily verify the mirror.
 *
 * The last block in this file measures the *preview* stylesheet's muted
 * foregrounds rather than the code palette. It lives here because this is where
 * `luminance`/`contrast` and the theme-block parser are, and copying fifteen
 * lines of colour maths into a second file is how the two drift apart -- the
 * question ("is every colour we ship legible on the surface it lands on?") is
 * one question, wherever the colour is used.
 */
function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const CSS = read('../styles/variables.css');

/** sRGB hex to WCAG relative luminance. */
function luminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const n = parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * The slice of variables.css a theme's declarations live in.
 *
 * `variables.css` has **two** `:root` blocks -- a layout and font one, then
 * the light theme -- so "light" is everything before the dark block, not the
 * first `:root`. An earlier version of this file sliced from the first
 * `:root` and took the *first* regex match inside it, which is the opposite
 * of CSS's last-one-wins: a stale duplicate earlier in the file would be
 * measured while the browser painted the later value. `valueOf` below takes
 * the last match for the same reason.
 */
function themeBlock(theme: 'light' | 'dark'): string {
  const darkStart = CSS.indexOf("[data-theme='dark']");
  expect(darkStart, 'no dark block in variables.css').toBeGreaterThan(-1);
  return theme === 'light' ? CSS.slice(0, darkStart) : CSS.slice(darkStart);
}

/** The value `--name` ends up with in `theme`, i.e. its last declaration. */
function valueOf(name: string, theme: 'light' | 'dark'): string {
  const matches = [
    ...themeBlock(theme).matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, 'g')),
  ];
  expect(
    matches.length,
    `--${name} is not declared as a 6-digit hex in the ${theme} theme`,
  ).toBeGreaterThan(0);
  return matches[matches.length - 1]![1]!;
}

/**
 * Every `--syn-code-*` token the style actually asks for, read out of the CSS
 * it emits rather than listed here.
 *
 * A hand-maintained list is the failure this exists to prevent. Renaming every
 * `var(--syn-code-*)` in codetheme.ts to a name that does not exist left the
 * whole suite green -- 555 tests -- while the real editor painted every code
 * token the inherited foreground. Nothing connected the two files.
 *
 * Read from `module.rules`, not from the source text: a first version scanned
 * `codetheme.ts` for `var(--…)`, which binds by spelling. A rule built from a
 * constant or a template literal would evade it and reintroduce exactly the
 * hole this closes. The generated rules are what ship.
 *
 * `rules` is absent from `StyleModule`'s public types even though it is on the
 * object -- hence the cast, which is confined to this line.
 */
const EMITTED_CSS = (
  (codeHighlightStyle.module as unknown as { rules?: string[] })?.rules ?? []
).join('\n');
const REFERENCED = [
  ...new Set([...EMITTED_CSS.matchAll(/var\((--syn-code-[a-z0-9-]+)\)/g)].map((m) => m[1]!)),
];

describe('the fenced-code palette', () => {
  it('emits rules that reference tokens at all', () => {
    // Guard: an empty module, or a regex that matched nothing, would make
    // every check below vacuous rather than failing.
    expect(EMITTED_CSS).not.toBe('');
    expect(REFERENCED.length).toBeGreaterThanOrEqual(8);
  });

  it.each(['light', 'dark'] as const)('defines every token the palette uses, in %s', (theme) => {
    const missing = REFERENCED.filter(
      (token) => !new RegExp(`${token}:\\s*#[0-9a-fA-F]{6}`).test(themeBlock(theme)),
    );
    expect(missing).toEqual([]);
  });

  /**
   * Both surfaces a code token is ever composited over, not just the plain
   * editor background.
   *
   * `--syn-code-bg` is the one that matters and the one this originally missed:
   * `editor/highlight.ts` gives `tags.monospace` a `--syn-code-bg`
   * `backgroundColor`, and `styles/preview.css` gives `pre` and inline `code`
   * the same tint, so a code token is *never* actually painted on
   * `--bg-editor`. The tint costs roughly 0.6 in light, and checking
   * `--bg-editor` alone let `--syn-code-keyword` `#8250df` pass at 5.05:1 while
   * rendering at 4.43:1 -- every keyword in every light-theme fence, below AA.
   *
   * `--bg-editor` is kept in the list rather than replaced. It is the surface
   * these tokens would fall back to the day anyone drops the tint, and
   * `variables.css`'s own header says to check every surface a token is
   * composited over rather than picking one.
   */
  it.each(['light', 'dark'] as const)('clears WCAG AA on every surface in %s', (theme) => {
    const failures: string[] = [];
    for (const surface of ['bg-editor', 'syn-code-bg'] as const) {
      const background = valueOf(surface, theme);
      for (const token of REFERENCED) {
        const value = valueOf(token.slice(2), theme);
        const ratio = contrast(value, background);
        if (ratio < 4.5) {
          failures.push(`${token} ${value} on --${surface} ${background} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('declares no token variables.css does not define, and none it never uses', () => {
    const declared = [...themeBlock('light').matchAll(/(--syn-code-[a-z-]+):\s*#/g)].map(
      (m) => m[1]!,
    );
    // --syn-code-fg and --syn-code-bg predate this palette: they style inline
    // code and the fence background in *markdown*, not code tokens, and
    // markdownHighlightStyle owns them.
    const paletteOnly = declared.filter(
      (name) => name !== '--syn-code-fg' && name !== '--syn-code-bg',
    );
    expect([...new Set(paletteOnly)].sort()).toEqual([...REFERENCED].sort());
  });
});

/**
 * Coverage, which is a different question from legibility.
 *
 * Replacing `defaultHighlightStyle` meant inheriting responsibility for every
 * tag it used to colour, and the first draft of `codetheme.ts` quietly dropped
 * three: `inserted`, `deleted` and `meta`. A ```diff fence therefore rendered
 * with **zero** spans -- added and removed lines the same colour as prose,
 * which reads as deliberate rather than broken. Every check above passed.
 *
 * So this asserts the positive: named constructs in real fences must come out
 * carrying a class. It walks the tree directly rather than mounting a view,
 * because none of it needs layout and `highlightTree` is what the editor uses
 * underneath anyway.
 */
describe('the palette colours what it took responsibility for', () => {
  const LANGUAGES = ['javascript', 'python', 'html', 'diff', 'shell'] as const;

  beforeAll(async () => {
    await Promise.all(
      LANGUAGES.map(async (name) => {
        const description = LanguageDescription.matchLanguageName(
          MARKDOWN_CODE_LANGUAGES,
          name,
          true,
        );
        expect(description, `${name} is not in MARKDOWN_CODE_LANGUAGES`).not.toBeNull();
        await description!.load();
      }),
    );
  });

  /** The substrings of `code` that came out inside a highlighted span. */
  function highlighted(language: string, code: string): string[] {
    const description = LanguageDescription.matchLanguageName(
      MARKDOWN_CODE_LANGUAGES,
      language,
      true,
    );
    const support = description?.support;
    expect(support, `${language} did not load`).toBeDefined();

    const spans: string[] = [];
    highlightTree(support!.language.parser.parse(code), codeHighlightStyle, (from, to, classes) => {
      if (classes) spans.push(code.slice(from, to));
    });
    return spans;
  }

  it.each([
    ['javascript', "const s = 'str'; // note", ['const', "'str'", '// note']],
    ['python', 'def f(x):  # note\n    return "str"\n', ['def', '# note', '"str"']],
    // The regression that motivated this block. Both sides of a diff must be
    // distinguishable, and the hunk header is `meta`.
    ['diff', '@@ -1,2 +1,2 @@\n-removed\n+added\n', ['@@ -1,2 +1,2 @@', '-removed', '+added']],
    ['html', '<!DOCTYPE html>\n<div class="x">t</div>\n', ['<!DOCTYPE html>']],
    ['shell', '#!/bin/sh\necho hi\n', ['#!/bin/sh']],
  ] as const)('colours %s', (language, code, expected) => {
    const spans = highlighted(language, code);
    const missing = expected.filter((text) => !spans.some((span) => span.includes(text)));
    expect(missing, `spans found: ${JSON.stringify(spans)}`).toEqual([]);
  });

  it('gives a diff fence different colours for added and removed lines', () => {
    const code = '-removed\n+added\n';
    const description = LanguageDescription.matchLanguageName(
      MARKDOWN_CODE_LANGUAGES,
      'diff',
      true,
    );
    const byText = new Map<string, string>();
    highlightTree(
      description!.support!.language.parser.parse(code),
      codeHighlightStyle,
      (from, to, classes) => byText.set(code.slice(from, to).trim(), classes),
    );
    // Same colour for both would make the fence useless, which is what
    // inheriting a single fallback would have produced.
    expect(byText.get('-removed')).toBeDefined();
    expect(byText.get('+added')).toBeDefined();
    expect(byText.get('-removed')).not.toBe(byText.get('+added'));
  });
});

/**
 * The preview's deliberately dim text, measured rather than eyeballed.
 *
 * Task 8's own plan asked only that someone *look* at the front-matter card and
 * the image placeholder in both themes. Looking is still necessary -- nothing
 * here can tell you whether the card reads as a card -- but it leaves nothing
 * behind, and these are the two surfaces most likely to drift under AA because
 * being dim is the point of both. So the pairing is pinned as a number.
 *
 * Each row is checked in two halves, and both halves matter:
 *
 * - **The pairing is real.** `preview.css` must actually declare that
 *   foreground on that selector, and the background must actually come from the
 *   rule named in `bgFrom`. Without this the ratio below is arithmetic about a
 *   pairing the stylesheet may no longer have -- swapping the card to
 *   `--fg-secondary` would leave a "passing" test measuring the old colour.
 * - **The ratio clears AA.** Retuning either token in variables.css reddens it.
 */
describe("the preview's muted foregrounds", () => {
  const PREVIEW_CSS = read('../styles/preview.css');

  /** The declarations inside one rule. CSS has no nesting here, so `[^}]*` is enough. */
  function block(selector: string): string {
    const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(PREVIEW_CSS);
    expect(match, `preview.css has no standalone \`${selector}\` rule`).not.toBeNull();
    return match![1]!;
  }

  const SURFACES = [
    // Dimmed because front matter is metadata, not prose (design §2.2). The
    // tightest pairing in the file.
    {
      selector: '.preview-frontmatter',
      fg: 'fg-muted',
      bg: 'bg-hover',
      bgFrom: '.preview-frontmatter',
    },
    // The placeholder has no background of its own; it sits on the pane.
    {
      selector: '.preview-image-placeholder',
      fg: 'fg-muted',
      bg: 'bg-editor',
      bgFrom: '.preview-pane',
    },
    // Not muted, but it is the one colour in preview.css that changed for this
    // reason: --bg-danger measured 3.07:1 as text on the dark editor. The
    // palette block above already asserts --syn-code-invalid against
    // --bg-editor as a *code token*; this pins the same number for the error
    // card, which is a different reason to care about it.
    {
      selector: '.preview-error',
      fg: 'syn-code-invalid',
      bg: 'bg-editor',
      bgFrom: '.preview-pane',
    },
  ] as const;

  it.each(SURFACES)(
    '$selector pairs $fg with $bg in preview.css',
    ({ selector, fg, bg, bgFrom }) => {
      expect(block(selector)).toContain(`color: var(--${fg})`);
      expect(block(bgFrom)).toContain(`background: var(--${bg})`);
      // When the background comes from an *ancestor*, the element must not
      // acquire one of its own -- otherwise the ratio above is measured against
      // a surface the text no longer sits on. This is not hypothetical: the
      // error card's own comment records that `--syn-code-invalid` drops to
      // 4.41:1 on `--bg-hover`, so a well-meaning tint on that card would take
      // it below AA with every assertion here still green. Measured: adding
      // `background: var(--bg-hover)` to `.preview-error` left the whole suite
      // passing before this line existed.
      if (bgFrom !== selector) {
        expect(
          block(selector),
          `${selector} must inherit its background from ${bgFrom}`,
        ).not.toMatch(/(^|[;\s])background(-color)?\s*:/);
      }
    },
  );

  it.each(
    (['light', 'dark'] as const).flatMap((theme) =>
      SURFACES.map((surface) => ({ theme, ...surface })),
    ),
  )('$selector clears AA in $theme', ({ theme, fg, bg }) => {
    const foreground = valueOf(fg, theme);
    const background = valueOf(bg, theme);
    const ratio = contrast(foreground, background);
    expect(
      ratio,
      `--${fg} ${foreground} on --${bg} ${background} = ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
