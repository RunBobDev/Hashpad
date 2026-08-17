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
import { describe, expect, it, vi } from 'vitest';
import { ShowWindow } from '../wailsjs/go/app/App';

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    // bootstrap validates `window.previewSplitRatio` and seeds the store with it.
    window: { previewSplitRatio: 0.5 },
    // Also read by bootstrap. Go always sends the block, so a mock without it
    // would make bootstrap throw where the real app never can.
    preview: { syncScroll: true },
    toolbar: { visible: false, pinned: ['bold'] },
  }),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

describe('bootstrap honouring settings.toolbar.visible', () => {
  it('does not mount the toolbar when toolbar.visible is false', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());

    expect(document.querySelector('.toolbar')).toBeNull();
    // The menu bar is unrelated to this setting and must still be there --
    // otherwise this test would also pass against a bootstrap that crashed
    // before mounting anything at all, which is not what it claims to prove.
    expect(document.querySelector('[role="menubar"]')).not.toBeNull();
  });
});
