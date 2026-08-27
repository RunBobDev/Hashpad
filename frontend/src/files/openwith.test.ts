import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OPEN_FILES_EVENT, mountOpenWith, openPendingFiles } from './openwith';

describe('openPendingFiles', () => {
  it('opens what Go was holding', async () => {
    const open = vi.fn().mockResolvedValue(undefined);

    await openPendingFiles(() => Promise.resolve(['C:/notes/a.md']), open);

    expect(open).toHaveBeenCalledWith(['C:/notes/a.md']);
  });

  /**
   * Go drops anything that is not a regular file; SPEC §6.4's extension list is
   * this side's job. Dragging a `.png` onto `hashpad.exe`, or an "Open with"
   * aimed at one, would otherwise get a tab full of mojibake -- the same reason
   * `ui/filedrop.ts` filters, and the same function doing it.
   */
  it('leaves out files Hashpad does not edit', async () => {
    const open = vi.fn().mockResolvedValue(undefined);

    await openPendingFiles(
      () => Promise.resolve(['C:/notes/a.md', 'C:/pictures/cat.png', 'C:/notes/b.txt']),
      open,
    );

    expect(open).toHaveBeenCalledWith(['C:/notes/a.md', 'C:/notes/b.txt']);
  });

  /**
   * **The one that matters for startup.** This is called from `bootstrap`'s
   * `finally`, after `ShowWindow`. An unhandled rejection escaping here during
   * module evaluation is the failure mode Checkpoint D had to add a Go-side
   * backstop for, so it must resolve however badly the IPC call goes.
   */
  it('survives Go failing to answer', async () => {
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = vi.fn().mockResolvedValue(undefined);

    await expect(
      openPendingFiles(() => Promise.reject(new Error('no IPC')), open),
    ).resolves.toBeUndefined();

    expect(open).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalled();
    failed.mockRestore();
  });
});

describe('mountOpenWith', () => {
  it('opens the files a second launch handed over', () => {
    const open = vi.fn().mockResolvedValue(undefined);
    let deliver: ((paths: string[]) => void) | undefined;
    const on = vi.fn((_event: string, callback: (paths: string[]) => void) => {
      deliver = callback;
      return () => {};
    });

    mountOpenWith(on, open);
    deliver?.(['C:/notes/a.md', 'C:/pictures/cat.png']);

    expect(open).toHaveBeenCalledWith(['C:/notes/a.md']);
  });

  it('subscribes to the event Go emits', () => {
    const on = vi.fn(() => () => {});

    mountOpenWith(on, vi.fn());

    expect(on).toHaveBeenCalledWith(OPEN_FILES_EVENT, expect.any(Function));
  });

  it('hands back the unsubscribe', () => {
    const off = () => {};

    expect(mountOpenWith(() => off, vi.fn())).toBe(off);
  });

  /**
   * Wails' event callback is not async-aware, so a rejection here has no caller
   * to reach. Unguarded it becomes an unhandled promise, which in a packaged
   * app is an error nobody sees on a launch that appeared to do nothing.
   */
  it('survives a launch whose files cannot be read', async () => {
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
    let deliver: ((paths: string[]) => void) | undefined;

    mountOpenWith(
      (_event, callback) => {
        deliver = callback;
        return () => {};
      },
      () => Promise.reject(new Error('unreadable')),
    );
    deliver?.(['C:/notes/a.md']);
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());

    failed.mockRestore();
  });
});

/**
 * The event name is a contract across the IPC boundary, and nothing else checks
 * it: Go emitting `app:open-files` while this listens for something else is two
 * files that each look perfectly correct, a suite that stays green, and a
 * second launch that silently does nothing. Reading the Go source is blunt, but
 * it is the only thing in either suite that can see both halves at once.
 */
it('listens for the event name Go actually emits', () => {
  const source = readFileSync(
    new URL('../../../internal/app/openwith.go', import.meta.url),
    'utf8',
  );

  expect(source).toMatch(new RegExp(`openFilesEvent\\s*=\\s*"${OPEN_FILES_EVENT}"`));
});
