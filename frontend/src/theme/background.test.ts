// @vitest-environment jsdom
/**
 * `applyTheme` telling Wails what colour the *window* is.
 *
 * Its own file because it needs jsdom and two mocked collaborators, while
 * `theme.test.ts` deliberately runs under the default `node` environment on
 * pure functions alone.
 *
 * `getComputedStyle` is stubbed, and that is not a shortcut -- it is the whole
 * reason this file exists. jsdom resolves `var(--bg-app)` to the empty string,
 * so against the real one `syncWindowBackground` takes its "unparseable, leave
 * it alone" branch every time and the call under test never happens. A test
 * written without the stub would pass whatever the code did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowSetBackgroundColour } from '../../wailsjs/runtime/runtime';
import { applyTheme } from './theme';

vi.mock('../../wailsjs/runtime/runtime', () => ({ WindowSetBackgroundColour: vi.fn() }));
vi.mock('../editor/theme', () => ({ setEditorDark: vi.fn() }));
vi.mock('../state/appcontext', () => ({
  getEditorView: () => ({}),
  store: { setState: vi.fn(), getState: () => ({}), subscribe: () => () => {} },
}));

const realComputedStyle = window.getComputedStyle;

/** Makes `--bg-app` resolve to `value`, the way a real browser would. */
function stubBackground(value: string): void {
  window.getComputedStyle = ((element: Element) => {
    const real = realComputedStyle.call(window, element);
    return { ...real, getPropertyValue: (name: string) => (name === '--bg-app' ? value : '') };
  }) as typeof window.getComputedStyle;
}

beforeEach(() => {
  vi.mocked(WindowSetBackgroundColour).mockClear();
});

afterEach(() => {
  window.getComputedStyle = realComputedStyle;
});

describe('applyTheme keeping the window background in step', () => {
  /**
   * `main.go` sets an opaque white window background so nothing flashes dark
   * before CSS applies. While a window is being *resized*, Windows fills the
   * newly exposed strip with that same colour before WebView2 paints there --
   * which in the dark theme is a white flash down the edge being dragged. This
   * is what stops it.
   */
  it('sends the dark theme’s background to Wails', () => {
    stubBackground('#1f1f1f');

    applyTheme(true);

    expect(WindowSetBackgroundColour).toHaveBeenCalledExactlyOnceWith(0x1f, 0x1f, 0x1f, 255);
  });

  it('sends the light theme’s background too', () => {
    stubBackground('#f3f3f3');

    applyTheme(false);

    expect(WindowSetBackgroundColour).toHaveBeenCalledExactlyOnceWith(0xf3, 0xf3, 0xf3, 255);
  });

  /** Reads whatever the stylesheet says, rather than a copy kept in TypeScript. */
  it('follows the token rather than a hard-coded pair of colours', () => {
    stubBackground('#123456');

    applyTheme(true);

    expect(WindowSetBackgroundColour).toHaveBeenCalledExactlyOnceWith(0x12, 0x34, 0x56, 255);
  });

  it('expands the three-digit form', () => {
    stubBackground('#abc');

    applyTheme(false);

    expect(WindowSetBackgroundColour).toHaveBeenCalledExactlyOnceWith(0xaa, 0xbb, 0xcc, 255);
  });

  /**
   * Leaves the window alone rather than guessing. The empty string is what
   * jsdom returns and what a browser returns for an undefined property, and
   * guessing white there would reintroduce the exact flash this fixes.
   */
  it.each([[''], ['rgb(0, 0, 0)'], ['red'], ['#12345'], ['#0078d4; --bg-app: red']])(
    'says nothing when --bg-app reads as %s',
    (value) => {
      stubBackground(value);

      applyTheme(true);

      expect(WindowSetBackgroundColour).not.toHaveBeenCalled();
    },
  );

  /** The theme still applies even when the colour cannot be handed over. */
  it('still sets data-theme when the colour is unusable', () => {
    stubBackground('');

    applyTheme(true);

    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
