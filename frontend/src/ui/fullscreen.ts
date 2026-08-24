/**
 * F11 (SPEC §6.14), the last item in the View menu that was still greyed out.
 *
 * Wails owns the window, so this is `WindowFullscreen`/`WindowUnfullscreen`
 * rather than the DOM's Fullscreen API. The DOM one would put an *element* full
 * screen inside a window that is still its old size, which on a frameless
 * window means the chrome we draw ourselves stays exactly where it was.
 *
 * **The current state is tracked here rather than asked for.** Wails offers
 * `WindowIsFullscreen`, but it returns a promise, and the View menu resolves its
 * indicators synchronously while building the popup (`ui/menubar.ts`) -- there
 * is nothing to await into. Since every transition goes through `toggle` below,
 * a local boolean is exact; it is not a second copy of a truth someone else
 * owns, it *is* where that truth is recorded on this side of the IPC.
 */
import { WindowFullscreen, WindowIsFullscreen, WindowUnfullscreen } from '../../wailsjs/runtime/runtime';

let fullscreen = false;

/** Whether the window is full screen, for the View menu's tick. */
export function isFullscreen(): boolean {
  return fullscreen;
}

/**
 * Flips full screen, and returns the state it moved to.
 *
 * Injectable calls so the wiring is testable: `wailsjs/runtime` is importable
 * under Vitest but reaches for `window.runtime`, which only the injected desktop
 * runtime provides.
 */
export function toggleFullscreen(
  enter: () => void = WindowFullscreen,
  leave: () => void = WindowUnfullscreen,
): boolean {
  fullscreen = !fullscreen;
  if (fullscreen) enter();
  else leave();
  return fullscreen;
}

/**
 * Re-reads the window's real state, for startup.
 *
 * Nothing sets `Fullscreen` in main.go's options, so this is `false` every time
 * today. It exists because "the local flag is exact" holds only while every
 * transition goes through `toggle`, and a future start-maximised-or-fullscreen
 * option would break that quietly -- this is the seam that would fix it, and it
 * costs one call at startup.
 */
export async function syncFullscreen(
  read: () => Promise<boolean> = WindowIsFullscreen,
): Promise<void> {
  try {
    fullscreen = await read();
  } catch (error) {
    // Not fatal: the flag stays false, which is what the window actually is on
    // every path that can reach here.
    console.error('hashpad: could not read the window fullscreen state', error);
  }
}
