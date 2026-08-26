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
import { COMMAND_EVENT, mountMenuBar } from './menubar';

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
   * in such a menu, which should carry no empty gutter.
   *
   * The negative example is **Edit**, and it used to be File. File stopped
   * qualifying the moment Autosave landed there (H.6), which is the rule
   * working rather than failing: File now has a stateful item, so File now
   * reserves the column. Edit is the menu left with nothing to show.
   */
  it('reserves the indicator column only where something uses it', () => {
    mountMenuBar(root, () => false);

    expect(item(open('View'), 'Zoom In').querySelector('.menu-item__mark')).not.toBeNull();
    expect(item(open('Edit'), 'Undo').querySelector('.menu-item__mark')).toBeNull();
    // And File does reserve it now, on a row that is not the toggle itself.
    expect(item(open('File'), 'New').querySelector('.menu-item__mark')).not.toBeNull();
  });

  /**
   * Reported by the owner alongside the missing indicators: Full Screen was
   * greyed out. An `aria-disabled` item stays focusable but `activateItem`
   * refuses to run its command, so the attribute is what decides whether the
   * entry does anything -- and it is a state, so it takes a tick too.
   */
  it('offers Full Screen as a working toggle', () => {
    mountMenuBar(root, (id) => id === 'view.fullscreen');

    const popup = open('View');
    const fullScreen = item(popup, 'Full Screen');

    expect(fullScreen.hasAttribute('aria-disabled')).toBe(false);
    expect(fullScreen.getAttribute('role')).toBe('menuitemcheckbox');
    expect(mark(popup, 'Full Screen')).toBe('✓');
  });

  /**
   * The owner turned line numbers on through settings.json and asked "what line
   * numbers?" -- the feature worked, but nothing in the app could switch it on,
   * so the only route was hand-editing a file. Word Wrap sits right beside it
   * and has had a menu entry all along.
   */
  it('offers Line Numbers as a toggle beside Word Wrap', () => {
    mountMenuBar(root, (id) => id === 'view.lineNumbers');

    const popup = open('View');
    const labels = [...popup.querySelectorAll('.menu-item__label')].map((el) => el.textContent);

    expect(labels).toContain('Line Numbers');
    expect(labels.indexOf('Line Numbers')).toBe(labels.indexOf('Word Wrap') + 1);
    expect(mark(popup, 'Line Numbers')).toBe('✓');
    expect(item(popup, 'Line Numbers').getAttribute('role')).toBe('menuitemcheckbox');
  });

  /** Mounting without a callback must not mark everything, or nothing, wrongly. */
  it('shows nothing checked when no state is supplied', () => {
    mountMenuBar(root);

    const popup = open('View');

    expect(mark(popup, 'Word Wrap')).toBe('');
    expect(item(popup, 'Word Wrap').getAttribute('aria-checked')).toBe('false');
  });
});

/**
 * SPEC §6.14: "Every shortcut must also be reachable through a menu, with the
 * shortcut displayed beside it." Ctrl+, is the newest one, and the keymap in
 * `editor/extensions.ts` only fires while the editor has focus -- so the menu
 * entry is not a convenience, it is the other half of the requirement.
 */
describe('File > Settings', () => {
  // Nothing in this group is a toggle, so the checked-state callback answers
  // `false` throughout -- the shared `beforeEach` builds `root` but leaves
  // mounting to each group, because the callback is what the group is varying.
  beforeEach(() => mountMenuBar(root, () => false));

  it('offers Settings with its shortcut beside it', () => {
    const popup = open('File');
    const entry = item(popup, 'Settings…');

    expect(entry.querySelector('kbd')?.textContent).toBe('Ctrl+,');
    expect(entry.getAttribute('aria-disabled')).not.toBe('true');
  });

  /**
   * Above Exit, which is the one item every File menu keeps last. Asserted as a
   * position rather than mere presence because "somewhere in the File menu" is
   * satisfied by putting it after the way out.
   */
  it('sits above Exit', () => {
    const popup = open('File');
    const labels = [...popup.querySelectorAll('.menu-item__label')].map((el) => el.textContent);

    expect(labels.indexOf('Settings…')).toBe(labels.indexOf('Exit') - 1);
  });

  it('emits settings.open when chosen', () => {
    const seen: string[] = [];
    const listen = (event: Event): void => {
      seen.push((event as CustomEvent<string>).detail);
    };
    document.addEventListener(COMMAND_EVENT, listen);

    item(open('File'), 'Settings…').click();
    document.removeEventListener(COMMAND_EVENT, listen);

    expect(seen).toEqual(['settings.open']);
  });
});

/**
 * SPEC §3.2's autosave, reachable without opening the settings dialog.
 *
 * In File rather than View, where the app's other checkable toggles live: this
 * one changes what *saving* does, not what is on screen, and it sits beside the
 * two commands it modifies.
 */
describe('File > Autosave', () => {
  it('is a checkable toggle, not a plain action', () => {
    mountMenuBar(root, () => false);
    const entry = item(open('File'), 'Autosave');

    expect(entry.getAttribute('role')).toBe('menuitemcheckbox');
    expect(entry.getAttribute('aria-checked')).toBe('false');
  });

  it('ticks when the callback says autosave is on', () => {
    mountMenuBar(root, (id) => id === 'file.autosave');
    const entry = item(open('File'), 'Autosave');

    expect(entry.getAttribute('aria-checked')).toBe('true');
    expect(entry.querySelector('.menu-item__mark')?.textContent).toBe('✓');
  });

  /**
   * Beside Save As, not at the bottom of the menu. Position is asserted because
   * "somewhere in File" is satisfied by dropping it under Exit, where nobody
   * relating it to saving would ever look.
   */
  it('sits directly after Save As', () => {
    mountMenuBar(root, () => false);
    const labels = [...open('File').querySelectorAll('.menu-item__label')].map(
      (el) => el.textContent,
    );

    expect(labels.indexOf('Autosave')).toBe(labels.indexOf('Save As…') + 1);
  });

  it('emits file.autosave when chosen', () => {
    mountMenuBar(root, () => false);
    const seen: string[] = [];
    const listen = (event: Event): void => {
      seen.push((event as CustomEvent<string>).detail);
    };
    document.addEventListener(COMMAND_EVENT, listen);

    item(open('File'), 'Autosave').click();
    document.removeEventListener(COMMAND_EVENT, listen);

    expect(seen).toEqual(['file.autosave']);
  });
});
