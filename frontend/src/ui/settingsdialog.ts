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
import {
  setAutosaveDelaySetting,
  setAutosaveSetting,
  setBehaviourSetting,
  setDefaultEncodingSetting,
  setDefaultViewModeSetting,
  setSyncScrollSetting,
  setWordWrapSetting,
} from '../settings/live';
import { store } from '../state/appcontext';
import { isEncoding, type Document } from '../state/document';
import { confirmReset } from './confirmdialog';
import { emitCommand } from './menubar';

/**
 * Mirrors the ranges in `settings/typography.ts` and `state/document.ts`, which
 * do the real clamping. These are the *input* bounds -- what the spinner will
 * let you reach -- and duplicating them here is deliberate: a control that
 * offers a value the app then silently clamps is worse than one that does not
 * offer it. If they drift, the clamp still wins and nothing breaks.
 */
const LIMITS = {
  uiFontSize: { min: 10, max: 24 },
  editorFontSize: { min: 8, max: 48 },
  lineHeight: { min: 1, max: 3 },
  previewFontSize: { min: 8, max: 48 },
  // Mirrors `clampAutosaveDelay`. The floor is not cosmetic: below it, every
  // keystroke is an IPC round trip and a disk write.
  autosaveDelayMs: { min: 200, max: 60_000 },
  tabSize: { min: 1, max: 16 },
} as const;

/**
 * The pending writes, coalesced into one.
 *
 * `<input type="color">` fires `input` continuously while the user drags around
 * the OS colour picker, and a number field fires on every digit. Persisting each
 * one would be two IPC round trips and a file write per event. Applying is not
 * debounced -- that is what "takes effect immediately" means, and it is only a
 * CSS custom property.
 *
 * **A map keyed by setting, not a single pending write.** The single-write
 * version held only the most recent one, so two controls touched inside the same
 * window meant the first was silently dropped: change the font size, change the
 * line height a moment later, and the size was applied on screen and never
 * written down -- gone at the next launch. Found by a test that expected the
 * font size in the saved object and got the value it started with. Keying by
 * setting also bounds the map: fifty events from one slider collapse to one
 * entry, which is the coalescing this exists for.
 *
 * `flush` exists because the dialog can be closed inside the window: pick a
 * colour, hit Escape, and without it the change is applied to a live app but
 * never saved.
 */
type Mutate = (settings: app.Settings) => void;

interface Coalescer {
  schedule: (key: string, mutate: Mutate) => void;
  flush: () => void;
}

