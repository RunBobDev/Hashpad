/**
 * SPEC §6.13's settings dialog: modal, Ctrl+, and "every setting takes effect
 * immediately — no Apply button, no restart".
 *
 * Beside `confirmdialog.ts` rather than in `settings/`, because what it is is a
 * dialog; `settings/typography.ts` is the pure half that pushes values into CSS
 * and has no DOM of its own. Same `<dialog>` + `showModal()` reasoning as the
 * confirm prompt: real modal semantics -- top layer, inert background, focus
 * trapping, Escape -- are worth more than a hand-rolled overlay.
 *
 * **One scrolling column, not a tab rail.** SPEC names four groups (Appearance,
 * Editor, Files, Advanced) and Windows Settings would draw them as a left rail.
 * A rail needs tab semantics, roving focus and a selected-panel state; four
 * `<fieldset>`s stacked in a scroll need none of that, group correctly for a
 * screen reader for free, and are navigable with Tab alone. With this many
 * controls the scroll is short. If it stops being short, the rail can be added
 * without touching a single control.
 *
 * **Nothing here holds a settings object between changes.** Each save is its own
 * `LoadSettings` → mutate → `SaveSettings`, the read-modify-write every other
 * setter in the app uses (main.ts's `setWordWrapSetting` and friends). The
 * alternative -- keep the copy loaded at open time and save that -- looks
 * cheaper and is wrong: the theme control below routes through the command bus,
 * which does its own save, so a held copy would be stale the moment the user
 * touched it and would put the old theme back on the next keystroke elsewhere.
 */
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import type { app } from '../../wailsjs/go/models';
import { applyAccent, isValidAccent } from '../theme/theme';
import { applyTypography } from '../settings/typography';
import { emitCommand } from './menubar';

/** Mirrors `settings/typography.ts`'s `LIMITS.uiFontSize`, which does the real clamping. */
const UI_FONT_SIZE = { min: 10, max: 24 } as const;

/**
 * A pending write, coalesced.
 *
 * `<input type="color">` fires `input` continuously while the user drags around
 * the OS colour picker, and a number field fires on every digit. Persisting
 * each one would be two IPC round trips and a file write per event. Applying
 * is not debounced -- that is what "takes effect immediately" means, and it is
 * only a CSS custom property.
 *
 * `flush` exists because the dialog can be closed inside the debounce window:
 * pick a colour, hit Escape, and without it the last change is applied to a
 * live app but never written down.
 */
function coalesce(delayMs: number): { schedule: (write: () => void) => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;

  const run = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const write = pending;
    pending = null;
    write?.();
  };

  return {
    schedule(write) {
      pending = write;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    flush: run,
  };
}

/**
 * Reads settings fresh, applies `mutate`, and writes them back.
 *
 * A failed disk write is logged rather than thrown, the same as every other
 * setter: it means the choice will not survive a restart, not that it silently
 * did not apply -- the apply already happened, on screen, before this ran.
 */
async function persist(mutate: (settings: app.Settings) => void): Promise<void> {
  try {
    const settings = await LoadSettings();
    mutate(settings);
    await SaveSettings(settings);
  } catch (err) {
    console.error('hashpad: failed to persist a settings change', err);
  }
}

const SHORT_HEX = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;

/**
 * A colour in the only form `<input type="color">` will hold: `#rrggbb`, lower
 * case. Anything else is sanitised by the element to `#000000`, silently.
 *
 * The three-digit expansion is not a nicety. `isValidAccent` accepts `#RGB` --
 * CSS does, so bootstrap really will apply `"#fff"` and the window really will
 * be white-accented -- and handing that same `#fff` to the swatch shows
 * **black**. Worse than a cosmetic mismatch: the first click on the swatch
 * would then write `#000000` back over the user's setting. Found by a test,
 * after the first version of it was rewritten to assert a positive value.
 */
