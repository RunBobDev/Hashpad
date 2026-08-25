// @vitest-environment jsdom
/**
 * "Close the app and the preview disappears" -- the launch half of the owner's
 * report, and the half no other file can cover.
 *
 * In its own file for the reason main.toolbarSeed.test.ts is: a bootstrap runs
 * once per module instance, and this one needs a settings file whose
 * `editor.defaultViewMode` says `"split"`. main.preview.test.ts has already
 * committed to a mock that omits the key (so its toggle cases start from
 * source, deliberately), and Vitest gives every test *file* a fresh module
 * registry, which is exactly what a second, differently-mocked bootstrap wants.
 *
 * What this proves that main.preview.test.ts cannot: the pane is reached
 * through a dynamic import that only `togglePreview` used to perform, so
 * restoring a saved `"split"` at startup is a genuinely different path -- one
 * where no one has clicked anything and the handle is still null.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { store } from './state/appcontext';
import { activeDocument } from './state/documents';
import { COMMAND_EVENT } from './ui/menubar';
import { ShowWindow } from '../wailsjs/go/app/App';

/**
 * Hoisted so the `vi.mock` factory below can close over it -- the factory is
 * lifted above the imports, and a plain `let` here would still be in its
 * temporal dead zone when it runs.
 *
 * `ShowWindow` records whether the pane was already in the tree at the moment
 * it was called. That ordering is the point, not a detail: main.ts applies the
 * theme and the fonts before the window appears precisely so the user does not
 * watch them change on every launch, and a preview pane sliding in a frame
 * later is the same flaw.
 *
 * Moving the restore after `ShowWindow()` does currently fail the other three
 * cases too -- but only by timing, because `beforeAll` releases on `ShowWindow`
 * and the restore is then still in flight. That is a race, not an assertion:
 * one more `await` in the harness and those three would go green over a window
 * the user watches rearrange itself. This is the only case that pins the order
 * by construction.
 */
const probe = vi.hoisted(() => ({ paneWasUpAtShowWindow: null as boolean | null }));

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
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(() => {
    probe.paneWasUpAtShowWindow = document.querySelector('.preview-pane') !== null;
  }),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    toolbar: { visible: true, pinned: ['bold'] },
    window: {
      previewSplitRatio: 0.3,
      statusBarVisible: true,
      outlineVisible: false,
      outlineWidth: 240,
    },
    preview: { syncScroll: true },
    // The whole reason this file exists. `'source'` is both Go's default and
    // the store's pre-bootstrap placeholder, so a bootstrap that never read the
    // key would be indistinguishable from one that read it and got `'source'`.
    editor: { wordWrap: true, defaultViewMode: 'split' },
  }),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

function emit(command: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: command }));
}

describe('bootstrap restoring the saved view mode', () => {
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
  });

  /**
   * The startup document is minted at module scope, before `LoadSettings`
   * resolves, so it is always holding the compiled-in `'source'` when it is
   * created -- the same situation as the theme, the fonts and
   * `editorBehaviour`. Bootstrap catching it up is what this asserts.
   */
  it('opens the startup document in the saved mode', () => {
    expect(activeDocument(store.getState())!.viewMode).toBe('split');
  });

  it('has the pane on screen', () => {
    expect(document.querySelector('.preview-pane')).not.toBeNull();
  });

  /** See `probe`: applied before the window appears, not a frame after it. */
  it('mounts the pane before the window is shown', () => {
    expect(probe.paneWasUpAtShowWindow).toBe(true);
  });

  /**
   * Seeded into the store as well as onto the startup document, which is what
   * carries the mode to tabs opened later in the session -- a bootstrap that
   * only fixed up the one document would leave the second tab in source mode
   * and put the owner's report straight back.
   */
  it('seeds the store, so the next tab inherits it', () => {
    expect(store.getState().defaultViewMode).toBe('split');

    emit('file.new');

    expect(activeDocument(store.getState())!.viewMode).toBe('split');
    expect(document.querySelector('.preview-pane')).not.toBeNull();
  });
});
