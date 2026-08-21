/**
 * Getting an image into a document (SPEC §6.10).
 *
 * Two ways in -- pasted from the clipboard, or dropped as a file -- and they
 * differ only in what they hand Go: raw bytes, or a path to copy. Everything
 * after that is shared: make sure the document has somewhere to write beside,
 * ask Go for a document-relative path, and insert `![](that)` at the cursor.
 *
 * Go does the filesystem work, including reading `files.assetFolder` from its
 * own settings. Nothing here knows where the file lands, which is why nothing
 * here has to be told when Checkpoint H makes that folder configurable.
 */
import type { EditorView } from '@codemirror/view';
import { SaveClipboardImage, SaveDroppedImage } from '../../wailsjs/go/app/App';
import { confirmSaveForImage } from '../ui/confirmdialog';
import type { Document } from '../state/document';
import { store } from '../state/appcontext';
import { saveActiveAs } from './fileops';

/**
 * Extensions the drop path accepts, matching Go's `imageExtensions` allow-list.
 *
 * Checked on both sides on purpose, and this one is not the security check --
 * Go's is. This copy exists so a dropped `.zip` is quietly ignored rather than
 * making a round trip that comes back as an error dialog for something the user
 * never meant as an image.
 */
export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.avif',
  '.ico',
] as const;

export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * The path of the document identified by `id`, saving it first if it has none.
 *
 * Resolves to null when the user declined or the Save As was cancelled -- both
 * mean "no location", and neither is an error worth reporting.
 *
 * **By id, not "whatever is active".** Everything here is asynchronous, and the
 * user can switch tabs mid-prompt; resolving the active document each time would
 * write the image next to a different file than the one it is going into. The
 * save path is the sharper case: `saveActiveAs` acts on the *active* document by
 * definition, so it is only the right call while this document still is active
 * -- otherwise a paste into an untitled tab would put up a Save As for whichever
 * tab the user moved to.
 */
async function documentPath(id: string): Promise<string | null> {
  const find = (): Document | null =>
    store.getState().documents.find((doc) => doc.id === id) ?? null;

  const existing = find()?.filePath ?? null;
  if (existing !== null) return existing;

  if (!(await confirmSaveForImage())) return null;
  // One check, here, and not also before the prompt: both callers read the
  // active id and reach this line in the same tick, so it cannot have changed
  // yet. It can change while the prompt is up, which is what this catches.
  if (store.getState().activeDocumentId !== id) return null;
  if (!(await saveActiveAs())) return null;

  // Re-read rather than trusting the value from before the await: `saveActiveAs`
  // is what set the path, and it set it in the store.
  return find()?.filePath ?? null;
}

/**
 * Inserts `![](relative/path)` and leaves the caret after it.
 *
 * `at` is where the drop landed; paste passes nothing and replaces the
 * selection, which is what Ctrl+V means everywhere else.
 *
 * **Checks the document has not changed under it.** Everything above this is
 * asynchronous -- a prompt, a file dialog, a write -- and the user can switch
 * tabs while it runs. Without the guard the image would be inserted into
 * whichever document happened to be on screen when Go replied, and the path
 * would be relative to a different folder. Same reasoning as `markSaved`'s
 * pre-await snapshot in fileops.ts.
 *
 * Refusing leaves the written file on disk with nothing referencing it. That is
 * the better of the two losses -- an unused file in `assets/` against an image
 * silently inserted into the wrong document -- and it needs the user to switch
 * tabs inside the millisecond or two a write takes. Inserting into the correct
 * *background* document is possible (its `EditorState` is in the store, as
 * `currentText` in fileops.ts relies on) but is a bigger change than the case
 * warrants.
 */
function insertMarkdown(view: EditorView, expectedId: string, markdown: string, at?: number): void {
  if (store.getState().activeDocumentId !== expectedId) return;

  if (at === undefined) {
    view.dispatch(view.state.replaceSelection(markdown));
  } else {
    const position = Math.min(at, view.state.doc.length);
    view.dispatch({
      changes: { from: position, insert: markdown },
      selection: { anchor: position + markdown.length },
    });
  }
  view.focus();
}

/** The markdown for an image, with the empty alt SPEC §6.10 specifies. */
function imageMarkdown(relativePath: string): string {
  return `![](${relativePath})`;
}

/**
 * The base64 payload of a `File`, without the `data:` prefix.
 *
 * `readAsDataURL` rather than `arrayBuffer()` plus hand-rolled base64: the
 * browser already has an encoder, and `btoa` over a large `Uint8Array` means
 * building a megabytes-long intermediate string a character at a time.
 */
function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read the image'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      // A data URL always has one; refusing rather than slicing from -1 keeps a
      // malformed read from being sent on as a plausible-looking payload.
      if (comma === -1) {
        reject(new Error('unexpected data URL'));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** The first image on the clipboard, or null when there is none. */
export function clipboardImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of data.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/**
 * Ctrl+V with an image on the clipboard (SPEC §6.10).
 *
 * Returns whether the paste was claimed. False means there was no image and
 * CodeMirror should paste text as usual -- deciding that *synchronously* is why
 * `clipboardImage` is separate from the async work: by the time an await
 * resolves, the event is long past being preventable.
 */
export function pasteImage(view: EditorView, event: ClipboardEvent): boolean {
  const file = clipboardImage(event.clipboardData);
  if (file === null) return false;

  event.preventDefault();
  const documentId = store.getState().activeDocumentId;
  if (documentId === null) return true;

  void (async () => {
    try {
      const path = await documentPath(documentId);
      if (path === null) return;

      const relative = await SaveClipboardImage(path, await toBase64(file));
      insertMarkdown(view, documentId, imageMarkdown(relative));
    } catch (error) {
      console.error('hashpad: failed to save the pasted image', error);
    }
  })();

  return true;
}

/**
 * Images dropped on the window (an extension of SPEC §6.4's drop, at the
 * owner's request -- the spec covers pasting only).
 *
 * `at` is the document position under the pointer, so an image lands where it
 * was dropped rather than wherever the caret happened to be. The caller works
 * that out, because only it knows whether the drop was over the editor at all.
 *
 * Sequential rather than `Promise.all`: each insert moves the positions after
 * it, and the whole point of dropping three images at once is getting them in
 * the order they were dropped.
 */
export async function dropImages(
  view: EditorView,
  paths: readonly string[],
  at?: number,
): Promise<void> {
  const documentId = store.getState().activeDocumentId;
  if (documentId === null) return;

  // Once, before the loop. Three dropped images must not mean three save
  // prompts -- and after the first save the document has a path anyway, so the
  // later calls would silently differ from the first.
  const path = await documentPath(documentId);
  if (path === null) return;

  let position = at;
  for (const source of paths) {
    try {
      const relative = await SaveDroppedImage(path, source);
      const markdown = imageMarkdown(relative);
      insertMarkdown(view, documentId, markdown, position);
      // Keep the next image after the last one, rather than all of them landing
      // on the same spot in reverse.
      if (position !== undefined) position += markdown.length;
    } catch (error) {
      console.error(`hashpad: failed to add ${source}`, error);
    }
  }
}
