// @vitest-environment jsdom
/**
 * The half of SPEC §7.2 that turns a placeholder into typeset math.
 *
 * **The security cases here are not routine coverage.** L.1's whole design
 * rests on KaTeX output being safe to insert *past* the sanitiser (design
 * §4.29), and that claim is only as good as `trust: false` and KaTeX's strict
 * mode actually being enforced. Both are KaTeX 0.18 defaults; they are passed
 * explicitly and asserted here anyway, because a default is not a promise and
 * a version bump is exactly how one stops being true.
 *
 * jsdom, because `katex.render` builds DOM and this file measures what it
 * built. What the typeset output *looks like* is unanswerable here -- jsdom has
 * no layout -- and is `harness/math.html`'s question.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import katex from 'katex';
import { onMathLoaded, renderMathIn } from './math';
import { MATH_DISPLAY_CLASS, MATH_INLINE_CLASS } from './rules/math';

/** A pane's worth of DOM holding the placeholders `rules/math.ts` emits. */
function placeholders(...specs: [string, string][]): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = specs
    .map(([className, expression]) => `<span class="${className}">${expression}</span>`)
    .join('');
  return root;
}

/**
 * Runs the pass until KaTeX has actually loaded.
 *
 * The first call only ever starts the dynamic import -- that is the design, and
 * `starts the load rather than rendering on the first pass` below is the test
 * for it. Every other case wants the loaded state, so it waits for the
 * notification the pane subscribes to and then passes again.
 */
async function rendered(root: HTMLElement): Promise<HTMLElement> {
  renderMathIn(root);
  if (root.querySelector('.katex') === null) {
    await vi.waitFor(() => {
      renderMathIn(root);
      expect(root.querySelector('.katex')).not.toBeNull();
    });
  }
  return root;
}

