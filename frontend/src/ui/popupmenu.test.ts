// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closePopupMenu, openPopupMenu, setPopupMarker } from './popupmenu';
import { mountMenuBar } from './menubar';

afterEach(() => {
  closePopupMenu();
  document.body.innerHTML = '';
});

function anchorInDocument(): HTMLButtonElement {
  const button = document.createElement('button');
  document.body.append(button);
  return button;
}

describe('openPopupMenu', () => {
  it('renders one item per entry with role menuitem', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      onChoose: () => {},
    });
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
  });

  it('calls onChoose and closes when an item is clicked', () => {
    const onChoose = vi.fn();
    openPopupMenu({ anchor: anchorInDocument(), items: [{ id: 'a', label: 'A' }], onChoose });
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
    expect(onChoose).toHaveBeenCalledWith('a');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('shows a shortcut beside an item that has one', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A', shortcut: 'Ctrl+A' }],
      onChoose: () => {},
    });
    expect(document.querySelector('kbd')?.textContent).toBe('Ctrl+A');
  });

  // Pin/unpin uses this: the context menu shows every command with a tick
  // beside the pinned ones.
  it('marks a checked item with aria-checked', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'A', checked: true },
        { id: 'b', label: 'B', checked: false },
      ],
      onChoose: () => {},
    });
    const items = document.querySelectorAll('[role="menuitemcheckbox"]');
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    expect(items[1]?.getAttribute('aria-checked')).toBe('false');
  });

  // Both dismissal paths return focus to the trigger, matching menubar.ts.
  // On the choose path this is only observable for a caller that runs no
  // editor command -- the toolbar's pin/unpin menu -- because elsewhere
  // toEditorCommand's own view.focus() would mask a drop to <body>.
  it('returns focus to the anchor after an item is chosen, not just after Escape', () => {
    const anchor = anchorInDocument();
    anchor.focus();
    openPopupMenu({ anchor, items: [{ id: 'a', label: 'A', checked: false }], onChoose: () => {} });
    document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!.focus();

    document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!.click();

    expect(document.activeElement).toBe(anchor);
  });

  it('closes on Escape', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A' }],
      onChoose: () => {},
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('moves focus between items with the arrow keys', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      onChoose: () => {},
    });
    const menu = document.querySelector('[role="menu"]')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('B');
  });

  // Two popups at once would leave an orphan in the DOM that nothing closes.
  it('replaces an already-open popup rather than stacking', () => {
    const anchor = anchorInDocument();
    openPopupMenu({ anchor, items: [{ id: 'a', label: 'A' }], onChoose: () => {} });
    openPopupMenu({ anchor, items: [{ id: 'b', label: 'B' }], onChoose: () => {} });
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  });

  // --- Additional coverage beyond the brief's given tests ---

  it('opens with the first item already focused', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      onChoose: () => {},
    });
    expect(document.activeElement?.textContent).toContain('A');
  });

  it('wraps from the last item to the first with ArrowDown', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      onChoose: () => {},
    });
    const menu = document.querySelector('[role="menu"]')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('A');
  });

  it('moves to the last item with End and back to the first with Home', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      onChoose: () => {},
    });
    const menu = document.querySelector('[role="menu"]')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('C');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('A');
  });

  it('activates the focused item on Enter', () => {
    const onChoose = vi.fn();
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      onChoose,
    });
    const menu = document.querySelector('[role="menu"]')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onChoose).toHaveBeenCalledWith('b');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  // A leading item with no `checked` field at all must render as a plain
  // menuitem, not a checkbox that happens to read false -- `checked: false`
  // and "no checked field" are different inputs and must render differently.
  // A wrong implementation using `item.checked ? ... : 'menuitem'` (instead
  // of testing `item.checked === undefined`) would make an *unchecked*
  // checkbox item indistinguishable from a plain item -- this fails that.
  it('renders a plain menuitem, not a checkbox, when checked is entirely absent', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A' }],
      onChoose: () => {},
    });
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
  });

  // menu-popup's own convention (ui/menubar.ts's buildPopup): a click landing
  // on the popup's own padding must not bubble out to the same
  // outside-click listener that closes the popup, or every click anywhere
  // near an item would risk closing the menu out from under the user. A
  // wrong implementation that skips the popup's own click-stopPropagation
  // listener would let this bubble to document and close -- this fails that.
  it('does not close when a click lands on the popup itself, off any item', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A' }],
      onChoose: () => {},
    });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('closes when a click lands outside the popup', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A' }],
      onChoose: () => {},
    });
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  // Returning focus to the trigger on Escape is what lets a keyboard user
  // keep going from where they were, instead of losing focus to <body>. A
  // wrong implementation that just removes the popup without refocusing
  // would leave document.activeElement as <body> here.
  it('returns focus to the anchor button after Escape', () => {
    const anchor = anchorInDocument();
    openPopupMenu({ anchor, items: [{ id: 'a', label: 'A' }], onChoose: () => {} });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(anchor);
  });
});

