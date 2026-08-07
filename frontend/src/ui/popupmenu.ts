/**
 * A generic popup menu (Task 7): the toolbar's heading-level picker, its
 * `···` overflow list, and its pin/unpin context menu all render through this
 * one implementation rather than three near-identical ones.
 *
 * Deliberately a plain absolutely-positioned `<div>`, not `<dialog>` -- jsdom
 * has no `<dialog>` support at all, and `ui/menubar.ts` (the house reference
 * for this convention) uses the same plain-div approach for the same reason.
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
}

interface OpenPopupMenuOptions {
  anchor: HTMLElement;
  items: PopupItem[];
  onChoose: (id: string) => void;
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

function buildItem(item: PopupItem, onChoose: (id: string) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  // Focused only programmatically (open + arrow keys) -- see this module's
  // header comment for why that has to stay out of the sequential Tab order.
  button.tabIndex = -1;

  const label = document.createElement('span');

  if (item.checked === undefined) {
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

  return button;
}

/**
 * Opens a popup anchored below `anchor`, replacing whatever popup (if any) is
 * currently open. See this module's header comment for the DOM shape and
 * `ui/menubar.ts`'s `buildPopup` for the keyboard conventions mirrored below.
 */
export function openPopupMenu(options: OpenPopupMenuOptions): void {
  closePopupMenu();

  const { anchor, items, onChoose } = options;

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

  const buttons = items.map((item) => buildItem(item, onChoose));
  buttons.forEach((button) => menu.append(button));

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
