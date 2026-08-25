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
import { Quit, WindowMinimise, WindowToggleMaximise } from '../../wailsjs/runtime/runtime';

export const COMMAND_EVENT = 'hashpad:command';

/**
 * Announced by any module about to open a popup, so every *other* popup can
 * close itself first.
 *
 * This exists because both popup owners stop propagation on their own trigger
 * clicks -- they have to, or the click that opens a popup immediately reaches
 * the document-level listener that closes it. The side effect is that neither
 * module's outside-click listener ever sees a click on the other's trigger,
 * so before this, opening the File menu and then the `···` overflow left both
 * on screen at once. Escape happened to clear both (neither Escape listener
 * stops propagation); a click did not.
 *
 * A dispatcher must fire this *before* opening its own popup, so it does not
 * immediately close what it just opened.
 */
export const POPUP_OPENING_EVENT = 'hashpad:popup-opening';

/** Fires POPUP_OPENING_EVENT. See that constant for why this seam exists. */
export function announcePopupOpening(): void {
  document.dispatchEvent(new CustomEvent(POPUP_OPENING_EVENT));
}

/**
 * Dispatches a `hashpad:command`. Shared rather than redefined per module --
 * ui/tabbar.ts, ui/toolbar.ts and editor/extensions.ts all dispatch the same
 * event, and all three already import COMMAND_EVENT from here.
 */
export function emitCommand(id: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: id }));
}

interface MenuItem {
  id: string;
  label: string;
  /** Displayed beside the label; every shortcut is discoverable here (SPEC §6.14). */
  shortcut?: string;
  /** Commands whose checkpoint has not landed yet render greyed rather than lying. */
  enabled: boolean;
  /**
   * Items that show their current state, and how.
   *
   * `check` is an independent on/off (Word Wrap, Preview); `radio` is one of a
   * group where exactly one is on (the three themes). Absent means the item is
   * an action -- it *does* something rather than *being* something -- and gets
   * no indicator at all.
   *
   * The distinction is not decorative: it picks the ARIA role, and a screen
   * reader announces "checked" for one and "selected, 1 of 3" for the other.
   */
  toggle?: 'check' | 'radio';
}

/**
 * Answers whether a stateful item is currently on, asked afresh every time a
 * popup opens.
 *
 * A callback rather than a field on `MenuItem` or a copy in the store, because
 * the truth is genuinely scattered: `wordWrap` lives in the store, the outline
 * and status bar are "is the handle non-null" in main.ts, and the preview is a
 * property of the *active document*. Mirroring all of that into a fourth place
 * would be a fourth thing to keep in sync. Popups are rebuilt on every open
 * (see `openMenuAt`), so asking at build time is always current and needs no
 * subscription.
 */
export type MenuItemChecked = (id: string) => boolean;

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
 * `tab.close`/`tab.reopen` sit in File next to New and Open rather than under
 * View or a new "Tabs" menu — SPEC §6.1 fixes the bar at exactly four menus
 * (File, Edit, View, Help), so tab management has to live inside one of
 * those, and it is fundamentally about which file is open, same as New and
 * Open. `tab.next`/`tab.previous` go under View instead: they change what is
 * *displayed*, not what documents exist, which is the same distinction that
 * already separates View's other (still-disabled) display toggles from
 * File's document operations. "Go to Tab 1".."Go to Tab 9" are listed even
 * though nine near-identical entries are more than this menu wants: SPEC §6.14
 * requires every shortcut to be reachable through a menu with its shortcut
 * displayed, and a single summary line would show the chord without being
 * invocable, which is not what that asks for.
 *
 * Still unavailable: Edit > Find/Replace (no search panel yet), View's
 * display toggles (no preview, outline, or word-wrap yet), and Help > About
 * (no dialog yet).
 *
 * `theme.system`/`theme.light`/`theme.dark` sit in their own group below the
 * tab commands and above the (still-disabled) display toggles -- distinct
 * from both neighbours rather than interleaved with either, so the menu
 * stays scannable per-topic. None carries a shortcut: SPEC §6.14's list of
 * chords to wire up has no entry for theme switching, so there is nothing to
 * display beside them (contrast `view.wordWrap`, also shortcut-less, for the
 * same reason). There is deliberately no fourth entry per accent preset:
 * SPEC §6.14 only requires *shortcuts* to be menu-reachable, and accents have
 * none, while §6.13 places appearance settings (and §6.12's custom colour
 * picker) in the settings dialog -- splitting the eight presets from the
 * picker across two surfaces would be worse than either alone, so accent
 * presets stay deferred to the settings dialog in Checkpoint H. Also
 * deliberately absent: a checkmark or radio indicator on whichever mode is
 * active. `MenuItem` has no field for that, and adding one is out of scope
 * for the checkpoint that first gives these commands somewhere to live.
 */
