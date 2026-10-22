// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { store } from '../state/appcontext';
import { confirmResetShortcuts } from './confirmdialog';
import { buildShortcutsDialog, shortcutRows } from './shortcutsdialog';

vi.mock('../../wailsjs/go/app/App', () => ({
  LoadSettings: vi.fn(),
  SaveSettings: vi.fn(),
}));
// `showModal()` does not exist in jsdom; confirmdialog.test.ts covers the prompt.
vi.mock('./confirmdialog', () => ({ confirmResetShortcuts: vi.fn() }));

let dialog: HTMLDialogElement;

beforeEach(() => {
  vi.mocked(LoadSettings).mockResolvedValue({ shortcuts: {} } as never);
  vi.mocked(SaveSettings).mockResolvedValue(undefined as never);
  dialog = buildShortcutsDialog();
  document.body.append(dialog);
});

afterEach(() => {
  dialog.remove();
  store.setState((prev) => ({ ...prev, shortcuts: {} }));
  vi.clearAllMocks();
});

function row(id: string): HTMLElement {
  return dialog.querySelector<HTMLElement>(`[data-command="${id}"]`)!;
}

function keys(id: string): HTMLButtonElement {
  return row(id).querySelector<HTMLButtonElement>('.shortcuts-dialog__key')!;
}

function message(id: string): string {
  return row(id).querySelector('.shortcuts-dialog__message')?.textContent ?? '';
}

function choice(id: string, label: string): HTMLButtonElement {
  return [...row(id).querySelectorAll<HTMLButtonElement>('.shortcuts-dialog__choice')].find(
    (button) => button.textContent === label,
  )!;
}

function icon(id: string, index: 0 | 1): HTMLButtonElement {
  return row(id).querySelectorAll<HTMLButtonElement>('.shortcuts-dialog__icon')[index]!;
}

/** Starts recording on `id`'s row and presses one key there. */
function record(id: string, init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  keys(id).click();
  const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
  keys(id).dispatchEvent(event);
  return event;
}