function coalesce(delayMs: number): Coalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, Mutate>();

  const run = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return;

    // Drained before the write starts, so a flush that arrives while one is in
    // flight -- or a second flush from another close event -- cannot re-issue
    // it. One read-modify-write for all of them, rather than one each: parallel
    // read-modify-writes against the same file lose whichever finishes first.
    const mutators = [...pending.values()];
    pending.clear();
    void persist((settings) => {
      for (const mutate of mutators) mutate(settings);
    });
  };

  return {
    schedule(key, mutate) {
      pending.set(key, mutate);
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

/**
 * A typography change: applied to the page now, written to disk shortly.
 *
 * The same `mutate` is used twice, against two different objects, and that is
 * the point. Against the **display copy** so `applyTypography` -- which sets all
 * six tokens in one pass -- sees the sibling values alongside the one that
 * changed; and against a **freshly read** copy when the coalescer runs, so the
 * write cannot put back a value some other writer changed meanwhile.
 *
 * Mutating the display copy does not contradict this file's "nothing holds a
 * settings object": that rule is about saving. This copy is never saved.
 */
function liveTypography(
  settings: app.Settings,
  saves: Coalescer,
  key: string,
  mutate: Mutate,
): void {
  mutate(settings);
  applyTypography(settings);
  saves.schedule(key, mutate);
}

/** A `<select>` carrying `[value, label]` pairs, set to `value`. */
function select(options: readonly (readonly [string, string])[], value: string): HTMLSelectElement {
  const element = document.createElement('select');
  element.className = 'settings-dialog__control';
  for (const [optionValue, label] of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    element.append(option);
  }
  // A value the file does not recognise leaves the browser's own fallback -- the
  // first option -- selected, which is the safe end of every list here.
  element.value = value;
  return element;
}

function numberField(
  limit: { min: number; max: number },
  step: number,
  value: number,
): HTMLInputElement {
  const element = document.createElement('input');
  element.type = 'number';
  element.className = 'settings-dialog__control settings-dialog__control--number';
  element.min = String(limit.min);
  element.max = String(limit.max);
  element.step = String(step);
  element.value = String(value);
  return element;
}

function checkbox(checked: boolean): HTMLInputElement {
  const element = document.createElement('input');
  element.type = 'checkbox';
  element.className = 'settings-dialog__control settings-dialog__control--check';
  element.checked = checked;
  return element;
}

function textField(value: string, placeholder: string): HTMLInputElement {
  const element = document.createElement('input');
  element.type = 'text';
  element.className = 'settings-dialog__control';
  element.value = value;
  element.placeholder = placeholder;
  return element;
}

/**
 * Wires a number field, skipping the keystroke where it is empty.
 *
 * Clearing a field to retype it leaves it unparseable for a moment, and
 * `valueAsNumber` is `NaN` then. Every clamp downstream would turn that into
 * its fallback and write it -- saving 14 over the size the user is halfway
 * through replacing. One guard, in one place, rather than once per field.
 */
function onNumber(input: HTMLInputElement, apply: (value: number) => void): void {
  input.addEventListener('input', () => {
    const value = input.valueAsNumber;
    if (!Number.isFinite(value)) return;
    apply(value);
  });
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
function appearanceGroup(settings: app.Settings, saves: Coalescer): HTMLElement {
  const theme = select(
    [
      ['system', 'Follow system'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ],
    settings.appearance.theme,
  );
  theme.addEventListener('change', () => emitCommand(`theme.${theme.value}`));

  const accent = document.createElement('input');
  accent.type = 'color';
  accent.className = 'settings-dialog__control settings-dialog__control--color';
  accent.value = effectiveAccent(settings.appearance.accentColor);
  accent.addEventListener('input', () => {
    applyAccent(accent.value);
    saves.schedule('appearance.accentColor', (next) => {
      next.appearance.accentColor = accent.value;
    });
  });

  const uiFontSize = numberField(LIMITS.uiFontSize, 1, settings.appearance.uiFontSize);
  onNumber(uiFontSize, (size) => {
    liveTypography(settings, saves, 'appearance.uiFontSize', (target) => {
      target.appearance.uiFontSize = size;
    });
  });

  // The preview's typography lives here rather than in a Preview group of its
  // own: SPEC §6.13 names four groups and Preview is not one of them, and these
  // two are fonts and sizes exactly like the three above.
  const previewFont = textField(settings.preview.fontFamily, 'Segoe UI');
  previewFont.addEventListener('input', () => {
    liveTypography(settings, saves, 'preview.fontFamily', (target) => {
      target.preview.fontFamily = previewFont.value;
    });
  });

  const previewFontSize = numberField(LIMITS.previewFontSize, 1, settings.preview.fontSize);
  onNumber(previewFontSize, (size) => {
    liveTypography(settings, saves, 'preview.fontSize', (target) => {
      target.preview.fontSize = size;
    });
  });

  return group('Appearance', [
    row('Theme', theme),
    row('Accent colour', accent),
    row('Interface font size', uiFontSize, `${LIMITS.uiFontSize.min}–${LIMITS.uiFontSize.max} px`),
    row('Preview font', previewFont),
    row(
      'Preview font size',
      previewFontSize,
      `${LIMITS.previewFontSize.min}–${LIMITS.previewFontSize.max} px`,
    ),
  ]);
}

/**
 * The Editor group.
 *
 * Split by who owns the value, which is not obvious from the settings file:
 *
 * - **Typography** (font, size, line height) is nothing but CSS custom
 *   properties. No store field, no CodeMirror reconfiguration, no other writer
 *   -- so it applies and persists here, through `liveTypography`.
 * - **Word wrap, line numbers, tab size, insert spaces** all have live state:
 *   a store field *and* a compartment on the running `EditorView`, because a
 *   new tab builds its extensions from the store while the open one needs
 *   reconfiguring. `settings/live.ts` owns that sequence and the View menu goes
 *   through the same functions.
 * - **Default view mode** has a store field but no view of its own, and the
 *   preview toggle writes it too.
 *
 * The controls for the second and third kinds are populated from the **store**,
 * not from the settings file this dialog loaded. The store is the live truth:
 * if a disk write failed earlier (logged, not thrown -- see `persistSettings`),
 * the file and the running app disagree, and a checkbox showing the file would
 * be reporting something the user is not looking at.
 */
function editorGroup(settings: app.Settings, saves: Coalescer): HTMLElement {
  const state = store.getState();

  const fontFamily = textField(settings.editor.fontFamily, 'Cascadia Mono');
  fontFamily.addEventListener('input', () => {
    liveTypography(settings, saves, 'editor.fontFamily', (target) => {
      target.editor.fontFamily = fontFamily.value;
    });
  });

  const fontSize = numberField(LIMITS.editorFontSize, 1, settings.editor.fontSize);
  onNumber(fontSize, (size) => {
    liveTypography(settings, saves, 'editor.fontSize', (target) => {
      target.editor.fontSize = size;
    });
  });

  const lineHeight = numberField(LIMITS.lineHeight, 0.1, settings.editor.lineHeight);
  onNumber(lineHeight, (height) => {
    liveTypography(settings, saves, 'editor.lineHeight', (target) => {
      target.editor.lineHeight = height;
    });
  });

  const wordWrap = checkbox(state.wordWrap);
  wordWrap.addEventListener('change', () => void setWordWrapSetting(wordWrap.checked));

  const lineNumbers = checkbox(state.editorBehaviour.showLineNumbers);
  lineNumbers.addEventListener('change', () => {
    void setBehaviourSetting({ showLineNumbers: lineNumbers.checked });
  });

  // Not debounced, unlike the typography fields. Each keystroke here
  // reconfigures a CodeMirror compartment rather than setting a CSS property,
  // and `setBehaviourSetting` is the same call the View menu makes -- one place
  // deciding when to write is better than two disagreeing.
  const tabSize = numberField(LIMITS.tabSize, 1, state.editorBehaviour.tabSize);
  onNumber(tabSize, (size) => void setBehaviourSetting({ tabSize: size }));

  const insertSpaces = checkbox(state.editorBehaviour.insertSpaces);
  insertSpaces.addEventListener('change', () => {
    void setBehaviourSetting({ insertSpaces: insertSpaces.checked });
  });

  // Source and Split only. `'live'` is in the `viewMode` union and the app
  // renders it exactly like source -- there is no live-preview mode yet -- so
  // offering it would be a control wired to nothing, which is the thing
  // `PreviewSettings`' own comment about `loadRemoteImages` warns against. A
  // hand-edited `"live"` therefore shows as Source here, which is what it
  // behaves as.
  const viewMode = select(
    [
      ['source', 'Editor only'],
      ['split', 'Editor and preview'],
    ],
    state.defaultViewMode,
  );
  viewMode.addEventListener('change', () => {
    void setDefaultViewModeSetting(viewMode.value as Document['viewMode']);
  });

  return group('Editor', [
    row('Font', fontFamily),
    row('Font size', fontSize, `${LIMITS.editorFontSize.min}–${LIMITS.editorFontSize.max} px`),
    row('Line height', lineHeight, `${LIMITS.lineHeight.min}–${LIMITS.lineHeight.max}`),
    row('Word wrap', wordWrap),
    row('Line numbers', lineNumbers),
    row('Tab width', tabSize, `${LIMITS.tabSize.min}–${LIMITS.tabSize.max} spaces`),
    row('Insert spaces instead of tabs', insertSpaces),
    row('New documents open in', viewMode),
  ]);
}

/**
 * The Files group.
 *
 * `assetFolder` needs no wiring beyond the write: Go's `assetFolder()` reads
 * the settings file on every image save, so the next paste uses the new folder
 * with nothing to reconfigure. It is also the one control here whose value can
 * be nonsense in a way that only shows up later -- Go falls back to `assets`
 * for an empty string, and `images.go` keeps the path inside the document's
 * directory, so a bad value costs a misplaced folder rather than a stray write.
 *
 * `defaultEncoding` reaches untitled documents only, which is why the hint says
 * so out loud: someone changing it while looking at an open UTF-16 file would
 * otherwise reasonably expect that file to change with it.
 */
function filesGroup(settings: app.Settings, saves: Coalescer): HTMLElement {
  const assetFolder = textField(settings.files.assetFolder, 'assets');
  assetFolder.addEventListener('input', () => {
    saves.schedule('files.assetFolder', (next) => {
      next.files.assetFolder = assetFolder.value;
    });
  });

  const encoding = select(
    [
      ['utf-8', 'UTF-8'],
      ['utf-8-bom', 'UTF-8 with BOM'],
      ['utf-16le', 'UTF-16 LE'],
    ],
    store.getState().defaultEncoding,
  );
  encoding.addEventListener('change', () => {
    if (isEncoding(encoding.value)) void setDefaultEncodingSetting(encoding.value);
  });

  // SPEC §3.2: "off by default ... an opt-in for saved files only (never
  // silently creates files)". The hint says so, because a switch called
  // "autosave" that quietly does nothing on the untitled tab you are looking at
  // is worse than one that tells you why.
  const autosave = checkbox(store.getState().autosave);
  autosave.addEventListener('change', () => void setAutosaveSetting(autosave.checked));

  const autosaveDelay = numberField(LIMITS.autosaveDelayMs, 100, store.getState().autosaveDelayMs);
  onNumber(autosaveDelay, (delayMs) => void setAutosaveDelaySetting(delayMs));

  return group('Files', [
    row('Image folder', assetFolder, 'Beside the document'),
    row('Encoding for new documents', encoding, 'Opened files keep their own'),
    row('Autosave', autosave, 'Saved files only'),
    row(
      'Autosave after',
      autosaveDelay,
      `${LIMITS.autosaveDelayMs.min}–${LIMITS.autosaveDelayMs.max} ms`,
    ),
  ]);
}

/**
 * The Advanced group.
 *
 * SPEC names four groups and the settings file has a `preview` block that fits
 * none of them, so the two genuinely fiddly settings live here: a width that is
 * off when zero, and a scroll behaviour most people never think about. That is
 * also what keeps this from being a one-control group.
 */
function advancedGroup(settings: app.Settings, saves: Coalescer): HTMLElement {
  // `0` means no limit, and it is the only way to say that in the file -- there
  // is no null, and every positive number is a width. `min` is 0 rather than
  // `LIMITS.maxContentWidth.min` for exactly that reason: the spinner has to be
  // able to reach the off switch.
  const maxWidth = numberField({ min: 0, max: 4000 }, 20, settings.editor.maxContentWidth);
  onNumber(maxWidth, (width) => {
    liveTypography(settings, saves, 'editor.maxContentWidth', (target) => {
      target.editor.maxContentWidth = width;
    });
  });

  const syncScroll = checkbox(store.getState().syncScroll);
  syncScroll.addEventListener('change', () => void setSyncScrollSetting(syncScroll.checked));

  return group('Advanced', [
    row('Maximum text width', maxWidth, '0 for no limit'),
    row('Scroll the preview with the editor', syncScroll),
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
  body.append(
    appearanceGroup(settings, saves),
    editorGroup(settings, saves),
    filesGroup(settings, saves),
    advancedGroup(settings, saves),
  );

  const actions = document.createElement('div');
  actions.className = 'settings-dialog__actions';

  // Left of the row, away from Close. They are the two buttons here and one of
  // them is destructive, so the gap between them is doing real work -- Close is
  // what people reach for on the way out, and a reset one pixel away from it is
  // a misclick with no undo. `confirmReset` is the other half of that.
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'settings-dialog__reset';
  reset.textContent = 'Reset to default';
  reset.addEventListener('click', () => {
    void (async () => {
      if (!(await confirmReset())) return;
      // Through the bus, and not because the dialog cannot call `ResetSettings`
      // itself. Re-applying the defaults means touching the theme, the status
      // bar and the outline, and all three are owned by module locals in
      // main.ts -- so main.ts does the reset, and rebuilds this dialog after.
      emitCommand('settings.reset');
    })();
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'settings-dialog__close';
  close.textContent = 'Close';
  actions.append(reset, close);

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
/**
 * Closes an open settings dialog, if there is one.
 *
 * For main.ts's reset, which has to rebuild this dialog from the new values --
 * every control was populated at build time, so re-reading them all in place
 * would mean a second, parallel way of writing the same thing. Closing and
 * reopening runs the one that already exists.
 *
 * Goes through `close()` rather than `remove()` so the `close` listener runs and
 * flushes any pending write. A reset immediately after another change must not
 * drop it -- the write it flushes is against the pre-reset file, and losing it
 * would be invisible.
 */
export function closeSettings(): void {
  const dialog = document.querySelector<HTMLDialogElement>('.settings-dialog');
  if (dialog === null) return;

  // Guarded because jsdom implements <dialog> as a bare HTMLElement with no
  // close(); dispatching the event directly is the same path there.
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.dispatchEvent(new Event('close'));
}

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
