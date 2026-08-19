// @vitest-environment jsdom
/**
 * `WailsInvoke` is injected by the Wails runtime and does not exist here, which
 * is why `mountWindowEdges` takes it as a parameter -- these tests pass a spy.
 * The default (the real global, or `null` when there is none) is covered by its
 * own case below.
 *
 * What no test here can check is whether Windows then actually resizes: that is
 * the manual list in `docs/testing.md`. What it can check is that the right
 * message is sent for the right edge, which is the part that was getting lost.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountWindowEdges } from './windowedges';

const teardowns: (() => void)[] = [];

afterEach(() => {
  while (teardowns.length > 0) teardowns.pop()!();
  document.body.replaceChildren();
});

function mount(invoke?: (message: string) => void): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  teardowns.push(mountWindowEdges(root, invoke ?? null));
  return root;
}

function edge(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`.window-edge--${name}`);
  expect(element, `there should be a ${name} edge`).not.toBeNull();
  return element!;
}

function mousedown(element: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}

describe('mountWindowEdges', () => {
  it('builds all four sides and all four corners', () => {
    const root = mount();

    expect([...root.children].map((child) => (child as HTMLElement).dataset.edge)).toEqual([
      'n',
      's',
      'e',
      'w',
      'ne',
      'nw',
      'se',
      'sw',
    ]);
  });

  /**
   * The cursor names Wails' `edgeMap` is keyed by. A typo here is a strip that
   * looks right, reports nothing to the console, and silently does not resize --
   * `edgeMap[undefined]` is `undefined` and Go's `startResize` gets a zero.
   */
  it.each([
    ['n', 'resize:n-resize'],
    ['s', 'resize:s-resize'],
    ['e', 'resize:e-resize'],
    ['w', 'resize:w-resize'],
    ['ne', 'resize:ne-resize'],
    ['nw', 'resize:nw-resize'],
    ['se', 'resize:se-resize'],
    ['sw', 'resize:sw-resize'],
  ])('asks for %s with the message Wails expects', (name, message) => {
    const invoke = vi.fn();
    const root = mount(invoke);

    mousedown(edge(root, name));

    expect(invoke).toHaveBeenCalledExactlyOnceWith(message);
  });

  /**
   * Otherwise the drag selects text across the whole window and the OS resize
   * loop runs with a selection in progress.
   */
  it('prevents the default so the drag does not select text', () => {
    const root = mount(vi.fn());

    expect(mousedown(edge(root, 'e')).defaultPrevented).toBe(true);
  });

  /**
   * Wails' own `mousedown` listener sits on `window` and would fire for this
   * same event, asking for a second resize of the same gesture.
   */
  it('does not let the event reach Wails’ own window listener', () => {
    const onWindow = vi.fn();
    window.addEventListener('mousedown', onWindow);
    const root = mount(vi.fn());

    try {
      mousedown(edge(root, 'se'));
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('mousedown', onWindow);
    }
  });

  /**
   * A right-click should reach whatever is underneath rather than start a
   * resize the user cannot finish -- and middle-click paste on Linux later.
   */
  it('ignores buttons other than the left one', () => {
    const invoke = vi.fn();
    const root = mount(invoke);

    mousedown(edge(root, 'n'), { button: 2 });
    mousedown(edge(root, 'n'), { button: 1 });

    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * There is no `WailsInvoke` in Vitest or in `harness/layout.html`, and the
   * strips must still mount rather than throwing on the way past -- a throw
   * here runs during bootstrap, before `ShowWindow`.
   */
  it('mounts without a Wails runtime and does nothing on click', () => {
    const root = mount();

    expect(() => mousedown(edge(root, 'w'))).not.toThrow();
    expect(root.querySelectorAll('.window-edge')).toHaveLength(8);
  });

  it('is hidden from assistive technology, which has no resize gesture', () => {
    const root = mount();

    for (const element of root.querySelectorAll('.window-edge')) {
      expect(element.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('removes every strip when torn down', () => {
    const root = mount(vi.fn());

    teardowns.pop()!();

    expect(root.querySelectorAll('.window-edge')).toHaveLength(0);
  });
});
