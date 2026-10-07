// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepMine, reloadFromDisk } from '../files/diskwatch';
import { getEditorView, store } from '../state/appcontext';
import {
  DEFAULT_BEHAVIOUR,
  DEFAULT_OUTLINE_WIDTH,
  EMPTY_STATUS,
  createUntitledDocument,
  type Document,
} from '../state/document';
import { mountDiskBar } from './diskbar';

vi.mock('../files/diskwatch', () => ({ reloadFromDisk: vi.fn(), keepMine: vi.fn() }));
vi.mock('../state/appcontext', async () => {
  const { createStore } = await import('../state/store');
  const focus = vi.fn();
  return { store: createStore({} as never), getEditorView: () => ({ focus }) };
});

const changed = { content: 'theirs', encoding: 'utf-8', lineEnding: 'crlf', mixed: false } as const;

function doc(id: string, diskChange: Document['diskChange']): Document {
  const base = createUntitledDocument(EditorState.create({ doc: '' }));
  return { ...base, id, filePath: `C:\\${id}.md`, diskChange };
}

function seed(documents: Document[], activeId: string): void {
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
}

let anchor: HTMLElement;
let bar: HTMLElement;
let unmount: () => void;

/** The buttons a user can see. */
function buttons(): HTMLButtonElement[] {
  return [...bar.querySelectorAll('button')].filter((b) => !b.hidden);
}

beforeEach(() => {
  seed([doc('a', null)], 'a');
  const parent = document.createElement('div');
  anchor = document.createElement('div');
  parent.append(anchor);
  document.body.append(parent);
  ({ element: bar, unmount } = mountDiskBar(parent, anchor));
  vi.clearAllMocks();
});

afterEach(() => {
  unmount();
  document.body.replaceChildren();
});

describe('the disk bar', () => {
  it('sits immediately before the element it was given', () => {
    expect(bar.nextElementSibling).toBe(anchor);
  });

  it('is hidden while the disk agrees with the document', () => {
    expect(bar.hidden).toBe(true);
  });

  it('offers Reload and Keep mine when the file changed', () => {
    seed([doc('a', changed)], 'a');

    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('This file changed on disk.');
    expect(buttons().map((b) => b.textContent)).toEqual(['Reload', 'Keep mine']);
  });

  it('says a deleted file is deleted, with nothing to click', () => {
    seed([doc('a', 'deleted')], 'a');

    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('deleted on disk');
    expect(buttons()).toEqual([]);
  });

  it('follows the active tab', () => {
    seed([doc('a', changed), doc('b', null)], 'a');
    expect(bar.hidden).toBe(false);

    store.setState((prev) => ({ ...prev, activeDocumentId: 'b' }));

    expect(bar.hidden).toBe(true);
  });

  it.each([
    ['Reload', reloadFromDisk],
    ['Keep mine', keepMine],
  ])('%s answers for the active document and hands focus back to the editor', (label, action) => {
    seed([doc('x', null), doc('a', changed)], 'a');

    buttons()
      .find((b) => b.textContent === label)!
      .click();

    expect(action).toHaveBeenCalledExactlyOnceWith('a');
    expect(getEditorView().focus).toHaveBeenCalled();
  });

  // Non-blocking: appearing must not take the keyboard from whoever is typing.
  it('does not take focus when it appears', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    seed([doc('a', changed)], 'a');

    expect(document.activeElement).toBe(input);
  });

  it('announces itself politely', () => {
    expect(bar.getAttribute('role')).toBe('status');
  });
});
