// @vitest-environment jsdom
/**
 * SPEC §3.2's autosave.
 *
 * The delay is set to the clamp floor (200 ms) throughout rather than faked.
 * `vi.useFakeTimers()` would also freeze the promise machinery inside
 * `saveDocument`, and almost every assertion here is about what reached
 * `WriteFile` after an `await`; interleaving the two clocks costs more than a
 * fifth of a second per case. The one exception is the case that is *about*
 * elapsed time, which fakes the clock and says why.
 */
import { EditorState } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WriteFile } from '../../wailsjs/go/app/App';
import { store } from '../state/appcontext';
import {
  DEFAULT_BEHAVIOUR,
  DEFAULT_OUTLINE_WIDTH,
  DEFAULT_SPLIT_RATIO,
  EMPTY_STATUS,
  createUntitledDocument,
  isDirty,
  type Document,
} from '../state/document';
import { mountAutosave } from './autosave';

vi.mock('../../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  LoadSettings: vi.fn(),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  WriteFile: vi.fn(),
}));
// `currentText` reads the live view for the *active* document. Nothing here is
// active, so every document is read from its own `editorState` -- which is the
// path a background tab takes in the real app too.
vi.mock('../state/appcontext', async () => {
  const { createStore } = await import('../state/store');
  return { store: createStore({} as never), getEditorView: vi.fn() };
});

/** A document with a path and unsaved changes: the only kind autosave writes. */
function dirtySaved(id: string, filePath: string, text = 'hello'): Document {
  const base = EditorState.create({ doc: text });
  const changed = base.update({ changes: { from: text.length, insert: '!' } }).state;
  return { ...createUntitledDocument(base), id, filePath, editorState: changed };
}

function seed(documents: Document[], overrides: Record<string, unknown> = {}): void {
  store.setState(() => ({
    documents,
    activeDocumentId: null,
    isDark: false,
    closedPaths: [],
    activeFormats: '',
    pinnedToolbarCommands: [],
    previewSplitRatio: DEFAULT_SPLIT_RATIO,
    syncScroll: true,
    wordWrap: true,
    editorBehaviour: DEFAULT_BEHAVIOUR,
    defaultViewMode: 'source',
    defaultEncoding: 'utf-8',
    autosave: true,
    autosaveDelayMs: 200,
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
    ...overrides,
  }));
}

/**
 * Stands in for an edit: replaces each `Document` with a new object.
 *
 * A fresh *array* holding the same object references is not enough, and getting
 * that wrong is how this helper started. `store.ts`'s `isEqual` compares one
 * level of own keys with `Object.is`, so `[...documents]` is equal to what it
 * copied and the subscription never fires -- which made the debounce test look
 * broken while the debounce was fine. The real edit path replaces the object,
 * because `syncActiveDocument` writes a new `editorState` into it.
 */
function touch(): void {
  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((doc) => ({ ...doc })),
  }));
}

/** Longer than the 200 ms delay, for asserting that nothing was written. */
function quietFor(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500));
}

let unmount: () => void;

beforeEach(() => {
  vi.mocked(WriteFile).mockResolvedValue(undefined);
  seed([]);
  unmount = mountAutosave();
});

afterEach(() => {
  unmount();
  vi.clearAllMocks();
});

describe('what autosave writes', () => {
  it('saves a dirty document that has a path', async () => {
    seed([dirtySaved('a', 'C:/notes/a.md')]);

    await vi.waitFor(() => expect(WriteFile).toHaveBeenCalled());
    expect(vi.mocked(WriteFile).mock.lastCall?.[0]).toBe('C:/notes/a.md');
    expect(vi.mocked(WriteFile).mock.lastCall?.[1]).toBe('hello!');
  });

  /**
   * **The line SPEC draws.** "Never silently creates files" -- and
   * `saveDocument` falls back to `saveDocumentAs` for a document with no path,
   * which opens a save dialog. A file picker appearing on a timer, over work the
   * user never asked to name, is the worst thing this feature could do, so the
   * filter lives here rather than relying on the save path to be polite.
   */
  it('never writes an untitled document', async () => {
    const untitled = { ...dirtySaved('a', 'C:/notes/a.md'), filePath: null };
    seed([untitled]);

    await quietFor();
    expect(WriteFile).not.toHaveBeenCalled();
  });

  it('leaves a clean document alone', async () => {
    const base = EditorState.create({ doc: 'hello' });
    const clean = { ...createUntitledDocument(base), id: 'a', filePath: 'C:/notes/a.md' };
    expect(isDirty(clean)).toBe(false);
    seed([clean]);

    await quietFor();
    expect(WriteFile).not.toHaveBeenCalled();
  });

  /**
   * A tab edited and then switched away from inside the delay window is exactly
   * the case autosave exists to cover, so it saves every dirty saved document
   * rather than only the active one.
   */
  it('saves every dirty saved document, not just one', async () => {
    seed([dirtySaved('a', 'C:/notes/a.md'), dirtySaved('b', 'C:/notes/b.md')]);

    await vi.waitFor(() => expect(vi.mocked(WriteFile).mock.calls).toHaveLength(2));
    expect(
      vi
        .mocked(WriteFile)
        .mock.calls.map((call) => call[0])
        .sort(),
    ).toEqual(['C:/notes/a.md', 'C:/notes/b.md']);
  });

  /** Writing marks them saved, or the next pass would write the same text again. */
  it('leaves the documents clean afterwards', async () => {
    seed([dirtySaved('a', 'C:/notes/a.md')]);

    await vi.waitFor(() => expect(WriteFile).toHaveBeenCalled());
    await vi.waitFor(() => {
      expect(isDirty(store.getState().documents[0]!)).toBe(false);
    });
  });
});

