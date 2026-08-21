// @vitest-environment jsdom
/**
 * Dropping files on the window (SPEC §6.4).
 *
 * jsdom is needed for more than the DOM here: it turns out to run CodeMirror's
 * built-in drop path *end to end* -- `FileReader` reads the dropped file and
 * `posAtCoords` resolves a position even with no layout engine -- so the
 * suppression test below can assert the document's contents rather than
 * whether some handler returned true. Measured, not assumed: without
 * `suppressEditorFileDrop`, a file dropped in this environment really does
 * insert its text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { mountFileDrop, suppressEditorFileDrop, supportedPaths } from './filedrop';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('which dropped files are opened', () => {
  /** SPEC §6.4's list, spelled out again here so a quiet edit to it fails. */
  it('keeps every recognised extension, in the order dropped', () => {
    const paths = [
      'a.md',
      'b.markdown',
      'c.mdown',
      'd.mkd',
      'e.mdx',
      'f.qmd',
      'g.rmd',
      'h.txt',
    ];

    expect(supportedPaths(paths)).toEqual(paths);
  });

  /**
   * The reason this filter exists. Every file this app opens is decoded as
   * markdown text, so opening a `.png` would produce a tab of mojibake -- worse
   * than doing nothing, because it also steals focus from the document the user
   * was working in.
   */
  it('ignores files it cannot open as markdown', () => {
    expect(supportedPaths(['photo.png', 'archive.zip', 'binary', 'notes.md'])).toEqual([
      'notes.md',
    ]);
  });

  /** Windows paths are case-insensitive, and a `README.MD` is common. */
  it('matches extensions regardless of case', () => {
    expect(supportedPaths(['C:\\docs\\README.MD', 'C:\\docs\\Notes.Txt'])).toEqual([
      'C:\\docs\\README.MD',
      'C:\\docs\\Notes.Txt',
    ]);
  });

  /**
   * Wails' dispatcher builds its list with `strings.Split(payload, "\n")`, which
   * returns `[""]` rather than an empty slice when there is nothing to split --
   * so an empty payload arrives as one empty path, not as no paths.
   */
  it('survives the empty path Wails sends for an empty drop', () => {
    expect(supportedPaths([''])).toEqual([]);
  });
});

describe('subscribing to drops', () => {
  interface Harness {
    open: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
    useDropTarget: boolean | undefined;
    fire: (paths: string[]) => void;
    teardown: () => void;
  }

  function mount(open = vi.fn()): Harness {
    let callback: ((x: number, y: number, paths: string[]) => void) | null = null;
    let useDropTarget: boolean | undefined;
    const unregister = vi.fn();

    const teardown = mountFileDrop(
      open,
      (cb, flag) => {
        callback = cb;
        useDropTarget = flag;
      },
      unregister,
    );

    return {
      open,
      unregister,
      get useDropTarget() {
        return useDropTarget;
      },
      fire: (paths) => callback?.(0, 0, paths),
      teardown,
    };
  }

  /**
   * Load-bearing, not a default worth copying blindly. With `useDropTarget`
   * true, Wails only reports a drop that landed on an element whose computed
   * style carries `--wails-drop-target: drop` -- which would mean every region
   * of the app declaring it, and any region that forgot silently swallowing
   * drops. SPEC §6.4 says the window.
   */
  it('accepts a drop anywhere on the window', () => {
    expect(mount().useDropTarget).toBe(false);
  });

  it('opens the recognised files from a mixed drop', () => {
    const harness = mount();

    harness.fire(['photo.png', 'notes.md', 'todo.txt']);

    expect(harness.open).toHaveBeenCalledWith(['notes.md', 'todo.txt']);
  });

  /** Nothing openable means nothing happens -- not an empty call that churns tabs. */
  it('does nothing when no dropped file is openable', () => {
    const harness = mount();

    harness.fire(['photo.png', 'archive.zip']);

    expect(harness.open).not.toHaveBeenCalled();
  });

  it('unsubscribes on teardown', () => {
    const harness = mount();

    harness.teardown();

    expect(harness.unregister).toHaveBeenCalled();
  });

  /**
   * Wails' callback is not async-aware, so a rejection has nowhere to go. It has
   * to be caught here or it surfaces as an unhandled rejection -- which in a
   * packaged app is an error nobody sees and a drop that silently did nothing.
   */
  it('reports a failed open rather than rejecting into nowhere', async () => {
    const error = new Error('nope');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = mount(vi.fn().mockRejectedValue(error));

    harness.fire(['notes.md']);
    await Promise.resolve();
    await Promise.resolve();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('dropped files'), error);
  });
});

describe('the editor’s own file-drop handling', () => {
  function editor(extensions: ReturnType<typeof suppressEditorFileDrop>[]): EditorView {
    return new EditorView({
      state: EditorState.create({ doc: 'hello', extensions }),
      parent: document.createElement('div'),
    });
  }

  function drop(view: EditorView, dataTransfer: { files: File[]; text: string }): void {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: dataTransfer.files, getData: () => dataTransfer.text },
    });
    // posAtCoords reads these. jsdom reports every rect as zero, which resolves
    // to position 0 -- fine, since what matters is whether anything is inserted
    // at all, not where.
    Object.defineProperty(event, 'clientX', { value: 0 });
    Object.defineProperty(event, 'clientY', { value: 0 });
    view.contentDOM.dispatchEvent(event);
  }

  /**
   * The bug this prevents: CodeMirror reads a dropped file with a `FileReader`
   * and inserts its text at the cursor. Since the drop also opens the file as a
   * tab, the user would get their file opened *and* its contents pasted into
   * whichever document they happened to be editing.
   */
  it('does not paste a dropped file into the current document', async () => {
    const view = editor([suppressEditorFileDrop()]);

    drop(view, { files: [new File(['dropped text'], 'a.md')], text: '' });
    // FileReader is asynchronous, so the insertion this asserts against would
    // land after the dispatch returns. Waiting is what makes the test able to
    // fail.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(view.state.doc.toString()).toBe('hello');
  });

  /**
   * The other half: only *files* are claimed. Dragging a selection from one part
   * of the document to another is ordinary editing, and CodeMirror's handling of
   * it is exactly right.
   */
  it('leaves a dragged text selection alone', () => {
    const view = editor([suppressEditorFileDrop()]);

    drop(view, { files: [], text: 'moved' });

    expect(view.state.doc.toString()).toBe('movedhello');
  });
});
