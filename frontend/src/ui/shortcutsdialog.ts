/**
 * The Keyboard shortcuts window (design §4.39), opened from Settings.
 *
 * Every menu item and toolbar button is a row, named the way the menu or the
 * toolbar names it -- read from `MENUS` and `TOOLBAR_COMMANDS` rather than typed
 * out a third time. Each row shows its keys (from `settings/shortcuts.ts`), and
 * clicking them records new ones with the same `shortcutFromEvent` the keymap
 * runs on, so what the row shows is what the keyboard does.
 *
 * Its own `<dialog>` on top of Settings rather than a group inside it: sixty-odd
 * rows would triple that scroll, and a list this long wants a search box.
 */
import { setShortcutsSetting } from '../settings/live';
import {
  DEFAULT_SHORTCUTS,
  conflictFor,
  refusal,
  shortcutFor,
  shortcutFromEvent,
  withShortcut,
  type Shortcuts,
} from '../settings/shortcuts';
import { store } from '../state/appcontext';
import { confirmResetShortcuts } from './confirmdialog';
import { MENUS } from './menubar';
import { TOOLBAR_COMMANDS } from './toolbar';

export interface ShortcutRow {
  group: string;
  id: string;
  label: string;
}

/** In no menu, but bound since the find panel landed. Listed under Find and Replace. */
const FIND_ROWS: readonly ShortcutRow[] = [
  { group: 'Edit', id: 'edit.replace', label: 'Replace…' },
  { group: 'Edit', id: 'edit.findNext', label: 'Find Next' },
  { group: 'Edit', id: 'edit.findPrevious', label: 'Find Previous' },
];

/** The toolbar's commands, with the heading button opened out into its six levels. */
function formattingRows(): ShortcutRow[] {
  return TOOLBAR_COMMANDS.flatMap((command) =>
    command.id === 'heading'
      ? [1, 2, 3, 4, 5, 6].map((level) => ({
          group: 'Formatting',
          id: `format.heading${level}`,
          label: `Heading ${level}`,
        }))
      : [{ group: 'Formatting', id: `format.${command.id}`, label: command.label }],
  );
}

/**
 * Every row, in menu order with Formatting before Help. Open Recent is left
 * out: it opens a list rather than doing anything itself.
 */
export function shortcutRows(): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const menu of MENUS) {
    if (menu.label === 'Help') rows.push(...formattingRows());
    for (const item of menu.items) {
      if (item.submenu) continue;
      rows.push({ group: menu.label, id: item.id, label: item.label });
      if (item.id === 'edit.find') rows.push(...FIND_ROWS);
    }
  }
  return rows;
}

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta']);

function overrides(): Shortcuts {
  return store.getState().shortcuts;
}

function button(className: string, text: string, label?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  if (label !== undefined) {
    element.setAttribute('aria-label', label);
    element.title = label;
  }
  return element;
}

