/**
 * The formatting toolbar (SPEC §6.1, §6.5). Same convention as the tab strip
 * (ui/tabbar.ts, read that file's header first): `buildToolbar` is a pure
 * function of plain arguments -- a pinned-id list and the store's
 * `activeFormats` string -- so its tests need no mounted store, and
 * `mountToolbar` is the thin wrapper that subscribes and rebuilds whole.
 *
 * A toolbar button never calls a command directly. Clicking dispatches
 * `hashpad:command` with `format.<id>`, the same bus the menu bar and tab
 * strip use; main.ts's COMMAND_EVENT handler is the one place that turns
 * that into `toEditorCommand(COMMANDS[id])(getEditorView())`. That is what
 * keeps a button and its keyboard shortcut (editor/extensions.ts's keymap)
 * running through the exact same `MarkdownCommand` -- SPEC §6.5's "one
 * implementation, two triggers" -- rather than the toolbar growing a second
 * path into the editor.
 *
 * The heading button and the `···` overflow button are the two exceptions:
 * neither dispatches a command of its own. Both open a popup (ui/popupmenu.ts)
 * instead -- a heading-level menu, and the full sixteen-command list
 * respectively -- and it is *choosing an item* in that popup that dispatches
 * `format.<id>`. `contextmenu` anywhere on the row opens a third popup, the
 * pin/unpin list, which does not dispatch a `format.*` command at all but
 * `toolbar.pin:<id>`/`toolbar.unpin:<id>` -- see `mountToolbar`'s comment for
 * who's listening.
 */
import { store } from '../state/appcontext';
import { emitCommand } from './menubar';
import { ICONS } from './icons';
import {
  closePopupMenu,
  isPopupOpenFor,
  openPopupMenu,
  repointPopupAnchor,
  setPopupMarker,
  type PopupItem,
} from './popupmenu';
import type { CommandId } from '../editor/commands';

/**
 * The one id in the row that is not a `CommandId`. `heading` is a single
 * button standing for six commands (`heading1`..`heading6`), so it dispatches
 * nothing itself -- Task 7's dropdown picks the level.
 */
type HeadingButtonId = 'heading';

interface ToolbarCommand {
  /**
   * Typed against `COMMANDS`' own keys rather than `string`, so a typo or a
   * later rename of a command is a compile error here instead of a button
   * that silently does nothing. `main.ts`'s router has to guard with `in
   * COMMANDS` anyway (for `heading`, which deliberately has no entry), and
   * that guard would otherwise turn every mismatch into a dead button with
   * no throw, no warning, and no failing test.
   */
  id: CommandId | HeadingButtonId;
  label: string;
  /** Displayed form of the shortcut bound in editor/extensions.ts's keymap. */
  shortcut: string;
  /** SPEC §6.1's three visual clusters, in display order: 1 = inline marks
   * and structure, 2 = the three list types, 3 = block-level inserts. */
  group: number;
}

/**
 * All sixteen commands SPEC §6.5 lists, grouped and ordered exactly as its
 * §6.1 mock shows them. This is the row's *only* order -- `buildToolbar`
 * below renders whichever of these are pinned in this order, never in the
 * order `pinned` happens to list them, because pinning is a visibility
 * choice (SPEC §6.5's "pin or unpin"), not a reordering one.
 */