const MENUS: Menu[] = [
  {
    label: 'File',
    items: [
      { id: 'file.new', label: 'New', shortcut: 'Ctrl+N', enabled: true },
      { id: 'file.open', label: 'Open…', shortcut: 'Ctrl+O', enabled: true },
      { id: 'tab.close', label: 'Close Tab', shortcut: 'Ctrl+W', enabled: true },
      { id: 'tab.reopen', label: 'Reopen Closed Tab', shortcut: 'Ctrl+Shift+T', enabled: true },
      { id: 'file.save', label: 'Save', shortcut: 'Ctrl+S', enabled: true },
      { id: 'file.saveAs', label: 'Save As…', shortcut: 'Ctrl+Shift+S', enabled: true },
      // File rather than Edit: SPEC §6.1 gives this app File/Edit/View/Help and
      // no Tools menu, and the closest thing to a convention for a Windows
      // editor of this shape is VS Code's File > Preferences > Settings. SPEC
      // §6.14 requires every shortcut to be reachable from a menu, so Ctrl+,
      // needs an entry somewhere regardless.
      { id: 'settings.open', label: 'Settings…', shortcut: 'Ctrl+,', enabled: true },
      { id: 'file.exit', label: 'Exit', enabled: true },
    ],
  },
  {
    label: 'Edit',
    items: [
      { id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', enabled: true },
      { id: 'edit.redo', label: 'Redo', shortcut: 'Ctrl+Y', enabled: true },
      // One entry rather than two, at the owner's request: the panel is a single
      // row carrying both halves, so two menu items for one bar read as two
      // features. Ctrl+H still opens it with the cursor in the replace field --
      // it is the one shortcut this menu does not display, which bends SPEC
      // §6.14's "every shortcut reachable through a menu". What that rule is
      // really protecting is discoverability, and the replace controls are on
      // screen whenever the bar is.
      { id: 'edit.find', label: 'Find and Replace…', shortcut: 'Ctrl+F', enabled: true },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'tab.next', label: 'Next Tab', shortcut: 'Ctrl+Tab', enabled: true },
      { id: 'tab.previous', label: 'Previous Tab', shortcut: 'Ctrl+Shift+Tab', enabled: true },
      // Reordering is otherwise mouse-only: SPEC §6.2 asks for drag, but the
      // project's accessibility constraint asks for full keyboard navigability,
      // and a capability reachable only by dragging fails it. Ctrl+Shift with
      // the arrow keys is what Firefox and Chrome use for moving a tab.
      { id: 'tab.moveLeft', label: 'Move Tab Left', shortcut: 'Ctrl+Shift+Left', enabled: true },
      { id: 'tab.moveRight', label: 'Move Tab Right', shortcut: 'Ctrl+Shift+Right', enabled: true },
      // SPEC §6.14 requires every shortcut to be reachable through a menu with
      // its shortcut displayed. Nine entries is more than this menu wants, but
      // the requirement is explicit and a single summary line would show the
      // chord without actually being invocable, which is not what it asks for.
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `tab.goto${i + 1}`,
        label: `Go to Tab ${i + 1}`,
        shortcut: `Ctrl+Alt+${i + 1}`,
        enabled: true,
      })),
      // Prefixed rather than bare "System"/"Light"/"Dark": these sit directly
      // below "Go to Tab 9" in a flat list with no separators or submenus, so
      // an item reading only "System" says nothing about what it does.
      { id: 'theme.system', label: 'Theme: Follow System', enabled: true, toggle: 'radio' },
      { id: 'theme.light', label: 'Theme: Light', enabled: true, toggle: 'radio' },
      { id: 'theme.dark', label: 'Theme: Dark', enabled: true, toggle: 'radio' },
      {
        id: 'view.preview',
        label: 'Preview',
        shortcut: 'Ctrl+Shift+P',
        enabled: true,
        toggle: 'check',
      },
      {
        id: 'view.outline',
        label: 'Outline',
        shortcut: 'Ctrl+Shift+O',
        enabled: true,
        toggle: 'check',
      },
      { id: 'view.statusBar', label: 'Status Bar', enabled: true, toggle: 'check' },
      { id: 'view.wordWrap', label: 'Word Wrap', enabled: true, toggle: 'check' },
      // Beside Word Wrap because it is the same kind of thing: a display
      // toggle backed by a setting. SPEC §6.13 puts `showLineNumbers` in the
      // settings dialog, and it will be there too -- but wordWrap is in both
      // already, and a setting whose only switch is a JSON file is a setting
      // nobody finds. The owner found exactly that.
      { id: 'view.lineNumbers', label: 'Line Numbers', enabled: true, toggle: 'check' },
      { id: 'view.zoomIn', label: 'Zoom In', shortcut: 'Ctrl+Plus', enabled: true },
      { id: 'view.zoomOut', label: 'Zoom Out', shortcut: 'Ctrl+Minus', enabled: true },
      { id: 'view.zoomReset', label: 'Reset Zoom', shortcut: 'Ctrl+0', enabled: true },
      {
        id: 'view.fullscreen',
        label: 'Full Screen',
        shortcut: 'F11',
        enabled: true,
        toggle: 'check',
      },
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

