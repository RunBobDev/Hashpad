/**
 * Keyboard shortcuts: the defaults, the user's changes, and the one function
 * that turns a key press into a shortcut (design §4.39).
 *
 * **One notation, used three ways.** The string a shortcut is stored as is the
 * string the menus display (`Ctrl+Shift+S`), and `shortcutFromEvent` produces
 * exactly that string from a `keydown`. The recorder in the shortcuts window
 * and the editor's keymap both call it, so a recorded shortcut and a pressed
 * one cannot disagree -- there is no second notation to parse or drift.
 *
 * **Only changes are stored.** `settings.json`'s `shortcuts` maps a command id
 * to its new shortcut, `''` meaning cleared. A command with no entry uses its
 * default, so a default changed in a later version reaches everyone who never
 * touched that command.
 */
import { base, shift } from 'w3c-keyname';

/** The user's changes, by command id; `''` is "no shortcut". */
export type Shortcuts = Readonly<Record<string, string>>;

/**
 * Every command that has a shortcut out of the box. Commands without one are
 * not listed here but can still be given one (`ui/shortcutsdialog.ts` lists
 * every menu item and toolbar button).
 *
 * Ctrl+Alt for tab positions and Table, because Ctrl+1..6 are the heading
 * levels and Ctrl+Shift+T is Reopen Closed Tab -- both collisions were
 * resolved deliberately (SPEC §6.14) and the owner chose these.
 */
export const DEFAULT_SHORTCUTS: Readonly<Record<string, string>> = {
  'file.new': 'Ctrl+N',
  'file.open': 'Ctrl+O',
  'tab.close': 'Ctrl+W',
  'tab.reopen': 'Ctrl+Shift+T',
  'file.save': 'Ctrl+S',
  'file.saveAs': 'Ctrl+Shift+S',
  'file.print': 'Ctrl+P',
  'settings.open': 'Ctrl+,',
  'edit.undo': 'Ctrl+Z',
  'edit.redo': 'Ctrl+Y',
  'edit.copyRich': 'Ctrl+Shift+C',
  'edit.find': 'Ctrl+F',
  'edit.replace': 'Ctrl+H',
  // F3 is Notepad's and the Windows convention; Ctrl+G was a second binding,
  // dropped when every command got exactly one.
  'edit.findNext': 'F3',
  'edit.findPrevious': 'Shift+F3',
  'view.preview': 'Ctrl+Shift+P',
  'view.outline': 'Ctrl+Shift+O',
  'view.zoomIn': 'Ctrl+Plus',
  'view.zoomOut': 'Ctrl+Minus',
  'view.zoomReset': 'Ctrl+0',
  'view.fullscreen': 'F11',
  'tab.next': 'Ctrl+Tab',
  'tab.previous': 'Ctrl+Shift+Tab',
  'tab.moveLeft': 'Ctrl+Shift+Left',
  'tab.moveRight': 'Ctrl+Shift+Right',
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`tab.goto${i + 1}`, `Ctrl+Alt+${i + 1}`]),
  ),
  'format.bold': 'Ctrl+B',
  'format.italic': 'Ctrl+I',
  'format.strikethrough': 'Ctrl+Shift+X',
  'format.highlight': 'Ctrl+Shift+H',
  'format.inlineCode': 'Ctrl+`',
  'format.codeBlock': 'Ctrl+Shift+K',
  ...Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`format.heading${i + 1}`, `Ctrl+${i + 1}`]),
  ),
  'format.bulletList': 'Ctrl+Shift+8',
  'format.numberedList': 'Ctrl+Shift+7',
  'format.taskList': 'Ctrl+Shift+9',
  'format.blockquote': 'Ctrl+Shift+.',
  'format.link': 'Ctrl+K',
  'format.image': 'Ctrl+Shift+I',
  'format.table': 'Ctrl+Alt+T',
  'format.horizontalRule': 'Ctrl+Shift+Minus',
  'format.footnote': 'Ctrl+Shift+F',
};

/** Key names as a menu shows them; anything not here is shown as it is. */
const KEY_NAMES: Readonly<Record<string, string>> = {
  '=': 'Plus',
  '+': 'Plus',
  '-': 'Minus',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ' ': 'Space',
};

