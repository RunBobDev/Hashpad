// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  commandFor,
  conflictFor,
  isDefaultShortcut,
  refusal,
  shortcutFor,
  shortcutFromEvent,
  withShortcut,
} from './shortcuts';

function press(init: KeyboardEventInit & { keyCode?: number }): string | null {
  return shortcutFromEvent(new KeyboardEvent('keydown', init));
}

describe('shortcutFromEvent', () => {
  it('names a letter in upper case after its modifiers, in a fixed order', () => {
    expect(press({ key: 's', keyCode: 83, ctrlKey: true })).toBe('Ctrl+S');
    expect(press({ key: 'S', keyCode: 83, ctrlKey: true, shiftKey: true, altKey: true })).toBe(
      'Ctrl+Alt+Shift+S',
    );
  });

  /** The key, not the character Shift makes of it -- which differs by layout. */
  it('names a shifted digit by its key', () => {
    expect(press({ key: '*', keyCode: 56, ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+8');
    expect(press({ key: '(', keyCode: 56, ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+8');
  });

  it('takes an F key with or without modifiers', () => {
    expect(press({ key: 'F3', keyCode: 114 })).toBe('F3');
    expect(press({ key: 'F3', keyCode: 114, shiftKey: true })).toBe('Shift+F3');
  });

  it('reads =, Shift+= and the numpad + all as Plus', () => {
    expect(press({ key: '=', keyCode: 187, ctrlKey: true })).toBe('Ctrl+Plus');
    expect(press({ key: '+', keyCode: 187, ctrlKey: true, shiftKey: true })).toBe('Ctrl+Plus');
    expect(press({ key: '+', keyCode: 107, ctrlKey: true })).toBe('Ctrl+Plus');
  });

  it('names minus, arrows, space and punctuation the way the menus show them', () => {
    expect(press({ key: '_', keyCode: 189, ctrlKey: true, shiftKey: true })).toBe(
      'Ctrl+Shift+Minus',
    );
    expect(press({ key: 'ArrowLeft', keyCode: 37, ctrlKey: true, shiftKey: true })).toBe(
      'Ctrl+Shift+Left',
    );
    expect(press({ key: ' ', keyCode: 32, ctrlKey: true })).toBe('Ctrl+Space');
    expect(press({ key: ',', keyCode: 188, ctrlKey: true })).toBe('Ctrl+,');
    expect(press({ key: 'Tab', keyCode: 9, ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+Tab');
  });

  it('is nothing for a modifier on its own, or with the Windows key held', () => {
    expect(press({ key: 'Control', keyCode: 17, ctrlKey: true })).toBeNull();
    expect(press({ key: 'Shift', keyCode: 16, ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press({ key: 'e', keyCode: 69, metaKey: true })).toBeNull();
  });

  /** AltGr arrives as Ctrl+Alt; on a Croatian keyboard AltGr+1 types `~`. */
  it('treats a character typed with AltGr as typing', () => {
    expect(press({ key: '~', keyCode: 49, ctrlKey: true, altKey: true })).toBeNull();
    expect(press({ key: '@', keyCode: 86, ctrlKey: true, altKey: true })).toBeNull();
  });

  it('keeps Ctrl+Alt when it types nothing else, as on a US keyboard', () => {
    expect(press({ key: '1', keyCode: 49, ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+1');
    expect(press({ key: 't', keyCode: 84, ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+T');
    expect(press({ key: '!', keyCode: 49, ctrlKey: true, altKey: true, shiftKey: true })).toBe(
      'Ctrl+Alt+Shift+1',
    );
  });

  /** jsdom and hand-built events carry no keyCode; the key is all there is. */
  it('falls back to the key when there is no keyCode', () => {
    expect(press({ key: 'b', ctrlKey: true })).toBe('Ctrl+B');
    expect(press({ key: 'F11' })).toBe('F11');
  });
});

describe('the defaults', () => {
  it('give no two commands the same shortcut', () => {
    const keys = Object.values(DEFAULT_SHORTCUTS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('are all shortcuts the recorder would accept', () => {
    for (const key of Object.values(DEFAULT_SHORTCUTS)) expect(refusal(key)).toBeNull();
  });
});

describe('looking shortcuts up', () => {
  it('uses the default until the user changes it', () => {
    expect(shortcutFor({}, 'file.save')).toBe('Ctrl+S');
    expect(shortcutFor({ 'file.save': 'Ctrl+Alt+S' }, 'file.save')).toBe('Ctrl+Alt+S');
    expect(shortcutFor({ 'file.save': '' }, 'file.save')).toBe('');
    expect(shortcutFor({}, 'file.exit')).toBe('');
  });

  it('finds the command a key runs, and nothing for a moved default', () => {
    expect(commandFor({}, 'Ctrl+S')).toBe('file.save');
    const moved = { 'file.save': 'Ctrl+Alt+S' };
    expect(commandFor(moved, 'Ctrl+Alt+S')).toBe('file.save');
    expect(commandFor(moved, 'Ctrl+S')).toBeNull();
    expect(commandFor({ 'file.exit': 'Ctrl+Q' }, 'Ctrl+Q')).toBe('file.exit');
  });

  it('knows a default even after it was freed', () => {
    expect(isDefaultShortcut('Ctrl+B')).toBe(true);
    expect(isDefaultShortcut('Ctrl+G')).toBe(false);
  });
});

describe('refusal', () => {
  it('refuses a key that would stop typing', () => {
    expect(refusal('A')).toMatch(/Ctrl or Alt/);
    expect(refusal('Shift+A')).toMatch(/Ctrl or Alt/);
    expect(refusal('Delete')).toMatch(/Ctrl or Alt/);
  });

  it('refuses the clipboard keys and Alt+F4, and says what they are for', () => {
    expect(refusal('Ctrl+V')).toBe('Ctrl+V is kept for Paste.');
    expect(refusal('Ctrl+A')).toBe('Ctrl+A is kept for Select All.');
    expect(refusal('Alt+F4')).toBe('Alt+F4 is kept for closing the window.');
  });

  it('accepts Ctrl, Alt and F keys', () => {
    expect(refusal('Ctrl+Shift+V')).toBeNull();
    expect(refusal('Alt+Q')).toBeNull();
    expect(refusal('F5')).toBeNull();
    expect(refusal('Shift+F12')).toBeNull();
  });
});

describe('changing a shortcut', () => {
  it('reports the command that already has the key, but not the one being changed', () => {
    expect(conflictFor({}, 'file.save', 'Ctrl+B')).toBe('format.bold');
    expect(conflictFor({}, 'file.save', 'Ctrl+S')).toBeNull();
    expect(conflictFor({}, 'file.save', 'Ctrl+G')).toBeNull();
  });

  it('takes the key away from the command that had it', () => {
    const next = withShortcut({}, 'file.save', 'Ctrl+B');
    expect(next).toEqual({ 'file.save': 'Ctrl+B', 'format.bold': '' });
    expect(commandFor(next, 'Ctrl+B')).toBe('file.save');
    expect(commandFor(next, 'Ctrl+S')).toBeNull();
  });

  it('drops an entry that is back to its default', () => {
    expect(withShortcut({ 'file.save': 'Ctrl+Alt+S' }, 'file.save', 'Ctrl+S')).toEqual({});
  });

  /** Resetting Bold while Save holds Ctrl+B gives it back and clears Save. */
  it('resolves a reset that collides with a moved shortcut', () => {
    const next = withShortcut(
      { 'file.save': 'Ctrl+B', 'format.bold': '' },
      'format.bold',
      'Ctrl+B',
    );
    expect(next).toEqual({ 'file.save': '' });
  });

  it('clears with an empty key, touching nothing else', () => {
    expect(withShortcut({}, 'format.bold', '')).toEqual({ 'format.bold': '' });
    expect(withShortcut({ 'file.exit': 'Ctrl+Q' }, 'file.exit', '')).toEqual({});
  });
});
