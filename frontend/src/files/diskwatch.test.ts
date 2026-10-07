// @vitest-environment jsdom
/**
 * SPEC §7.4's decisions, against a real `EditorView`. "Which buffer did the
 * reload land in" is the thing most likely to be wrong here, and only a real
 * view can show it -- the active document's text lives in the view, a
 * background document's in its own stored state (fileops.ts `currentText`).
 */
import { undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from '../editor/extensions';
import { setEditorView, store } from '../state/appcontext';
import {
  DEFAULT_BEHAVIOUR,
  DEFAULT_OUTLINE_WIDTH,
  EMPTY_STATUS,
  createUntitledDocument,
  isDirty,
  type Document,
} from '../state/document';
import {
  FILE_CHANGED_EVENT,
  FILE_DELETED_EVENT,
  handleDiskChange,
  handleDiskDeleted,
  keepMine,
  minimalChange,
  mountDiskWatch,
  reloadFromDisk,
} from './diskwatch';

vi.mock('../../wailsjs/go/app/App', () => ({ SetWatchedFiles: vi.fn(async () => {}) }));
vi.mock('../../wailsjs/runtime/runtime', () => ({ EventsOn: vi.fn(() => () => {}) }));

let view: EditorView;

/** A clean document over `path`, as if just opened. */
function fileDoc(id: string, path: string, text: string): Document {
  const editorState = EditorState.create({ doc: text, extensions: buildExtensions(false) });
  return { ...createUntitledDocument(editorState), id, filePath: path };
}

/** Seeds the store and puts the active document's state on screen. */
function seed(documents: Document[], activeId: string | null): void {
  store.setState(() => ({
    documents,
    activeDocumentId: activeId,
    isDark: false,
    closedPaths: [],
    activeFormats: '',
    pinnedToolbarCommands: [],
    previewSplitRatio: 0.5,
    syncScroll: true,
    wordWrap: true,
    editorBehaviour: DEFAULT_BEHAVIOUR,
    defaultViewMode: 'source',
    openedViewMode: 'source',
    recentViewModes: [],
    defaultEncoding: 'utf-8',
    autosave: false,
    autosaveDelayMs: 2000,
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
  }));
  const active = documents.find((d) => d.id === activeId);
  if (active) view.setState(active.editorState);
}

function stored(id: string): Document {
  return store.getState().documents.find((d) => d.id === id)!;
}

/** What Go sends: the file as read, with its path and detected metadata. */
function disk(
  path: string,
  content: string,
  overrides: Partial<{ encoding: string; lineEnding: string; mixed: boolean }> = {},
) {
  return { path, content, encoding: 'utf-8', lineEnding: 'crlf', mixed: false, ...overrides };
}

/** Types into the active document the way a user would, through the view. */
function typeAtEnd(text: string): void {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

beforeEach(() => {
  view = new EditorView({
    state: EditorState.create({ doc: '', extensions: buildExtensions(false) }),
    parent: document.createElement('div'),
  });
  setEditorView(view);
  vi.clearAllMocks();
});

afterEach(() => {
  view.destroy();
});

describe('minimalChange', () => {
  it('is null for identical text', () => {
    expect(minimalChange('same', 'same')).toBeNull();
  });

  it('touches only the part that differs', () => {
    expect(minimalChange('one two three', 'one 2 three')).toEqual({ from: 4, to: 7, insert: '2' });
  });

  it.each([
    ['abc', 'abcdef'],
    ['xabc', 'abc'],
    ['aaa', 'aa'],
    ['', 'new'],
    ['old', ''],
    ['line 1\nline 2\n', 'line 1\nline 1.5\nline 2\n'],
  ])('turns %j into %j', (before, after) => {
    const change = minimalChange(before, after)!;

    expect(before.slice(0, change.from) + change.insert + before.slice(change.to)).toBe(after);
  });
});

describe('a change on disk', () => {
  it('reloads a clean active document silently', () => {
    seed([fileDoc('a', 'C:\\a.md', 'first\nsecond')], 'a');

    handleDiskChange(disk('C:\\a.md', 'first\nsecond, edited'));

    expect(view.state.doc.toString()).toBe('first\nsecond, edited');
    expect(stored('a').diskChange).toBeNull();
    expect(isDirty(stored('a'))).toBe(false);
  });

  // Replacing the whole text would send the caret to one end of it.
  it('keeps the caret where it was when the change is elsewhere', () => {
    seed([fileDoc('a', 'C:\\a.md', 'first\nsecond')], 'a');
    view.dispatch({ selection: EditorSelection.cursor(2) });

    handleDiskChange(disk('C:\\a.md', 'first\nsecond, edited'));

    expect(view.state.selection.main.head).toBe(2);
  });

  it('reloads a clean background document without touching the one on screen', () => {
    seed(
      [fileDoc('front', 'C:\\front.md', 'front'), fileDoc('back', 'C:\\back.md', 'old')],
      'front',
    );

    handleDiskChange(disk('C:\\back.md', 'new'));

    expect(stored('back').editorState.doc.toString()).toBe('new');
    expect(isDirty(stored('back'))).toBe(false);
    expect(view.state.doc.toString()).toBe('front');
  });

  it('takes the encoding and line ending the file now has', () => {
    seed([fileDoc('a', 'C:\\a.md', 'text')], 'a');

    handleDiskChange(
      disk('C:\\a.md', 'text', { encoding: 'utf-16le', lineEnding: 'lf', mixed: true }),
    );

    const doc = stored('a');
    expect([doc.encoding, doc.savedEncoding, doc.lineEnding, doc.savedLineEnding]).toEqual([
      'utf-16le',
      'utf-16le',
      'lf',
      'lf',
    ]);
    expect(doc.mixedLineEndings).toBe(true);
    expect(isDirty(doc)).toBe(false);
  });

  it('can be undone', () => {
    seed([fileDoc('a', 'C:\\a.md', 'mine')], 'a');

    handleDiskChange(disk('C:\\a.md', 'theirs'));
    undo(view);

    expect(view.state.doc.toString()).toBe('mine');
  });

  // CodeMirror folds edits less than half a second apart into one undo step.
  // Typing straight after a reload must not be folded into it.
  it('stays its own undo step when typing follows at once', () => {
    seed([fileDoc('a', 'C:\\a.md', 'mine')], 'a');

    handleDiskChange(disk('C:\\a.md', 'theirs'));
    typeAtEnd('!');
    undo(view);

    expect(view.state.doc.toString()).toBe('theirs');
  });

  it('leaves an edited document alone and holds the disk version for the bar', () => {
    seed([fileDoc('a', 'C:\\a.md', 'base')], 'a');
    typeAtEnd(' + mine');

    handleDiskChange(disk('C:\\a.md', 'base + theirs'));

    expect(view.state.doc.toString()).toBe('base + mine');
    expect(stored('a').diskChange).toEqual({
      content: 'base + theirs',
      encoding: 'utf-8',
      lineEnding: 'crlf',
      mixed: false,
    });
    expect(stored('a').savedDoc.toString()).toBe('base');
  });

  // Another program wrote exactly what the buffer holds: nothing to resolve.
  it('records the buffer as saved when the disk caught up with it', () => {
    seed([fileDoc('a', 'C:\\a.md', 'base')], 'a');
    typeAtEnd('!');

    handleDiskChange(disk('C:\\a.md', 'base!'));

    expect(isDirty(stored('a'))).toBe(false);
    expect(stored('a').diskChange).toBeNull();
  });

  // A touch, or a change reverted: the disk is back to what was last read.
  it('ends a conflict when the disk goes back to what was last read', () => {
    seed([fileDoc('a', 'C:\\a.md', 'base')], 'a');
    typeAtEnd(' + mine');
    handleDiskChange(disk('C:\\a.md', 'base + theirs'));

    handleDiskChange(disk('C:\\a.md', 'base'));

    expect(stored('a').diskChange).toBeNull();
    expect(view.state.doc.toString()).toBe('base + mine');
  });

  it('ignores a path no document holds', () => {
    seed([fileDoc('a', 'C:\\a.md', 'base')], 'a');
    const before = store.getState();

    handleDiskChange(disk('C:\\other.md', 'x'));

    expect(store.getState()).toBe(before);
  });
});

describe('a deletion on disk', () => {
  it('marks the document, which then counts as unsaved', () => {
    seed([fileDoc('a', 'C:\\a.md', 'base')], 'a');

    handleDiskDeleted('C:\\a.md');

    expect(stored('a').diskChange).toBe('deleted');
    expect(isDirty(stored('a'))).toBe(true);
  });

  it('is undone by the file coming back', () => {
    seed([fileDoc('a', 'C:\\a.md', 'base')], 'a');
    handleDiskDeleted('C:\\a.md');

    handleDiskChange(disk('C:\\a.md', 'base'));

    expect(stored('a').diskChange).toBeNull();
    expect(isDirty(stored('a'))).toBe(false);
  });
});

describe("the bar's answers", () => {
  function conflicted(): void {
    seed([fileDoc('a', 'C:\\a.md', 'base')], 'a');
    typeAtEnd(' + mine');
    handleDiskChange(disk('C:\\a.md', 'base + theirs'));
  }

  it('Reload takes the disk version, and Ctrl+Z brings the edits back', () => {
    conflicted();

    reloadFromDisk('a');

    expect(view.state.doc.toString()).toBe('base + theirs');
    expect(stored('a').diskChange).toBeNull();
    expect(isDirty(stored('a'))).toBe(false);
    undo(view);
    expect(view.state.doc.toString()).toBe('base + mine');
  });

  it('Keep mine leaves the buffer and measures it against the disk version', () => {
    conflicted();

    keepMine('a');

    expect(view.state.doc.toString()).toBe('base + mine');
    expect(stored('a').savedDoc.toString()).toBe('base + theirs');
    expect(stored('a').diskChange).toBeNull();
    expect(isDirty(stored('a'))).toBe(true);
  });

  it('both do nothing without a change to answer', () => {
    seed([fileDoc('a', 'C:\\a.md', 'base')], 'a');
    handleDiskDeleted('C:\\a.md');
    const before = store.getState();

    reloadFromDisk('a');
    keepMine('a');

    expect(store.getState()).toBe(before);
  });
});

describe('mountDiskWatch', () => {
  it('tells Go the open paths now, and again only when they change', () => {
    const untitled = { ...fileDoc('u', 'x', ''), filePath: null };
    seed([fileDoc('a', 'C:\\a.md', 'a'), untitled], 'a');
    const setWatched = vi.fn(async (_paths: string[]) => {});
    const unmount = mountDiskWatch(
      vi.fn(() => () => {}),
      setWatched,
    );

    expect(setWatched).toHaveBeenLastCalledWith(['C:\\a.md']);

    typeAtEnd('!');
    expect(setWatched).toHaveBeenCalledTimes(1);

    store.setState((prev) => ({
      ...prev,
      documents: [...prev.documents, fileDoc('b', 'C:\\b.md', 'b')],
    }));
    expect(setWatched).toHaveBeenLastCalledWith(['C:\\a.md', 'C:\\b.md']);

    unmount();
  });

  it('routes both events to their handlers, and unsubscribes on teardown', () => {
    seed([fileDoc('a', 'C:\\a.md', 'a')], 'a');
    const handlers = new Map<string, (data: unknown) => void>();
    const offs = [vi.fn(), vi.fn()];
    const on = vi.fn((event: string, callback: (data: unknown) => void) => {
      handlers.set(event, callback);
      return offs[handlers.size - 1]!;
    });
    const unmount = mountDiskWatch(
      on as never,
      vi.fn(async () => {}),
    );

    handlers.get(FILE_DELETED_EVENT)!('C:\\a.md');
    expect(stored('a').diskChange).toBe('deleted');
    handlers.get(FILE_CHANGED_EVENT)!(disk('C:\\a.md', 'a'));
    expect(stored('a').diskChange).toBeNull();

    unmount();
    expect(offs[0]).toHaveBeenCalled();
    expect(offs[1]).toHaveBeenCalled();
  });
});
