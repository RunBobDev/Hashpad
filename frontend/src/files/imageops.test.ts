// @vitest-environment jsdom
/**
 * Getting an image into a document (SPEC §6.10, plus the dropped-image path the
 * owner asked for on top of it).
 *
 * Go owns the filesystem work, so what is testable here is the orchestration --
 * and that is where this feature's bugs live: deciding synchronously whether to
 * claim the paste, prompting exactly once, and not inserting into a document the
 * user has since switched away from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { SaveClipboardImage, SaveDroppedImage } from '../../wailsjs/go/app/App';
import { confirmSaveForImage } from '../ui/confirmdialog';
import { createUntitledDocument, type Document } from '../state/document';
import { store } from '../state/appcontext';
import { saveActiveAs } from './fileops';
import { clipboardImage, dropImages, isImagePath, pasteImage } from './imageops';

vi.mock('../../wailsjs/go/app/App', () => ({
  SaveClipboardImage: vi.fn(),
  SaveDroppedImage: vi.fn(),
}));
vi.mock('../ui/confirmdialog', () => ({ confirmSaveForImage: vi.fn() }));
vi.mock('./fileops', () => ({ saveActiveAs: vi.fn() }));

/** Puts one document in the store and returns a view over it. */
function open(filePath: string | null, doc = 'hello'): { view: EditorView; document: Document } {
  const state = EditorState.create({ doc });
  const document_ = { ...createUntitledDocument(state), filePath };
  store.setState((prev) => ({
    ...prev,
    documents: [document_],
    activeDocumentId: document_.id,
  }));
  return {
    view: new EditorView({ state, parent: window.document.createElement('div') }),
    document: document_,
  };
}

/** A `paste` event carrying whatever items are described. */
function pasteEvent(items: { kind: string; type: string; file?: File }[]): ClipboardEvent {
  const event = new Event('paste', { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: items.map((item) => ({
        kind: item.kind,
        type: item.type,
        getAsFile: () => item.file ?? null,
      })),
    },
  });
  return event;
}

const pngFile = (): File =>
  new File([new Uint8Array([1, 2, 3])], 'clip.png', { type: 'image/png' });

/**
 * Drains work still in flight before the next test resets the mocks. `pasteImage`
 * returns before its own async chain finishes, so without this a paste started
 * in one test lands in the middle of the next one -- which is exactly how two of
 * these first failed.
 */
afterEach(async () => {
  await settle();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(SaveClipboardImage).mockResolvedValue('assets/image-20260821-120000.png');
  vi.mocked(SaveDroppedImage).mockImplementation(
    async (_doc: string, source: string) => 'assets/' + source.split(/[\\/]/).pop(),
  );
  vi.mocked(confirmSaveForImage).mockResolvedValue(true);
  vi.mocked(saveActiveAs).mockResolvedValue(true);
});

/**
 * Waits for something a paste eventually does.
 *
 * `pasteImage` returns before its own chain finishes, and part of that chain is
 * a **real `FileReader` read**, whose timing jsdom does not promise. A fixed
 * delay looked fine and then failed under a shuffled run, because it was a guess
 * about how long that read takes. Polling is the honest version.
 */
function eventually(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 2000, interval: 5 });
}

