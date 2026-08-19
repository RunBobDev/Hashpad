import { EditorState } from '@codemirror/state';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEditorView, store } from '../state/appcontext';
import type { EditorView } from '@codemirror/view';
import { EMPTY_STATUS, createUntitledDocument, isDirty, type Document } from '../state/document';
import type { SaveChoice } from '../ui/confirmdialog';
import {
  displayName,
  markSaved,
  resolveDocumentsBeforeQuit,
  saveDocumentAs,
  windowTitle,
} from './fileops';
import { ShowSaveDialog, WriteFile } from '../../wailsjs/go/app/App';

vi.mock('../../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  LoadSettings: vi.fn(),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  WriteFile: vi.fn(),
}));

function docWith(overrides: Partial<Document>): Document {
  const base = createUntitledDocument(EditorState.create({ doc: 'hello' }));
  return { ...base, ...overrides };
}

/** A document whose editorState has diverged from savedDoc -- isDirty(doc) is true. */
function dirtyDoc(overrides: Partial<Document> = {}): Document {
  const original = EditorState.create({ doc: 'hello' });
  const changed = original.update({ changes: { from: 5, insert: '!' } }).state;
  return docWith({ editorState: changed, savedDoc: original.doc, ...overrides });
}

/** A document whose editorState matches savedDoc -- isDirty(doc) is false. */
function cleanDoc(overrides: Partial<Document> = {}): Document {
  const state = EditorState.create({ doc: 'hello' });
  return docWith({ editorState: state, savedDoc: state.doc, ...overrides });
}

describe('displayName', () => {
  it('is Untitled for a never-saved document', () => {
    expect(displayName(docWith({}))).toBe('Untitled');
  });

  it('is the basename of a Windows path', () => {
    expect(displayName(docWith({ filePath: 'C:\\notes\\todo.md' }))).toBe('todo.md');
  });

  it('is the basename of a POSIX path', () => {
    expect(displayName(docWith({ filePath: '/home/user/notes/todo.md' }))).toBe('todo.md');
  });

  it('handles a bare filename with no directory', () => {
    expect(displayName(docWith({ filePath: 'todo.md' }))).toBe('todo.md');
  });
});

describe('windowTitle', () => {
  it('names the app when nothing is open', () => {
    expect(windowTitle(null)).toBe('Hashpad');
  });

  it('shows a clean document without a marker', () => {
    const state = EditorState.create({ doc: 'hello' });
    const doc = docWith({ editorState: state, savedDoc: state.doc, filePath: 'a.md' });
    expect(windowTitle(doc)).toBe('a.md — Hashpad');
  });

  it('marks a dirty document', () => {
    const doc = docWith({
      editorState: EditorState.create({ doc: 'changed' }),
      savedDoc: EditorState.create({ doc: 'original' }).doc,
      filePath: 'a.md',
    });
    expect(windowTitle(doc)).toBe('• a.md — Hashpad');
  });

  it('shows the • marker exactly when isDirty is true', () => {
    const clean = docWith({
      editorState: EditorState.create({ doc: 'same' }),
      savedDoc: EditorState.create({ doc: 'same' }).doc,
      filePath: 'a.md',
    });
    const dirty = docWith({
      editorState: EditorState.create({ doc: 'changed' }),
      savedDoc: EditorState.create({ doc: 'original' }).doc,
      filePath: 'a.md',
    });

    expect(isDirty(clean)).toBe(false);
    expect(windowTitle(clean).startsWith('• ')).toBe(isDirty(clean));

    expect(isDirty(dirty)).toBe(true);
    expect(windowTitle(dirty).startsWith('• ')).toBe(isDirty(dirty));
  });
});

/**
 * These three cover the two data-loss failure modes a code review found:
 * nothing ever wrote the live `EditorView`'s state back into the store, so a
 * never-saved document's `editorState`/`savedDoc` never diverged (permanently
 * clean, dirty-discard prompts never fired) and, separately, a saved
 * document's `editorState` stayed frozen while `savedDoc` advanced
 * (permanently dirty, the title's `•` never cleared). `editor/extensions.ts`
 * fixes the first by syncing `editorState` on every doc change; `markSaved`
 * (exercised directly here, without the DOM- and IPC-bound `saveActive`)
 * fixes the second.
 */