describe('rendering math into the sanitised DOM', () => {
  it('leaves a document with no math entirely alone', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>no math here</p>';
    const before = root.innerHTML;
    renderMathIn(root);
    expect(root.innerHTML).toBe(before);
  });

  /**
   * The first pass over a document with math renders nothing and starts the
   * import; the pane is told when it lands and renders again. One flash per
   * session, and the LaTeX source is what shows until then -- which is why the
   * placeholder carries the expression as its own text.
   *
   * **Against a freshly imported module, and that is the whole difficulty.**
   * "Whether KaTeX has loaded" is module-level state, so this is the one case
   * in the file that cannot use the shared instance every other case has
   * already warmed up. Written with the shared one it passed in the default
   * order and failed under `--sequence.shuffle` -- caught by the third run,
   * which is why the suite is shuffled at all.
   */
  it('starts the load rather than rendering on the first pass', async () => {
    vi.resetModules();
    const fresh = await import('./math');

    const root = placeholders([MATH_INLINE_CLASS, 'a^2']);
    const told = new Promise<void>((resolve) => {
      const off = fresh.onMathLoaded(() => {
        off();
        resolve();
      });
    });

    fresh.renderMathIn(root);
    expect(root.textContent).toBe('a^2');

    await told;
    fresh.renderMathIn(root);
    expect(root.querySelector('.katex')).not.toBeNull();
  });

  it('typesets an inline expression', async () => {
    const root = await rendered(placeholders([MATH_INLINE_CLASS, 'E = mc^2']));
    expect(root.querySelector('.katex')).not.toBeNull();
    expect(root.querySelector('.katex-display')).toBeNull();
  });

  it('typesets a display expression in display mode', async () => {
    const root = await rendered(
      placeholders([`${MATH_INLINE_CLASS} ${MATH_DISPLAY_CLASS}`, '\\sum x']),
    );
    expect(root.querySelector('.katex-display')).not.toBeNull();
  });

  /**
   * `katex.render` replaces the element's children, and the children are where
   * the expression lives -- so a second pass would hand KaTeX its own output as
   * LaTeX. The pane rebuilds its HTML wholesale each render so this should not
   * arise, but "should not arise" is a property of a caller.
   */
  it('is a no-op on a second pass over the same DOM', async () => {
    const root = await rendered(placeholders([MATH_INLINE_CLASS, 'x^2']));
    const once = root.innerHTML;
    renderMathIn(root);
    expect(root.innerHTML).toBe(once);
  });

  /**
   * **`throwOnError: false` is load-bearing and the default is the other way.**
   * `pane.ts` catches a renderer exception by replacing the *whole pane* with an
   * error card, so without this a half-typed `\frac{1}{` would blank the
   * document around it on every keystroke.
   */
  it('renders a malformed expression in place instead of throwing', async () => {
    const root = placeholders([MATH_INLINE_CLASS, '\\frac{1}{'], [MATH_INLINE_CLASS, 'y = 2']);
    await rendered(root);

    expect(root.querySelector('.katex-error')).not.toBeNull();
    // The rest of the document still rendered.
    expect(root.querySelectorAll('.katex').length).toBeGreaterThan(0);
  });

  it('throws without that option, so it is not decoration', () => {
    expect(() => katex.renderToString('\\frac{1}{')).toThrow();
  });

  /**
   * **The case above proves KaTeX behaves; this one proves we ask it to.**
   *
   * Every assertion in that block calls `katex.renderToString` directly with
   * the options spelled out, so all of them survive `math.ts` dropping
   * `trust: false` entirely. This one goes through the real pass, so it is the
   * only thing standing between a one-word edit and a live `javascript:` link
   * in the pane -- past the sanitiser, which is the whole point of the design.
   */
  it('passes trust: false through the real pass, not just in theory', async () => {
    const root = await rendered(
      placeholders([MATH_INLINE_CLASS, '\\href{javascript:alert(1)}{x}']),
    );

    expect(root.querySelector('a')).toBeNull();
    expect([...root.querySelectorAll('*')].some((e) => e.hasAttribute('href'))).toBe(false);
  });

  /**
   * **The laziness claim, made mechanical.** SPEC §7.2 requires the dynamic
   * import to fire "only when a document actually contains math", so that
   * "normal notes never pay their cost".
   *
   * Asserted on the module *factory* rather than on rendering: a document with
   * no math renders none either way, so counting renders would pass whether or
   * not the chunk had been fetched.
   *
   * **The control in the second half is not decoration.** The first version of
   * this test waited one microtask and asserted zero, which is true of a
   * document that never imported *and* of one whose import simply had not
   * landed yet -- measured: it stayed green with the guard removed entirely.
   * Both halves now use the same window, so the second proves the first waited
   * long enough to have seen an import if there had been one.
   */
  it('never imports katex for a document with no math', async () => {
    vi.resetModules();
    let imports = 0;
    vi.doMock('katex', () => {
      imports++;
      return { default: { render: vi.fn(), renderToString: vi.fn(() => '') } };
    });
    const fresh = await import('./math');

    /** Long enough for a dynamic import to settle; the control below proves it. */
    const window = async (): Promise<void> => {
      for (let turn = 0; turn < 20; turn++) await new Promise((r) => setTimeout(r, 5));
    };

    const plain = document.createElement('div');
    plain.innerHTML = '<p>prose with a $5 price and <code>$PATH$</code></p>';
    fresh.renderMathIn(plain);
    fresh.renderMathIn(plain);
    await window();
    expect(imports).toBe(0);

    // The same wait, on a document that does contain math.
    fresh.renderMathIn(placeholders([MATH_INLINE_CLASS, 'x']));
    await window();
    expect(imports).toBe(1);

    vi.doUnmock('katex');
    vi.resetModules();
  });

  describe('the assumptions that let this bypass the sanitiser', () => {
    /**
     * **Asserted against the parsed DOM, not against the string.**
     *
     * The first version of these matched on text, and both cases failed for the
     * wrong reason: KaTeX echoes the LaTeX source into its `<annotation>`
     * element, so `javascript:` and ` onerror=` are genuinely *present* in the
     * output -- as escaped text, inert, exactly where they belong. A string
     * match cannot tell that from a live attribute, which makes it both a false
     * alarm here and worthless as a guard. What matters is structural: no
     * anchors, no scripts, no event handlers, no URL-bearing attributes.
     */
    function elements(html: string): Element[] {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return [...doc.querySelectorAll('*')];
    }

    function attributes(html: string): string[] {
      return elements(html).flatMap((element) => [...element.attributes].map((a) => a.name));
    }

    /**
     * `\href` must not become an anchor. If it did, a document could put a
     * `javascript:` link into the pane through a channel DOMPurify never sees.
     */
    it('will not build a link from \\href', () => {
      const html = katex.renderToString('\\href{javascript:alert(1)}{click}', {
        throwOnError: false,
        trust: false,
      });
      expect(elements(html).map((e) => e.tagName.toLowerCase())).not.toContain('a');
      expect(attributes(html)).not.toContain('href');
    });

    /** `\htmlClass` must not let a document choose a class in the pane. */
    it('will not apply a class from \\htmlClass', () => {
      const html = katex.renderToString('\\htmlClass{evil}{x}', {
        throwOnError: false,
        trust: false,
      });
      expect(html).not.toMatch(/class="[^"]*\bevil\b/);
    });

    /**
     * The general case: whatever a document puts between the dollars, nothing
     * executable comes out the far side. Every attribute KaTeX emits should be
     * one of a tiny set -- anything else is a finding, not a pass.
     *
     * **The inputs must reach KaTeX as real LaTeX**, which in a TypeScript
     * string literal means a doubled backslash. Written with a single one they
     * are ordinary text, KaTeX has nothing to interpret, and every assertion
     * below passes while testing nothing -- which is what the first version of
     * this file did.
     */
    it.each([
      ['a raw script tag', '<script>alert(1)</script>'],
      ['markup inside \\text', '\\text{<img src=x onerror=alert(1)>}'],
      ['a quote-breaking argument', '\\includegraphics{x" onload="alert(1)}'],
      ['a url in an argument', '\\href{javascript:alert(1)}{x}'],
      ['an html extension', '\\htmlData{x=1}{y}'],
    ])('emits nothing executable from %s', (_name, attack) => {
      const html = katex.renderToString(attack, { throwOnError: false, trust: false });
      const tags = elements(html).map((e) => e.tagName.toLowerCase());

      expect(tags).not.toContain('script');
      expect(tags).not.toContain('iframe');
      expect(tags).not.toContain('a');
      expect(tags).not.toContain('img');
      expect(attributes(html).filter((name) => /^on/.test(name))).toEqual([]);
      expect(attributes(html).filter((name) => ['href', 'src'].includes(name))).toEqual([]);
    });
  });
});

describe('what the pane subscribes to', () => {
  let seen: number;

  beforeEach(() => {
    seen = 0;
  });

  it('hands back an unsubscribe that actually unsubscribes', async () => {
    const off = onMathLoaded(() => {
      seen++;
    });
    off();
    await rendered(placeholders([MATH_INLINE_CLASS, 'z']));
    expect(seen).toBe(0);
  });
});