/**
 * The menu bar and this module are separate popup owners, and both stop
 * propagation on their own trigger clicks -- they have to, or the click that
 * opens a popup immediately reaches the document listener that closes it. The
 * side effect was that neither one's outside-click listener ever saw a click
 * on the other's trigger, so opening the File menu and then the toolbar's
 * overflow left *both* on screen with the File trigger still
 * aria-expanded="true". Escape happened to clear both; a click did not.
 */
describe('one popup at a time, across both popup owners', () => {
  it('closes the menu bar’s popup when this module opens one', () => {
    const host = document.createElement('div');
    document.body.append(host);
    mountMenuBar(host);

    host.querySelector<HTMLButtonElement>('#menubar-trigger-file')!.click();
    expect(document.querySelector('.menu-popup')).not.toBeNull();

    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A' }],
      onChoose: () => {},
    });

    expect(document.querySelector('.menu-popup')).toBeNull();
    expect(document.querySelector('.popup-menu')).not.toBeNull();
    expect(host.querySelector('#menubar-trigger-file')!.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('closes this module’s popup when the menu bar opens one', () => {
    const host = document.createElement('div');
    document.body.append(host);
    mountMenuBar(host);

    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A' }],
      onChoose: () => {},
    });
    expect(document.querySelector('.popup-menu')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('#menubar-trigger-file')!.click();

    expect(document.querySelector('.popup-menu')).toBeNull();
    expect(document.querySelector('.menu-popup')).not.toBeNull();
  });
});

/**
 * A `marker`: a state an item **shows** without **owning** it.
 *
 * The distinction is the item's primary action, and it is the whole reason this
 * exists rather than reusing `checked`. A `checked` item's click flips its own
 * tick, so `role="menuitemcheckbox"` is honest. A marked item's click does
 * something else -- in the overflow list, it runs the command -- while the tick
 * says whether that command is pinned. Announcing it as a checkbox would tell a
 * screen-reader user the click toggles the tick, which is a lie about the
 * control.
 */
describe('a marked item', () => {
  function open(on: boolean): HTMLButtonElement {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'Blockquote', marker: { on, label: 'pinned to toolbar' } }],
      onChoose: () => {},
    });
    return document.querySelector<HTMLButtonElement>('[role="menu"] button')!;
  }

  it('stays a menuitem rather than becoming a checkbox', () => {
    const item = open(true);

    expect(item.getAttribute('role')).toBe('menuitem');
    expect(item.hasAttribute('aria-checked')).toBe(false);
  });

  /**
   * The state goes into the accessible *name* instead, so it is announced --
   * "Blockquote, pinned to toolbar" -- without claiming the click will change
   * it.
   */
  it('says its state in the accessible name when it is on', () => {
    expect(open(true).getAttribute('aria-label')).toBe('Blockquote, pinned to toolbar');
  });

  it('names itself plainly when it is off', () => {
    expect(open(false).getAttribute('aria-label')).toBe('Blockquote');
  });

  /** A tick, not colour alone, and the column is reserved either way. */
  it('shows a tick only when it is on', () => {
    expect(open(true).querySelector('.popup-menu__check')?.textContent).toBe('✓');
    expect(open(false).querySelector('.popup-menu__check')?.textContent).toBe('');
  });
});

