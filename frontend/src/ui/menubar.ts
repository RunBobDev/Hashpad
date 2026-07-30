/**
 * The menu bar is HTML rather than a native OS menu because SPEC §6.1 places it
 * on the same 28px row as the window controls, which a native menu cannot do.
 *
 * Items do not call into features directly — they dispatch a `hashpad:command`
 * event. Later checkpoints subscribe to that, so adding a File > Save does not
 * mean editing this file's imports.
 *
 * Keyboard interaction follows the WAI-ARIA Authoring Practices "menubar"
 * pattern (https://www.w3.org/WAI/ARIA/apg/patterns/menubar/). Two focus
 * regions cooperate:
 *  - The four top-level buttons share a single roving tabindex, so Tab
 *    enters/exits the bar as one stop instead of walking all four buttons.
 *  - Whichever popup is open manages Up/Down/Home/End navigation among its
 *    own items, and Left/Right hands off to the neighbouring top-level menu.
 */
import {
  Quit,
  WindowMinimise,
  WindowToggleMaximise,
} from '../../wailsjs/runtime/runtime';

export const COMMAND_EVENT = 'hashpad:command';

interface MenuItem {
  id: string;
  label: string;
  /** Displayed beside the label; every shortcut is discoverable here (SPEC §6.14). */
  shortcut?: string;
  /** Commands whose checkpoint has not landed yet render greyed rather than lying. */
  enabled: boolean;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

/**
 * Most items are still disabled — later checkpoints flip their own items to
 * enabled as each feature lands. They are listed anyway to fix the structure
 * and the shortcut assignments up front.
 *
 * `help.about` is disabled for the same reason: there is no About dialog yet,
 * so leaving it enabled would mean an item that does nothing when activated.
 * `edit.undo`/`edit.redo` are enabled: the editor ships `history()` and
 * `historyKeymap` (see editor/extensions.ts), so Ctrl+Z/Ctrl+Y already work —
 * the menu items must be reachable too, or the shortcut exists with no menu
 * path to it. The four File items above `exit` are enabled for the same
 * reason, now that `files/fileops.ts` and the matching keymap in
 * `editor/extensions.ts` back them: New, Open, Save, and Save As all do real
 * work, and Ctrl+N/O/S/Shift+S already work as shortcuts.
 *
 * Still unavailable: Edit > Find/Replace (no search panel yet), every View
 * item (no preview, outline, or word-wrap toggle yet), and Help > About (no
 * dialog yet).
 */
const MENUS: Menu[] = [
  {
    label: 'File',
    items: [
      { id: 'file.new', label: 'New', shortcut: 'Ctrl+N', enabled: true },
      { id: 'file.open', label: 'Open…', shortcut: 'Ctrl+O', enabled: true },
      { id: 'file.save', label: 'Save', shortcut: 'Ctrl+S', enabled: true },
      { id: 'file.saveAs', label: 'Save As…', shortcut: 'Ctrl+Shift+S', enabled: true },
      { id: 'file.exit', label: 'Exit', enabled: true },
    ],
  },
  {
    label: 'Edit',
    items: [
      { id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', enabled: true },
      { id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y', enabled: true },
      { id: 'edit.find', label: 'Find…', shortcut: 'Ctrl+F', enabled: false },
      { id: 'edit.replace', label: 'Replace…', shortcut: 'Ctrl+H', enabled: false },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'view.preview', label: 'Preview', shortcut: 'Ctrl+Shift+P', enabled: false },
      { id: 'view.outline', label: 'Outline', shortcut: 'Ctrl+Shift+O', enabled: false },
      { id: 'view.wordWrap', label: 'Word Wrap', enabled: false },
      { id: 'view.fullscreen', label: 'Full Screen', shortcut: 'F11', enabled: false },
    ],
  },
  {
    label: 'Help',
    items: [{ id: 'help.about', label: 'About Hashpad', enabled: false }],
  },
];

function emit(id: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: id }));
}

/** Which end of a popup's item list should receive focus when it opens. */
type FocusTarget = 'first' | 'last' | 'none';