/** Builds the window without showing it; see `buildSettingsDialog` for why. */
export function buildShortcutsDialog(): HTMLDialogElement {
  const rows = shortcutRows();
  const labelOf = (id: string): string => rows.find((row) => row.id === id)?.label ?? id;

  const dialog = document.createElement('dialog');
  dialog.className = 'shortcuts-dialog';
  dialog.setAttribute('aria-labelledby', 'shortcuts-dialog-title');

  const title = document.createElement('h2');
  title.id = 'shortcuts-dialog-title';
  title.className = 'settings-dialog__title';
  title.textContent = 'Keyboard shortcuts';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'shortcuts-dialog__search';
  search.placeholder = 'Search';
  search.setAttribute('aria-label', 'Search shortcuts');

  const body = document.createElement('div');
  body.className = 'settings-dialog__body';

  /** Every row's refresh, run after any change -- a Replace changes two rows. */
  const refreshers: (() => void)[] = [];
  const refreshAll = (): void => {
    for (const refresh of refreshers) refresh();
  };
  const save = (next: Shortcuts): void => {
    void setShortcutsSetting(next);
    refreshAll();
  };

  /** The one row recording keys, if any, and how to stop it. */
  let stopRecording: (() => void) | null = null;

  const groups = new Map<string, HTMLFieldSetElement>();
  for (const { group, id, label } of rows) {
    let fieldset = groups.get(group);
    if (fieldset === undefined) {
      fieldset = document.createElement('fieldset');
      fieldset.className = 'settings-dialog__group';
      const legend = document.createElement('legend');
      legend.className = 'settings-dialog__legend';
      legend.textContent = group;
      fieldset.append(legend);
      groups.set(group, fieldset);
      body.append(fieldset);
    }

    const row = document.createElement('div');
    row.className = 'settings-dialog__row shortcuts-dialog__row';
    row.dataset.command = id;

    const name = document.createElement('span');
    name.className = 'settings-dialog__label';
    name.textContent = label;

    const keys = button('shortcuts-dialog__key', '');
    const clear = button('shortcuts-dialog__icon', '×', `Clear the shortcut for ${label}`);
    const reset = button('shortcuts-dialog__icon', '↺', `Reset ${label} to its default`);
    const controls = document.createElement('div');
    controls.className = 'shortcuts-dialog__keys';
    controls.append(keys, clear, reset);

    // A status line under the row: why a key was refused, or whose it is.
    const message = document.createElement('p');
    message.className = 'shortcuts-dialog__message';
    message.setAttribute('role', 'status');

    /** Shows `text` and any buttons under the row; no arguments clears it. */
    const say = (text = '', ...actions: HTMLButtonElement[]): void => {
      message.replaceChildren(...(text === '' ? [] : [text]), ...actions);
    };

    const refresh = (): void => {
      const current = shortcutFor(overrides(), id);
      keys.textContent = current === '' ? 'None' : current;
      keys.classList.toggle('shortcuts-dialog__key--none', current === '');
      keys.setAttribute('aria-label', `${label}: ${current === '' ? 'no shortcut' : current}`);
      clear.disabled = current === '';
      reset.hidden = !Object.hasOwn(overrides(), id);
      const fallback = DEFAULT_SHORTCUTS[id] ?? '';
      reset.title = `Reset to ${fallback === '' ? 'no shortcut' : fallback}`;
    };
    refreshers.push(refresh);

    /** Gives `id` the keys, asking first when another command has them. */
    const assign = (next: string): void => {
      const other = conflictFor(overrides(), id, next);
      if (other === null) {
        say();
        save(withShortcut(overrides(), id, next));
        return;
      }
      const replace = button('shortcuts-dialog__choice', 'Replace');
      const cancel = button('shortcuts-dialog__choice', 'Cancel');
      replace.addEventListener('click', () => {
        say();
        save(withShortcut(overrides(), id, next));
        keys.focus();
      });
      cancel.addEventListener('click', () => {
        say();
        keys.focus();
      });
      say(`${next} is used by ${labelOf(other)}.`, replace, cancel);
      replace.focus();
    };

    const stop = (): void => {
      if (stopRecording !== stop) return;
      stopRecording = null;
      keys.classList.remove('shortcuts-dialog__key--recording');
      refresh();
    };

    keys.addEventListener('click', () => {
      if (stopRecording === stop) return;
      stopRecording?.();
      stopRecording = stop;
      say();
      keys.textContent = 'Press keys…';
      keys.classList.add('shortcuts-dialog__key--recording');
      keys.setAttribute('aria-label', `${label}: press the new shortcut, or Escape to cancel`);
    });
    keys.addEventListener('blur', stop);
    keys.addEventListener('keydown', (event) => {
      if (stopRecording !== stop) return;
      // Tab leaves, so the keyboard is never trapped on a recording button.
      if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) {
        stop();
        return;
      }
      // Nothing else this press would do -- save, zoom, close the window --
      // may happen while it is being recorded.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        stop();
        return;
      }
      if (MODIFIERS.has(event.key)) return;

      const pressed = shortcutFromEvent(event);
      if (pressed === null) {
        say('That key types a character, so it cannot be a shortcut.');
        return;
      }
      const why = refusal(pressed);
      if (why !== null) {
        say(why);
        return;
      }
      stop();
      assign(pressed);
    });

    // Both buttons can vanish or disable themselves, so focus goes to the keys.
    clear.addEventListener('click', () => {
      say();
      save(withShortcut(overrides(), id, ''));
      keys.focus();
    });
    reset.addEventListener('click', () => {
      assign(DEFAULT_SHORTCUTS[id] ?? '');
      if (message.childNodes.length === 0) keys.focus();
    });

    refresh();
    row.append(name, controls, message);
    fieldset.append(row);
  }

  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    for (const row of body.querySelectorAll<HTMLElement>('.shortcuts-dialog__row')) {
      const text = `${row.querySelector('.settings-dialog__label')?.textContent ?? ''} ${
        row.querySelector('.shortcuts-dialog__key')?.textContent ?? ''
      }`.toLowerCase();
      row.hidden = !text.includes(query);
    }
    for (const fieldset of groups.values()) {
      fieldset.hidden = fieldset.querySelector('.shortcuts-dialog__row:not([hidden])') === null;
    }
  });

  const actions = document.createElement('div');
  actions.className = 'settings-dialog__actions';
  const resetAll = button('settings-dialog__reset', 'Reset all shortcuts');
  resetAll.addEventListener('click', () => {
    void (async () => {
      if (!(await confirmResetShortcuts())) return;
      for (const message of body.querySelectorAll('.shortcuts-dialog__message')) {
        message.replaceChildren();
      }
      save({});
    })();
  });
  const close = button('settings-dialog__close', 'Close');
  close.addEventListener('click', () => {
    // jsdom's <dialog> has no close(); see buildSettingsDialog.
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.remove();
  });
  actions.append(resetAll, close);

  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(title, search, body, actions);
  return dialog;
}

/** Settings' "Keyboard shortcuts" button. One copy at a time. */
export function openShortcuts(): void {
  if (document.querySelector('.shortcuts-dialog') !== null) return;
  const dialog = buildShortcutsDialog();
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>('.shortcuts-dialog__search')?.focus();
}
