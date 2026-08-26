/**
 * A generic popup menu (Task 7): the toolbar's heading-level picker, its
 * `···` overflow list, and its pin/unpin context menu all render through this
 * one implementation rather than three near-identical ones.
 *
 * Deliberately a plain absolutely-positioned `<div>`, not `<dialog>`. jsdom
 * implements `<dialog>` only partially -- the element exists but `showModal()`
 * does not (see ui/confirmdialog.ts, which works around exactly that) -- so a
 * `<dialog>`-based popup's open path would be untestable. `ui/menubar.ts`, the
 * house reference for this convention, uses the same plain-div approach.
 *
 * DOM shape and keyboard handling mirror `ui/menubar.ts`'s popup exactly, and
 * for the same reasons documented there: items are `<button role="menuitem">`
 * (or `role="menuitemcheckbox"` with `aria-checked` when the item carries a
 * `checked` flag), `tabIndex = -1` so they are only ever focused
 * programmatically -- never picked up by sequential Tab navigation -- and
 * Escape/outside-click both close the popup.
 *
 * Deliberately NOT the APG *menubar* pattern `ui/menubar.ts` implements
 * (roving tabindex across several trigger buttons, with Left/Right handing
 * off between them): every caller here has exactly one trigger per popup, so
 * there is nothing to rove between. `ui/menubar.ts` is left unmodified and
 * un-shared with this module -- see the Task 7 brief for why that duplication
 * is a recorded decision rather than an oversight (it carries a pattern this
 * generic popup does not need, and refactoring it to share this popup is
 * deferred to whenever a third caller, e.g. Checkpoint H's settings dialog,
 * makes the shared shape worth finding).
 */

import { announcePopupOpening, POPUP_OPENING_EVENT } from './menubar';

export interface PopupItem {
  id: string;
  label: string;
  /** Displayed beside the label in a `<kbd>`, same convention as the menu bar. */
  shortcut?: string;
  /**
   * `undefined` renders a plain `role="menuitem"`. Any boolean -- including
   * `false` -- renders `role="menuitemcheckbox"` with `aria-checked` set from
   * it, which is why every check in this module tests `!== undefined` rather
   * than truthiness: an *unchecked* checkbox item must still read as a
   * checkbox, not fall back to looking like a plain item.
   */
  checked?: boolean;
  /**
   * A state the item **shows** but does not **toggle**.
   *
   * Distinct from `checked`, and the distinction is the item's primary action.
   * `checked` means "activating this flips the tick", so it takes
   * `role="menuitemcheckbox"`. A marker means "activating this does something
   * else entirely, and by the way it is currently in this state" -- the
   * overflow list's items *run* their command on click, while the tick beside
   * them says whether the command is pinned to the toolbar. Announcing those as
   * checkboxes would tell a screen reader the click toggles the tick, which is
   * a lie about what the control does.
   *
   * So a marker draws the same glyph in the same column, keeps
   * `role="menuitem"`, and puts its state in the item's accessible *name*
   * instead -- "Blockquote, pinned to toolbar".
   *
   * One object rather than two coupled optional fields, so the flag and its
   * wording cannot half-exist.
   */
  marker?: { on: boolean; label: string };
}

interface OpenPopupMenuOptions {
  anchor: HTMLElement;
  items: PopupItem[];
  onChoose: (id: string) => void;
  /**
   * Right-click (or Shift+F10, or the Menu key -- `contextmenu` fires from all
   * three) on an item.
   *
   * Left-click acts, right-click configures, on the same row. The owner asked
   * for it from HMI/SCADA practice and it is Windows' own convention too:
   * Explorer and the taskbar both work this way.
   */
  onContextMenu?: (id: string) => void;
  /**
   * A line at the foot of the popup, outside the `role="menu"` element.
   *
   * Outside, because a `menu` whose children are not all menu items is invalid,
   * and a stray text node in one is not something a screen reader can navigate
   * to anyway. It exists for sighted discovery -- a list with ticks in it
   * invites the question of how to change them -- while assistive tech already
   * gets the state from every item's name.
   */
  hint?: string;
}

/**
 * Module-level singleton state (ambiguity #1 in the task brief: one popup at
 * a time, globally). `openPopupMenu` always tears down whatever is currently
 * open before building the new one, so there is never more than one of these
 * fields' worth of state alive at once.
 */
let openMenu: HTMLElement | null = null;
let openAnchor: HTMLElement | null = null;
let outsideClickListener: ((event: MouseEvent) => void) | null = null;
let documentEscapeListener: ((event: KeyboardEvent) => void) | null = null;

// The other half of the one-popup-at-a-time seam: the menu bar announces
// before it opens, and this closes whatever this module has on screen.
// Registered once at module scope rather than per popup, because it must be
// listening even while nothing of ours is open. `closePopupMenu` is
// idempotent, so a stray announcement costs nothing.
document.addEventListener(POPUP_OPENING_EVENT, () => closePopupMenu());