export function mountMenuBar(parent: HTMLElement): void {
  const bar = document.createElement('div');
  bar.className = 'menubar';

  const menus = document.createElement('div');
  menus.className = 'menubar__menus';
  menus.setAttribute('role', 'menubar');

  const topButtons: HTMLButtonElement[] = [];

  // Index of the top-level button that currently owns an open popup, or null
  // when nothing is open. `openPopup` is that popup's DOM node.
  let openIndex: number | null = null;
  let openPopup: HTMLElement | null = null;

  // Roving tabindex over the top-level buttons: exactly one is a Tab stop at
  // a time. This is what makes Tab enter/exit the bar as a single stop
  // instead of walking all four buttons (APG menubar pattern).
  let activeIndex = 0;

  function setRovingIndex(newIndex: number): void {
    topButtons[activeIndex]?.setAttribute('tabindex', '-1');
    topButtons[newIndex]?.setAttribute('tabindex', '0');
    activeIndex = newIndex;
  }

  /** Tears down the open popup without touching focus. */
  function removeOpenPopup(): void {
    if (openIndex !== null) topButtons[openIndex]?.setAttribute('aria-expanded', 'false');
    openPopup?.remove();
    openPopup = null;
    openIndex = null;
  }

  /**
   * Closes the open popup. Unless told otherwise, focus is moved to the
   * trigger button *before* the popup is removed from the DOM. Doing it in
   * the other order — remove first — pulls the currently-focused item out
   * from under the focus, and it silently falls back to <body> instead of
   * anywhere sensible. This default (focusTrigger: true) is also what the
   * Tab handlers below rely on: moving focus to the trigger first, then
   * removing the popup, lets the browser's native Tab handling compute
   * "next after the trigger button" instead of "next after <body>".
   * `focusTrigger: false` is for the document-level outside-click handler,
   * where a click has already moved focus to whatever was clicked (e.g. the
   * maximise button) — forcibly refocusing the trigger would yank focus back
   * to a place the user didn't click.
   */
  function closePopup(options: { focusTrigger?: boolean } = {}): void {
    const { focusTrigger = true } = options;
    const trigger = openIndex !== null ? topButtons[openIndex] : null;
    if (focusTrigger) trigger?.focus();
    removeOpenPopup();
  }

  /**
   * Activating an item (click, Enter, Space) closes the popup and dispatches
   * its command. An `aria-disabled` item does neither: no event, and the
   * popup stays open, because a disabled item advertises that a command
   * exists without pretending it can be run.
   */
  function activateItem(item: MenuItem, itemButton: HTMLButtonElement): void {
    if (itemButton.getAttribute('aria-disabled') === 'true') return;
    closePopup();
    emit(item.id);
  }

  function openMenuAt(index: number, focusTarget: FocusTarget): void {
    const menu = MENUS[index];
    const button = topButtons[index];
    if (!menu || !button) return;

    removeOpenPopup();
    const { popup, items } = buildPopup(menu, button, index);
    document.body.append(popup);
    button.setAttribute('aria-expanded', 'true');
    openPopup = popup;
    openIndex = index;

    if (focusTarget === 'first') items[0]?.focus();
    else if (focusTarget === 'last') items[items.length - 1]?.focus();
  }

  function buildPopup(
    menu: Menu,
    anchor: HTMLButtonElement,
    menuIndex: number,
  ): { popup: HTMLElement; items: HTMLButtonElement[] } {
    const popup = document.createElement('div');
    popup.className = 'menu-popup';
    popup.setAttribute('role', 'menu');
    // Names the popup after its trigger button (id set where the button is
    // created, below) so a screen reader announces e.g. "File menu" rather
    // than an unlabelled generic menu.
    popup.setAttribute('aria-labelledby', anchor.id);

    // A click landing on the popup's own padding (not a button) would
    // otherwise bubble up to the document-level listener that closes on
    // outside clicks. Stop it here so only genuine outside clicks close.
    popup.addEventListener('click', (event) => event.stopPropagation());

    const items: HTMLButtonElement[] = [];

    for (const item of menu.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      // Disabled items deliberately do NOT get the native `disabled`
      // property: that removes them from the focus order entirely, and a
      // keyboard or screen-reader user would have no way to discover that
      // "Save" exists but isn't available yet. `aria-disabled` greys the
      // item out and blocks activation (see activateItem) while leaving it
      // fully navigable — this looks like a bug but is exactly what the APG
      // menu pattern recommends.
      if (!item.enabled) button.setAttribute('aria-disabled', 'true');
      // Items are only ever focused programmatically (open + arrow keys), so
      // keep them out of the *sequential* Tab order. That's what lets Tab
      // exit the whole widget instead of walking the popup's items one by
      // one — see the 'Tab' case below.
      button.tabIndex = -1;

      const label = document.createElement('span');
      label.textContent = item.label;
      button.append(label);

      if (item.shortcut !== undefined) {
        const shortcut = document.createElement('kbd');
        shortcut.textContent = item.shortcut;
        button.append(shortcut);
      }

      button.addEventListener('click', () => activateItem(item, button));
      items.push(button);
      popup.append(button);
    }

    popup.addEventListener('keydown', (event) => {
      const currentIndex = items.findIndex((el) => el === document.activeElement);

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          items[(currentIndex + 1) % items.length]?.focus();
          break;
        case 'ArrowUp':
          event.preventDefault();
          items[(currentIndex - 1 + items.length) % items.length]?.focus();
          break;
        case 'Home':
          event.preventDefault();
          items[0]?.focus();
          break;
        case 'End':
          event.preventDefault();
          items[items.length - 1]?.focus();
          break;
        case 'Enter':
        case ' ': {
          event.preventDefault();
          const item = menu.items[currentIndex];
          const itemButton = items[currentIndex];
          if (item && itemButton) activateItem(item, itemButton);
          break;
        }
        case 'Escape':
          event.preventDefault();
          // Prevent the document-level Escape listener below from also
          // running for this key press; closePopup() is not the kind of
          // thing that needs to happen twice.
          event.stopPropagation();
          closePopup();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          event.preventDefault();
          const dir = event.key === 'ArrowRight' ? 1 : -1;
          const nextIndex = (menuIndex + dir + MENUS.length) % MENUS.length;
          // Focus was already inside a popup's item list, so the equivalent
          // move onto the next top-level menu is to land in its item list
          // too (mirrors ArrowDown on a top-level button), not merely on its
          // trigger button.
          setRovingIndex(nextIndex);
          openMenuAt(nextIndex, 'first');
          break;
        }
        case 'Tab':
          // Don't preventDefault: Tab's default action (move to the next/
          // previous focusable element) is resolved from
          // document.activeElement at dispatch time, so where focus sits
          // *before* the browser processes this key matters. closePopup()'s
          // default (focusTrigger: true) moves focus to the trigger button
          // first and only then removes the popup — removing it first would
          // pull the currently-focused item out of the DOM and drop focus to
          // <body>, restarting Tab navigation from the top of the document.
          closePopup();
          break;
        default:
          break;
      }
    });

    const { left, bottom } = anchor.getBoundingClientRect();
    popup.style.left = `${left}px`;
    popup.style.top = `${bottom}px`;
    return { popup, items };
  }

  for (const [i, menu] of MENUS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `menubar-trigger-${menu.label.toLowerCase()}`;
    button.textContent = menu.label;
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    // Only the first top-level button starts in the Tab order; see
    // setRovingIndex for how that single Tab stop moves.
    button.setAttribute('tabindex', i === 0 ? '0' : '-1');

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (openIndex === i) {
        closePopup();
        return;
      }
      setRovingIndex(i);
      button.focus();
      openMenuAt(i, 'none');
    });

    button.addEventListener('keydown', (event) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowLeft': {
          event.preventDefault();
          const dir = event.key === 'ArrowRight' ? 1 : -1;
          const nextIndex = (i + dir + MENUS.length) % MENUS.length;
          const menuWasOpen = openIndex !== null;
          setRovingIndex(nextIndex);
          topButtons[nextIndex]?.focus();
          // A menu was already open, so keep the same "browsing" experience
          // going on the newly focused button rather than requiring another
          // ArrowDown to reopen it.
          if (menuWasOpen) openMenuAt(nextIndex, 'none');
          break;
        }
        case 'ArrowDown':
        case 'Enter':
        case ' ':
          event.preventDefault();
          // If this menu is already open, rebuilding it via openMenuAt would
          // tear down and recreate an unchanged popup — just move focus to
          // the first item instead.
          if (openIndex === i) openPopup?.querySelector<HTMLButtonElement>('button')?.focus();
          else openMenuAt(i, 'first');
          break;
        case 'ArrowUp':
          event.preventDefault();
          openMenuAt(i, 'last');
          break;
        case 'Tab':
          // A mouse click opens the popup via openMenuAt(i, 'none'), which
          // leaves focus on this button rather than on a popup item — so
          // there was previously no handling here at all, and Tab would
          // leave the popup orphaned in the DOM (still expanded) while focus
          // moved on natively. Don't preventDefault: we only need the popup
          // gone before the browser's native Tab handling runs, not to
          // replace that handling.
          if (openIndex !== null) closePopup();
          break;
        default:
          break;
      }
    });

    topButtons.push(button);
    menus.append(button);
  }

  // A click outside the bar/popup has already put focus wherever it
  // landed (e.g. the maximise button); closePopup()'s default would yank
  // focus back to the trigger, so this path opts out via focusTrigger: false.
  document.addEventListener('click', () => closePopup({ focusTrigger: false }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePopup();
  });

  const spacer = document.createElement('div');
  spacer.className = 'menubar__spacer';

  const controls = document.createElement('div');
  controls.className = 'window-controls';

  // Icon-only buttons carry ARIA labels (SPEC §10). Glyphs are inline text
  // rather than an icon font — SPEC §6.1 forbids an icon-font dependency.
  const buttons: { action: string; glyph: string; label: string; onClick: () => void }[] = [
    { action: 'minimise', glyph: '─', label: 'Minimise', onClick: WindowMinimise },
    { action: 'maximise', glyph: '□', label: 'Maximise', onClick: WindowToggleMaximise },
    { action: 'close', glyph: '✕', label: 'Close', onClick: Quit },
  ];

  for (const spec of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = spec.action;
    button.textContent = spec.glyph;
    button.setAttribute('aria-label', spec.label);
    button.addEventListener('click', spec.onClick);
    controls.append(button);
  }

  bar.append(menus, spacer, controls);
  parent.append(bar);
}