describe('dirty tracking', () => {
  it('is dirty when editorState has diverged from savedDoc', () => {
    const original = EditorState.create({ doc: 'hello' });
    const changed = original.update({ changes: { from: 5, insert: '!' } }).state;
    const doc = docWith({ editorState: changed, savedDoc: original.doc });

    expect(isDirty(doc)).toBe(true);
  });

  it('is not dirty when editorState equals savedDoc', () => {
    const state = EditorState.create({ doc: 'hello' });
    const doc = docWith({ editorState: state, savedDoc: state.doc });

    expect(isDirty(doc)).toBe(false);
  });

  it('becomes clean after markSaved records the live text as saved (regression: stuck-dirty after save)', () => {
    const original = EditorState.create({ doc: 'hello' });
    const changed = original.update({ changes: { from: 5, insert: '!' } }).state;
    const doc = docWith({ editorState: changed, savedDoc: original.doc });
    expect(isDirty(doc)).toBe(true); // sanity: starts dirty, same as a real unsaved edit

    store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));
    markSaved(doc.id, changed.doc);

    const saved = store.getState().documents.find((d) => d.id === doc.id);
    expect(saved).toBeDefined();
    expect(isDirty(saved!)).toBe(false);
  });
});

/**
 * This is the highest-risk logic in Checkpoint B: a Cancel anywhere in the
 * list must abort the entire quit, and a Save that silently failed (or was
 * itself cancelled, e.g. Save As) must be treated the same as Cancel -- never
 * as permission to proceed as though the file were written. Both `prompt` and
 * `save` are plain stubs here; no DOM and no IPC are involved, which is the
 * whole reason the sequence was pulled out of the `app:close-requested`
 * handler into a pure function.
 */
