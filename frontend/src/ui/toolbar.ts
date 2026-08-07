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
import { COMMAND_EVENT } from './menubar';
import { ICONS } from './icons';
import { openPopupMenu, type PopupItem } from './popupmenu';
import type { CommandId } from '../editor/commands';

/**
 * The one id in the row that is not a `CommandId`. `heading` is a single
 * button standing for six commands (`heading1`..`heading6`), so it dispatches
 * nothing itself -- Task 7's dropdown picks the level.
 */
type HeadingButtonId = 'heading';

export interface ToolbarCommand {
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
 * The commands the toolbar starts with pinned, before Task 8 wires this to
 * settings. Order here is irrelevant -- `buildToolbar` always renders in
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

function emit(command: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: command }));
}

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
    if (current) emit(`format.${current}`);
    return;
  }
  emit(`format.${id}`);
}

function openHeadingPopup(anchor: HTMLElement, active: string): void {
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
    button.addEventListener('click', () => emit(`format.${command.id}`));
  }

  return button;
}

/** All sixteen `TOOLBAR_COMMANDS`, in their fixed order, as popup items. */
function overflowPopupItems(): PopupItem[] {
  return TOOLBAR_COMMANDS.map((command) => ({
    id: command.id,
    label: command.label,
    shortcut: command.shortcut,
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
  emit(`format.${id}`);
}

function buildOverflowButton(active: string): HTMLButtonElement {
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
    openPopupMenu({
      anchor: button,
      items: overflowPopupItems(),
      onChoose: (id) => chooseOverflowItem(id, button, active),
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
 * Toggles `id`'s pinned state. Never touches the pinned list itself -- that
 * would make `buildToolbar` (and its test suite) depend on which popup a
 * click came from, breaking the "pure function of plain arguments" contract
 * the rest of this file relies on. Emitting the event and letting
 * `mountToolbar`'s listener apply it keeps that contract intact; see that
 * function's comment for who is on the other end.
 */
function choosePinItem(id: string, pinnedIds: ReadonlySet<string>): void {
  emit(pinnedIds.has(id) ? `toolbar.unpin:${id}` : `toolbar.pin:${id}`);
}

/**
 * WAI-ARIA toolbar pattern: exactly one button is ever a Tab stop, and
 * Left/Right/Home/End move it among the row's buttons -- the overflow button
 * included, since it is as much a part of the row as any pinned command.
 * This is what makes `role="toolbar"` (below, in `buildToolbar`) true rather
 * than aspirational; see that attribute's own comment for why Task 6 could
 * not claim it and Task 7 can.
 *
 * Rebuilt fresh on every `buildToolbar` call, same as everything else in this
 * file -- there is no cross-render memory of which button last had the Tab
 * stop, because the whole row (and every button in it) is a new set of DOM
 * nodes on every rebuild regardless.
 */
function applyRovingTabindex(bar: HTMLElement, buttons: readonly HTMLButtonElement[]): void {
  buttons.forEach((button, index) => {
    button.tabIndex = index === 0 ? 0 : -1;
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
export function buildToolbar(pinned: readonly string[], active: string): HTMLElement {
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
  const overflowButton = buildOverflowButton(active);
  bar.append(overflowButton);
  focusable.push(overflowButton);

  applyRovingTabindex(bar, focusable);

  bar.addEventListener('contextmenu', (event) => {
    // Without this, WebView2 shows its own context menu on top of ours
    // (ambiguity #3 in the task brief).
    event.preventDefault();
    openPopupMenu({
      anchor: bar,
      items: pinPopupItems(pinnedIds),
      onChoose: (id) => choosePinItem(id, pinnedIds),
    });
  });

  return bar;
}

/**
 * Subscribes to the store and mounts the row, rebuilding it whole on every
 * `activeFormats` change -- `mountTabBar`'s pattern.
 *
 * Also owns the pinned-command list for the running session. Settings
 * persistence is Task 8's job (ambiguity #4 in the task brief: "the store is
 * the source of truth" here, not settings.json), and main.ts is not this
 * task's to modify -- so rather than routing `toolbar.pin:<id>`/
 * `toolbar.unpin:<id>` through main.ts's central COMMAND_EVENT switch, this
 * closure listens for them directly and is itself the in-memory source of
 * truth `buildToolbar`'s pin/unpin popup (`choosePinItem` above) emits those
 * events for. Task 8 can listen for the same two event names to persist them
 * without this function needing to change.
 */
export function mountToolbar(parent: HTMLElement): void {
  let pinned: string[] = [...DEFAULT_PINNED];
  let current = buildToolbar(pinned, store.getState().activeFormats);
  parent.append(current);

  function rerender(active: string): void {
    const next = buildToolbar(pinned, active);
    current.replaceWith(next);
    current = next;
  }

  store.subscribe(
    (state) => state.activeFormats,
    (active) => rerender(active),
  );

  document.addEventListener(COMMAND_EVENT, (event) => {
    const id = (event as CustomEvent<string>).detail;

    if (id.startsWith('toolbar.pin:')) {
      const commandId = id.slice('toolbar.pin:'.length);
      if (!pinned.includes(commandId)) {
        pinned = [...pinned, commandId];
        rerender(store.getState().activeFormats);
      }
      return;
    }

    if (id.startsWith('toolbar.unpin:')) {
      const commandId = id.slice('toolbar.unpin:'.length);
      if (pinned.includes(commandId)) {
        pinned = pinned.filter((existing) => existing !== commandId);
        rerender(store.getState().activeFormats);
      }
    }
  });
}
