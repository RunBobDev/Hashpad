// @vitest-environment jsdom
/**
 * The View menu showing which of its toggles are on.
 *
 * Reported by the owner: with word wrap enabled there was no way to tell short
 * of resizing the window to see whether lines wrapped. The same held for
 * Preview, Outline, Status Bar and which of the three themes was active --
 * `menubar.ts` even carried a comment saying the indicator was deliberately
 * deferred as out of scope for the checkpoint that created those items.
 *
 * The state is deliberately *not* stored here. It lives in four places --
 * the store, two nullable handles in main.ts, and the active document -- and
 * `mountMenuBar` takes a callback it asks each time a popup opens. The test
 * that matters most below is the one that changes the answer between two opens.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mountMenuBar } from './menubar';

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
});

/** Opens a top-level menu by its label and returns the popup. */
function open(label: string): HTMLElement {
  const button = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  expect(button, `a top-level "${label}" button`).toBeDefined();
  button!.click();

  const popup = document.querySelector<HTMLElement>('.menu-popup');
  expect(popup, `the "${label}" popup`).not.toBeNull();
  return popup!;
}

/**
 * Closes whatever is open. Clicking the trigger again is the toggle, which is
 * why the reopen test below cannot simply call `open` twice -- the second click
 * would shut the menu rather than reopen it.
 */
function close(label: string): void {
  [...root.querySelectorAll('button')]
    .find((candidate) => candidate.textContent === label)
    ?.click();
  expect(document.querySelector('.menu-popup')).toBeNull();
}

/** One item of an open popup, by its visible label. */
function item(popup: HTMLElement, label: string): HTMLButtonElement {
  const found = [...popup.querySelectorAll('button')].find(
    (candidate) => candidate.querySelector('.menu-item__label')?.textContent === label,
  );
  expect(found, `a "${label}" item`).toBeDefined();
  return found!;
}

function mark(popup: HTMLElement, label: string): string {
  return item(popup, label).querySelector('.menu-item__mark')?.textContent ?? '';
}

describe('the state of a toggle in the menu that toggles it', () => {
  it('ticks an independent toggle that is on', () => {
    mountMenuBar(root, (id) => id === 'view.wordWrap');

    const popup = open('View');
    const wordWrap = item(popup, 'Word Wrap');

    expect(mark(popup, 'Word Wrap')).toBe('✓');
    expect(wordWrap.getAttribute('aria-checked')).toBe('true');
    // The role is what makes a screen reader announce the state at all --
    // `aria-checked` on a plain `menuitem` is ignored.
    expect(wordWrap.getAttribute('role')).toBe('menuitemcheckbox');
  });

  it('leaves an independent toggle that is off unticked but announced', () => {
    mountMenuBar(root, () => false);

    const popup = open('View');

    expect(mark(popup, 'Word Wrap')).toBe('');
    expect(item(popup, 'Word Wrap').getAttribute('aria-checked')).toBe('false');
  });

  /** One of three, so a bullet and a different role -- "selected, 1 of 3". */
  it('marks the active theme as a radio choice', () => {
    mountMenuBar(root, (id) => id === 'theme.dark');

    const popup = open('View');

    expect(mark(popup, 'Theme: Dark')).toBe('●');
    expect(mark(popup, 'Theme: Light')).toBe('');
    expect(item(popup, 'Theme: Dark').getAttribute('role')).toBe('menuitemradio');
    expect(item(popup, 'Theme: Dark').getAttribute('aria-checked')).toBe('true');
  });

  /**
   * **The one that matters.** Popups are rebuilt on every open, which is what
   * lets the callback be asked afresh rather than mirrored into a fifth copy of
   * the state. Reading it once at mount would look identical until something
   * changed.
   */
  it('reflects a change made between two openings', () => {
    let wrapping = false;
    mountMenuBar(root, (id) => id === 'view.wordWrap' && wrapping);

    expect(mark(open('View'), 'Word Wrap')).toBe('');
    close('View');

    wrapping = true;

    expect(mark(open('View'), 'Word Wrap')).toBe('✓');
  });

  /**
   * An action is not a toggle. Zoom In *does* something; it is never "on", and
   * announcing it as unchecked would be a lie a screen reader reads out.
   */
  it('leaves plain actions unmarked whatever the callback says', () => {
    mountMenuBar(root, () => true);

    const popup = open('View');
    const zoom = item(popup, 'Zoom In');

    expect(zoom.getAttribute('role')).toBe('menuitem');
    expect(zoom.hasAttribute('aria-checked')).toBe(false);
    expect(mark(popup, 'Zoom In')).toBe('');
  });

  /**
   * The column is reserved on every row of a menu that has any stateful item,
   * so labels line up rather than stepping sideways down the list -- but only
   * in such a menu. File has nothing to show and should carry no empty gutter.
   */
  it('reserves the indicator column only where something uses it', () => {
    mountMenuBar(root, () => false);

    expect(item(open('View'), 'Zoom In').querySelector('.menu-item__mark')).not.toBeNull();
    expect(item(open('File'), 'New').querySelector('.menu-item__mark')).toBeNull();
  });

  /** Mounting without a callback must not mark everything, or nothing, wrongly. */
  it('shows nothing checked when no state is supplied', () => {
    mountMenuBar(root);

    const popup = open('View');

    expect(mark(popup, 'Word Wrap')).toBe('');
    expect(item(popup, 'Word Wrap').getAttribute('aria-checked')).toBe('false');
  });
});
