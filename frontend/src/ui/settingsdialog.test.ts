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
import { store } from '../state/appcontext';
import type { app } from '../../wailsjs/go/models';

vi.mock('../../wailsjs/go/app/App', () => ({
  LoadSettings: vi.fn(),
  SaveSettings: vi.fn(),
}));

// The Editor group's behaviour controls route through `settings/live.ts`, which
// reconfigures the live `EditorView`. There is no view here, so the two calls
// that need one are stubbed -- what this file asserts is that the dialog reaches
// the right function with the right value; `settings/live.test.ts` covers what
// those functions then do.
vi.mock('../editor/extensions', () => ({
  setWordWrap: vi.fn(),
  setEditorBehaviour: vi.fn(),
}));
vi.mock('../state/appcontext', async () => {
  const { createStore } = await import('../state/store');
  const { DEFAULT_BEHAVIOUR, EMPTY_STATUS, DEFAULT_OUTLINE_WIDTH, DEFAULT_SPLIT_RATIO } =
    await import('../state/document');
  return {
    store: createStore({
      documents: [],
      activeDocumentId: null,
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: DEFAULT_SPLIT_RATIO,
      syncScroll: true,
      wordWrap: true,
      editorBehaviour: DEFAULT_BEHAVIOUR,
      defaultViewMode: 'source',
      defaultEncoding: 'utf-8',
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
    }),
    getEditorView: vi.fn(),
  };
});

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

/**
 * One group by its legend. Position-based selectors (`querySelector('select')`)
 * were fine while Appearance was the only group, and quietly start meaning
 * something else the moment a second one is added above or below it.
 */
function group(dialog: HTMLElement, legend: string): HTMLElement {
  const found = [...dialog.querySelectorAll('fieldset')].find(
    (fieldset) => fieldset.querySelector('legend')?.textContent === legend,
  );
  expect(found, 'a group named ' + legend).toBeDefined();
  return found!;
}

/** A control by the visible text of the row it sits in. */
function byLabel<T extends HTMLElement>(scope: HTMLElement, label: string): T {
  const row = [...scope.querySelectorAll('label')].find(
    (candidate) => candidate.querySelector('.settings-dialog__label')?.textContent === label,
  );
  expect(row, 'a row labelled ' + label).toBeDefined();
  return row!.querySelector<T>('.settings-dialog__control')!;
}

/**
 * Waits for the debounced write to *land*, rather than for a fixed stretch of
 * wall clock longer than the debounce.
 *
 * The fixed-sleep version was 450 ms against a 300 ms debounce -- 150 ms of
 * slack, which is nothing on a cold run where Vite is still transforming. It
 * failed exactly once, in the first full run after `prettier --write` touched
 * every file, and passed six times afterwards. A test whose result depends on
 * how busy the machine is reports a load average, not a defect (the same
 * reasoning main.preview.test.ts's `waitForPane` already carries).
 *
 * For asserting a save did **not** happen, `quietFor` below is still a real
 * wait -- absence has nothing to poll for.
 */
function savedSettings(): Promise<app.Settings> {
  return vi.waitFor(
    () => {
      const call = vi.mocked(SaveSettings).mock.lastCall;
      expect(call, 'a SaveSettings call').toBeDefined();
      return call![0];
    },
    { timeout: 5000 },
  );
}

/** Long enough that a debounced write would have fired if one were pending. */
function quietFor(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 600));
}

beforeEach(() => {
  vi.mocked(LoadSettings).mockResolvedValue(settingsFixture());
  vi.mocked(SaveSettings).mockResolvedValue(undefined);
});