function toSwatchHex(color: string): string | null {
  const short = SHORT_HEX.exec(color);
  if (short !== null) {
    const [, r, g, b] = short;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return isValidAccent(color) ? color.toLowerCase() : null;
}

/**
 * The colour the swatch should show, which is not always the one in the file.
 *
 * Bootstrap validates `accentColor` before applying it (the field goes straight
 * into a CSS custom property, so a loose value is a stylesheet-injection
 * vector) and skips an invalid one, leaving variables.css's own default in
 * force. Showing the rejected value instead would put the control in
 * disagreement with the window it belongs to, so an invalid one falls back to
 * what is actually in effect, read off the root.
 *
 * Guarding the assignment instead -- `if (isValid) set it` -- looks like it
 * does the same job and does nothing at all: an unset colour input reads
 * `#000000` too, so guarded and unguarded are indistinguishable through
 * `.value`. That version was written first and deleted, because no test of it
 * could fail.
 */
function effectiveAccent(fromSettings: string): string {
  const requested = toSwatchHex(fromSettings);
  if (requested !== null) return requested;

  const inForce = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent-base')
    .trim();
  // `''` when the stylesheet has not loaded (jsdom), and a non-hex token is
  // possible in principle -- both land on the input's own default, which is
  // where an unusable value would have ended up anyway.
  return toSwatchHex(inForce) ?? '#000000';
}

/** A labelled row. The label wraps the control, so no id/for pair can drift apart. */
function row(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const label = document.createElement('label');
  label.className = 'settings-dialog__row';

  const text = document.createElement('span');
  text.className = 'settings-dialog__label';
  text.textContent = labelText;
  label.append(text, control);

  if (hint !== undefined) {
    const note = document.createElement('span');
    note.className = 'settings-dialog__hint';
    note.textContent = hint;
    label.append(note);
  }
  return label;
}

function group(legendText: string, rows: HTMLElement[]): HTMLElement {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'settings-dialog__group';

  const legend = document.createElement('legend');
  legend.className = 'settings-dialog__legend';
  legend.textContent = legendText;

  fieldset.append(legend, ...rows);
  return fieldset;
}

/**
 * The Appearance group.
 *
 * The theme control does **not** apply or persist anything itself -- it emits
 * the same `theme.*` command the View menu emits, and main.ts does the rest.
 * That is not indirection for its own sake: main.ts holds the `themeMode`
 * module local that the window-focus listener consults to decide whether an OS
 * theme change may override the user, and a second writer of the same setting
 * would leave that local behind. The other two controls have no such owner, so
 * they apply and persist here.
 */
function appearanceGroup(settings: app.Settings, saves: ReturnType<typeof coalesce>): HTMLElement {
  const theme = document.createElement('select');
  theme.className = 'settings-dialog__control';
  for (const [value, label] of [
    ['system', 'Follow system'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    theme.append(option);
  }
  // A value the file does not recognise leaves the browser's own fallback (the
  // first option) selected, which is 'system' -- the same answer bootstrap
  // reaches for an unreadable theme.
  theme.value = settings.appearance.theme;
  theme.addEventListener('change', () => emitCommand(`theme.${theme.value}`));

  const accent = document.createElement('input');
  accent.type = 'color';
  accent.className = 'settings-dialog__control settings-dialog__control--color';
  accent.value = effectiveAccent(settings.appearance.accentColor);
  accent.addEventListener('input', () => {
    applyAccent(accent.value);
    saves.schedule(() => {
      void persist((next) => {
        next.appearance.accentColor = accent.value;
      });
    });
  });

  const uiFontSize = document.createElement('input');
  uiFontSize.type = 'number';
  uiFontSize.className = 'settings-dialog__control settings-dialog__control--number';
  uiFontSize.min = String(UI_FONT_SIZE.min);
  uiFontSize.max = String(UI_FONT_SIZE.max);
  uiFontSize.step = '1';
  uiFontSize.value = String(settings.appearance.uiFontSize);
  uiFontSize.addEventListener('input', () => {
    // An emptied field parses as NaN. `applyTypography` clamps it back to the
    // fallback, so the app stays readable mid-edit -- but it must not be
    // *written*, or clearing the field to retype it saves 14 over the value the
    // user is halfway through replacing.
    const size = uiFontSize.valueAsNumber;
    if (!Number.isFinite(size)) return;

    // The loaded copy is mutated, then handed back whole. `applyTypography`
    // sets all six tokens at once, so it needs the sibling values -- the editor
    // and preview fonts -- alongside the one that changed, and a spread would
    // not typecheck anyway (`app.Settings` is a generated class with a method
    // on it, not a plain shape).
    //
    // Safe despite the header's "nothing holds a settings object": that rule is
    // about *saving*, and this copy is never saved. It is the display state, and
    // the only other writer that can run while the dialog is up -- the theme
    // command -- touches a field `applyTypography` does not read.
    settings.appearance.uiFontSize = size;
    applyTypography(settings);
    saves.schedule(() => {
      void persist((next) => {
        next.appearance.uiFontSize = size;
      });
    });
  });

  return group('Appearance', [
    row('Theme', theme),
    row('Accent colour', accent),
    row('Interface font size', uiFontSize, `${UI_FONT_SIZE.min}–${UI_FONT_SIZE.max} px`),
  ]);
}

/**
 * Builds the dialog without showing it.
 *
 * Split from `openSettings` for the reason `confirmdialog.ts` splits its own:
 * `showModal()` does not exist in jsdom, so everything downstream of it is
 * unreachable in a test. With construction separate, the parts where bugs live
 * -- a control carrying the loaded value, a change applying and persisting,
 * teardown happening exactly once -- are all reachable with plain event
 * dispatch, which jsdom does implement.
 */
export function buildSettingsDialog(settings: app.Settings): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.className = 'settings-dialog';
  dialog.setAttribute('aria-labelledby', 'settings-dialog-title');

  const title = document.createElement('h2');
  title.id = 'settings-dialog-title';
  title.className = 'settings-dialog__title';
  title.textContent = 'Settings';

  const body = document.createElement('div');
  body.className = 'settings-dialog__body';

  const saves = coalesce(300);
  body.append(appearanceGroup(settings, saves));

  const actions = document.createElement('div');
  actions.className = 'settings-dialog__actions';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'settings-dialog__close';
  close.textContent = 'Close';
  actions.append(close);

  // One handler covers every route out. Escape fires `cancel` then `close`;
  // the button and a direct `close()` fire only `close`. The flush is the point
  // of it: a change made inside the debounce window is otherwise applied to a
  // running app and never written down.
  //
  // No once-only flag, unlike `confirmdialog.ts`'s `finish`. That one resolves
  // a promise, which must settle exactly once; this one calls two idempotent
  // things -- `coalesce.flush` clears its pending write before running it, and
  // removing a node twice is a no-op. A flag here would have been a guard
  // against nothing, and no test of it could fail. (It was written, and
  // mutation testing said so.)
  const finish = (): void => {
    saves.flush();
    dialog.remove();
  };
  dialog.addEventListener('close', finish);
  close.addEventListener('click', () => {
    // Guarded because jsdom implements <dialog> as a bare HTMLElement with no
    // close(). Falling through to `finish` there costs nothing and keeps the
    // button's path testable.
    if (typeof dialog.close === 'function') {
      dialog.close();
      return;
    }
    finish();
  });

  dialog.append(title, body, actions);
  return dialog;
}

/**
 * Ctrl+, / File > Settings.
 *
 * Guarded against a second copy. `ui/shortcuts.ts` already refuses to forward
 * chords while a `dialog[open]` is up, so Ctrl+, cannot re-enter through the
 * keyboard -- but the menu entry is still clickable from a stale render, and
 * two dialogs in the top layer is not a state worth being able to reach.
 */
export async function openSettings(): Promise<void> {
  if (document.querySelector('.settings-dialog') !== null) return;

  let settings: app.Settings;
  try {
    settings = await LoadSettings();
  } catch (err) {
    // Nothing to show: every control would be populated from a guess, and
    // saving one would write that guess over the file that just failed to read.
    console.error('hashpad: cannot open settings; the settings file did not load', err);
    return;
  }

  const dialog = buildSettingsDialog(settings);
  document.body.append(dialog);
  dialog.showModal?.();
}
