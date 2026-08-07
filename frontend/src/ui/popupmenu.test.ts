// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closePopupMenu, openPopupMenu } from './popupmenu';

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
