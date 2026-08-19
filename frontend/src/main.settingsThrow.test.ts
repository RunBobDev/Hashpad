// @vitest-environment jsdom
/**
 * The window must become visible even when settings cannot be loaded at all.
 *
 * `main.go` uses `StartHidden`, so `ShowWindow()` at the end of bootstrap's
 * `finally` is the only thing that ever reveals the window -- anything that
 * throws between the start of bootstrap and that call leaves the app running
 * with no window and no way to reach it. Checkpoint D hit exactly that and had
 * to add a Go-side backstop; this is the frontend half.
 *
 * Its own file for the reason `main.toolbarSeed.test.ts`'s header gives: a
 * bootstrap runs once per module instance, and this one needs a `LoadSettings`
 * that fails.
 *
 * **Synchronous**, not a rejected promise, and that distinction is the whole
 * point. The generated binding is a plain
 * `window['go']['app']['App']['LoadSettings']()`, so a Wails runtime that has
 * not injected `window.go` yet makes the call throw a TypeError rather than
 * return a rejecting promise. Nothing has awaited at that moment, so bootstrap's
 * `catch` and `finally` run *inside module evaluation* rather than in a later
 * microtask -- which means every module-scope binding they touch must already
 * be initialised. A `let` declared below `void bootstrap()` is in its temporal
 * dead zone there, and reading it throws a ReferenceError that takes
 * `ShowWindow` down with it. G.2 introduced exactly that with
 * `statusBarTeardown` and this test is what catches it coming back.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ShowWindow } from '../wailsjs/go/app/App';

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  WindowSetBackgroundColour: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(),
  // Throws where the real binding would: reading `window.go` before Wails has
  // injected it. Not `mockRejectedValue` -- that suspends bootstrap at the
  // await and moves the catch into a microtask, which is the easy case.
  LoadSettings: vi.fn(() => {
    throw new TypeError("Cannot read properties of undefined (reading 'app')");
  }),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

describe('bootstrap when LoadSettings throws synchronously', () => {
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
  });

  it('still shows the window', () => {
    expect(ShowWindow).toHaveBeenCalled();
  });

  /**
   * And still mounts the compiled-in defaults, which is the difference between
   * "the settings file was ignored" and "the app came up broken". Go's
   * `DefaultSettings` has the status bar on and the toolbar visible, so a
   * failed load must land on both.
   */
  it('falls back to the compiled-in chrome rather than to nothing', () => {
    expect(document.querySelector('.statusbar')).not.toBeNull();
    expect(document.querySelector('.toolbar')).not.toBeNull();
    expect(document.querySelector('[role="menubar"]')).not.toBeNull();
  });

  it('leaves the status bar as the last row', () => {
    // Excluding the resize border, which is fixed to the viewport rather than
    // laid out in the column (ui/windowedges.ts).
    const rows = [...document.querySelector('#app')!.children]
      .map((child) => child.className)
      .filter((name) => !name.startsWith('window-edge'));

    expect(rows.pop()).toBe('statusbar');
  });
});
