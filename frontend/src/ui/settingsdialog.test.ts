// @vitest-environment jsdom
/**
 * SPEC §6.13's dialog. Everything here goes through `buildSettingsDialog`
 * rather than `openSettings`, for the reason confirmdialog.test.ts does the
 * same: jsdom implements `<dialog>` as a bare `HTMLElement` with no
 * `showModal()`, so anything downstream of showing it is unreachable. What is
 * reachable is every part where a bug would actually live -- a control carrying
 * the loaded value, a change applying *and* persisting, and teardown running
 * once -- because those are plain event dispatch.
 *
 * The debounce is real time, not fake: `vi.useFakeTimers()` would also freeze
 * the promise machinery inside `persist`, and the assertions here are about
 * what reaches `SaveSettings` after an `await`. 300 ms of real waiting in three
 * cases is cheaper than the ceremony of interleaving the two clocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { COMMAND_EVENT } from './menubar';
import { buildSettingsDialog } from './settingsdialog';
import type { app } from '../../wailsjs/go/models';

vi.mock('../../wailsjs/go/app/App', () => ({
  LoadSettings: vi.fn(),
  SaveSettings: vi.fn(),
}));

/**
 * A settings object shaped like Go's, with values that are deliberately **not**
 * the compiled-in defaults -- the accent is not `#0078d4` and the UI size is
 * not 14, so a control populated from a guess rather than from this cannot
 * pass by coincidence.
 */
function settingsFixture(overrides: Partial<app.AppearanceSettings> = {}): app.Settings {
  return {
    version: 2,
    appearance: { theme: 'dark', accentColor: '#aa3355', uiFontSize: 18, ...overrides },
    editor: {
      fontFamily: 'Cascadia Mono',
      fontSize: 14,
      lineHeight: 1.6,
      wordWrap: true,
      maxContentWidth: 0,
      showLineNumbers: false,
      tabSize: 2,
      insertSpaces: true,
      defaultViewMode: 'source',
    },
    preview: { fontFamily: 'Segoe UI', fontSize: 15, syncScroll: true },
    files: {
      autosave: false,
      autosaveDelayMs: 2000,
      assetFolder: 'assets',
      defaultEncoding: 'utf-8',
    },
    window: {
      width: 1000,
      height: 700,
      maximized: false,
      outlineVisible: false,
      outlineWidth: 240,
      statusBarVisible: true,
      previewSplitRatio: 0.5,
    },
    toolbar: { visible: true, pinned: ['bold'] },
  } as unknown as app.Settings;
}

/** Mounted for real, because `applyAccent`/`applyTypography` write to `<html>`. */
function mount(settings: app.Settings = settingsFixture()): HTMLDialogElement {
  const dialog = buildSettingsDialog(settings);
  document.body.append(dialog);
  return dialog;
}

function control<T extends HTMLElement>(dialog: HTMLElement, selector: string): T {
  return dialog.querySelector<T>(selector)!;
}

/** The debounce is 300 ms; this clears it with room to spare on a busy machine. */
function afterDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 450));
}

beforeEach(() => {
  vi.mocked(LoadSettings).mockResolvedValue(settingsFixture());
  vi.mocked(SaveSettings).mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  vi.clearAllMocks();
});

