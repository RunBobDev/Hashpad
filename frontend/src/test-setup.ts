/**
 * jsdom's `Range` implements neither `getClientRects` nor
 * `getBoundingClientRect`, and CodeMirror calls the first one from
 * `clientRectsFor` during its measure phase (`@codemirror/view`'s
 * `DocView.measureTextSize`). Measuring is queued on an animation frame, so a
 * test that constructs a real `EditorView` and then dispatches -- most
 * relevantly `switchToDocument`, which does `setState` plus a scroll-snapshot
 * effect -- throws *after* the test body has finished. Vitest reports it as an
 * unhandled error: the tests still pass, but the runner exits 1 and warns that
 * the run may contain false positives.
 *
 * Returning empty geometry is the honest answer here. jsdom has no layout
 * engine, so there are no real rects to hand back, and CodeMirror already
 * treats a zero-sized measurement as "not visible yet" rather than as a
 * dimension to trust. `preview/pane.test.ts` stubs `getBoundingClientRect` on
 * the specific elements whose width it needs, which is the pattern to follow
 * when a test actually depends on geometry -- this file exists to stop the
 * measure loop throwing, not to fake layout.
 *
 * Guarded on `typeof Range`: `vite.config.ts` keeps the default environment at
 * `node`, so most test files have no DOM globals at all and this must be inert
 * for them.
 */
if (typeof Range !== 'undefined') {
  const empty = { length: 0, item: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() };

  Range.prototype.getClientRects ??= function getClientRects() {
    return empty as unknown as DOMRectList;
  };

  Range.prototype.getBoundingClientRect ??= function getBoundingClientRect() {
    return new DOMRect(0, 0, 0, 0);
  };
}

/**
 * jsdom implements no scrolling at all, so `Element.scrollIntoView` is simply
 * absent -- calling it throws rather than doing nothing. Real code calls it for
 * good reasons (`ui/outline.ts` keeps the current section in view,
 * `preview/pane.ts` follows a `#fragment`), and every browser has it.
 *
 * A no-op rather than a spy: what these calls *do* is scrolling, which jsdom
 * cannot model and no assertion here could check honestly. The tests around
 * them assert the state that drives the scroll -- which item is
 * `aria-current`, which anchor was resolved -- and leave the scrolling itself
 * to the manual checks in docs/testing.md.
 *
 * `??=` so a test that wants to watch the call can install its own first, and
 * guarded on `typeof Element` because most test files run under the default
 * `node` environment with no DOM globals at all.
 */
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView ??= function scrollIntoView() {
    /* jsdom has no layout to scroll. */
  };
}