export function mountMenuBar(parent: HTMLElement, isChecked: MenuItemChecked = () => false): void {
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

    // Before opening, not after: this closes the toolbar's popups, and firing
    // it afterwards would close the one being opened here.
    announcePopupOpening();
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
    // Decided per menu, not per item: File and Edit have no stateful items and
    // should not carry an empty column, while every row in View reserves one so
    // the labels align.
    const menuHasToggles = menu.items.some((candidate) => candidate.toggle !== undefined);

    for (const item of menu.items) {
      const button = document.createElement('button');
      button.type = 'button';
      // `menuitemcheckbox`/`menuitemradio` rather than plain `menuitem` for
      // stateful items: the role is what makes a screen reader announce the
      // state at all, and `aria-checked` on a plain `menuitem` is ignored.
      button.setAttribute(
        'role',
        item.toggle === 'check'
          ? 'menuitemcheckbox'
          : item.toggle === 'radio'
            ? 'menuitemradio'
            : 'menuitem',
      );
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

      // The indicator column. Present on *every* item in a menu that has any
      // stateful one, empty on the others, so the labels line up instead of
      // jumping left and right down the list -- which is how Windows draws it.
      // `aria-hidden` because the role and `aria-checked` above already carry
      // this to a screen reader; announcing a tick glyph as well would be a
      // second, worse copy of the same fact.
      if (menuHasToggles) {
        const mark = document.createElement('span');
        mark.className = 'menu-item__mark';
        mark.setAttribute('aria-hidden', 'true');
        if (item.toggle !== undefined && isChecked(item.id)) {
          mark.textContent = item.toggle === 'radio' ? '●' : '✓';
        }
        button.append(mark);
      }

      if (item.toggle !== undefined) {
        const checked = isChecked(item.id);
        button.setAttribute('aria-checked', checked ? 'true' : 'false');
        // Weight, not colour alone (SPEC §10) -- the same rule the outline's
        // current section follows. The glyph carries it for everyone; this is
        // what makes an active item findable while scanning rather than read.
        if (checked) button.classList.add('menu-item--checked');
      }

      const label = document.createElement('span');
      label.className = 'menu-item__label';
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
  // Another module is opening a popup; only one may be on screen at a time.
  // focusTrigger: false because focus belongs wherever the new popup puts it,
  // not yanked back to this menu's trigger.
  document.addEventListener(POPUP_OPENING_EVENT, () => closePopup({ focusTrigger: false }));
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
