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
 * both open a popup in Task 7 (a heading-level menu, and the full command
 * list respectively) and are deliberately inert here -- clicking them does
 * nothing yet. Building that popup is out of scope for this task.
 */
import { store } from '../state/appcontext';
import type { AppState } from '../state/document';
import { COMMAND_EVENT } from './menubar';
import { ICONS } from './icons';
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
export const TOOLBAR_COMMANDS: readonly ToolbarCommand[] = [
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
];

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

function buildSeparator(): HTMLElement {
  const separator = document.createElement('div');
  separator.className = 'toolbar__separator';
  separator.setAttribute('role', 'separator');
  separator.setAttribute('aria-orientation', 'vertical');
  return separator;
}

function buildButton(command: ToolbarCommand, active: string): HTMLButtonElement {
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
  icon.innerHTML = ICONS[command.id] ?? '';
  button.append(icon);

  // Heading opens a level-picker dropdown (Task 7); left inert here rather
  // than dispatching a command that does not exist.
  if (command.id !== 'heading') {
    button.addEventListener('click', () => emit(`format.${command.id}`));
  }

  return button;
}

function buildOverflowButton(): HTMLButtonElement {
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

  // Opens the full command list (Task 7); inert here, same as heading above.
  return button;
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
  // `role="group"`, not `role="toolbar"`. The WAI-ARIA toolbar pattern
  // promises a single Tab stop with arrow keys moving between the buttons,
  // and these are eleven individual Tab stops -- declaring the role without
  // the roving tabindex behind it tells assistive tech something untrue.
  // Task 7 adds keyboard handling for the popups and is the place to add the
  // roving pattern and restore the role together.
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Formatting');

  const pinnedIds = new Set(pinned);
  let lastGroup: number | null = null;

  for (const command of TOOLBAR_COMMANDS) {
    if (!pinnedIds.has(command.id)) continue;

    // A separator marks a boundary between two *rendered* groups -- never
    // before the first button, which would show as a leading divider with
    // nothing before it.
    if (lastGroup !== null && command.group !== lastGroup) {
      bar.append(buildSeparator());
    }
    bar.append(buildButton(command, active));
    lastGroup = command.group;
  }

  // Always present, even with nothing pinned (SPEC §6.5): it is how every
  // unpinned command stays reachable, so an empty row must still offer a way
  // in.
  bar.append(buildOverflowButton());

  return bar;
}

/**
 * The fields that determine what the row looks like, reduced to primitives
 * -- see tabbar.ts's `tabStripSummary` for why that matters to store.ts's
 * `isEqual`. `pinned` is a constant today (Task 8 gives it a real, settings-
 * backed source), joined the same way so the shape here does not have to
 * change once it stops being one.
 */
function toolbarSummary(state: AppState): { pinned: string; active: string } {
  return { pinned: DEFAULT_PINNED.join('|'), active: state.activeFormats };
}

/**
 * Subscribes to the store and mounts the row, rebuilding it whole on every
 * change `toolbarSummary` detects -- `mountTabBar`'s pattern exactly.
 */
export function mountToolbar(parent: HTMLElement): void {
  let current = buildToolbar(DEFAULT_PINNED, store.getState().activeFormats);
  parent.append(current);

  store.subscribe(toolbarSummary, ({ pinned, active }) => {
    const next = buildToolbar(pinned.split('|'), active);
    current.replaceWith(next);
    current = next;
  });
}