describe('when autosave writes', () => {
  it('does nothing while the setting is off', async () => {
    seed([dirtySaved('a', 'C:/notes/a.md')], { autosave: false });

    await quietFor();
    expect(WriteFile).not.toHaveBeenCalled();
  });

  /**
   * Turning it on has to start the countdown there and then. Subscribing only
   * to `documents` would leave the switch apparently dead until the next
   * keystroke -- on a document the user has stopped typing in, which is
   * precisely when they reach for it.
   */
  it('starts as soon as the setting is turned on', async () => {
    seed([dirtySaved('a', 'C:/notes/a.md')], { autosave: false });
    await quietFor();
    expect(WriteFile).not.toHaveBeenCalled();

    store.setState((prev) => ({ ...prev, autosave: true }));

    await vi.waitFor(() => expect(WriteFile).toHaveBeenCalled());
  });

  /**
   * And turning it off has to cancel a countdown already running, or the switch
   * appears to do nothing and then writes two seconds later.
   */
  it('cancels a countdown when the setting is turned off', async () => {
    seed([dirtySaved('a', 'C:/notes/a.md')], { autosaveDelayMs: 400 });
    store.setState((prev) => ({ ...prev, autosave: false }));

    await quietFor();
    expect(WriteFile).not.toHaveBeenCalled();
  });

  /**
   * Debounced from the last edit, not run on an interval: nothing has been
   * written while the user is still typing.
   */
  it('waits for the delay before writing', async () => {
    seed([dirtySaved('a', 'C:/notes/a.md')], { autosaveDelayMs: 5000 });

    await quietFor();
    expect(WriteFile).not.toHaveBeenCalled();
  });

  /**
   * Each edit pushes the write back, which is what "after the last edit" means
   * -- an interval would have fired twice during this.
   *
   * **The one case here that fakes the clock**, and the reason is the reason
   * the rest do not: this test is *about* elapsed time, so a real-clock version
   * has to assert "nothing happened yet" against sleeps shorter than the delay.
   * The first draft used 150 ms nudges against a 300 ms delay and failed under
   * load, when one sleep overran and the debounce fired legitimately. That is a
   * load average, not a defect. Faking it makes the margins exact.
   */
  it('restarts the countdown on every edit', async () => {
    vi.useFakeTimers();
    try {
      seed([dirtySaved('a', 'C:/notes/a.md')], { autosaveDelayMs: 300 });

      // Four nudges, each 200 ms into the previous 300 ms countdown. 800 ms of
      // simulated time in which an interval would have fired twice.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(200);
        touch();
      }
      expect(WriteFile).not.toHaveBeenCalled();

      // And the countdown does still complete once the edits stop.
      await vi.advanceTimersByTimeAsync(300);
      expect(WriteFile).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops writing after unmount', async () => {
    seed([dirtySaved('a', 'C:/notes/a.md')], { autosaveDelayMs: 400 });
    unmount();

    await quietFor();
    expect(WriteFile).not.toHaveBeenCalled();

    // Re-mounted so `afterEach`'s unmount has something to do.
    unmount = mountAutosave();
  });
});

describe('when a write fails', () => {
  /**
   * `saveDocument` logs and returns false rather than throwing, so one
   * unwritable file must not abandon the others in the same pass -- the second
   * document here has nothing wrong with it.
   */
  it('carries on to the other documents', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(WriteFile).mockImplementation(async (path: string) => {
      if (path === 'C:/notes/a.md') throw new Error('read-only');
    });
    seed([dirtySaved('a', 'C:/notes/a.md'), dirtySaved('b', 'C:/notes/b.md')]);

    await vi.waitFor(() => expect(vi.mocked(WriteFile).mock.calls).toHaveLength(2));
    // The one that failed stays dirty, which is the honest outcome: its text is
    // not on disk, and the tab keeps saying so.
    await vi.waitFor(() => {
      const documents = store.getState().documents;
      expect(isDirty(documents.find((doc) => doc.id === 'a')!)).toBe(true);
      expect(isDirty(documents.find((doc) => doc.id === 'b')!)).toBe(false);
    });
    errors.mockRestore();
  });
});
