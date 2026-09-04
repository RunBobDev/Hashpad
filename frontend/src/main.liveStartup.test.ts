// @vitest-environment jsdom
/**
 * Launching straight into live preview (`editor.defaultViewMode: "live"`).
 *
 * **Its own file because a bootstrap runs once per module instance**, and the
 * question here is entirely about what that one bootstrap leaves behind: the
 * startup document is minted at module scope holding `'source'`, and the saved
 * mode is applied afterwards, once `LoadSettings` resolves. Any other file's
 * bootstrap has already settled by the time its cases run.
 *
 * The reported symptom: View > Live Preview shows ticked on launch, and the
 * editor renders like source mode until it is toggled off and on by hand.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getEditorView, store } from './state/appcontext';
import { activeDocument } from './state/documents';
import { makeUntitledDocument, switchToDocument } from './files/documentops';
import { hideInlineMarks } from './editor/livepreview';
import { COMMAND_EVENT } from './ui/menubar';
import { ReadFile, ShowOpenDialog, ShowWindow } from '../wailsjs/go/app/App';

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  OnFileDrop: vi.fn(),
  OnFileDropOff: vi.fn(),
  WindowIsFullscreen: vi.fn(async () => false),
  WindowFullscreen: vi.fn(),
  WindowUnfullscreen: vi.fn(),
  WindowSetBackgroundColour: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  PendingFiles: vi.fn().mockResolvedValue([]),
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    toolbar: { visible: true, pinned: ['bold'] },
    window: {
      previewSplitRatio: 0.5,
      statusBarVisible: true,
      outlineVisible: false,
      outlineWidth: 240,
    },
    preview: { syncScroll: true },
    editor: {
      wordWrap: true,
      // What the owner set, on both settings.
      defaultViewMode: 'live',
      openedViewMode: 'live',
      recentViewModes: [],
    },
    files: { defaultEncoding: 'utf-8' },
  }),
  ReadFile: vi.fn(),
  ResetSettings: vi.fn(),
  SaveSettings: vi.fn().mockResolvedValue(undefined),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

describe('launching with live preview as the default', () => {
  beforeAll(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import('./main');
    await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
  });

  /**
   * **One test, because the two halves are the bug.**
   *
   * The document carrying `'live'` is what ticks View > Live Preview, and the
   * plugin being in the editor is what actually hides anything. Asserting only
   * the first passes against exactly the reported fault: ticked menu, plain
   * editor. They are asserted together so a failure says which half broke.
   */
  it('puts the startup document in live mode and hands the editor the extension', async () => {
    await vi.waitFor(() => {
      expect(activeDocument(store.getState())!.viewMode).toBe('live');
    });

    expect(getEditorView().plugin(hideInlineMarks)).not.toBeNull();
  });

  /**
   * **Opening a file is where it actually broke**, which is why launching to an
   * empty document was not enough to reproduce it.
   *
   * `switchToDocument` calls `view.setState(incoming.editorState)`, and
   * CodeMirror's `setState` reinitialises every plugin from the incoming
   * state's own extension list -- a list that seeds the live-preview
   * compartment empty, because a document's `EditorState` is built before
   * anyone knows which mode it will be shown in.
   *
   * The store subscription does not rescue it, twice over. It runs off the
   * *store* write, which `switchToDocument` performs a line before
   * `view.setState`, so anything it applied is discarded immediately after.
   * And with both view-mode settings on `'live'` the selected value never
   * changes from one document to the next, so it does not fire at all.
   *
   * The result is the reported fault exactly: the document says live, so View >
   * Live Preview is ticked, and the editor renders like source until the mode
   * is toggled off and on by hand.
   */
  it('keeps the extension after opening a file into live mode', async () => {
    vi.mocked(ShowOpenDialog).mockResolvedValue(['C:/notes/opened.md']);
    vi.mocked(ReadFile).mockResolvedValue({
      path: 'C:/notes/opened.md',
      content: '# Opened\n\nSome **bold** here.\n',
      encoding: 'utf-8',
      lineEnding: 'lf',
      mixed: false,
    } as unknown as Awaited<ReturnType<typeof ReadFile>>);

    document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: 'file.open' }));

    await vi.waitFor(() => {
      expect(activeDocument(store.getState())!.filePath).toBe('C:/notes/opened.md');
    });
    expect(activeDocument(store.getState())!.viewMode).toBe('live');

    expect(getEditorView().plugin(hideInlineMarks)).not.toBeNull();
  });

  /**
   * The other half of the same fault, where the mode *does* change.
   *
   * Here the subscription genuinely fires -- `'live'` to `'source'` and back is
   * a real change to the value it watches -- and it still is not enough,
   * because it runs on the store write that `switchToDocument` performs a line
   * before `view.setState`. Switching back to the live tab would have left the
   * editor plain even though the mode changed under the subscription's nose.
   */
  it('follows the mode when switching between a live tab and a source one', async () => {
    const live = activeDocument(store.getState())!;
    expect(live.viewMode).toBe('live');

    const source = { ...makeUntitledDocument(), id: 'source-tab', viewMode: 'source' as const };
    store.setState((prev) => ({ ...prev, documents: [...prev.documents, source] }));

    switchToDocument('source-tab');
    expect(getEditorView().plugin(hideInlineMarks)).toBeNull();

    switchToDocument(live.id);
    expect(getEditorView().plugin(hideInlineMarks)).not.toBeNull();
  });
});
