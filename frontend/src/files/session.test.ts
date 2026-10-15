// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadFile, RememberOpened, RememberTabs } from '../../wailsjs/go/app/App';
import { store } from '../state/appcontext';
import type { Document } from '../state/document';
import { openDocumentInNewTab, switchToDocument } from './documentops';
import { openPendingFiles } from './openwith';
import {
  flushTabTracking,
  mountTabTracking,
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