export const TOOLBAR_COMMANDS = [
  // Group 1: inline marks, plus the two "insert code" commands and heading.
  { id: 'bold', label: 'Bold', shortcut: 'Ctrl+B', group: 1 },
  { id: 'italic', label: 'Italic', shortcut: 'Ctrl+I', group: 1 },
  { id: 'strikethrough', label: 'Strikethrough', shortcut: 'Ctrl+Shift+X', group: 1 },
  { id: 'highlight', label: 'Highlight', shortcut: 'Ctrl+Shift+H', group: 1 },
  { id: 'inlineCode', label: 'Inline code', shortcut: 'Ctrl+`', group: 1 },
  { id: 'codeBlock', label: 'Code block', shortcut: 'Ctrl+Shift+K', group: 1 },
  { id: 'heading', label: 'Heading', shortcut: 'Ctrl+1…6', group: 1 },

  // Group 2: the three list types.
  { id: 'bulletList', label: 'Bullet list', shortcut: 'Ctrl+Shift+8', group: 2 },
  { id: 'numberedList', label: 'Numbered list', shortcut: 'Ctrl+Shift+7', group: 2 },
  { id: 'taskList', label: 'Task list', shortcut: 'Ctrl+Shift+9', group: 2 },

  // Group 3: blockquote and the block-level inserts.
  { id: 'blockquote', label: 'Blockquote', shortcut: 'Ctrl+Shift+.', group: 3 },
  { id: 'link', label: 'Link', shortcut: 'Ctrl+K', group: 3 },
  { id: 'image', label: 'Image', shortcut: 'Ctrl+Shift+I', group: 3 },
  // Ctrl+Alt+T, not SPEC §6.5's Ctrl+Shift+T -- see editor/extensions.ts's
  // keymap comment: that chord is already Reopen Closed Tab.
  { id: 'table', label: 'Table', shortcut: 'Ctrl+Alt+T', group: 3 },
  { id: 'horizontalRule', label: 'Horizontal rule', shortcut: 'Ctrl+Shift+-', group: 3 },
  { id: 'footnote', label: 'Footnote', shortcut: 'Ctrl+Shift+F', group: 3 },
  // `as const satisfies` rather than a plain `readonly ToolbarCommand[]`
  // annotation: the annotation widens each `id` back to the full union and
  // makes the members mutable, while this keeps the literal ids -- which is
  // what `ToolbarCommandId` below is derived from, and what lets `ICONS` be
  // typed against exactly this set in both directions.
] as const satisfies readonly ToolbarCommand[];

/**
 * Exactly the ids the row renders. `ICONS` is keyed by this, so an icon for a
 * command that no longer exists -- or a command with no icon -- is a compile
 * error rather than dead bytes in the bundle.
 */
export type ToolbarCommandId = (typeof TOOLBAR_COMMANDS)[number]['id'];

/**
 * The compiled-in fallback pinned set, used when settings.json carries no
 * usable list (see `validatePinned`). main.ts seeds the real one from
 * settings at bootstrap. Order here is irrelevant -- `buildToolbar` always renders in
 * `TOOLBAR_COMMANDS` order regardless of how this list is written.
 */
export const DEFAULT_PINNED: readonly string[] = [
  'bold',
  'italic',
  'strikethrough',
  'inlineCode',
  'heading',
  'bulletList',
  'numberedList',
  'taskList',
  'link',
  'table',
];

/**
 * Validates a `settings.toolbar.pinned` value read off disk (Task 8, SPEC
 * §6.13). A hand-edited `settings.json` is untrusted input in two different
 * ways, handled differently:
 *
 * - Wrong *shape* entirely (not present, not an array, an array of numbers) —
 *   there is nothing salvageable, so this falls back to `DEFAULT_PINNED`.
 * - Right shape, wrong *contents* (an id from a future or renamed command) —
 *   the rest of the list is still meaningful, so only the unknown id is
 *   dropped, silently, the same way `buildToolbar` already tolerates a stale
 *   pinned id rather than throwing.
 *
 * An empty array is deliberately not treated as "wrong shape": unpinning
 * every command is a legitimate choice (everything stays reachable through
 * the `···` overflow menu), so it is honoured rather than replaced with
 * defaults.
 */
