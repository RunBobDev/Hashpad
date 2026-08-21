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

/**
 * The stacking order, which is the kind of thing that is only ever wrong in
 * combination -- and was.
 *
 * `@codemirror/view`'s base theme puts `.cm-panels` at **300**, a number from
 * the package rather than from us. Our menus were at 100, so with the find bar
 * open any dropdown overlapping it was painted underneath and the overlapping
 * rows simply disappeared. Reported by the owner. The window's resize border
 * was at 200 and had the same problem one layer up: the find bar covered the
 * top edge, so it could not be dragged while find was open.
 *
 * Both were a missing rule rather than two wrong numbers, so what is asserted
 * here is the *order*, not the values.
 */
describe('the stacking order', () => {
  /** `@codemirror/view`'s own `.cm-panels`. Not ours to set; everything above must clear it. */
  const CODEMIRROR_PANELS = 300;

  // Split rather than matched. A `new RegExp` built from a template literal
  // needs its backslashes doubled, and the first version of this silently did
  // not have them -- `\s` in a template literal is just `s`, so the pattern
  // matched nothing and the test failed for a reason that had nothing to do
  // with the stacking order. No escapes, no way to get that wrong.
  function token(name: string): number {
    const line = read('./variables.css')
      .split('\n')
      .find((candidate) => candidate.trim().startsWith(`--${name}:`));
    expect(line, `variables.css should define --${name}`).toBeDefined();
    return Number.parseInt(line!.split(':')[1]!.trim(), 10);
  }

  it('puts menus above CodeMirror’s editor panels', () => {
    expect(token('z-popup')).toBeGreaterThan(CODEMIRROR_PANELS);
  });

  /** A frameless window has no OS frame -- these strips *are* its edges. */
  it('puts the resize border above everything else', () => {
    expect(token('z-window-edge')).toBeGreaterThan(token('z-popup'));
    expect(token('z-window-edge')).toBeGreaterThan(CODEMIRROR_PANELS);
  });

  /** Every layer comes from the one list, so the next addition has to join it. */
  it.each([['.menu-popup'], ['.popup-menu'], ['.window-edge']])(
    '%s takes its layer from a token rather than a literal',
    (selector) => {
      expect(rule(selector)).toMatch(/z-index:\s*(var\(--z-|calc\(var\(--z-)/);
    },
  );
});

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
    expect(edge).toMatch(/z-index:\s*var\(--z-window-edge\)\s*;/);
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
   * The find bar is one line and must stay one. Wrapping to a second row as the
   * window narrows would shift the editor down under the user's cursor mid-type,
   * so the fields shrink instead -- which is what `min-width: 0` on them buys.
   *
   * Asserted here rather than in `findreplace.test.ts` because jsdom loads no
   * stylesheet: a test there can read the class list, never what the classes do.
   */
  it('the find bar stays on one line', () => {
    expect(rule('.findbar')).toMatch(/flex-wrap:\s*nowrap\s*;/);
    expect(rule('.findbar__input')).toMatch(/min-width:\s*0\s*;/);
  });

  /**
   * The match count reserves width it usually does not fill, and where that
   * slack lands is what groups the row. It sits last in the find group
   * (`ui/findreplace.ts`), so left-aligning it keeps the number against the find
   * controls and leaves the slack trailing as the gap before replace. Right
   * would push the number over to the replace field and read as belonging to it
   * -- the same misgrouping the owner reported when the count sat between the
   * find field and its buttons.
   */
  it('the match count hugs the find controls', () => {
    const count = rule('.findbar__count');

    expect(count).toMatch(/min-width:\s*76px\s*;/);
    expect(count).toMatch(/text-align:\s*left\s*;/);
  });

  /**
   * settings.editor.maxContentWidth (SPEC §6.13), which `settings/typography.ts`
   * writes to `--max-content-width`. Both panes honour it, because it is a
   * *measure* -- how far a line runs before wrapping -- and a side-by-side view
   * whose halves disagree about that defeats the point.
   *
   * The cap goes on what holds the text, never on what scrolls: capping the
   * scrolling element would pull its scrollbar into the middle of the window.
   * For the preview that means its children; the editor's half lives in
   * `editor/theme.ts` on `.cm-content`, which is not a stylesheet and so is not
   * visible from here.
   */
  it('the preview caps its content width without capping the scroller', () => {
    expect(rule('.preview-pane > *')).toMatch(/max-width:\s*var\(--max-content-width\)\s*;/);
    expect(rule('.preview-pane')).not.toMatch(/max-width:/);
  });

  /**
   * The compiled-in default is `none`, not `900px`. typography.ts sets the real
   * value before the window is shown, so this only applies if that never runs --
   * and an unwired app showing full-width text is right, where one silently
   * capped at 900px looks like a layout bug.
   */
  it('defaults the content width to no limit', () => {
    const line = read('./variables.css')
      .split('\n')
      .find((candidate) => candidate.trim().startsWith('--max-content-width:'));

    expect(line?.trim()).toBe('--max-content-width: none;');
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
