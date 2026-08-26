// @vitest-environment jsdom
/**
 * The settings that change the running app and are written back.
 *
 * Each of these does **three** things, and the middle one is the one nothing
 * was watching: write the store (so the *next* tab is built with the value),
 * reconfigure the live `EditorView` (so the tab already open changes now), and
 * persist (so the next launch agrees). Deleting the reconfigure call left every
 * other test in the suite green -- main.test.ts drives these through the View
 * menu and asserts the store and the file, and settingsdialog.test.ts mocks the
 * editor away entirely. Mutation testing said so; this file is the answer.
 *
 * The `EditorView` is a mock rather than a real one. What is under test is the
 * *sequence* -- that the reconfigure happens, with the merged value -- and
 * `editor/extensions.test.ts` already owns whether `setEditorBehaviour` does
 * anything useful once called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { setEditorBehaviour, setWordWrap } from '../editor/extensions';
import { getEditorView, store } from '../state/appcontext';
import {
  DEFAULT_BEHAVIOUR,
  DEFAULT_OUTLINE_WIDTH,
  DEFAULT_SPLIT_RATIO,
  EMPTY_STATUS,
} from '../state/document';
import {
  persistSettings,
  setBehaviourSetting,
  setDefaultViewModeSetting,
  setWordWrapSetting,
} from './live';
import type { app } from '../../wailsjs/go/models';

vi.mock('../../wailsjs/go/app/App', () => ({
  LoadSettings: vi.fn(),
  SaveSettings: vi.fn(),
}));
vi.mock('../editor/extensions', () => ({
  setWordWrap: vi.fn(),
  setEditorBehaviour: vi.fn(),
}));
vi.mock('../state/appcontext', async () => {
  const { createStore } = await import('../state/store');
  const { DEFAULT_BEHAVIOUR, EMPTY_STATUS, DEFAULT_OUTLINE_WIDTH, DEFAULT_SPLIT_RATIO } =
    await import('../state/document');
  return {
    store: createStore({
      documents: [],
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
      status: EMPTY_STATUS,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
    }),
    getEditorView: vi.fn(),
  };
});

const view = {} as EditorView;

function settingsFixture(): app.Settings {
  return {
    version: 2,
    appearance: { theme: 'system', accentColor: '#0078d4', uiFontSize: 14 },
    editor: {
      fontFamily: 'Cascadia Mono',
      fontSize: 14,
      lineHeight: 1.6,
      wordWrap: true,
      maxContentWidth: 0,
      showLineNumbers: false,
      tabSize: 2,
      insertSpaces: true,
      defaultViewMode: 'source',
    },
    preview: { fontFamily: 'Segoe UI', fontSize: 15, syncScroll: true },
    files: {
      autosave: false,
      autosaveDelayMs: 2000,
      assetFolder: 'assets',
      defaultEncoding: 'utf-8',
    },
    window: {
      width: 1000,
      height: 700,
      maximized: false,
      outlineVisible: false,
      outlineWidth: 240,
      statusBarVisible: true,
      previewSplitRatio: 0.5,
    },
    toolbar: { visible: true, pinned: ['bold'] },
  } as unknown as app.Settings;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEditorView).mockReturnValue(view);
  vi.mocked(LoadSettings).mockResolvedValue(settingsFixture());
  vi.mocked(SaveSettings).mockResolvedValue(undefined);
  store.setState(() => ({
    documents: [],
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
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
  }));
});

describe('setWordWrapSetting', () => {
  it('writes the store, the live view, and the file', async () => {
    await setWordWrapSetting(false);

    expect(store.getState().wordWrap).toBe(false);
    // The store alone is a half-wired setting: the open editor is already
    // constructed, and only a reconfigure reaches it.
    expect(setWordWrap).toHaveBeenCalledWith(view, false);
    expect(vi.mocked(SaveSettings).mock.lastCall?.[0].editor.wordWrap).toBe(false);
  });
});

describe('setBehaviourSetting', () => {
  it('merges the change onto the current behaviour', async () => {
    store.setState((prev) => ({
      ...prev,
      editorBehaviour: { showLineNumbers: true, tabSize: 8, insertSpaces: false },
    }));

    await setBehaviourSetting({ tabSize: 4 });

    expect(store.getState().editorBehaviour).toEqual({
      showLineNumbers: true,
      tabSize: 4,
      insertSpaces: false,
    });
  });

  /**
   * The reconfigure is what makes the change visible in the tab that is already
   * open, and it takes the **merged** object -- handing it the partial would
   * reset the two settings the user did not touch.
   */
  it('reconfigures the live view with the merged object', async () => {
    store.setState((prev) => ({
      ...prev,
      editorBehaviour: { showLineNumbers: true, tabSize: 8, insertSpaces: false },
    }));

    await setBehaviourSetting({ tabSize: 4 });

    expect(setEditorBehaviour).toHaveBeenCalledWith(view, {
      showLineNumbers: true,
      tabSize: 4,
      insertSpaces: false,
    });
  });

  /**
   * A new object every time, not a mutation in place. `store.ts`'s `isEqual`
   * compares one level of own keys, so a selector over `editorBehaviour` only
   * notices when the reference changes -- and `documentops.ts` reads the same
   * object when it builds a new tab, so mutating it would leave the two
   * agreeing by luck rather than by design.
   */
  it('replaces the object rather than mutating it', async () => {
    const before = store.getState().editorBehaviour;

    await setBehaviourSetting({ tabSize: 4 });

    expect(store.getState().editorBehaviour).not.toBe(before);
    expect(before.tabSize).toBe(DEFAULT_BEHAVIOUR.tabSize);
  });

  /** All three keys reach the file, so a partial change cannot half-write it. */
  it('writes all three behaviour keys', async () => {
    store.setState((prev) => ({
      ...prev,
      editorBehaviour: { showLineNumbers: true, tabSize: 8, insertSpaces: false },
    }));

    await setBehaviourSetting({ showLineNumbers: false });

    const saved = vi.mocked(SaveSettings).mock.lastCall![0].editor;
    expect(saved.showLineNumbers).toBe(false);
    expect(saved.tabSize).toBe(8);
    expect(saved.insertSpaces).toBe(false);
  });
});