export function validatePinned(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === 'string')) {
    return [...DEFAULT_PINNED];
  }

  const knownIds = new Set<string>(TOOLBAR_COMMANDS.map((command) => command.id));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of raw) {
    if (!knownIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * The commands whose cursor position can make them "active" -- these are the
 * only buttons that get `aria-pressed` at all. `link`, `image`, `table`,
 * `horizontalRule`, and `footnote` insert a construct rather than toggling
 * one on and off (see editor/commands.ts's comment on why those five have no
 * remove path), so a button that can never be pressed must not claim to be a
 * toggle by carrying the attribute.
 */
const TOGGLE_COMMAND_IDS = new Set([
  'bold',
  'italic',
  'strikethrough',
  'highlight',
  'inlineCode',
  'codeBlock',
  'heading',
  'bulletList',
  'numberedList',
  'taskList',
  'blockquote',
]);

/**
 * Whether `commandId` is "active" against the store's `activeFormats` string
 * (state/document.ts: sorted command ids joined by `|`, `''` when none
 * apply). `heading` is the one id here that never appears in that string
 * literally -- state/editor/marks.ts's `activeFormats` reports a level
 * (`heading3`), not the bare word -- so the heading button's active state is
 * "some heading level is active", checked by prefix, while every other id is
 * an exact match.
 */
function isActive(commandId: string, active: string): boolean {
  if (active === '') return false;
  const formats = active.split('|');
  if (commandId === 'heading') return formats.some((f) => f.startsWith('heading'));
  return formats.includes(commandId);
}

/**
 * The currently active heading level's raw id (e.g. `'heading3'`), or `null`
 * when no heading applies at the cursor. Used only by the heading popup's
 * "Normal text" entry: `toggleHeading(level)` (editor/commands.ts) only
 * *removes* a heading when the line already carries that exact level, so
 * "turn the heading off" has to name the level that is currently on rather
 * than emitting a fixed one.
 */
function activeHeadingId(active: string): string | null {
  if (active === '') return null;
  return active.split('|').find((format) => format.startsWith('heading')) ?? null;
}

/** Heading 1..6 (shortcuts Ctrl+1..6) plus the entry that turns a heading off. */
function headingPopupItems(): PopupItem[] {
  const items: PopupItem[] = [];
  for (let level = 1; level <= 6; level++) {
    items.push({ id: `heading${level}`, label: `Heading ${level}`, shortcut: `Ctrl+${level}` });
  }
  items.push({ id: 'normal', label: 'Normal text' });
  return items;
}

/**
 * `'normal'` is not a real command id -- it is this popup's own placeholder
 * for "whatever heading level is currently active, turn it off". Every other
 * id here is already `heading<n>`, matching a `COMMANDS` key directly, so it
 * is emitted as-is.
 */
function chooseHeadingItem(id: string, active: string): void {
  if (id === 'normal') {
    const current = activeHeadingId(active);
    if (current) emitCommand(`format.${current}`);
    return;
  }
  emitCommand(`format.${id}`);
}

/**
 * Toggles the picker rather than always reopening it. A trigger whose click
 * unconditionally calls `openPopupMenu` closes and immediately reopens its
 * own menu, so clicking Heading a second time can never dismiss it -- and
 * because the click is stopped from propagating, the outside-click listener
 * does not get the chance either.
 */
function openHeadingPopup(anchor: HTMLElement, active: string): void {
  if (isPopupOpenFor(anchor)) {
    closePopupMenu();
    return;
  }
  openPopupMenu({
    anchor,
    items: headingPopupItems(),
    onChoose: (id) => chooseHeadingItem(id, active),
  });
}

function buildSeparator(): HTMLElement {
  const separator = document.createElement('div');
  separator.className = 'toolbar__separator';
  separator.setAttribute('role', 'separator');
  separator.setAttribute('aria-orientation', 'vertical');
  return separator;
}

/**
 * Takes an element of `TOOLBAR_COMMANDS` rather than the wider
 * `ToolbarCommand`, so `command.id` is one of the sixteen ids the row
 * actually renders -- which is what lets `ICONS` be indexed without a
 * fallback, since it is keyed by exactly that set.
 */
function buildButton(
  command: (typeof TOOLBAR_COMMANDS)[number],
  active: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toolbar__button';
  button.dataset.command = command.id;

  const accessibleName = `${command.label} (${command.shortcut})`;
  button.setAttribute('aria-label', accessibleName);
  button.title = accessibleName;

  if (TOGGLE_COMMAND_IDS.has(command.id)) {
    button.setAttribute('aria-pressed', isActive(command.id, active) ? 'true' : 'false');
  }

  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  // ICONS holds our own compile-time SVG constants (ui/icons.ts) -- never
  // user content -- so assigning it via innerHTML cannot inject anything.
  icon.innerHTML = ICONS[command.id];
  button.append(icon);

  if (command.id === 'heading') {
    button.addEventListener('click', (event) => {
      // Without this, the same click that opens the popup would immediately
      // bubble to document and hit popupmenu.ts's outside-click listener,
      // closing the popup it just opened -- see that module's header comment.
      event.stopPropagation();
      openHeadingPopup(button, active);
    });
  } else {
    button.addEventListener('click', () => emitCommand(`format.${command.id}`));
  }

  return button;
}

/** What a marker in the overflow list means, in the words a screen reader reads. */
const PINNED = 'pinned to toolbar';

/**
 * All sixteen `TOOLBAR_COMMANDS`, in their fixed order, as popup items -- each
 * showing whether it is pinned.
 *
 * A `marker`, not `checked`, and the difference is what a click does. These
 * items *run* their command; the tick beside them is state they display rather
 * than state they own, so they stay `role="menuitem"` and put "pinned to
 * toolbar" in their accessible name. Announcing them as checkboxes would tell a
 * screen-reader user that clicking flips the tick, which is not what happens.
 */
function overflowPopupItems(pinnedIds: ReadonlySet<string>): PopupItem[] {
  return TOOLBAR_COMMANDS.map((command) => ({
    id: command.id,
    label: command.label,
    shortcut: command.shortcut,
    marker: { on: pinnedIds.has(command.id), label: PINNED },
  }));
}

/**
 * `'heading'` is one of the sixteen ids listed here but, like the pinned
 * heading button, names no `COMMANDS` entry of its own (TOOLBAR_COMMANDS's
 * comment) -- so choosing it opens the level-picker popup instead of
 * dispatching a command that does not exist. Every other id is a real
 * `CommandId` and is emitted as `format.<id>` directly.
 */
function chooseOverflowItem(id: string, anchor: HTMLElement, active: string): void {
  if (id === 'heading') {
    openHeadingPopup(anchor, active);
    return;
  }
  emitCommand(`format.${id}`);
}

function buildOverflowButton(
  active: string,
  pinnedIds: ReadonlySet<string>,
  onTogglePin?: (id: string) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toolbar__button';
  button.dataset.overflow = '';
  button.setAttribute('aria-label', 'More formatting commands');
  button.title = 'More formatting commands';

  const glyph = document.createElement('span');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '···';
  button.append(glyph);

  button.addEventListener('click', (event) => {
    // Same reason as the heading button's own listener above: without this,
    // this click would immediately close the popup it just opened.
    event.stopPropagation();
    // Toggles, for the same reason openHeadingPopup does -- see its comment.
    if (isPopupOpenFor(button)) {
      closePopupMenu();
      return;
    }
    openPopupMenu({
      anchor: button,
      items: overflowPopupItems(pinnedIds),
      onChoose: (id) => chooseOverflowItem(id, button, active),
      // Left-click runs the command, right-click pins it. The list stays open
      // and its tick flips in place, so pinning several is one visit rather
      // than one visit each.
      onContextMenu: (id) => {
        choosePinItem(id, pinnedIds, onTogglePin);
        setPopupMarker(id, { on: !pinnedIds.has(id), label: PINNED });
      },
      hint: 'Right-click an item to pin or unpin it',
    });
  });

  return button;
}

/** Every command listed as a checkbox, ticked for the ones currently pinned. */
function pinPopupItems(pinnedIds: ReadonlySet<string>): PopupItem[] {
  return TOOLBAR_COMMANDS.map((command) => ({
    id: command.id,
    label: command.label,
    checked: pinnedIds.has(command.id),
  }));
}

/**
 * Toggles `id`'s pinned state: announces it on the shared bus for main.ts to
 * persist, and tells the caller so the row can rebuild now.
 *
 * The split matters. `buildToolbar` stays a pure function of plain arguments
 * -- it never mutates a pinned list of its own, which is what keeps it (and
 * its tests) independent of which popup a click came from. The `onTogglePin`
 * callback is `mountToolbar`'s, and is a direct call rather than a second
 * listener on `hashpad:command`: a module that both emits and consumes the
 * same event is a self-loop that would also fire for any *other* dispatcher
 * of those ids, and it would stop main.ts being the one place to look when
 * tracing that bus.
 */
function choosePinItem(
  id: string,
  pinnedIds: ReadonlySet<string>,
  onTogglePin?: (id: string) => void,
): void {
  emitCommand(pinnedIds.has(id) ? `toolbar.unpin:${id}` : `toolbar.pin:${id}`);
  onTogglePin?.(id);
}

/**
 * WAI-ARIA toolbar pattern: exactly one button is ever a Tab stop, and
 * Left/Right/Home/End move it among the row's buttons -- the overflow button
 * included, since it is as much a part of the row as any pinned command.
 * This is what makes `role="toolbar"` (below, in `buildToolbar`) true rather
 * than aspirational; see that attribute's own comment for why Task 6 could
 * not claim it and Task 7 can.
 *
 * `initialIndex` is what carries the Tab stop across a rebuild. The row is
 * replaced wholesale on every `activeFormats` change -- which includes every
 * activation of a toolbar button, since applying a format republishes it --
 * so seating the Tab stop unconditionally on button 0 would reset it the
 * instant the user pressed Enter on any other button, and the focused node
 * would be detached with focus falling back to <body>. That is worse than no
 * roving tabindex at all, because `role="toolbar"` promises the pattern.
 * `mountToolbar` reads the outgoing row's index and passes it back in here.
 */
function applyRovingTabindex(
  bar: HTMLElement,
  buttons: readonly HTMLButtonElement[],
  initialIndex = 0,
): void {
  // Clamped: the row shrinks when a command is unpinned, so a remembered
  // index can point past the end.
  const seated = Math.min(Math.max(initialIndex, 0), Math.max(buttons.length - 1, 0));
  buttons.forEach((button, index) => {
    button.tabIndex = index === seated ? 0 : -1;
  });

  // Keeps the Tab stop in sync with whichever button last received focus, by
  // *any* means -- a keyboard move below, a mouse click (ui/menubar.ts's own
  // top-level buttons update their roving index on click too, for the same
  // reason: a click that landed on button 3 but left button 1 as the lone Tab
  // stop would make a following Tab jump backwards), or Tab landing on the
  // row for the first time. `focusin` bubbles (plain `focus` does not), so
  // one delegated listener on the row covers every button without each
  // needing its own.
  bar.addEventListener('focusin', (event) => {
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index === -1) return;
    for (const button of buttons) button.tabIndex = -1;
    buttons[index]!.tabIndex = 0;
  });

  bar.addEventListener('keydown', (event) => {
    const currentIndex = buttons.findIndex((button) => button === document.activeElement);
    // Focus is somewhere else entirely (e.g. inside an open popup) -- not
    // this row's concern.
    if (currentIndex === -1) return;

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        buttons[(currentIndex + 1) % buttons.length]?.focus();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        buttons[(currentIndex - 1 + buttons.length) % buttons.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        buttons[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        buttons[buttons.length - 1]?.focus();
        break;
      default:
        break;
    }
  });
}

/**
 * Pure rendering: the pinned subset of `TOOLBAR_COMMANDS`, in that array's
 * order, grouped with separators, plus the trailing overflow button. Takes
 * plain arguments rather than reading the store directly, so this (and its
 * test suite) never needs a mounted store -- the same rule `ui/tabbar.ts`'s
 * `buildTabStrip` follows.
 *
 * An id in `pinned` that matches nothing in `TOOLBAR_COMMANDS` is silently
 * skipped: this only ever iterates `TOOLBAR_COMMANDS` and asks whether each
 * one is pinned, never the reverse, so a stale or malformed pinned id (e.g.
 * a settings file surviving a future rename) can never throw.
 */
export function buildToolbar(
  pinned: readonly string[],
  active: string,
  initialTabStop = 0,
  onTogglePin?: (id: string) => void,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  // `role="toolbar"`, restored here: Task 6 downgraded this to `role="group"`
  // because the WAI-ARIA toolbar pattern promises a single Tab stop with
  // arrow keys moving between the buttons, and back then these were eleven
  // individual Tab stops -- declaring the role without the roving tabindex
  // behind it would have told assistive tech something untrue.
  // `applyRovingTabindex` below is what makes the promise true again.
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');

  const pinnedIds = new Set(pinned);
  let lastGroup: number | null = null;
  const focusable: HTMLButtonElement[] = [];

  for (const command of TOOLBAR_COMMANDS) {
    if (!pinnedIds.has(command.id)) continue;

    // A separator marks a boundary between two *rendered* groups -- never
    // before the first button, which would show as a leading divider with
    // nothing before it.
    if (lastGroup !== null && command.group !== lastGroup) {
      bar.append(buildSeparator());
    }
    const button = buildButton(command, active);
    bar.append(button);
    focusable.push(button);
    lastGroup = command.group;
  }

  // Always present, even with nothing pinned (SPEC §6.5): it is how every
  // unpinned command stays reachable, so an empty row must still offer a way
  // in.
  const overflowButton = buildOverflowButton(active, pinnedIds, onTogglePin);
  bar.append(overflowButton);
  focusable.push(overflowButton);

  applyRovingTabindex(bar, focusable, initialTabStop);

  bar.addEventListener('contextmenu', (event) => {
    // Without this, WebView2 shows its own context menu on top of ours
    // (ambiguity #3 in the task brief).
    event.preventDefault();
    // Anchored to whichever button was right-clicked, falling back to the row
    // itself only when the click landed on its empty space. Anchoring to the
    // row always would put the menu at its bottom-left however far right the
    // user clicked -- and would break Escape's focus return, since the row is
    // a div with no tabindex and `.focus()` on it does nothing.
    const clicked = (event.target as HTMLElement | null)?.closest('button');
    openPopupMenu({
      anchor: clicked instanceof HTMLElement ? clicked : bar,
      items: pinPopupItems(pinnedIds),
      onChoose: (id) => choosePinItem(id, pinnedIds, onTogglePin),
    });
  });

  return bar;
}

/**
 * Subscribes to the store and mounts the row, rebuilding it whole on every
 * `activeFormats` change -- `mountTabBar`'s pattern.
 *
 * Also owns the pinned-command list for the running session, seeded once
 * from `initialPinned` -- required, not defaulted: main.ts passes the
 * validated `settings.toolbar.pinned`, and a default would let a future
 * caller that forgot the argument silently fall back to the compiled-in list
 * instead of the user's settings, which is exactly the bug
 * `main.toolbarSeed.test.ts` exists to catch.
 * `choosePinItem` emits `toolbar.pin:<id>`/`toolbar.unpin:<id>` on the shared
 * bus, which is main.ts's seam for *persisting* a toggle back to
 * settings.json -- but the in-session redraw here travels a **direct
 * callback**, not a second listener on that bus. A module that both emits
 * and consumes the same event is a self-loop: it makes main.ts stop being
 * the one place to look when tracing `hashpad:command`, and it would react
 * to those ids from any future dispatcher, not just its own popup. That is
 * why this function has no `hashpad:command` listener of its own, and must
 * not grow one.
 */
export function mountToolbar(
  parent: HTMLElement,
  initialPinned: readonly string[],
  before: HTMLElement | null = null,
): void {
  let pinned: string[] = [...initialPinned];

  /**
   * Which button held the Tab stop, so a rebuild can put it back. Read from
   * the live DOM rather than tracked in a variable: `applyRovingTabindex`'s
   * `focusin` listener moves it on mouse clicks too, so the DOM is the only
   * place that always knows the truth.
   */
  function currentTabStop(row: HTMLElement): { index: number; hadFocus: boolean } {
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.findIndex((button) => button.tabIndex === 0);
    const hadFocus = buttons.some((button) => button === document.activeElement);
    return { index: index === -1 ? 0 : index, hadFocus };
  }

  let current = buildToolbar(pinned, store.getState().activeFormats, 0, togglePin);
  // Inserted *before* `before`, not appended. `#app` is a plain flex column
  // with no `order` anywhere, so DOM order is visual order -- and this mounts
  // from main.ts's async bootstrap, by which time the editor area is already
  // in the tree. Appending would put SPEC §6.1's formatting row underneath
  // the editor, at the bottom of the window.
  parent.insertBefore(current, before);

  function rerender(active: string): void {
    const { index, hadFocus } = currentTabStop(current);
    const next = buildToolbar(pinned, active, index, togglePin);
    current.replaceWith(next);
    current = next;

    // The row this rebuilt has just detached the `···` button, and a popup
    // anchored to it may still be open -- right-clicking an item in the
    // overflow list pins it *and* leaves the list up. A no-op when nothing is
    // open, which is every other path through here.
    const overflow = next.querySelector<HTMLElement>('[data-overflow]');
    if (overflow !== null) repointPopupAnchor(overflow);

    // Restores focus when the outgoing row held it. On the *command* path
    // this is invisible: `toEditorCommand` ends with `view.focus()`, which
    // runs after the synchronous store notification and so wins -- focus
    // lands in the editor, which is what you want when you press a format
    // button and keep typing. The path this exists for is pin/unpin, where
    // no command runs and nothing else would rescue focus, and where without
    // it the user is dropped to <body> with the Tab stop reset.
    if (hadFocus) {
      const buttons = [...next.querySelectorAll<HTMLButtonElement>('button')];
      buttons.find((button) => button.tabIndex === 0)?.focus();
    }
  }

  function togglePin(commandId: string): void {
    pinned = pinned.includes(commandId)
      ? pinned.filter((existing) => existing !== commandId)
      : [...pinned, commandId];
    rerender(store.getState().activeFormats);
  }

  store.subscribe(
    (state) => state.activeFormats,
    (active) => rerender(active),
  );
}