afterEach(async () => {
  // Closed through the real path rather than by emptying the body. A scheduled
  // write lives in the dialog's own closure and removing the node does not
  // cancel it -- it fires 300 ms later, inside whichever test is running by
  // then. That is not hypothetical: the "ignores an emptied number field" case
  // failed on a `SaveSettings` belonging to the case before it.
  for (const dialog of document.querySelectorAll('.settings-dialog')) {
    dialog.dispatchEvent(new Event('close'));
  }
  // Let the flushed write's promises settle before the mocks are cleared, or it
  // lands in the next test instead of this one.
  await new Promise((resolve) => setTimeout(resolve, 0));

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

    expect((await savedSettings()).appearance.accentColor).toBe('#11ff22');
  });

  it('applies and persists the UI font size', async () => {
    const dialog = mount();
    const size = control<HTMLInputElement>(dialog, 'input[type="number"]');

    size.value = '20';
    size.dispatchEvent(new Event('input'));

    expect(document.documentElement.style.getPropertyValue('--size-ui')).toBe('20px');

    expect((await savedSettings()).appearance.uiFontSize).toBe(20);
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

    await quietFor();
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
    const saved = await savedSettings();
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
    await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 5000 });

    expect(document.documentElement.style.getPropertyValue('--accent-base')).toBe('#040506');
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
    await quietFor();
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

/**
 * The Editor group, whose eight controls fall into three kinds by *who owns the
 * value* — which is the thing worth testing, because getting that wrong
 * produces a control that appears to work and quietly writes to the wrong
 * place.
 */
