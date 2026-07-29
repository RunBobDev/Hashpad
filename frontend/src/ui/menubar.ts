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
 * Checkpoint A can genuinely do very little, so most items are disabled. They
 * are listed anyway to fix the structure and the shortcut assignments; each
 * later checkpoint flips its own items to enabled.
 *
 * `edit.undo`, `edit.redo`, and `help.about` are disabled for the same reason:
 * there is no editor and no About dialog yet, so leaving them enabled would
 * mean an item that does nothing when activated.
 */
const MENUS: Menu[] = [
  {
    label: 'File',
    items: [
      { id: 'file.new', label: 'New', shortcut: 'Ctrl+N', enabled: false },
      { id: 'file.open', label: 'Open…', shortcut: 'Ctrl+O', enabled: false },
      { id: 'file.save', label: 'Save', shortcut: 'Ctrl+S', enabled: false },
      { id: 'file.saveAs', label: 'Save As…', shortcut: 'Ctrl+Shift+S', enabled: false },
      { id: 'file.exit', label: 'Exit', enabled: true },
    ],
  },
  {
    label: 'Edit',
    items: [
      { id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', enabled: false },
      { id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y', enabled: false },
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
   * anywhere sensible. `focusTrigger: false` is only for the Tab key, which
   * needs to leave focus alone so the browser's own Tab handling takes over.
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
          // Don't preventDefault — let the browser's default Tab behaviour
          // proceed; we only need the popup gone first.
          closePopup({ focusTrigger: false });
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
          openMenuAt(i, 'first');
          break;
        case 'ArrowUp':
          event.preventDefault();
          openMenuAt(i, 'last');
          break;
        default:
          break;
      }
    });

    topButtons.push(button);
    menus.append(button);
  }

  document.addEventListener('click', () => closePopup());
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