describe('right-clicking an item', () => {
  function openWith(onContextMenu: (id: string) => void): HTMLButtonElement {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'A', marker: { on: false, label: 'pinned' } },
        { id: 'b', label: 'B', marker: { on: true, label: 'pinned' } },
      ],
      onChoose: () => {},
      onContextMenu,
    });
    return document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')[1]!;
  }

  it('calls onContextMenu with that item’s id', () => {
    const onContextMenu = vi.fn();
    openWith(onContextMenu).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith('b');
  });

  /**
   * **The popup stays open**, unlike a left-click. Pinning two commands in a
   * row should be one visit to the list, not two -- which was the whole
   * objection to routing this through a second popup.
   */
  it('leaves the popup open', () => {
    openWith(vi.fn()).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  /** Or WebView2 draws its own context menu on top of ours. */
  it('prevents the browser’s own menu', () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    openWith(vi.fn()).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  /** Nothing happens on a popup that did not ask for the gesture. */
  it('is inert when no handler was given', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A' }],
      onChoose: () => {},
    });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector<HTMLButtonElement>('[role="menu"] button')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

/**
 * Updating a marker **in place**. Rebuilding the popup instead would close it
 * under the user's cursor, which is the thing the right-click gesture exists to
 * avoid.
 */
describe('setPopupMarker', () => {
  function openTwo(): void {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [
        { id: 'a', label: 'Blockquote', marker: { on: false, label: 'pinned to toolbar' } },
        { id: 'b', label: 'Footnote', marker: { on: false, label: 'pinned to toolbar' } },
      ],
      onChoose: () => {},
    });
  }

  it('flips the tick and the name without touching the other items', () => {
    openTwo();

    setPopupMarker('a', { on: true, label: 'pinned to toolbar' });

    const [first, second] = document.querySelectorAll<HTMLButtonElement>('[role="menu"] button');
    expect(first!.querySelector('.popup-menu__check')?.textContent).toBe('✓');
    expect(first!.getAttribute('aria-label')).toBe('Blockquote, pinned to toolbar');
    expect(second!.querySelector('.popup-menu__check')?.textContent).toBe('');
    expect(second!.getAttribute('aria-label')).toBe('Footnote');
  });

  it('flips back off again', () => {
    openTwo();

    setPopupMarker('a', { on: true, label: 'pinned to toolbar' });
    setPopupMarker('a', { on: false, label: 'pinned to toolbar' });

    const first = document.querySelector<HTMLButtonElement>('[role="menu"] button')!;
    expect(first.querySelector('.popup-menu__check')?.textContent).toBe('');
    expect(first.getAttribute('aria-label')).toBe('Blockquote');
  });

  /** Called unconditionally by the toolbar, so it must tolerate both. */
  it('does nothing for an unknown id, or with no popup open', () => {
    openTwo();
    expect(() => setPopupMarker('nope', { on: true, label: 'x' })).not.toThrow();

    closePopupMenu();
    expect(() => setPopupMarker('a', { on: true, label: 'x' })).not.toThrow();
  });
});

describe('the hint line', () => {
  function openWithHint(): void {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A', marker: { on: false, label: 'pinned' } }],
      onChoose: () => {},
      hint: 'Right-click an item to pin or unpin it',
    });
  }

  it('renders the text it was given', () => {
    openWithHint();

    expect(document.querySelector('.popup-menu__hint')?.textContent).toBe(
      'Right-click an item to pin or unpin it',
    );
  });

  /**
   * `aria-hidden`, which keeps the menu's accessible children nothing but menu
   * items -- a `role="menu"` containing loose text is invalid, and there is
   * nothing for a screen reader to navigate to anyway. Every item in a list
   * that carries a hint already states its state in its own name.
   */
  it('is out of the accessibility tree, and not a menu item', () => {
    openWithHint();
    const note = document.querySelector('.popup-menu__hint')!;

    expect(note.getAttribute('aria-hidden')).toBe('true');
    expect(note.getAttribute('role')).toBeNull();
    expect(document.querySelectorAll('[role="menu"] button')).toHaveLength(1);
  });

  it('is absent from a popup that did not ask for one', () => {
    openPopupMenu({
      anchor: anchorInDocument(),
      items: [{ id: 'a', label: 'A' }],
      onChoose: () => {},
    });

    expect(document.querySelector('.popup-menu__hint')).toBeNull();
  });
});
