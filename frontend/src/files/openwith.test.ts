import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OPEN_FILES_EVENT, mountOpenWith, openPendingFiles } from './openwith';
import { SUPPORTED_EXTENSIONS } from '../ui/filedrop';

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

/**
 * The installer's file associations decide which files *launch* Hashpad;
 * `SUPPORTED_EXTENSIONS` decides which files Hashpad will *open* once launched.
 * An extension in the first list but not the second registers happily, launches
 * the app on a double-click, and then silently opens nothing — two files that
 * each look perfectly correct, in two languages, with no test between them.
 */
it('associates only extensions Hashpad will actually open', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../../wails.json', import.meta.url), 'utf8'),
  ) as { info: { fileAssociations: { ext: string }[] } };

  const associated = config.info.fileAssociations.map((each) => `.${each.ext}`);

  // Without this the check passes vacuously the day someone empties the list.
  expect(associated.length).toBeGreaterThan(0);
  for (const ext of associated) {
    expect(SUPPORTED_EXTENSIONS).toContain(ext);
  }
});

/**
 * The same guard as above, for the extensions the installer registers *itself*.
 *
 * `.txt` is deliberately not in wails.json: `wails.associateFiles` takes every
 * association in that file at once, so anything listed there is bound to the
 * markdown checkbox, and `.txt` needed its own. The cost is that it escapes the
 * check above — a second `APP_ASSOCIATE` for an extension Hashpad cannot open
 * would register happily, launch the app on a double-click, and open nothing.
 *
 * Parsed out of the installer script rather than duplicated as a list here,
 * because a list would be a third place to keep in step and the failure it is
 * guarding against is exactly two places disagreeing.
 */
it('associates only extensions Hashpad will actually open, including the installer’s own', () => {
  const script = readFileSync(
    new URL('../../../build/windows/installer/project.nsi', import.meta.url),
    'utf8',
  );

  // `!insertmacro APP_ASSOCIATE "txt" ...` -- the first argument is the
  // extension, without its dot.
  const registered = [...script.matchAll(/!insertmacro\s+APP_ASSOCIATE\s+"([^"]+)"/g)].map(
    (match) => `.${match[1]}`,
  );

  // Vacuous the day the installer stops registering anything directly, which is
  // a legitimate change -- but then this test should be deleted, not silently
  // pass.
  expect(registered.length).toBeGreaterThan(0);
  for (const ext of registered) {
    expect(SUPPORTED_EXTENSIONS).toContain(ext);
  }
});

/**
 * `iconName` names a file Wails looks for at `build/windows/<name>.ico`, and it
 * is a plain string in a JSON file — nothing checks it. A typo, or the icon
 * being renamed or deleted, is not a build error: the association registers with
 * an icon that is not there, and Explorer falls back to a blank page glyph on
 * every markdown file on the machine. Only visible after installing.
 *
 * The icon is generated by `scripts/make-icons.ps1` rather than hand-drawn,
 * so this also catches the script being changed to write somewhere else.
 */
it('associates an icon that exists on disk', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../../wails.json', import.meta.url), 'utf8'),
  ) as { info: { fileAssociations: { iconName: string }[] } };

  const names = new Set(config.info.fileAssociations.map((each) => each.iconName));

  expect(names.size).toBeGreaterThan(0);
  for (const name of names) {
    const icon = new URL(`../../../build/windows/${name}.ico`, import.meta.url);
    expect(existsSync(icon), `build/windows/${name}.ico`).toBe(true);
  }
});

/**
 * The document icon must not *be* the application icon. Windows convention is
 * that a file looks different from the program that opens it, and reusing
 * `appicon` put Hashpad's own "H" on every markdown file — reported as
 * unintuitive. Asserted by name rather than by comparing bytes: the point is the
 * decision, and two files that happened to be identical would be the same defect.
 */
it('gives markdown files their own icon rather than the application’s', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../../wails.json', import.meta.url), 'utf8'),
  ) as { info: { fileAssociations: { iconName: string }[] } };

  for (const association of config.info.fileAssociations) {
    expect(association.iconName).not.toBe('appicon');
  }
});

/**
 * The installer script must stay pure ASCII, and this is not pedantry.
 *
 * NSIS reads a `.nsi` source file as Windows-1252 unless it carries a UTF-8
 * BOM, and `Unicode true` governs the *output* installer rather than the input.
 * So a UTF-8 em dash in a displayed string compiles without complaint and
 * reaches the user as `â€"`. That shipped: three radio labels on the installer's
 * maintenance page rendered as mojibake, and nothing in either build or either
 * test suite noticed, because the file is not code anything here executes.
 *
 * A BOM would also fix it, and would silently un-fix it the first time an editor
 * stripped one. Pure ASCII cannot regress.
 */
it('keeps the installer script free of characters NSIS will mis-decode', () => {
  const script = readFileSync(
    new URL('../../../build/windows/installer/project.nsi', import.meta.url),
    'utf8',
  );

  // Walked by code point rather than matched by regex: the obvious pattern for
  // this is `/[^\x00-\x7F]/`, and eslint's no-control-regex rejects it — for
  // good reason, since a control character in a character class is nearly
  // always a typo. Here it would not be, but a loop says the same thing without
  // needing the rule suppressed.
  const offenders: string[] = [];
  let line = 1;
  for (const character of script) {
    if (character === '\n') line += 1;
    else if (character.codePointAt(0)! > 127) {
      offenders.push(`line ${line}: ${JSON.stringify(character)}`);
    }
  }

  expect(offenders).toEqual([]);
});
