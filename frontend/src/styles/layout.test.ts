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
   * The window is frameless, so its right edge is page content rather than an
   * OS frame: Wails arms a resize from a `mousemove` near the edge, and
   * Chromium dispatches no mouse events over a native scrollbar -- which is
   * 15px and sits flush there, swallowing Wails' whole 6px band. `.resize-gutter`
   * is a real element in that band so the pointer has something to be over.
   *
   * Three declarations, each load-bearing: `position: absolute` is what lifts
   * it above the scrollbar (a positioned element paints above in-flow content,
   * which is why no `z-index` is needed and none is asserted -- an earlier
   * version pinned one, and the harness showed the gutter wins the hit test
   * without it); `right: 0` is what puts it on the edge; and without a width it
   * is nothing at all.
   *
   * Verified for real in `frontend/harness/layout.html`, where
   * `window.layout.rightEdge()` reports `resize-gutter` with it and
   * `preview-pane` -- the scroll container, meaning its scrollbar -- without.
   */
  it('the resize gutter covers the right edge, above the scrollbar', () => {
    const gutter = rule('.resize-gutter');

    expect(gutter).toMatch(/position:\s*absolute\s*;/);
    expect(gutter).toMatch(/right:\s*0\s*;/);
    expect(gutter).toMatch(/width:\s*var\(--resize-gutter\)\s*;/);
  });

  /** Absolute positioning needs a positioned ancestor, or it escapes the row. */
  it('the workspace is the gutter’s containing block', () => {
    expect(rule('.workspace')).toMatch(/position:\s*relative\s*;/);
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
