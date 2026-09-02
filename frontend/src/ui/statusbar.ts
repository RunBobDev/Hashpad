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
 * The encoding and line-ending segments are buttons that open a menu (SPEC
 * §6.11). That needed the file model to change first, not this row: dirtiness
 * here is *derived* rather than stored as a flag, so until `Document` carried a
 * `savedEncoding`/`savedLineEnding` to compare against, picking a new line
 * ending left the document looking clean, gave Ctrl+S nothing to do, and threw
 * the choice away on close.
 *
 * Choosing an item dispatches a `hashpad:command` rather than writing the store
 * from here, the same as the tab strip and the toolbar. Changing a document is
 * main.ts's job; see `ui/tabbar.ts`'s header for why that boundary exists.
 */
import { store } from '../state/appcontext';
import { activeDocument } from '../state/documents';
import type { AppState, Document, EditorStatus, Encoding, LineEnding } from '../state/document';
import { emitCommand } from './menubar';
import { closePopupMenu, isPopupOpenFor, openPopupMenu, type PopupItem } from './popupmenu';

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
  encoding: Encoding | null;
  lineEnding: LineEnding | null;
  viewMode: Document['viewMode'] | null;
  /** Drives the line-ending segment's tooltip; see `Document.mixedLineEndings`. */
  mixedLineEndings: boolean;
}

const ENCODING_LABELS: Record<Encoding, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM',
  'utf-16le': 'UTF-16 LE',
};

const LINE_ENDING_LABELS: Record<LineEnding, string> = {
  lf: 'LF',
  crlf: 'CRLF',
};

const ENCODING_PREFIX = 'document.encoding:';
const LINE_ENDING_PREFIX = 'document.lineEnding:';

/** The command id `main.ts` recognises as "write this encoding to the active document". */
export function encodingCommand(encoding: Encoding): string {
  return `${ENCODING_PREFIX}${encoding}`;
}

export function lineEndingCommand(lineEnding: LineEnding): string {
  return `${LINE_ENDING_PREFIX}${lineEnding}`;
}

/**
 * Reverses the two above. Same arrangement as `ui/tabbar.ts`'s
 * `parseTabCommand`: one module understands the encoding, and main.ts's router
 * does not re-derive the prefixes for itself.
 *
 * The value is validated against the label tables rather than cast. These ids
 * arrive as strings on a `document`-level event bus that anything can dispatch
 * to, and `WriteFile` hands whatever it is to Go -- so an unrecognised value is
 * answered with `null` here rather than becoming a `Document.encoding` no
 * decoder knows.
 */
export function parseStatusCommand(
  command: string,
): { kind: 'encoding'; value: Encoding } | { kind: 'lineEnding'; value: LineEnding } | null {
  if (command.startsWith(ENCODING_PREFIX)) {
    const value = command.slice(ENCODING_PREFIX.length);
    return value in ENCODING_LABELS ? { kind: 'encoding', value: value as Encoding } : null;
  }
  if (command.startsWith(LINE_ENDING_PREFIX)) {
    const value = command.slice(LINE_ENDING_PREFIX.length);
    return value in LINE_ENDING_LABELS ? { kind: 'lineEnding', value: value as LineEnding } : null;
  }
  return null;
}

// `Record<Document['viewMode'], …>` rather than a partial map: adding a mode to
// the union makes this a compile error rather than a segment that silently
// reads blank. That is how `'preview'` was found here at all.
const VIEW_MODE_LABELS: Record<Document['viewMode'], string> = {
  source: 'Source',
  live: 'Live',
  split: 'Split',
  preview: 'Preview',
};