describe('shortcutRows', () => {
  it('groups every command the way the menus do, with Formatting before Help', () => {
    const groups = [...new Set(shortcutRows().map((r) => r.group))];
    expect(groups).toEqual(['File', 'Edit', 'View', 'Tabs', 'Formatting', 'Help']);
  });

  it('lists the find keys under Find and Replace, the heading levels, and no Open Recent', () => {
    const ids = shortcutRows().map((r) => r.id);
    const find = ids.indexOf('edit.find');
    expect(ids.slice(find, find + 4)).toEqual([
      'edit.find',
      'edit.replace',
      'edit.findNext',
      'edit.findPrevious',
    ]);
    expect(ids).toContain('format.heading6');
    expect(ids).not.toContain('format.heading');
    expect(ids).not.toContain('file.openRecent');
  });

  it('gives every row a different command', () => {
    const ids = shortcutRows().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the shortcuts window', () => {
  it('shows each command’s keys, and None for a command without any', () => {
    expect(keys('file.save').textContent).toBe('Ctrl+S');
    expect(keys('file.exit').textContent).toBe('None');
    expect(icon('file.exit', 0).disabled).toBe(true);
    expect(icon('file.save', 1).hidden).toBe(true);
  });

  it('records a new shortcut and saves it', async () => {
    record('file.save', { key: 's', keyCode: 83, ctrlKey: true, altKey: true });

    expect(store.getState().shortcuts).toEqual({ 'file.save': 'Ctrl+Alt+S' });
    expect(keys('file.save').textContent).toBe('Ctrl+Alt+S');
    expect(icon('file.save', 1).hidden).toBe(false);
    await vi.waitFor(() =>
      expect(SaveSettings).toHaveBeenCalledWith({ shortcuts: { 'file.save': 'Ctrl+Alt+S' } }),
    );
  });

  it('refuses a plain key and the clipboard keys, and keeps listening', () => {
    const event = record('file.save', { key: 'a', keyCode: 65 });
    expect(event.defaultPrevented).toBe(true);
    expect(message('file.save')).toMatch(/Ctrl or Alt/);

    keys('file.save').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', keyCode: 86, ctrlKey: true, cancelable: true }),
    );
    expect(message('file.save')).toBe('Ctrl+V is kept for Paste.');
    expect(keys('file.save').textContent).toBe('Press keys…');
    expect(store.getState().shortcuts).toEqual({});
  });

  it('ignores a modifier pressed on its own', () => {
    record('file.save', { key: 'Control', keyCode: 17, ctrlKey: true });
    expect(keys('file.save').textContent).toBe('Press keys…');
    expect(message('file.save')).toBe('');
  });

  /** Prevented, so the same Escape does not also close the window. */
  it('cancels on Escape without closing anything', () => {
    const event = record('file.save', { key: 'Escape', keyCode: 27 });

    expect(event.defaultPrevented).toBe(true);
    expect(keys('file.save').textContent).toBe('Ctrl+S');
    expect(store.getState().shortcuts).toEqual({});
  });

  it('lets Tab leave without recording it', () => {
    const event = record('file.save', { key: 'Tab', keyCode: 9 });

    expect(event.defaultPrevented).toBe(false);
    expect(keys('file.save').textContent).toBe('Ctrl+S');
  });

  it('asks before taking a key from another command, and Replace takes it', () => {
    record('file.save', { key: 'b', keyCode: 66, ctrlKey: true });

    expect(message('file.save')).toContain('Ctrl+B is used by Bold.');
    expect(store.getState().shortcuts).toEqual({});

    choice('file.save', 'Replace').click();

    expect(store.getState().shortcuts).toEqual({ 'file.save': 'Ctrl+B', 'format.bold': '' });
    expect(keys('format.bold').textContent).toBe('None');
    expect(message('file.save')).toBe('');
  });

  it('leaves both commands alone on Cancel', () => {
    record('file.save', { key: 'b', keyCode: 66, ctrlKey: true });
    choice('file.save', 'Cancel').click();

    expect(store.getState().shortcuts).toEqual({});
    expect(keys('file.save').textContent).toBe('Ctrl+S');
    expect(message('file.save')).toBe('');
  });

  it('clears a shortcut, which then offers its default back', () => {
    icon('format.bold', 0).click();

    expect(store.getState().shortcuts).toEqual({ 'format.bold': '' });
    expect(keys('format.bold').textContent).toBe('None');
    expect(icon('format.bold', 1).hidden).toBe(false);
  });

  /** Save took Ctrl+B; resetting Bold has to ask for it back. */
  it('asks before a reset takes back a key another command now has', () => {
    store.setState((prev) => ({
      ...prev,
      shortcuts: { 'file.save': 'Ctrl+B', 'format.bold': '' },
    }));
    dialog.remove();
    dialog = buildShortcutsDialog();
    document.body.append(dialog);

    icon('format.bold', 1).click();
    expect(message('format.bold')).toContain('Ctrl+B is used by Save.');
    choice('format.bold', 'Replace').click();

    expect(store.getState().shortcuts).toEqual({ 'file.save': '' });
    expect(keys('format.bold').textContent).toBe('Ctrl+B');
  });

  it('resets every shortcut once confirmed, and nothing when not', async () => {
    record('file.save', { key: 's', keyCode: 83, ctrlKey: true, altKey: true });
    const resetAll = dialog.querySelector<HTMLButtonElement>('.settings-dialog__reset')!;

    vi.mocked(confirmResetShortcuts).mockResolvedValueOnce(false);
    resetAll.click();
    await vi.waitFor(() => expect(confirmResetShortcuts).toHaveBeenCalledTimes(1));
    expect(store.getState().shortcuts).toEqual({ 'file.save': 'Ctrl+Alt+S' });

    vi.mocked(confirmResetShortcuts).mockResolvedValueOnce(true);
    resetAll.click();
    await vi.waitFor(() => expect(store.getState().shortcuts).toEqual({}));
    expect(keys('file.save').textContent).toBe('Ctrl+S');
  });

  it('finds commands by name or by keys, hiding empty groups', () => {
    const search = dialog.querySelector<HTMLInputElement>('.shortcuts-dialog__search')!;
    const visible = (): string[] =>
      [...dialog.querySelectorAll<HTMLElement>('.shortcuts-dialog__row:not([hidden])')].map(
        (r) => r.dataset.command!,
      );

    search.value = 'zoom';
    search.dispatchEvent(new Event('input'));
    expect(visible()).toEqual(['view.zoomIn', 'view.zoomOut', 'view.zoomReset']);
    const shownGroups = [...dialog.querySelectorAll('fieldset:not([hidden]) legend')];
    expect(shownGroups.map((legend) => legend.textContent)).toEqual(['View']);

    search.value = 'ctrl+shift+p';
    search.dispatchEvent(new Event('input'));
    expect(visible()).toEqual(['view.preview']);
  });
});