describe('resolveDocumentsBeforeQuit', () => {
  it('resolves true without prompting when every document is clean', async () => {
    const docs = [cleanDoc({ filePath: 'a.md' }), cleanDoc({ filePath: 'b.md' })];
    const prompt = vi.fn<(name: string) => Promise<SaveChoice>>();
    const save = vi.fn<(doc: Document) => Promise<boolean>>();

    const result = await resolveDocumentsBeforeQuit(docs, prompt, save);

    expect(result).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('resolves true and saves once when the one dirty document is saved', async () => {
    const doc = dirtyDoc({ filePath: 'a.md' });
    const prompt = vi.fn<(name: string) => Promise<SaveChoice>>().mockResolvedValue('save');
    const save = vi.fn<(doc: Document) => Promise<boolean>>().mockResolvedValue(true);

    const result = await resolveDocumentsBeforeQuit([doc], prompt, save);

    expect(result).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(doc);
  });

  it("does not save when the user picks Don't Save", async () => {
    const doc = dirtyDoc({ filePath: 'a.md' });
    const prompt = vi.fn<(name: string) => Promise<SaveChoice>>().mockResolvedValue('dontsave');
    const save = vi.fn<(doc: Document) => Promise<boolean>>();

    const result = await resolveDocumentsBeforeQuit([doc], prompt, save);

    expect(result).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('resolves false and prompts no further documents when the user picks Cancel', async () => {
    const doc = dirtyDoc({ filePath: 'a.md' });
    const prompt = vi.fn<(name: string) => Promise<SaveChoice>>().mockResolvedValue('cancel');
    const save = vi.fn<(doc: Document) => Promise<boolean>>();

    const result = await resolveDocumentsBeforeQuit([doc], prompt, save);

    expect(result).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('stops at the second of three dirty documents when it is cancelled, never prompting the third', async () => {
    const docs = [
      dirtyDoc({ filePath: 'a.md' }),
      dirtyDoc({ filePath: 'b.md' }),
      dirtyDoc({ filePath: 'c.md' }),
    ];
    const prompt = vi
      .fn<(name: string) => Promise<SaveChoice>>()
      .mockResolvedValueOnce('dontsave')
      .mockResolvedValueOnce('cancel')
      .mockResolvedValueOnce('dontsave'); // would prove the third was (wrongly) reached
    const save = vi.fn<(doc: Document) => Promise<boolean>>();

    const result = await resolveDocumentsBeforeQuit(docs, prompt, save);

    expect(result).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenNthCalledWith(1, 'a.md');
    expect(prompt).toHaveBeenNthCalledWith(2, 'b.md');
  });

  it('resolves false when Save is chosen but the save fails or is cancelled (e.g. a cancelled Save As)', async () => {
    const doc = dirtyDoc({ filePath: 'a.md' });
    const prompt = vi.fn<(name: string) => Promise<SaveChoice>>().mockResolvedValue('save');
    const save = vi.fn<(doc: Document) => Promise<boolean>>().mockResolvedValue(false);

    const result = await resolveDocumentsBeforeQuit([doc], prompt, save);

    expect(result).toBe(false);
  });

  it('prompts documents in array order', async () => {
    const docs = [dirtyDoc({ filePath: 'a.md' }), dirtyDoc({ filePath: 'b.md' })];
    const seen: string[] = [];
    const prompt = vi
      .fn<(name: string) => Promise<SaveChoice>>()
      .mockImplementation(async (name) => {
        seen.push(name);
        return 'dontsave';
      });
    const save = vi.fn<(doc: Document) => Promise<boolean>>();

    await resolveDocumentsBeforeQuit(docs, prompt, save);

    expect(seen).toEqual(['a.md', 'b.md']);
  });
});

/**
 * Save As can move a document to a different folder, and the stored `filePath`
 * is the only record of that: `preview/pane.ts` derives the `dir=` on every
 * relative image URL from it on each render (design §5.7). Writing it to the
 * wrong document, or not at all, leaves every image in the preview 404ing —
 * silently, because a broken image looks the same as one that was never there.
 */
describe('save-as records the new path on the document it saved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WriteFile).mockResolvedValue(undefined as never);
    // `currentText` reads the live view's document for the *active* tab, so
    // one has to exist. A stub rather than a real EditorView keeps this file
    // in the node environment: the whole rest of it tests pure functions, and
    // opting the file into jsdom to satisfy one field would slow every one of
    // them. `.state.doc` is all `currentText` touches.
    const stub = { state: { doc: EditorState.create({ doc: 'hello' }).doc } };
    setEditorView(stub as unknown as EditorView);
  });

  function seed(activeId: string | null, docs: Document[]): void {
    store.setState(() => ({
      documents: docs,
      activeDocumentId: activeId,
      isDark: false,
      closedPaths: [],
      activeFormats: '',
      pinnedToolbarCommands: [],
      previewSplitRatio: 0.5,
      syncScroll: true,
      wordWrap: true,
      status: EMPTY_STATUS,
    }));
  }

  function pathOf(id: string): string | null {
    return store.getState().documents.find((d) => d.id === id)!.filePath;
  }

  it('records the new folder when the saved document is the active one', async () => {
    seed('a', [cleanDoc({ id: 'a' })]);
    vi.mocked(ShowSaveDialog).mockResolvedValue('D:\\elsewhere\\moved.md');

    await saveDocumentAs('a');

    expect(pathOf('a')).toBe('D:\\elsewhere\\moved.md');
  });

  // Saving a background tab must write the path onto that tab, not onto the
  // one on screen — otherwise the visible document's images start resolving
  // against a folder it was never saved to.
  it('records it on the background document, not the active one', async () => {
    seed('front', [cleanDoc({ id: 'front' }), cleanDoc({ id: 'back' })]);
    vi.mocked(ShowSaveDialog).mockResolvedValue('D:\\elsewhere\\moved.md');

    await saveDocumentAs('back');

    expect(pathOf('back')).toBe('D:\\elsewhere\\moved.md');
    expect(pathOf('front')).toBeNull();
  });

  it('records nothing when the dialog is cancelled', async () => {
    seed('a', [cleanDoc({ id: 'a' })]);
    vi.mocked(ShowSaveDialog).mockResolvedValue('');

    await saveDocumentAs('a');

    expect(pathOf('a')).toBeNull();
  });
});