describe('the Editor group', () => {
  function editor(dialog: HTMLElement): HTMLElement {
    return group(dialog, 'Editor');
  }

  it('carries the loaded typography', () => {
    const scope = editor(mount());

    expect(byLabel<HTMLInputElement>(scope, 'Font').value).toBe('Cascadia Mono');
    expect(byLabel<HTMLInputElement>(scope, 'Font size').value).toBe('14');
    expect(byLabel<HTMLInputElement>(scope, 'Line height').value).toBe('1.6');
  });

  /**
   * **From the store, not from the file.** These five have live state -- a store
   * field, and for four of them a compartment on the running view -- and a write
   * can fail without throwing (`persistSettings` logs it). When that happens the
   * file and the running app disagree, and a control showing the file would be
   * reporting something the user is not looking at.
   *
   * The fixture makes the two genuinely differ: the file says word wrap on, line
   * numbers off, tab width 2, insert spaces on, source mode. The store says the
   * opposite of every one.
   */
  it('reads the live settings from the store rather than the file', () => {
    store.setState((prev) => ({
      ...prev,
      wordWrap: false,
      editorBehaviour: { showLineNumbers: true, tabSize: 8, insertSpaces: false },
      defaultViewMode: 'split',
    }));

    const scope = editor(mount());

    expect(byLabel<HTMLInputElement>(scope, 'Word wrap').checked).toBe(false);
    expect(byLabel<HTMLInputElement>(scope, 'Line numbers').checked).toBe(true);
    expect(byLabel<HTMLInputElement>(scope, 'Tab width').value).toBe('8');
    expect(byLabel<HTMLInputElement>(scope, 'Insert spaces instead of tabs').checked).toBe(false);
    expect(byLabel<HTMLSelectElement>(scope, 'New documents open in').value).toBe('split');
  });

  it('applies an editor font change at once and persists it', async () => {
    const scope = editor(mount());
    const font = byLabel<HTMLInputElement>(scope, 'Font');

    font.value = 'Iosevka';
    font.dispatchEvent(new Event('input'));

    // `fontStack` appends the fallbacks, so this asserts the leading name rather
    // than the whole property.
    expect(document.documentElement.style.getPropertyValue('--font-editor')).toContain('Iosevka');

    expect((await savedSettings()).editor.fontFamily).toBe('Iosevka');
  });

  /**
   * **Two controls inside one debounce window, and both must survive.** This is
   * the case that caught the coalescer holding a single pending write: the line
   * height replaced the font size, so the size was applied on screen and never
   * saved -- gone at the next launch, with nothing to suggest why. The map is
   * keyed by setting now.
   */
  it('applies the font size and the line height', async () => {
    const scope = editor(mount());

    const size = byLabel<HTMLInputElement>(scope, 'Font size');
    size.value = '19';
    size.dispatchEvent(new Event('input'));
    expect(document.documentElement.style.getPropertyValue('--size-editor')).toContain('19');

    const height = byLabel<HTMLInputElement>(scope, 'Line height');
    height.value = '2.1';
    height.dispatchEvent(new Event('input'));
    expect(document.documentElement.style.getPropertyValue('--line-editor')).toBe('2.1');

    const saved = await savedSettings();
    expect(saved.editor.fontSize).toBe(19);
    expect(saved.editor.lineHeight).toBe(2.1);
  });

  /**
   * The emptied-field guard is shared by every number control here, which is
   * why it is worth checking on one the Appearance group does not cover: a
   * per-field copy of it would be a per-field chance to leave it out.
   */
  it('ignores an emptied number field in this group too', async () => {
    const scope = editor(mount());
    const size = byLabel<HTMLInputElement>(scope, 'Font size');

    size.value = '';
    size.dispatchEvent(new Event('input'));

    await quietFor();
    expect(SaveSettings).not.toHaveBeenCalled();
  });

  /**
   * Word wrap and the three behaviours go through `settings/live.ts`, which is
   * what the View menu calls too. Asserted through the **store**, because that
   * write is the part proving the dialog reached the shared setter rather than
   * a private copy of it -- a copy would still reach `SaveSettings`.
   */
  it('routes word wrap through the shared setter', async () => {
    store.setState((prev) => ({ ...prev, wordWrap: true }));
    const wrap = byLabel<HTMLInputElement>(editor(mount()), 'Word wrap');

    wrap.checked = false;
    wrap.dispatchEvent(new Event('change'));

    expect(store.getState().wordWrap).toBe(false);
    await vi.waitFor(() => {
      expect(vi.mocked(SaveSettings).mock.lastCall?.[0].editor.wordWrap).toBe(false);
    });
  });

  it.each([
    ['Line numbers', 'showLineNumbers', true],
    ['Insert spaces instead of tabs', 'insertSpaces', false],
  ] as const)('routes %s through the shared behaviour setter', async (label, key, next) => {
    store.setState((prev) => ({
      ...prev,
      editorBehaviour: { showLineNumbers: false, tabSize: 2, insertSpaces: true },
    }));
    const box = byLabel<HTMLInputElement>(editor(mount()), label);

    box.checked = next;
    box.dispatchEvent(new Event('change'));

    expect(store.getState().editorBehaviour[key]).toBe(next);
    await vi.waitFor(() => expect(SaveSettings).toHaveBeenCalled());
  });

  /**
   * A partial change must leave its siblings alone. `setBehaviourSetting` merges
   * onto the current object and then writes all three keys, so a version that
   * built a fresh object would silently reset the other two to their defaults --
   * changing the tab width would turn line numbers off.
   */
  it('changes one behaviour without resetting the others', async () => {
    store.setState((prev) => ({
      ...prev,
      editorBehaviour: { showLineNumbers: true, tabSize: 2, insertSpaces: false },
    }));
    const width = byLabel<HTMLInputElement>(editor(mount()), 'Tab width');

    width.value = '6';
    width.dispatchEvent(new Event('input'));

    expect(store.getState().editorBehaviour).toEqual({
      showLineNumbers: true,
      tabSize: 6,
      insertSpaces: false,
    });
    await vi.waitFor(() => {
      const saved = vi.mocked(SaveSettings).mock.lastCall?.[0].editor;
      expect(saved?.tabSize).toBe(6);
      expect(saved?.showLineNumbers).toBe(true);
      expect(saved?.insertSpaces).toBe(false);
    });
  });

  it('routes the default view mode through the shared setter', async () => {
    store.setState((prev) => ({ ...prev, defaultViewMode: 'source' }));
    const mode = byLabel<HTMLSelectElement>(editor(mount()), 'New documents open in');

    mode.value = 'split';
    mode.dispatchEvent(new Event('change'));

    expect(store.getState().defaultViewMode).toBe('split');
    await vi.waitFor(() => {
      expect(vi.mocked(SaveSettings).mock.lastCall?.[0].editor.defaultViewMode).toBe('split');
    });
  });

  /**
   * `'live'` is in the `viewMode` union and renders exactly like source -- there
   * is no live-preview mode yet. Offering it would be a control wired to
   * nothing, which is what `PreviewSettings`'s `loadRemoteImages` comment exists
   * to warn against.
   */
  it('offers only the two modes that do something', () => {
    const mode = byLabel<HTMLSelectElement>(editor(mount()), 'New documents open in');

    expect([...mode.options].map((option) => option.value)).toEqual(['source', 'split']);
  });
});
