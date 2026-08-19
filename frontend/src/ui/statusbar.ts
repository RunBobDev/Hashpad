/**
 * The status bar (SPEC §6.1's bottom row, §6.11's contents).
 *
 * Same convention as the tab strip and the toolbar -- read `ui/tabbar.ts`'s
 * header first: `buildStatusBar` is a pure function of a plain model object, so
 * its tests need no store and no editor, and `mountStatusBar` is the thin
 * wrapper that subscribes and rebuilds whole.
 *
 * Rebuilding the row from scratch on every change rather than patching the
 * segments in place is deliberate and cheap for the same reason it is in the
 * tab strip: six spans, no listeners, no focus to preserve.
 *
 * Be clear about what the flat model buys, because it is easy to overstate.
 * Typing rebuilds this row every single keystroke -- both the character count
 * and the column change, so `isEqual` cannot match. What it buys is immunity to
 * every *other* `setState`: `syncActiveDocument` replacing the documents array,
 * a theme flip, a pin toggle, a divider drag. Those are the majority of store
 * writes and none of them touch these six strings. This is nonetheless the
 * busiest subscriber in the app, and worth remembering before adding a seventh
 * segment that is expensive to compute.
 *
 * SPEC §6.11 also asks for clicking the encoding and line-ending segments to
 * open a menu that changes them. That is deliberately not here yet: changing
 * either has to make the document dirty, and dirtiness in this app is *derived*
 * (`isDirty` compares the doc against `savedDoc`) rather than stored as a flag,
 * so a metadata-only change has nothing to compare against and would be
 * silently unsaveable. Doing it properly means giving `Document` a saved
 * encoding and line ending too -- a change to the file model, not to this row.
 */
import { store } from '../state/appcontext';
import { activeDocument } from '../state/documents';
import type { AppState, Document, EditorStatus } from '../state/document';

/**
 * Everything the row displays, flattened into one level of primitives so that
 * store.ts's `isEqual` can compare it by value. A nested `Document` here would
 * be compared by reference instead, and `syncActiveDocument` replaces that
 * object on every keystroke -- so the row would also rebuild on every store
 * write that leaves all six strings alone, which is most of them.
 */
export interface StatusBarModel extends EditorStatus {
  /**
   * `null` when there is no active document. Not reachable while the row is
   * mounted -- `main.ts` seeds the store with a document at module scope, long
   * before bootstrap's `finally` mounts this, and closing the last tab opens a
   * fresh one. It is here because `activeDocument` is typed nullable, and three
   * blank segments is the wrong answer if that ever stops being true.
   */
  encoding: Document['encoding'] | null;
  lineEnding: Document['lineEnding'] | null;
  viewMode: Document['viewMode'] | null;
}

const ENCODING_LABELS: Record<Document['encoding'], string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM',
  'utf-16le': 'UTF-16 LE',
};

const LINE_ENDING_LABELS: Record<Document['lineEnding'], string> = {
  lf: 'LF',
  crlf: 'CRLF',
};

const VIEW_MODE_LABELS: Record<Document['viewMode'], string> = {
  source: 'Source',
  live: 'Live',
  split: 'Split',
};

export function statusBarModel(state: AppState): StatusBarModel {
  const doc = activeDocument(state);
  return {
    ...state.status,
    encoding: doc?.encoding ?? null,
    lineEnding: doc?.lineEnding ?? null,
    viewMode: doc?.viewMode ?? null,
  };
}

/**
 * `toLocaleString` for the thousands separator SPEC §6.1's mock shows
 * ("1,247 words"). Locale-aware rather than a hard-coded comma: the separator
 * is a period in half of Europe, and a number formatted the wrong way for the
 * reader is worse than one with no separator at all.
 */
function count(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}`;
}

/**
 * The segments, in SPEC §6.1's order. A segment with nothing to say is omitted
 * rather than rendered empty -- before the first document exists there is no
 * encoding to name, and "Ln 1, Col 1" beside three blanks reads as a bug.
 */
export function statusSegments(model: StatusBarModel): string[] {
  const segments = [
    `Ln ${model.line}, Col ${model.col}`,
    // The suffix is what stops the counts silently changing subject: with a
    // selection they describe it rather than the document (SPEC §6.11), and
    // a number that drops from 1,247 to 12 with no explanation looks like
    // data loss.
    count(model.words, model.selection ? 'words selected' : 'words'),
    count(model.chars, model.selection ? 'chars selected' : 'chars'),
  ];
  if (model.encoding !== null) segments.push(ENCODING_LABELS[model.encoding]);
  if (model.lineEnding !== null) segments.push(LINE_ENDING_LABELS[model.lineEnding]);
  if (model.viewMode !== null) segments.push(VIEW_MODE_LABELS[model.viewMode]);
  return segments;
}

export function buildStatusBar(model: StatusBarModel): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'statusbar';
  // `region` plus a label, which is a navigable landmark: a screen-reader user
  // can jump here on demand and read the counts.
  //
  // Not `role="status"`, which was the first attempt and is self-contradictory.
  // `status` exists *to be* a polite live region, so it announces its contents
  // whenever they change -- and the column changes on every keystroke and every
  // arrow key, which would narrate the caret's whole journey across the
  // document. Silencing it with `aria-live="off"` cancels the only thing the
  // role does, leaving a role that claims to be a live region, is not one, and
  // is not a landmark either, so nothing can reach it.
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Editor status');

  for (const text of statusSegments(model)) {
    const segment = document.createElement('span');
    segment.className = 'statusbar__segment';
    segment.textContent = text;
    bar.append(segment);
  }
  return bar;
}

/**
 * Mounts the row and keeps it in sync; returns a teardown that removes both the
 * node and the subscription.
 *
 * Appended rather than inserted before anything: `#app` is a flex column and
 * this is its last row, so appending is what puts it at the bottom. That is the
 * whole reason it needs no equivalent of the toolbar's `insertBefore` guard.
 *
 * A teardown rather than a hidden node, because View > Status Bar can turn it
 * off for a session: a hidden row still subscribes, and would keep rebuilding
 * six spans nobody can see on every keystroke.
 */
export function mountStatusBar(root: HTMLElement): () => void {
  let bar = buildStatusBar(statusBarModel(store.getState()));
  root.append(bar);

  const unsubscribe = store.subscribe(statusBarModel, (model) => {
    const next = buildStatusBar(model);
    bar.replaceWith(next);
    bar = next;
  });

  return () => {
    unsubscribe();
    bar.remove();
  };
}