describe('the controls carry the loaded settings', () => {
  it('selects the theme the file names', () => {
    const dialog = mount();

    expect(control<HTMLSelectElement>(dialog, 'select').value).toBe('dark');
  });

  it('shows the accent colour and the UI font size', () => {
    const dialog = mount();

    expect(control<HTMLInputElement>(dialog, 'input[type="color"]').value).toBe('#aa3355');
    expect(control<HTMLInputElement>(dialog, 'input[type="number"]').value).toBe('18');
  });

  /**
   * A hand-edited accent that bootstrap refused to apply must not make the
   * swatch disagree with the window. Bootstrap validates the field before it
   * reaches a CSS custom property and skips an invalid one, so what is *in
   * force* is variables.css's default -- and that is what the swatch shows.
   *
   * The naive version of this -- only assign when the value is valid -- is
   * unfalsifiable, which is why the fallback exists rather than a guard: an
   * unset colour input reads `#000000`, and so does one assigned `'red'`,
   * because `type="color"` sanitises anything that is not `#rrggbb`. Asserting
   * `not.toBe('red')` passes either way. Hence a positive assertion against a
   * value nothing else in this test could produce.
   */
  it.each([['red'], [''], ['#0078d4; --bg-app: red'], ['rgb(0,0,0)']])(
    'shows the accent actually in force when the file says %s',
    (accentColor) => {
      // Stands in for variables.css, which jsdom does not load.
      document.documentElement.style.setProperty('--accent-base', '#3c9f41');

      const dialog = mount(settingsFixture({ accentColor }));

      expect(control<HTMLInputElement>(dialog, 'input[type="color"]').value).toBe('#3c9f41');
    },
  );

  /** With nothing in force either, the input's own default is all that is left. */
  it('falls back to the input default when even the root has no accent', () => {
    const dialog = mount(settingsFixture({ accentColor: 'red' }));

    expect(control<HTMLInputElement>(dialog, 'input[type="color"]').value).toBe('#000000');
  });

  /**
   * `#RGB` is valid CSS and `isValidAccent` accepts it, so bootstrap really
   * does apply `"#fff"` and the window really is white-accented -- but
   * `type="color"` holds only `#rrggbb` and sanitises three digits to
   * `#000000`. Left alone, the swatch would show black for a setting that is
   * working, and the first click on it would write black back over the file.
   */
  it.each([
    ['#fff', '#ffffff'],
    ['#F0A', '#ff00aa'],
    ['#AABBCC', '#aabbcc'],
  ])('expands and normalises %s to %s for the swatch', (accentColor, expected) => {
    const dialog = mount(settingsFixture({ accentColor }));

    expect(control<HTMLInputElement>(dialog, 'input[type="color"]').value).toBe(expected);
  });
});