/**
 * Drains whatever is still in flight. Used for the *negative* assertions --
 * "nothing was written" has no event to wait for, so all that can be done is
 * give the work every chance to happen and then check it did not.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('recognising an image', () => {
  it.each([['a.png'], ['a.JPG'], ['a.jpeg'], ['a.gif'], ['a.webp'], ['a.svg'], ['a.AVIF']])(
    '%s is an image',
    (path) => {
      expect(isImagePath(path)).toBe(true);
    },
  );

  it.each([['notes.md'], ['archive.zip'], ['pngfile'], ['a.png.txt']])(
    '%s is not an image',
    (path) => {
      expect(isImagePath(path)).toBe(false);
    },
  );

  it('finds the image among other clipboard flavours', () => {
    const file = pngFile();
    const data = pasteEvent([
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', file },
    ]).clipboardData;

    expect(clipboardImage(data)).toBe(file);
  });

  it('finds nothing on a text-only clipboard', () => {
    const data = pasteEvent([{ kind: 'string', type: 'text/plain' }]).clipboardData;

    expect(clipboardImage(data)).toBeNull();
  });
});

describe('pasting an image', () => {
  /**
   * A text paste must fall straight through to CodeMirror -- and the answer has
   * to be synchronous, because after an await the event can no longer be
   * prevented and the decision would already have been made for us.
   */
  it('leaves a text paste to CodeMirror', () => {
    const { view } = open('C:\\notes\\a.md');
    const event = pasteEvent([{ kind: 'string', type: 'text/plain' }]);

    expect(pasteImage(view, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('claims a paste that carries an image', () => {
    const { view } = open('C:\\notes\\a.md');
    const event = pasteEvent([{ kind: 'file', type: 'image/png', file: pngFile() }]);

    expect(pasteImage(view, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('writes the image beside the document and inserts the markdown', async () => {
    const { view } = open('C:\\notes\\a.md');

    pasteImage(view, pasteEvent([{ kind: 'file', type: 'image/png', file: pngFile() }]));

    await eventually(() => {
      // The bytes cross IPC base64-encoded -- [1, 2, 3] is "AQID".
      expect(SaveClipboardImage).toHaveBeenCalledWith('C:\\notes\\a.md', 'AQID');
      expect(view.state.doc.toString()).toBe('![](assets/image-20260821-120000.png)hello');
    });
  });

  /** SPEC §6.10 step 1: there is nowhere to write beside an untitled document. */
  it('offers to save an untitled document first', async () => {
    const { view } = open(null);
    vi.mocked(saveActiveAs).mockImplementation(async () => {
      store.setState((prev) => ({
        ...prev,
        documents: prev.documents.map((doc) => ({ ...doc, filePath: 'C:\\saved\\a.md' })),
      }));
      return true;
    });

    pasteImage(view, pasteEvent([{ kind: 'file', type: 'image/png', file: pngFile() }]));

    await eventually(() => {
      expect(confirmSaveForImage).toHaveBeenCalled();
      expect(SaveClipboardImage).toHaveBeenCalledWith('C:\\saved\\a.md', 'AQID');
    });
  });

  it('does nothing when the save prompt is declined', async () => {
    const { view } = open(null);
    vi.mocked(confirmSaveForImage).mockResolvedValue(false);

    pasteImage(view, pasteEvent([{ kind: 'file', type: 'image/png', file: pngFile() }]));
    await settle();

    expect(saveActiveAs).not.toHaveBeenCalled();
    expect(SaveClipboardImage).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('hello');
  });

  it('does nothing when the Save As is cancelled', async () => {
    const { view } = open(null);
    vi.mocked(saveActiveAs).mockResolvedValue(false);

    pasteImage(view, pasteEvent([{ kind: 'file', type: 'image/png', file: pngFile() }]));
    await settle();

    expect(SaveClipboardImage).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('hello');
  });

  /**
   * `saveActiveAs` acts on the *active* document by definition. If the user
   * moves to another tab while the prompt is up, running it would put a Save As
   * in front of a document they never asked to save -- and save it under a name
   * chosen for a different one.
   */
  it('does not put a Save As in front of a tab the user moved to', async () => {
    const { view } = open(null);
    vi.mocked(confirmSaveForImage).mockImplementation(async () => {
      store.setState((prev) => ({ ...prev, activeDocumentId: 'someone-else' }));
      return true;
    });

    pasteImage(view, pasteEvent([{ kind: 'file', type: 'image/png', file: pngFile() }]));
    await settle();

    expect(saveActiveAs).not.toHaveBeenCalled();
    expect(SaveClipboardImage).not.toHaveBeenCalled();
  });

  /**
   * Everything between the paste and the insert is asynchronous -- a prompt, a
   * file dialog, a write -- and the user can switch tabs while it runs. Without
   * the guard the image lands in whichever document is on screen when Go
   * replies, carrying a path relative to a different folder.
   */
  it('does not insert into a document the user has switched away from', async () => {
    const { view } = open('C:\\notes\\a.md');

    pasteImage(view, pasteEvent([{ kind: 'file', type: 'image/png', file: pngFile() }]));
    store.setState((prev) => ({ ...prev, activeDocumentId: 'someone-else' }));

    // The write still happens -- the document it belongs to is still open, just
    // not in front. What must not happen is the insert.
    await eventually(() => expect(SaveClipboardImage).toHaveBeenCalled());
    await settle();

    expect(view.state.doc.toString()).toBe('hello');
  });

  it('reports a failed write rather than inserting a broken link', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { view } = open('C:\\notes\\a.md');
    vi.mocked(SaveClipboardImage).mockRejectedValue(new Error('disk full'));

    pasteImage(view, pasteEvent([{ kind: 'file', type: 'image/png', file: pngFile() }]));

    await eventually(() => expect(logged).toHaveBeenCalled());

    expect(view.state.doc.toString()).toBe('hello');
  });
});

describe('dropping images', () => {
  it('inserts at the position they were dropped', async () => {
    const { view } = open('C:\\notes\\a.md', 'hello');

    await dropImages(view, ['C:\\pics\\one.png'], 5);

    expect(view.state.doc.toString()).toBe('hello![](assets/one.png)');
  });

  /**
   * Sequential, and each insert moves the next one along. Getting this wrong
   * puts them in at the same offset, which reverses their order.
   */
  it('keeps several dropped images in the order they were dropped', async () => {
    const { view } = open('C:\\notes\\a.md', 'AB');

    await dropImages(view, ['C:\\pics\\one.png', 'C:\\pics\\two.png'], 1);

    expect(view.state.doc.toString()).toBe('A![](assets/one.png)![](assets/two.png)B');
  });

  /** With no position -- dropped outside the editor -- it replaces the selection. */
  it('falls back to the caret when the drop was not over the text', async () => {
    const { view } = open('C:\\notes\\a.md', 'hello');

    await dropImages(view, ['C:\\pics\\one.png']);

    expect(view.state.doc.toString()).toBe('![](assets/one.png)hello');
  });

  /** Three images must not mean three prompts. */
  it('asks to save once, however many images were dropped', async () => {
    const { view } = open(null);
    vi.mocked(saveActiveAs).mockImplementation(async () => {
      store.setState((prev) => ({
        ...prev,
        documents: prev.documents.map((doc) => ({ ...doc, filePath: 'C:\\saved\\a.md' })),
      }));
      return true;
    });

    await dropImages(view, ['a.png', 'b.png', 'c.png'], 0);

    expect(confirmSaveForImage).toHaveBeenCalledTimes(1);
    expect(SaveDroppedImage).toHaveBeenCalledTimes(3);
  });

  /**
   * The "once" above cannot see a per-image prompt on its own: after the first
   * Save As the document has a path, so the later images find one and never
   * ask. Declining keeps it untitled, which is the case where resolving the path
   * inside the loop would put the prompt up again for every remaining image.
   */
  it('does not ask again for the rest of the drop once declined', async () => {
    const { view } = open(null);
    vi.mocked(confirmSaveForImage).mockResolvedValue(false);

    await dropImages(view, ['a.png', 'b.png', 'c.png'], 0);

    expect(confirmSaveForImage).toHaveBeenCalledTimes(1);
    expect(SaveDroppedImage).not.toHaveBeenCalled();
  });

  /** One bad file must not cost the user the rest of the drop. */
  it('skips an image it cannot add and still adds the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { view } = open('C:\\notes\\a.md', '');
    vi.mocked(SaveDroppedImage).mockImplementation(async (_doc: string, source: string) => {
      if (source.endsWith('bad.png')) throw new Error('locked');
      return 'assets/' + source.split(/[\\/]/).pop();
    });

    await dropImages(view, ['bad.png', 'good.png'], 0);

    expect(view.state.doc.toString()).toBe('![](assets/good.png)');
  });
});
