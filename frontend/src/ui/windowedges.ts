/**
 * The window's resize borders, as page content.
 *
 * The window is frameless (main.go), so Windows gives it no resize border and
 * Wails synthesises one in JavaScript: its injected runtime watches `mousemove`
 * on `window`, sets a flag when the pointer is within `borderThickness` of an
 * edge, and the next `mousedown` asks Go to start an OS resize. That works
 * until something about the edge is not an ordinary element, and three separate
 * ways it failed here were reported by the owner:
 *
 * - **A native scrollbar.** Chromium dispatches no mouse events over one, so
 *   the pointer could be on the right edge and Wails never heard about it.
 * - **The chrome buttons.** The top edge is entirely menu-bar and window-control
 *   buttons, and it would not resize over any of them.
 * - **The bottom edge needing pixel-perfect aim.** Wails compares `clientY`
 *   against `window.outerHeight`, which is the *window* rect and includes
 *   whatever Windows keeps outside the client area; the two are not the same
 *   number, and the difference eats most of a 6px band.
 *
 * Rather than work out which of those applies where, this removes the
 * dependency: eight elements -- four edges and four corners -- sit at the
 * window's rim and ask for the resize themselves. Their geometry is ours, so
 * the band is exactly `--resize-gutter` everywhere, and nothing underneath them
 * can swallow the pointer.
 *
 * This is also how a native window behaves: the caption buttons on a real
 * Windows title bar sit *below* the resize border, and the top few pixels of
 * the close button resize rather than close.
 */

/** The eight directions, as the cursor names Wails' `edgeMap` is keyed by. */
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Edge = (typeof EDGES)[number];

/**
 * The `WailsInvoke` the injected runtime installs on `window`. Not part of
 * `wailsjs/runtime`, which is the *generated* binding surface and has no resize
 * call at all -- this is the same private channel Wails' own runtime uses, and
 * the only one there is.
 *
 * Typed as possibly absent and feature-detected at the call site rather than
 * assumed, because it genuinely is absent in two places: Vitest, and
 * `harness/layout.html` in a plain browser. Missing simply means no explicit
 * resize, which leaves Wails' own edge detection as it was.
 */
type Invoke = (message: string) => void;

function wailsInvoke(): Invoke | null {
  const candidate = (window as unknown as { WailsInvoke?: Invoke }).WailsInvoke;
  return typeof candidate === 'function' ? candidate : null;
}

/**
 * Builds the eight elements and returns a teardown.
 *
 * `invoke` is injectable so tests can watch what is asked for without a Wails
 * runtime; the default is the real one, or `null` when there is none.
 */
export function mountWindowEdges(
  parent: HTMLElement,
  invoke: Invoke | null = wailsInvoke(),
): () => void {
  const elements = EDGES.map((edge) => build(edge, invoke));
  parent.append(...elements);

  return () => {
    for (const element of elements) element.remove();
  };
}

function build(edge: Edge, invoke: Invoke | null): HTMLElement {
  const element = document.createElement('div');
  element.className = `window-edge window-edge--${edge}`;
  element.dataset.edge = edge;
  // Decoration for the pointer; it has nothing to say to a screen reader, and
  // it is not reachable by keyboard because there is no keyboard gesture for
  // "resize the window" to give it.
  element.setAttribute('aria-hidden', 'true');

  element.addEventListener('mousedown', (event) => {
    // Left button only. A right-click here should reach whatever context menu
    // the app has rather than start a resize the user cannot finish.
    if (event.button !== 0) return;
    // Without this the drag selects text across the whole window, and the OS
    // resize loop then runs with a selection in progress.
    event.preventDefault();
    // Wails' own `mousedown` listener is on `window` and would fire for this
    // same event, asking for a second resize. Harmless in practice, but one
    // request per gesture is the honest thing to send.
    event.stopPropagation();
    invoke?.(`resize:${edge}-resize`);
  });

  return element;
}
