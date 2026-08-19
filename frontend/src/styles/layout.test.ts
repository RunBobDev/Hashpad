/**
 * The flex-shrink rules that keep wide content reachable.
 *
 * This parses the stylesheets rather than measuring anything, and that is a
 * compromise worth naming: the property under test is *layout*, jsdom has no
 * layout engine, and a real browser is the only place it can be observed.
 * `frontend/harness/layout.html` is where it was observed -- it reports, for
 * every container that could scroll, whether its content overflows and whether
 * the user can scroll to it.
 *
 * What this file can still do is stop the declaration being deleted. That is
 * narrower than proving the layout works, and it is the difference between a
 * regression caught in CI and one caught by the owner running the app -- which
 * is how this one was caught.
 *
 * The bug, for the next person: `.editor-split` had no `min-width: 0`. While it
 * was a child of `#app` -- a flex *column* -- width was the cross axis and the
 * flex default of `min-width: auto` never applied. G.3a put it inside
 * `.workspace`, a flex *row*, which made width the main axis; the row then
 * refused to shrink below its content's min-content width, which a single
 * 400-character unbroken token in the preview can make enormous. Measured at a
 * 900px window: `.editor-split` became 3945px, carrying the preview pane and
 * its own horizontal scrollbar off the right edge, and `html, body { overflow:
 * hidden }` meant there was nothing left to scroll them back with. The clipped
 * text was simply unreachable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

/**
 * Both stylesheets, because the rules under test are split across them: the
 * chrome rows are in `app.css`, and `.preview-pane` moved to `preview.css` with
 * the prose styling in Checkpoint F. Which file a selector lives in is not what
 * this file asserts, so it looks in both rather than hard-coding the split and
 * going stale the next time something moves.
 */
const SHEETS = [read('./app.css'), read('./preview.css')];

/** The declarations inside one top-level rule, by selector. */
function rule(selector: string): string {
  for (const css of SHEETS) {
    const start = css.indexOf('\n' + selector + ' {');
    if (start === -1) continue;
    return css.slice(start, css.indexOf('\n}', start));
  }
  return expect.fail('no ' + selector + ' rule in app.css or preview.css');
}

describe('flex items that must be allowed to shrink', () => {
  /**
   * Every child of a flex **row** here. A flex item defaults to
   * `min-width: auto`, so any one of these without the override can push the
   * row wider than the window -- and `html, body { overflow: hidden }` means
   * that overflow is not scrollable, just gone.
   */
  it.each([['.editor-split'], ['.editor-area'], ['.preview-pane'], ['.outline-column']])(
    '%s declares min-width: 0',
    (selector) => {
      expect(rule(selector)).toMatch(/min-width:\s*0\s*;/);
    },
  );

  /**
   * The two rows themselves need `min-height: 0` for the same reason on the
   * other axis: they are items of `#app`'s flex *column*, and without it a long
   * document stretches the row instead of scrolling inside it, walking the
   * status bar off the bottom of the window.
   */
  it.each([['.workspace'], ['.editor-split']])('%s declares min-height: 0', (selector) => {
    expect(rule(selector)).toMatch(/min-height:\s*0\s*;/);
  });

  /**
   * The frameless window's resize border (ui/windowedges.ts). Eight strips at
   * the rim, replacing three separate ways Wails' own edge detection failed
   * here: a native scrollbar swallowing the pointer on the right, the chrome
   * buttons on the top, and `outerHeight` not being `innerHeight` on the bottom.
   *
   * `position: fixed` is the load-bearing part -- it is what puts them at the
   * *window's* rim rather than inside whatever row they were appended to -- and
   * the z-index is what keeps them above popups, which is how a real resize
   * border behaves. Verified for real in `frontend/harness/layout.html`, where
   * `window.layout.rightEdge()` names what the pointer would land on.
   */
  it('the resize border is fixed to the viewport, above everything', () => {
    const edge = rule('.window-edge');

    expect(edge).toMatch(/position:\s*fixed\s*;/);
    expect(edge).toMatch(/z-index:\s*\d+\s*;/);
  });

  /** All four sides, or one of them silently is not resizable. */
  it.each([['n'], ['s'], ['e'], ['w'], ['ne'], ['nw'], ['se'], ['sw']])(
    'declares a .window-edge--%s rule',
    (edge) => {
      expect(() => rule(`.window-edge--${edge}`)).not.toThrow();
    },
  );

  /**
   * Both popup kinds. The window can be shorter than a nine-item View menu when
   * it is not maximised, and an unbounded popup is simply clipped by the window
   * with no way to reach the rest of it -- reported by the owner. The bound has
   * to come with the scroll: `max-height` alone would clip it just the same,
   * only sooner.
   */
  it.each([['.menu-popup'], ['.popup-menu']])('%s is bounded and scrolls', (selector) => {
    const popup = rule(selector);

    expect(popup).toMatch(/max-height:\s*calc\(100dvh/);
    expect(popup).toMatch(/overflow-y:\s*auto\s*;/);
  });

  /**
   * The pane is what scrolls when its content is too wide, so its own overflow
   * must stay `auto`. `hidden` here would clip the same text with no scrollbar
   * -- the symptom this whole file is about, reached by a different route.
   */
  it('the preview pane can scroll in both directions', () => {
    const pane = rule('.preview-pane');

    expect(pane).toMatch(/overflow:\s*auto\s*;/);
    expect(pane).not.toMatch(/overflow-x:\s*hidden/);
  });
});