/**
 * Whether `anchor` is the trigger that owns the currently open popup. A
 * trigger uses this to *toggle*: without it, clicking Heading a second time
 * closes and immediately reopens the same menu, so the button can never
 * dismiss what it opened.
 */
export function isPopupOpenFor(anchor: HTMLElement): boolean {
  return openMenu !== null && openAnchor === anchor;
}

/**
 * Closes whatever popup is open, if any. Idempotent: an item's own click
 * handler already calls this before `openMenu` is cleared, so the same click
 * event's later arrival at the document-level outside-click listener (see
 * `openPopupMenu`) must be a harmless no-op rather than a second removal.
 */
export function closePopupMenu(): void {
  if (!openMenu) return;

  if (outsideClickListener) document.removeEventListener('click', outsideClickListener);
  if (documentEscapeListener) document.removeEventListener('keydown', documentEscapeListener);
  outsideClickListener = null;
  documentEscapeListener = null;

  openMenu.remove();
  openMenu = null;
  openAnchor = null;
}

/**
 * Closes the popup and puts focus back on the trigger that opened it.
 *
 * Used on both the Escape path and the choose-an-item path, matching
 * ui/menubar.ts's `closePopup`, whose default is likewise to refocus the
 * trigger on activation. Bare `closePopupMenu()` on activation would drop
 * focus to <body>: for the heading and overflow popups that is masked,
 * because the command that runs next calls `view.focus()` and rescues it
 * into the editor -- but the pin/unpin menu runs no command, so a keyboard
 * user who opened it with Shift+F10 and picked an item would be stranded.
 * Returning focus to the button also makes `mountToolbar`'s rebuild see
 * `hadFocus`, so the Tab stop travels into the new row with them.
 */
function closeAndReturnFocus(): void {
  const anchor = openAnchor;
  closePopupMenu();
  anchor?.focus();
}

/**
 * Writes a marker's glyph and its share of the accessible name.
 *
 * Split out because it runs twice: once when the item is built, and again when
 * a right-click flips the state. The second path deliberately does **not**
 * rebuild the popup -- that would close it under the user's cursor mid-task,
 * and pinning several commands in a row is the normal case.
 */
function applyMarker(
  button: HTMLButtonElement,
  label: string,
  marker: { on: boolean; label: string },
): void {
  const glyph = button.querySelector<HTMLElement>('.popup-menu__check');
  if (glyph !== null) glyph.textContent = marker.on ? '✓' : '';
  // The state lives in the name rather than in `aria-checked`, because this
  // item is a `menuitem` -- see `PopupItem.marker`.
  button.setAttribute('aria-label', marker.on ? `${label}, ${marker.label}` : label);
  button.classList.toggle('popup-menu__item--marked', marker.on);
}

function buildItem(
  item: PopupItem,
  onChoose: (id: string) => void,
  onContextMenu?: (id: string) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.itemId = item.id;
  // Focused only programmatically (open + arrow keys) -- see this module's
  // header comment for why that has to stay out of the sequential Tab order.
  button.tabIndex = -1;

  const label = document.createElement('span');

  if (item.marker !== undefined) {
    // A `menuitem` that *shows* a state without owning it. The glyph column is
    // built the same way the checkbox branch builds it, so a mixed list still
    // lines up.
    button.setAttribute('role', 'menuitem');
    const check = document.createElement('span');
    check.className = 'popup-menu__check';
    check.setAttribute('aria-hidden', 'true');
    label.append(check, document.createTextNode(item.label));
  } else if (item.checked === undefined) {
    button.setAttribute('role', 'menuitem');
    label.textContent = item.label;
  } else {
    button.setAttribute('role', 'menuitemcheckbox');
    button.setAttribute('aria-checked', item.checked ? 'true' : 'false');

    // A tick beside the label, not colour alone -- the pin/unpin menu's whole
    // point is showing which commands are currently pinned.
    const check = document.createElement('span');
    check.className = 'popup-menu__check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = item.checked ? '✓' : '';
    label.append(check, document.createTextNode(item.label));
  }

  button.append(label);
  if (item.marker !== undefined) applyMarker(button, item.label, item.marker);

  if (item.shortcut !== undefined) {
    const shortcut = document.createElement('kbd');
    shortcut.textContent = item.shortcut;
    button.append(shortcut);
  }

  button.addEventListener('click', () => {
    // Focus first, then act: `onChoose` may replace the row the anchor lives
    // in, and a detached button cannot take focus.
    closeAndReturnFocus();
    onChoose(item.id);
  });

  if (onContextMenu !== undefined) {
    button.addEventListener('contextmenu', (event) => {
      // Without this, WebView2 shows its own context menu on top of ours --
      // the same reason ui/toolbar.ts's row handler preventDefaults.
      event.preventDefault();
      // Deliberately *not* closing the popup. Pinning three commands in a row
      // is the normal case, and a list that vanished after each one would make
      // it three round trips through the `···` button.
      onContextMenu(item.id);
    });
  }

  return button;
}