describe('setDefaultViewModeSetting', () => {
  it('writes the store and the file, and touches no open document', async () => {
    await setDefaultViewModeSetting('split');

    expect(store.getState().defaultViewMode).toBe('split');
    expect(vi.mocked(SaveSettings).mock.lastCall?.[0].editor.defaultViewMode).toBe('split');
    // `viewMode` is per document by design (Checkpoint F): changing the default
    // decides what the *next* tab opens as and leaves the open ones alone.
    expect(setEditorBehaviour).not.toHaveBeenCalled();
  });
});

describe('persistSettings', () => {
  /**
   * Always a read-modify-write. Several of these settings have more than one
   * writer, so a copy held from before another one ran would put its value
   * back -- which is exactly what a held copy in the settings dialog would do
   * to a theme changed through the command bus.
   */
  it('reads the file again rather than trusting a caller’s copy', async () => {
    vi.mocked(LoadSettings).mockResolvedValue(
      Object.assign(settingsFixture(), {
        appearance: { theme: 'dark', accentColor: '#123456', uiFontSize: 20 },
      }),
    );

    await persistSettings('test', (settings) => {
      settings.editor.tabSize = 7;
    });

    const saved = vi.mocked(SaveSettings).mock.lastCall![0];
    expect(saved.editor.tabSize).toBe(7);
    expect(saved.appearance.theme).toBe('dark');
  });

  /**
   * A failed write costs the restart, not the session -- the value has already
   * been applied by the time this runs, so throwing would unwind a caller that
   * has nothing left to undo.
   */
  it('logs a failure instead of throwing, naming the setting', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(SaveSettings).mockRejectedValue(new Error('disk full'));

    await expect(persistSettings('word-wrap', () => {})).resolves.toBeUndefined();

    expect(errors.mock.lastCall?.[0]).toContain('word-wrap');
    errors.mockRestore();
  });
});
