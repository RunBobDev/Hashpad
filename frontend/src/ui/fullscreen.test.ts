/**
 * F11 (SPEC §6.14). Reported by the owner: the View entry was greyed out and
 * the shortcut did nothing.
 *
 * No DOM here -- this module is a boolean and two IPC calls, and the interesting
 * part is that the boolean stays in step with which call was made. The keymap
 * entry and the menu wiring are covered where they live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isFullscreen, syncFullscreen, toggleFullscreen } from './fullscreen';

beforeEach(async () => {
  // The flag is module state and every test below moves it, so each starts by
  // putting it back rather than depending on the file's order.
  await syncFullscreen(async () => false);
});

describe('toggling full screen', () => {
  it('starts windowed', () => {
    expect(isFullscreen()).toBe(false);
  });

  it('enters on the first press and reports it', () => {
    const enter = vi.fn();
    const leave = vi.fn();

    expect(toggleFullscreen(enter, leave)).toBe(true);

    expect(enter).toHaveBeenCalledOnce();
    expect(leave).not.toHaveBeenCalled();
    expect(isFullscreen()).toBe(true);
  });

  it('leaves on the second press', () => {
    const enter = vi.fn();
    const leave = vi.fn();

    toggleFullscreen(enter, leave);
    expect(toggleFullscreen(enter, leave)).toBe(false);

    expect(leave).toHaveBeenCalledOnce();
    expect(isFullscreen()).toBe(false);
  });

  /**
   * The flag is what the View menu ticks, and the menu resolves synchronously
   * while building its popup -- there is nothing to await `WindowIsFullscreen`
   * into. So the flag has to be exact rather than eventually correct, which it
   * is only because every transition goes through `toggle`.
   */
  it('reports the state the menu will show', () => {
    toggleFullscreen(vi.fn(), vi.fn());
    expect(isFullscreen()).toBe(true);

    toggleFullscreen(vi.fn(), vi.fn());
    expect(isFullscreen()).toBe(false);
  });
});

describe('reading the window state at startup', () => {
  it('adopts what the window reports', async () => {
    await syncFullscreen(async () => true);

    expect(isFullscreen()).toBe(true);
  });

  /**
   * A failed read must not be fatal -- it happens before the window is shown,
   * and the honest fallback is the state the window actually has on every path
   * that can reach here.
   */
  it('stays windowed when the window cannot be asked', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      syncFullscreen(() => Promise.reject(new Error('no runtime'))),
    ).resolves.toBeUndefined();

    expect(isFullscreen()).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