/**
 * Opens a popup anchored below `anchor`, replacing whatever popup (if any) is
 * currently open. See this module's header comment for the DOM shape and
 * `ui/menubar.ts`'s `buildPopup` for the keyboard conventions mirrored below.
 */
/**
 * Flips a marker on an item of the popup that is currently open.
 *
 * The alternative -- reopen the popup with fresh items -- closes it under the
 * user's cursor, and pinning several commands in a row is the normal case. A
 * no-op when nothing is open or the id is not in it, so the caller does not
 * have to know which popup it is talking to.
 */
export function setPopupMarker(id: string, marker: { on: boolean; label: string }): void {
  const button = openMenu?.querySelector<HTMLButtonElement>(`[data-item-id="${id}"]`);
  if (button === null || button === undefined) return;

  // The label without the marker's suffix. Read from the DOM rather than kept
  // in module state: the popup owns its own rendering, and a second copy of
  // every label here would be a second thing to keep in step.
  const label = button.querySelector('.popup-menu__check')?.nextSibling?.textContent ?? '';
  applyMarker(button, label, marker);
}

/**
 * Re-points the open popup at a replacement anchor.
 *
 * The toolbar rebuilds its whole row whenever a pin changes, which detaches the
 * `···` button the popup is anchored to -- and the popup stays open on purpose,
 * because pinning two commands in a row should not mean opening the list twice.
 * Without this the popup would be left holding a node that is no longer in the
 * document: Escape would return focus to nowhere, and the next click on the new
 * `···` button would not read as "close the one I have open".
 *
 * A no-op when nothing is open, so the caller does not have to ask first.
 */
export function repointPopupAnchor(anchor: HTMLElement): void {
  if (openMenu === null) return;
  openAnchor = anchor;
}

export function openPopupMenu(options: OpenPopupMenuOptions): void {
  // Closes the menu bar's popup, if one is open. Fired before this popup is
  // built, so the listener registered below cannot close what it just opened.
  announcePopupOpening();
  closePopupMenu();

  const { anchor, items, onChoose, onContextMenu, hint } = options;

  const menu = document.createElement('div');
  menu.className = 'popup-menu';
  menu.setAttribute('role', 'menu');

  // A click landing on the popup's own padding (not a button) would
  // otherwise bubble to the document-level listener registered below that
  // closes on outside clicks. Stop it here so only genuine outside clicks
  // close the popup -- same convention as ui/menubar.ts's buildPopup, and
  // this also means a menu item's own click never reaches that listener
  // either, since closePopupMenu() above is already idempotent by the time
  // it would.
  menu.addEventListener('click', (event) => event.stopPropagation());

  const buttons = items.map((item) => buildItem(item, onChoose, onContextMenu));
  buttons.forEach((button) => menu.append(button));

  if (hint !== undefined) {
    const note = document.createElement('div');
    note.className = 'popup-menu__hint';
    note.textContent = hint;
    // Inside the menu, but `aria-hidden` -- which takes it out of the
    // accessibility tree entirely, so the menu's accessible children are still
    // nothing but menu items. The first attempt put it *after* the menu
    // element, which silently did nothing: `after()` needs a parent, and the
    // popup is not in the document until further down this function.
    //
    // Hiding it costs a screen-reader user nothing here: every item in a list
    // that carries a hint already states its own state in its accessible name,
    // and this line exists for the sighted question "there are ticks in this
    // list, how do I change them?".
    note.setAttribute('aria-hidden', 'true');
    menu.append(note);
  }

  menu.addEventListener('keydown', (event) => {
    const currentIndex = buttons.findIndex((button) => button === document.activeElement);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        buttons[(currentIndex + 1) % buttons.length]?.focus();
        break;
      case 'ArrowUp':
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
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const item = items[currentIndex];
        if (item) {
          closePopupMenu();
          onChoose(item.id);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        // Prevent the document-level Escape listener below from also running
        // for this same key press -- closing twice is not the kind of thing
        // that needs to happen.
        event.stopPropagation();
        closeAndReturnFocus();
        break;
      default:
        break;
    }
  });

  const { left, bottom } = anchor.getBoundingClientRect();
  menu.style.left = `${left}px`;
  menu.style.top = `${bottom}px`;

  document.body.append(menu);

  openMenu = menu;
  openAnchor = anchor;

  outsideClickListener = () => closePopupMenu();
  document.addEventListener('click', outsideClickListener);

  documentEscapeListener = (event) => {
    if (event.key === 'Escape') closeAndReturnFocus();
  };
  document.addEventListener('keydown', documentEscapeListener);

  // Opens with the first item already focused: unlike ui/menubar.ts's popups
  // (whose initial focus depends on whether the trigger was reached by mouse
  // or keyboard, per its FocusTarget parameter), every caller here has a
  // single, simple "open" action, so there is only one sensible place for
  // focus to land.
  buttons[0]?.focus();
}