describe('changing a setting', () => {
  /**
   * The theme is the one control that does not write anything itself: it emits
   * the command the View menu emits, because main.ts holds the `themeMode`
   * local that the window-focus listener reads to decide whether an OS theme
   * change may override an explicit choice. A second writer would leave that
   * local behind, and the app would start following the system again after the
   * next Alt-Tab.
   */
  it('routes the theme through the command bus rather than saving it here', () => {
    const dialog = mount();
    const commands: string[] = [];
    const listen = (event: Event): void => {
      commands.push((event as CustomEvent<string>).detail);
    };
    document.addEventListener(COMMAND_EVENT, listen);

    const select = control<HTMLSelectElement>(dialog, 'select');
    select.value = 'light';
    select.dispatchEvent(new Event('change'));
    document.removeEventListener(COMMAND_EVENT, listen);

    expect(commands).toEqual(['theme.light']);
    expect(SaveSettings).not.toHaveBeenCalled();
  });

  /** "Takes effect immediately" (SPEC §6.13) means before any disk write. */
  it('applies the accent colour to the page at once, and persists it after', async () => {
    const dialog = mount();
    const accent = control<HTMLInputElement>(dialog, 'input[type="color"]');

    accent.value = '#11ff22';
    accent.dispatchEvent(new Event('input'));

    expect(document.documentElement.style.getPropertyValue('--accent-base')).toBe('#11ff22');
    // Debounced, so nothing has been written yet -- the colour picker fires
    // `input` continuously while the user drags, and each one would be two IPC
    // round trips and a file write.
    expect(SaveSettings).not.toHaveBeenCalled();

    await afterDebounce();
    expect(vi.mocked(SaveSettings).mock.lastCall?.[0].appearance.accentColor).toBe('#11ff22');
  });

  it('applies and persists the UI font size', async () => {
    const dialog = mount();
    const size = control<HTMLInputElement>(dialog, 'input[type="number"]');

    size.value = '20';
    size.dispatchEvent(new Event('input'));

    expect(document.documentElement.style.getPropertyValue('--size-ui')).toBe('20px');

    await afterDebounce();
    expect(vi.mocked(SaveSettings).mock.lastCall?.[0].appearance.uiFontSize).toBe(20);
  });

  /**
   * Clearing a number field to retype it leaves it empty for a keystroke, and
   * an empty field reads as `NaN`. Writing that would save the clamp fallback
   * over the value the user is halfway through replacing -- so an unparseable
   * field is ignored rather than applied.
   */
  it('ignores an emptied font-size field instead of writing a fallback', async () => {
    const dialog = mount();
    const size = control<HTMLInputElement>(dialog, 'input[type="number"]');

    size.value = '';
    size.dispatchEvent(new Event('input'));

    await afterDebounce();
    expect(SaveSettings).not.toHaveBeenCalled();
  });

  /**
   * Each write reads the file again rather than saving a copy held since the
   * dialog opened. The theme control saves through a different path
   * (main.ts's), so a held copy would be stale the moment it was used and would
   * put the old theme back.
   */
  it('re-reads settings for each save rather than saving a stale copy', async () => {
    const dialog = mount();
    // Something else changed the theme while the dialog was open -- which is
    // exactly what the theme control above causes.
    vi.mocked(LoadSettings).mockResolvedValue(settingsFixture({ theme: 'light' }));

    const accent = control<HTMLInputElement>(dialog, 'input[type="color"]');
    accent.value = '#010203';
    accent.dispatchEvent(new Event('input'));
    await afterDebounce();

    const saved = vi.mocked(SaveSettings).mock.lastCall![0];
    expect(saved.appearance.accentColor).toBe('#010203');
    expect(saved.appearance.theme).toBe('light');
  });

  /** A failed disk write costs the restart, not the session. */
  it('logs a failed save instead of throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(SaveSettings).mockRejectedValue(new Error('disk full'));
    const dialog = mount();

    const accent = control<HTMLInputElement>(dialog, 'input[type="color"]');
    accent.value = '#040506';
    accent.dispatchEvent(new Event('input'));
    await afterDebounce();

    expect(document.documentElement.style.getPropertyValue('--accent-base')).toBe('#040506');
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('closing', () => {
  /**
   * The dialog can be closed inside the 300 ms debounce window -- pick a
   * colour, press Escape. Without the flush the change is applied to a running
   * app and never written down, so it survives until the next launch and then
   * vanishes, which is the worst of both.
   */
  it('flushes a pending save rather than dropping it', async () => {
    const dialog = mount();
    const accent = control<HTMLInputElement>(dialog, 'input[type="color"]');

    accent.value = '#778899';
    accent.dispatchEvent(new Event('input'));
    expect(LoadSettings).not.toHaveBeenCalled();

    dialog.querySelector<HTMLButtonElement>('.settings-dialog__close')!.click();

    // **Synchronously**, and that is the whole assertion. The first version of
    // this waited on `SaveSettings` through `vi.waitFor`, whose default 1000 ms
    // window is longer than the 300 ms debounce -- so the pending write landed
    // on its own and the test passed with the flush deleted. Mutation testing
    // said so. `persist` starts with a read, so the read having been issued
    // before any timer could fire is what proves the flush ran.
    expect(LoadSettings).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(vi.mocked(SaveSettings).mock.lastCall?.[0].appearance.accentColor).toBe('#778899');
    });
  });

  it('takes the dialog out of the DOM', () => {
    const dialog = mount();

    dialog.querySelector<HTMLButtonElement>('.settings-dialog__close')!.click();

    expect(document.querySelector('.settings-dialog')).toBeNull();
  });

  /**
   * Escape fires `close` without going near the button, and `close()` fires it
   * too, so the handler can genuinely run more than once -- and a flush that
   * re-ran its pending write would save the same change twice.
   *
   * What makes that safe is `coalesce` clearing `pending` **before** invoking
   * it, not a once-only flag on the close handler. A flag was there first and
   * is gone: with `coalesce` already idempotent it guarded nothing, and no
   * mutation of it could be caught. This case points at the property that is
   * real.
   */
  it('runs a pending write once however many times it is closed', async () => {
    const dialog = mount();
    const accent = control<HTMLInputElement>(dialog, 'input[type="color"]');
    accent.value = '#123456';
    accent.dispatchEvent(new Event('input'));

    dialog.dispatchEvent(new Event('close'));
    dialog.querySelector<HTMLButtonElement>('.settings-dialog__close')!.click();
    dialog.dispatchEvent(new Event('close'));

    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());
    await afterDebounce();
    expect(vi.mocked(SaveSettings).mock.calls).toHaveLength(1);
  });
});

describe('accessibility', () => {
  /** A modal with no accessible name is announced as "dialog" and nothing else. */
  it('names the dialog from its own heading', () => {
    const dialog = mount();

    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(dialog.querySelector(`#${labelledBy}`)?.textContent).toBe('Settings');
  });

  /**
   * `<fieldset>`/`<legend>` is why there is no tab rail: the grouping a screen
   * reader needs comes free, and every control is reachable with Tab alone.
   */
  it('groups the controls under a named legend', () => {
    const dialog = mount();

    const fieldset = dialog.querySelector('fieldset')!;
    expect(fieldset.querySelector('legend')?.textContent).toBe('Appearance');
    expect(fieldset.querySelectorAll('label')).toHaveLength(3);
  });

  /**
   * Every control is inside its `<label>`, so there is no id/for pair that can
   * drift apart -- and no control can end up unlabelled by a typo.
   */
  it('wraps every control in its own label', () => {
    const dialog = mount();

    for (const el of dialog.querySelectorAll('.settings-dialog__control')) {
      expect(el.closest('label')).not.toBeNull();
    }
  });
});
