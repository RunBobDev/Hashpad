// @vitest-environment jsdom
/**
 * See main.toolbarSeed.test.ts's header for why this needs its own file: a
 * bootstrap only runs once per module instance, and this scenario needs a
 * `LoadSettings` mock (`toolbar.visible: false`) that neither main.test.ts's
 * nor main.toolbarSeed.test.ts's bootstrap uses.
 *
 * Proves ambiguity #3 from the Task 8 brief: `toolbar.visible: false` means
 * `mountToolbar` is never called at all, not called-and-then-hidden with
 * CSS. The plausible wrong implementation this catches is one that always
 * mounts the toolbar and only toggles a `display: none`-style class on it --
 * that would leave `.toolbar` in the DOM, which the assertion below treats
 * as a failure just as much as the wrong pinned set would.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ShowWindow } from '../wailsjs/go/app/App';

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  // ui/filedrop.ts subscribes at module load. A missing export here is a hard
  // mock error rather than a silent fallback, which is how these five files
  // announced themselves the moment main.ts imported it.
  OnFileDrop: vi.fn(),
  OnFileDropOff: vi.fn(),
  // ui/fullscreen.ts reads this at startup. It returns a promise, so a bare
  // vi.fn() would make `await` yield undefined and set the flag to that.
  WindowIsFullscreen: vi.fn(async () => false),
  WindowFullscreen: vi.fn(),
  WindowUnfullscreen: vi.fn(),
  WindowSetBackgroundColour: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  // bootstrap asks Go which files this launch was given (files/openwith.ts).
  // Without it the default parameter throws on property access, which happens
  // outside that function's try/catch and lands as an unhandled rejection --
  // the same way OnFileDrop announced itself in the runtime mock above.
  PendingFiles: vi.fn().mockResolvedValue([]),
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    // bootstrap validates `window.previewSplitRatio` and seeds the store with it.
    window: {
      previewSplitRatio: 0.5,
      statusBarVisible: false,
      outlineVisible: false,
      outlineWidth: 240,
    },
    // Also read by bootstrap. Go always sends the block, so a mock without it
    // would make bootstrap throw where the real app never can.
    // Both blocks are read by bootstrap and Go always sends them, so a mock
    // without them makes bootstrap throw where the real app never can -- and a
    // bootstrap that throws silently runs its `catch` path, seeding every
    // setting from the compiled-in defaults instead of from this mock. That is
    // exactly what happened to this file between G.1 and G.2: `editor` was
    // added to the read and not to the mock, and no test noticed.
    preview: { syncScroll: true },
    editor: { wordWrap: true },
    // Go always sends this block, so a mock without it makes bootstrap throw
    // where the real app never can -- and a bootstrap that throws runs its
    // catch path, seeding every setting from the compiled-in defaults instead
    // of from this mock. See main.toolbarSeed.test.ts for the time that bit.
    files: { defaultEncoding: 'utf-8' },
    toolbar: { visible: false, pinned: ['bold'] },
  }),
  ReadFile: vi.fn(),
  ResetSettings: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

describe('bootstrap honouring the chrome visibility settings', () => {
  /**
   * In `beforeAll` rather than in the first `it`, which is where it used to be.
   * A bootstrap runs once per module instance and the ESM registry is shared
   * across a file, so a second test cannot import it again -- it gets the
   * cached module and whatever DOM the first test left. That was fine while
   * there was one test; the moment G.2 added a second, the pair only passed in
   * declaration order and `vitest --sequence.shuffle` failed on it. Hoisting
   * the setup is what makes each test independent of the others' order, which
   * is the arrangement `main.toolbarSeed.test.ts` already uses.
   */
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
  });

  it('does not mount the toolbar when toolbar.visible is false', () => {
    expect(document.querySelector('.toolbar')).toBeNull();
    // The menu bar is unrelated to this setting and must still be there --
    // otherwise this test would also pass against a bootstrap that crashed
    // before mounting anything at all, which is not what it claims to prove.
    expect(document.querySelector('[role="menubar"]')).not.toBeNull();
  });

  /** The same claim for SPEC 6.11's row, and the same guard against a crash. */
  it('does not mount the status bar when window.statusBarVisible is false', () => {
    expect(document.querySelector('.statusbar')).toBeNull();
    expect(document.querySelector('[role="menubar"]')).not.toBeNull();
  });
});
