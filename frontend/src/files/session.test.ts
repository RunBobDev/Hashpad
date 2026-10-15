// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgetRecent, ReadFile, RememberOpened, RememberTabs } from '../../wailsjs/go/app/App';
import { store } from '../state/appcontext';
import type { Document } from '../state/document';
import { showNotice } from '../ui/confirmdialog';
import { openDocumentInNewTab, switchToDocument } from './documentops';
import { openPendingFiles } from './openwith';
import { setRecentFiles } from './recent';
import {
  flushTabTracking,
  mountTabTracking,
  openRecent,
  recentMenuItems,
  restoreTabs,
  sessionTabs,
  startSession,
  TAB_SAVE_DELAY_MS,
} from './session';

vi.mock('../../wailsjs/go/app/App', () => ({
  ReadFile: vi.fn(),
  RememberTabs: vi.fn(() => Promise.resolve()),
  RememberOpened: vi.fn(() => Promise.resolve([])),
  ForgetRecent: vi.fn(() => Promise.resolve([])),
  ClearRecent: vi.fn(() => Promise.resolve([])),
}));
vi.mock('./documentops', () => ({ openDocumentInNewTab: vi.fn(), switchToDocument: vi.fn() }));
vi.mock('../ui/confirmdialog', () => ({ showNotice: vi.fn(() => Promise.resolve()) }));
vi.mock('./openwith', () => ({ openPendingFiles: vi.fn(() => Promise.resolve()) }));

const doc = (id: string, filePath: string | null): Document =>
  ({ id, filePath }) as unknown as Document;

function tabs(documents: Document[], activeDocumentId: string | null): void {
  store.setState((prev) => ({ ...prev, documents, activeDocumentId }));
}

let unmount: (() => void) | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  tabs([doc('u', null)], 'u');
});
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.useRealTimers();
});

describe('sessionTabs', () => {
  it('lists the files in tab order, leaving unsaved documents out', () => {
    expect(
      sessionTabs({
        documents: [doc('a', 'C:\\a.md'), doc('u', null), doc('b', 'C:\\b.md')],
        activeDocumentId: 'b',
      }),
    ).toEqual({ paths: ['C:\\a.md', 'C:\\b.md'], active: 1 });
  });

  it('says -1 when the active tab is an unsaved document', () => {
    expect(
      sessionTabs({ documents: [doc('a', 'C:\\a.md'), doc('u', null)], activeDocumentId: 'u' })
        .active,
    ).toBe(-1);
  });
});

describe('mountTabTracking', () => {
  it('writes the tabs once on mounting', () => {
    tabs([doc('a', 'C:\\a.md')], 'a');
    unmount = mountTabTracking();
    expect(RememberTabs).toHaveBeenCalledWith(['C:\\a.md'], 0);
  });

  it('writes a burst of changes once, after the delay', () => {
    vi.useFakeTimers();
    unmount = mountTabTracking();
    vi.mocked(RememberTabs).mockClear();

    tabs([doc('a', 'C:\\a.md')], 'a');
    tabs([doc('a', 'C:\\a.md'), doc('b', 'C:\\b.md')], 'b');
    expect(RememberTabs).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TAB_SAVE_DELAY_MS);
    expect(vi.mocked(RememberTabs).mock.calls).toEqual([[['C:\\a.md', 'C:\\b.md'], 1]]);
  });

  it('ignores a change that is not about the tabs', () => {
    vi.useFakeTimers();
    unmount = mountTabTracking();
    vi.mocked(RememberTabs).mockClear();

    store.setState((prev) => ({ ...prev, wordWrap: !prev.wordWrap }));
    vi.advanceTimersByTime(TAB_SAVE_DELAY_MS);
    expect(RememberTabs).not.toHaveBeenCalled();
  });

  it('writes a waiting change at once when flushed, for quitting', async () => {
    vi.useFakeTimers();
    unmount = mountTabTracking();
    vi.mocked(RememberTabs).mockClear();

    tabs([doc('a', 'C:\\a.md')], 'a');
    await flushTabTracking();
    expect(RememberTabs).toHaveBeenCalledWith(['C:\\a.md'], 0);
  });
});

const contents = (path: string) =>
  ({ path, content: '', encoding: 'utf-8', lineEnding: 'lf', mixed: false }) as never;