export function statusBarModel(state: AppState): StatusBarModel {
  const doc = activeDocument(state);
  return {
    ...state.status,
    encoding: doc?.encoding ?? null,
    lineEnding: doc?.lineEnding ?? null,
    viewMode: doc?.viewMode ?? null,
    mixedLineEndings: doc?.mixedLineEndings ?? false,
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

/** One readout in the row. `menu` is what makes it a button instead of a span. */
export interface StatusSegment {
  text: string;
  menu?: 'encoding' | 'lineEnding';
  /** Hover text, currently only the mixed-line-endings warning. */
  title?: string;
}

/**
 * What a mixed file's line-ending segment says on hover. Worth a tooltip rather
 * than a visible marker: it is true of the file as read, it stops being true
 * the moment the user saves, and the row has no space for a fourth state.
 */
const MIXED_TITLE =
  'This file mixes CRLF and LF line endings. Saving will convert the whole file to one.';

/**
 * The segments, in SPEC §6.1's order. A segment with nothing to say is omitted
 * rather than rendered empty -- before the first document exists there is no
 * encoding to name, and "Ln 1, Col 1" beside three blanks reads as a bug.
 */
export function statusSegments(model: StatusBarModel): StatusSegment[] {
  const segments: StatusSegment[] = [
    { text: `Ln ${model.line}, Col ${model.col}` },
    // The suffix is what stops the counts silently changing subject: with a
    // selection they describe it rather than the document (SPEC §6.11), and
    // a number that drops from 1,247 to 12 with no explanation looks like
    // data loss.
    { text: count(model.words, model.selection ? 'words selected' : 'words') },
    { text: count(model.chars, model.selection ? 'chars selected' : 'chars') },
  ];
  if (model.encoding !== null) {
    segments.push({ text: ENCODING_LABELS[model.encoding], menu: 'encoding' });
  }
  if (model.lineEnding !== null) {
    segments.push({
      text: LINE_ENDING_LABELS[model.lineEnding],
      menu: 'lineEnding',
      ...(model.mixedLineEndings ? { title: MIXED_TITLE } : {}),
    });
  }
  // Not a menu, deliberately: the view mode has a command of its own
  // (Ctrl+Shift+P, View > Preview), and a second way in that looked identical
  // to the two above would imply the three are the same kind of control.
  if (model.viewMode !== null) segments.push({ text: VIEW_MODE_LABELS[model.viewMode] });
  return segments;
}

/** The menu behind each clickable segment, with the current value ticked. */
export function segmentItems(menu: 'encoding' | 'lineEnding', model: StatusBarModel): PopupItem[] {
  if (menu === 'encoding') {
    return (Object.keys(ENCODING_LABELS) as Encoding[]).map((id) => ({
      id: encodingCommand(id),
      label: ENCODING_LABELS[id],
      checked: id === model.encoding,
    }));
  }
  return (Object.keys(LINE_ENDING_LABELS) as LineEnding[]).map((id) => ({
    id: lineEndingCommand(id),
    // The bare 'LF'/'CRLF' the row shows is not enough in a menu you are
    // choosing from -- naming the platform is what makes the choice meaningful
    // to someone who does not already know the difference.
    label: id === 'lf' ? 'LF (Unix)' : 'CRLF (Windows)',
    checked: id === model.lineEnding,
  }));
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

  for (const segment of statusSegments(model)) {
    bar.append(buildSegment(segment, model));
  }
  return bar;
}

/**
 * A plain readout is a `<span>`; a segment with a menu is a real `<button>`.
 *
 * Not a span with a click handler: a button is focusable, reachable by Tab,
 * operable with Enter and Space, and announced as something that does
 * something -- none of which comes free, and all of which SPEC §10 asks for.
 * `aria-haspopup` tells a screen reader what the something is.
 */
function buildSegment(segment: StatusSegment, model: StatusBarModel): HTMLElement {
  const menu = segment.menu;
  const element = document.createElement(menu === undefined ? 'span' : 'button');
  element.className = 'statusbar__segment';
  element.textContent = segment.text;
  if (segment.title !== undefined) element.title = segment.title;
  if (menu === undefined || !(element instanceof HTMLButtonElement)) return element;

  // `type="button"`: a bare <button> defaults to type="submit", which is inert
  // today only because there is no <form> anywhere in the app.
  element.type = 'button';
  element.classList.add('statusbar__segment--menu');
  element.setAttribute('aria-haspopup', 'menu');
  element.addEventListener('click', (event) => {
    // Without this the click carries on to `document`, where the outside-click
    // listener `openPopupMenu` registers a moment later is waiting -- and closes
    // the popup this very click just opened. A listener added mid-dispatch still
    // fires for the event in flight, because the target's own handlers run
    // before the event reaches `document`. `ui/toolbar.ts`'s heading button
    // needs the same line for the same reason.
    event.stopPropagation();
    // Toggle rather than reopen: without this, clicking an open menu's own
    // trigger closes and immediately rebuilds it, so the button can never
    // dismiss what it opened. Same guard the toolbar's heading button uses.
    if (isPopupOpenFor(element)) {
      closePopupMenu();
      return;
    }
    openPopupMenu({ anchor: element, items: segmentItems(menu, model), onChoose: emitCommand });
  });
  return element;
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