const NOT_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Unidentified',
  'Process',
]);

/**
 * The shortcut a key press means, or null when it means none (a modifier on
 * its own, the Windows key, or a character typed with AltGr).
 *
 * The key is named from `keyCode` through CodeMirror's own table
 * (`w3c-keyname`), not from `event.key`: Ctrl+Shift+8 reports `*` as its key
 * on a US keyboard and `(` on a Croatian one, and both must mean
 * `Ctrl+Shift+8`. That is also why the name follows the key's position rather
 * than its label on non-US layouts.
 */
export function shortcutFromEvent(event: KeyboardEvent): string | null {
  if (event.metaKey) return null;
  // A synthetic event (jsdom, or one a page builds) can carry no keyCode; its
  // `key` is then the only name there is.
  const key = base[event.keyCode] ?? (event.key.length === 1 ? event.key.toLowerCase() : event.key);
  if (NOT_KEYS.has(key)) return null;
  // AltGr reaches the page as Ctrl+Alt on Windows. When the press typed a
  // character other than the key's own -- `~` from AltGr+1 on a Croatian
  // keyboard -- it is typing, which is the line CodeMirror draws too.
  if (
    event.ctrlKey &&
    event.altKey &&
    event.key.length === 1 &&
    event.key.toLowerCase() !== key &&
    event.key !== shift[event.keyCode]
  ) {
    return null;
  }

  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  // `+` is Shift+= on most keyboards, and Ctrl+Plus means zoom in either way.
  if (event.shiftKey && name !== 'Plus') parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

function defaultFor(id: string): string {
  return Object.hasOwn(DEFAULT_SHORTCUTS, id) ? DEFAULT_SHORTCUTS[id]! : '';
}

/** The shortcut `id` has now: the user's, else the default, else `''`. */
export function shortcutFor(overrides: Shortcuts, id: string): string {
  return Object.hasOwn(overrides, id) ? overrides[id]! : defaultFor(id);
}

/** The command `key` runs now, or null. */
export function commandFor(overrides: Shortcuts, key: string): string | null {
  for (const [id, shortcut] of Object.entries(overrides)) {
    if (shortcut === key) return id;
  }
  for (const [id, shortcut] of Object.entries(DEFAULT_SHORTCUTS)) {
    if (shortcut === key && !Object.hasOwn(overrides, id)) return id;
  }
  return null;
}

/**
 * Whether `key` is some command's default. The editor keeps such a key even
 * after the user frees it, so freeing Ctrl+B does nothing rather than handing
 * it to the browser's own bold.
 */
export function isDefaultShortcut(key: string): boolean {
  return Object.values(DEFAULT_SHORTCUTS).includes(key);
}

const KEPT: Readonly<Record<string, string>> = {
  'Ctrl+A': 'Select All',
  'Ctrl+C': 'Copy',
  'Ctrl+X': 'Cut',
  'Ctrl+V': 'Paste',
  'Alt+F4': 'closing the window',
};

/** Why `key` cannot be a shortcut, or null when it can. */
export function refusal(key: string): string | null {
  if (Object.hasOwn(KEPT, key)) return `${key} is kept for ${KEPT[key]}.`;
  if (!/^(Ctrl|Alt)\+/.test(key) && !/(^|\+)F\d+$/.test(key)) {
    return 'Use Ctrl or Alt, or an F key, so typing still works.';
  }
  return null;
}

/** The other command that already has `key`, or null. */
export function conflictFor(overrides: Shortcuts, id: string, key: string): string | null {
  const other = commandFor(overrides, key);
  return other === id ? null : other;
}

/**
 * The overrides after giving `id` the shortcut `key` (`''` clears it). A
 * command that had `key` loses it -- the shortcuts window has already asked.
 * An entry equal to the default is dropped, so only real changes are stored.
 */
export function withShortcut(overrides: Shortcuts, id: string, key: string): Shortcuts {
  const next: Record<string, string> = { ...overrides };
  const set = (target: string, value: string): void => {
    if (value === defaultFor(target)) delete next[target];
    else next[target] = value;
  };
  const other = key === '' ? null : conflictFor(overrides, id, key);
  if (other !== null) set(other, '');
  set(id, key);
  return next;
}