describe('restoreTabs', () => {
  beforeEach(() => {
    vi.mocked(ReadFile).mockImplementation((path: string) =>
      path === 'C:\\gone.md' ? Promise.reject('not found') : Promise.resolve(contents(path)),
    );
    // openDocumentInNewTab is mocked: add the document the way the real one does.
    vi.mocked(openDocumentInNewTab).mockImplementation((c) => {
      store.setState((prev) => ({
        ...prev,
        documents: [...prev.documents, doc(c.path, c.path)],
        activeDocumentId: c.path,
      }));
    });
  });

  it('opens the files in order, skipping one that has gone, and activates the saved one', async () => {
    await restoreTabs(['C:\\a.md', 'C:\\gone.md', 'C:\\b.md'], 0);
    expect(vi.mocked(openDocumentInNewTab).mock.calls.map(([c]) => c.path)).toEqual([
      'C:\\a.md',
      'C:\\b.md',
    ]);
    expect(switchToDocument).toHaveBeenLastCalledWith('C:\\a.md');
  });

  it('activates the first when an unsaved document was active', async () => {
    await restoreTabs(['C:\\a.md', 'C:\\b.md'], -1);
    expect(switchToDocument).toHaveBeenLastCalledWith('C:\\a.md');
  });

  it('leaves the recent list alone', async () => {
    await restoreTabs(['C:\\a.md'], 0);
    expect(RememberOpened).not.toHaveBeenCalled();
  });
});

describe('startSession', () => {
  it('restores, then opens the launch files, then starts tracking', async () => {
    const order: string[] = [];
    vi.mocked(ReadFile).mockImplementation((path: string) => {
      order.push(`read ${path}`);
      return Promise.resolve(contents(path));
    });
    vi.mocked(openPendingFiles).mockImplementation(async () => {
      order.push('launch files');
    });
    vi.mocked(RememberTabs).mockImplementation(async () => {
      order.push('tracking');
    });

    unmount = await startSession(['C:\\a.md'], 0);
    expect(order).toEqual(['read C:\\a.md', 'launch files', 'tracking']);
  });
});

describe('Open Recent', () => {
  beforeEach(() => {
    setRecentFiles(['C:\\docs\\notes.md', 'C:\\gone.md']);
    vi.mocked(ReadFile).mockImplementation((path: string) =>
      path === 'C:\\gone.md' ? Promise.reject('not found') : Promise.resolve(contents(path)),
    );
  });

  it('lists each file by name with its folder, then Clear', () => {
    expect(recentMenuItems()).toEqual([
      {
        id: 'file.openRecent.0',
        label: 'notes.md',
        detail: 'C:\\docs',
        tooltip: 'C:\\docs\\notes.md',
        enabled: true,
      },
      {
        id: 'file.openRecent.1',
        label: 'gone.md',
        detail: 'C:',
        tooltip: 'C:\\gone.md',
        enabled: true,
      },
      {
        id: 'file.clearRecent',
        label: 'Clear Recently Opened',
        enabled: true,
        separatorBefore: true,
      },
    ]);
  });

  /**
   * The end of a folder says the most -- cut at the end, every entry read
   * "C:\Users\…" on the real exe. The tooltip keeps the whole path.
   */
  it('shortens a long folder to its start and its last two folders', () => {
    setRecentFiles([
      'C:\\Users\\Someone\\Documents\\Projects\\Notes\\2026\\plan.md',
      '/home/someone/documents/projects/notes/2026/plan.md',
    ]);
    const [windows, posix] = recentMenuItems();
    expect(windows!.detail).toBe('C:\\…\\Notes\\2026');
    expect(windows!.tooltip).toBe('C:\\Users\\Someone\\Documents\\Projects\\Notes\\2026\\plan.md');
    expect(posix!.detail).toBe('/…/notes/2026');
  });

  it('says so when there is nothing, with Clear disabled', () => {
    setRecentFiles([]);
    expect(recentMenuItems()).toEqual([
      { id: 'file.noRecent', label: 'No recent files', enabled: false },
      {
        id: 'file.clearRecent',
        label: 'Clear Recently Opened',
        enabled: false,
        separatorBefore: true,
      },
    ]);
  });

  it('opens the chosen file and moves it to the top', async () => {
    await openRecent(0);
    expect(openDocumentInNewTab).toHaveBeenCalledWith(contents('C:\\docs\\notes.md'));
    expect(RememberOpened).toHaveBeenCalledWith('C:\\docs\\notes.md');
  });

  it('tells you about a file that has gone, and drops it from the list', async () => {
    await openRecent(1);
    expect(openDocumentInNewTab).not.toHaveBeenCalled();
    expect(ForgetRecent).toHaveBeenCalledWith('C:\\gone.md');
    expect(vi.mocked(showNotice).mock.calls[0]![0]).toContain('gone.md');
  });
});
