// @vitest-environment jsdom
/**
 * A focused sibling to main.test.ts, in its own file so its LoadSettings
 * mock can resolve a `toolbar.pinned` list that differs from
 * `DEFAULT_PINNED` -- main.test.ts's shared `beforeAll` bootstrap already
 * commits to one mocked settings shape (deliberately equal to
 * DEFAULT_PINNED, so its own tests aren't testing settings-seeding at all),
 * and a bootstrap only runs once per module instance. Vitest gives every
 * test *file* its own fresh module registry by default, which is exactly
 * what a second, differently-mocked bootstrap needs.
 *
 * This is the test that actually proves Task 8's "seed the initial list from
 * settings": the plausible wrong implementation it is built to catch is a
 * `mountToolbar` call that still hard-codes `DEFAULT_PINNED` (i.e. Task 8's
 * seeding change never actually shipped, or got seeded from the store's
 * pre-bootstrap placeholder instead of the loaded settings). That
 * implementation would pass every test in main.test.ts, because that file's
 * mock happens to use the same ten ids as DEFAULT_PINNED -- it would only
 * fail here, where the mocked pinned list is deliberately disjoint from it.
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
    // Neither of these is in DEFAULT_PINNED (bold, italic, strikethrough,
    // inlineCode, heading, bulletList, numberedList, taskList, link, table).
    toolbar: { visible: true, pinned: ['blockquote', 'footnote'] },
  }),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

describe('bootstrap seeding the toolbar from settings', () => {
  it('renders the pinned commands settings.json named, not the compiled-in default', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());

    expect(document.querySelector('[data-command="blockquote"]')).not.toBeNull();
    expect(document.querySelector('[data-command="footnote"]')).not.toBeNull();
    // 'bold' is in DEFAULT_PINNED but not in this settings file's list --
    // its presence here would mean the seed came from the compiled-in
    // default instead of settings.toolbar.pinned.
    expect(document.querySelector('[data-command="bold"]')).toBeNull();
  });
});
