// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { LanguageDescription } from '@codemirror/language';
import { MARKDOWN_CODE_LANGUAGES } from '../editor/languages';
import { highlightCode, onLanguageLoaded } from './codehighlight';

/** The description `highlightCode` matches for `name`, so a test can await its load. */
function descriptionFor(name: string): LanguageDescription {
  const description = LanguageDescription.matchLanguageName(MARKDOWN_CODE_LANGUAGES, name, true);
  expect(description, `no ${name} in language-data`).not.toBeNull();
  return description!;
}

/** Lets every already-scheduled promise callback run, rejections included. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('highlightCode', () => {
  it('returns null for a language whose grammar has not loaded', () => {
    // `brainfuck` is in language-data and nothing else in the suite loads it.
    expect(highlightCode('+++', 'brainfuck')).toBeNull();
  });

  it('returns null for a language that does not exist', () => {
    expect(highlightCode('x', 'not-a-language')).toBeNull();
  });

  describe('once the grammar is loaded', () => {
    beforeAll(async () => {
      await descriptionFor('javascript').load();
    });

    it('wraps tokens in spans carrying our code palette classes', () => {
      const html = highlightCode("const s = 'str';", 'javascript');
      expect(html).not.toBeNull();
      const doc = new DOMParser().parseFromString(`<pre>${html}</pre>`, 'text/html');

      const keyword = Array.from(doc.querySelectorAll('span')).find(
        (el) => el.textContent === 'const',
      );
      expect(keyword, 'no span around the keyword').toBeDefined();
      expect(keyword!.className).not.toBe('');

      // Text is preserved exactly, spans or not.
      expect(doc.body.textContent).toBe("const s = 'str';");
    });

    it('escapes HTML in the source rather than emitting it', () => {
      const html = highlightCode('const x = "<script>";', 'javascript');
      expect(html).not.toBeNull();
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes every character it claims to, not just the angle brackets', () => {
      // The test above only reaches `escapeHtml`'s `<` and `>` branches, so
      // the `&` and `"` branches could each be deleted with the suite green.
      // `&` is the one that matters: a fence documenting HTML escaping (this
      // repo's own docs do) would otherwise render `&amp;` as `&`.
      const source = 'const s = "a & b <c>";';
      const html = highlightCode(source, 'javascript');
      expect(html).toContain('&amp;');
      expect(html).toContain('&lt;c&gt;');
      expect(html).toContain('&quot;');

      const doc = new DOMParser().parseFromString(`<pre>${html}</pre>`, 'text/html');
      expect(doc.body.textContent).toBe(source);
    });

    /**
     * The class names in the output are meaningless unless their stylesheet is
     * in the document, and the module-scope `StyleModule.mount` is the only
     * thing putting it there when the preview loads before the editor. Without
     * this the mount -- and the whole `style-mod` import -- can be deleted with
     * every other test still green.
     *
     * This is as close as jsdom gets to seeing colour: it proves the class
     * resolves to a rule, never that the rule paints anything visible.
     */
    it('mounts the palette stylesheet, so the emitted classes resolve to rules', () => {
      const html = highlightCode('const s = 1;', 'javascript');
      const emitted = /class="([^"]+)"/.exec(html ?? '')?.[1];
      expect(emitted, 'no span class to look up').toBeDefined();

      const css = Array.from(document.querySelectorAll('style'))
        .map((element) => element.textContent ?? '')
        .join('\n');
      for (const name of emitted!.split(' ')) {
        expect(css, `.${name} is in no mounted stylesheet`).toContain(`.${name}`);
      }
    });
  });
});

/**
 * Task 6's pane subscribes to this to re-render when a grammar arrives, so a
 * silently dead subscription would show up there as code that never colours.
 *
 * Both tests count a *live* listener alongside whatever they are really
 * checking. Other tests in this file start grammar loads of their own, and one
 * of those settling mid-test would bump a raw call count; asserting on which
 * listeners fired rather than how many times is immune to that.
 */
describe('onLanguageLoaded', () => {
  it('notifies subscribers when a grammar finishes loading', async () => {
    const fired: string[] = [];
    const unsubscribe = onLanguageLoaded(() => fired.push('subscribed'));

    // A language no other test here touches, so this call is what starts the
    // load and the notification cannot already have happened.
    expect(highlightCode('x = 1', 'python')).toBeNull();
    await descriptionFor('python').load();
    unsubscribe();

    expect(fired).toContain('subscribed');
  });

  it('stops notifying once the returned function is called', async () => {
    const fired: string[] = [];
    onLanguageLoaded(() => fired.push('unsubscribed'))();
    const unsubscribe = onLanguageLoaded(() => fired.push('subscribed'));

    expect(highlightCode('a {}', 'css')).toBeNull();
    await descriptionFor('css').load();
    unsubscribe();

    // The live listener is the control: without it this passes vacuously in
    // the case where no notification happened at all.
    expect(fired).toContain('subscribed');
    expect(fired).not.toContain('unsubscribed');
  });
});

/**
 * A grammar chunk that fails to load. Left unhandled this is an unhandled
 * rejection in the webview console *and* a language stuck as "requested" for
 * the rest of the session, i.e. never coloured again even once the network or
 * the build is fine.
 *
 * `LanguageDescription.of` gives a description whose `load` this test controls.
 * Pushing it onto `MARKDOWN_CODE_LANGUAGES` is contained: vitest gives each
 * test file its own module registry, so this array is not the one any other
 * file sees. It goes on the end, and `matchLanguageName` does a full exact pass
 * before any fuzzy matching, so no other name can reach it.
 */
describe('a grammar that fails to load', () => {
  it('is retried on the next render rather than pinned as requested', async () => {
    let attempts = 0;
    MARKDOWN_CODE_LANGUAGES.push(
      LanguageDescription.of({
        name: 'never-loads',
        load: () => {
          attempts++;
          return Promise.reject(new Error('no chunk'));
        },
      }),
    );

    expect(highlightCode('x', 'never-loads')).toBeNull();
    expect(attempts).toBe(1);
    await settle();

    expect(highlightCode('x', 'never-loads')).toBeNull();
    expect(attempts).toBe(2);
    // Let the second failure be handled too, so an unhandled rejection cannot
    // escape into the next test file instead of failing this one.
    await settle();
  });
});
