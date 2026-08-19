/**
 * The document outline (SPEC §6.9): a collapsible left sidebar listing every
 * heading, indented by level, with a click scrolling the editor to it.
 *
 * Same convention as the tab strip and the status bar -- read `ui/tabbar.ts`'s
 * header first. `outlineHeadings` and `buildOutline` are pure functions of plain
 * arguments; `mountOutline` is the thin wrapper that subscribes and rebuilds.
 *
 * **Headings are scanned from the text, not from the syntax tree**, and that is
 * deliberate. `editor/marks.ts` reaches for `syntaxTree(state)` and is right to
 * -- it asks about the position the caret is in, which is always parsed. This
 * asks about the *whole document*, and CodeMirror's parser is incremental: past
 * a work budget `syntaxTree` returns a tree that simply stops, so a long
 * document would get an outline that silently ends halfway down. A line scan is
 * both complete and cheaper, and it is the reason this module needs no
 * `EditorState` at all -- only its text.
 */
import { EditorView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { headingLevelAt } from '../editor/marks';
import { store } from '../state/appcontext';
import { clampOutlineWidth } from '../state/document';
import { activeDocument } from '../state/documents';

export interface Heading {
  /** 1-based source line, as `EditorState.doc.line` numbers them. */
  line: number;
  /** 1..6. */
  level: number;
  /** The heading's text with its markers stripped; never empty. */
  text: string;
}

/** ``` or ~~~, three or more, up to three spaces of indent. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A setext underline: a run of `=` or `-` alone on its line. */
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
/** Trailing `#`s, which CommonMark treats as a closing marker, not as text. */
const CLOSING_HASHES = /\s+#+\s*$/;

/**
 * A heading's own text, with the ATX marker already removed by the caller.
 *
 * Falls back to the marker itself for an empty heading (`###` alone is valid
 * CommonMark). A blank row in the sidebar would be unclickable and look like a
 * rendering fault, so it shows what is actually on the line.
 */
function headingText(body: string, level: number): string {
  const text = body.replace(CLOSING_HASHES, '').trim();
  return text === '' ? '#'.repeat(level) : text;
}

/**
 * Every heading in the document, in source order.
 *
 * Three things are deliberately skipped, and each one is a heading that is not
 * a heading:
 *
 * - **Fenced code.** A shell script full of `# comments` would otherwise fill
 *   the sidebar. Tracked by matching fence openers and closers rather than by
 *   asking the parser, for the reason in this module's header.
 * - **Front matter.** `---` on line 1 opens a YAML block whose `title:` lines
 *   are metadata, and `preview/rules/frontmatter.ts` already treats it as such.
 * - **A setext underline with nothing above it.** `---` after a blank line is a
 *   thematic break, and after a fence it is code.
 *
 * Setext headings are included because they are headings and documents written
 * elsewhere use them, even though this app's own `toggleHeading` only ever
 * produces ATX. The rule is tight on purpose: the line above must be ordinary
 * paragraph text. That is CommonMark's own reading for the cases that matter,
 * and it keeps `---` under a blank line, under a fence and under another
 * heading out of the list.
 */
export function outlineHeadings(doc: Text): Heading[] {
  const headings: Heading[] = [];
  let fence: string | null = null;
  let inFrontMatter = false;
  /** The previous line's text when it was ordinary paragraph text, else null. */
  let paragraphAbove: { line: number; text: string } | null = null;
  let lineNumber = 0;

  for (const raw of doc.iterLines()) {
    lineNumber++;
    const line = raw;

    // Front matter first: inside it, nothing else applies.
    if (lineNumber === 1 && line.trim() === '---') {
      inFrontMatter = true;
      paragraphAbove = null;
      continue;
    }
    if (inFrontMatter) {
      if (line.trim() === '---') inFrontMatter = false;
      paragraphAbove = null;
      continue;
    }

    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      // Only a fence of the same character closes one, so ``` inside a ~~~
      // block stays content.
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!)) fence = null;
      paragraphAbove = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      paragraphAbove = null;
      continue;
    }

    const level = headingLevelAt(line);
    if (level !== null) {
      headings.push({
        line: lineNumber,
        level,
        text: headingText(line.trim().slice(level), level),
      });
      paragraphAbove = null;
      continue;
    }

    if (paragraphAbove !== null) {
      const setext = SETEXT.exec(line);
      if (setext) {
        headings.push({
          line: paragraphAbove.line,
          level: setext[1]!.startsWith('=') ? 1 : 2,
          text: paragraphAbove.text,
        });
        paragraphAbove = null;
        continue;
      }
    }

    const trimmed = line.trim();
    paragraphAbove = trimmed === '' ? null : { line: lineNumber, text: trimmed };
  }

  return headings;
}

/** A drag emits a mousemove per pixel; without this each one writes the file. */
const SAVE_DEBOUNCE_MS = 300;

/** How far Left/Right move the resizer per press. */
const KEYBOARD_STEP = 16;

/** The list, as a pure function so what the sidebar shows is testable alone. */
export function buildOutline(
  headings: readonly Heading[],
  onChoose: (line: number) => void,
): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'outline';
  nav.setAttribute('aria-label', 'Document outline');

  if (headings.length === 0) {
    // An empty sidebar reads as broken. Say why it is empty instead.
    const empty = document.createElement('p');
    empty.className = 'outline__empty';
    empty.textContent = 'No headings';
    nav.append(empty);
    return nav;
  }

  /**
   * Indented with `padding-left` from the level rather than nested lists.
   * Markdown headings are a flat sequence that need not nest properly -- an
   * `h4` can follow an `h1` with nothing between -- so a tree would mean
   * inventing parents the document does not have, and a screen reader would
   * then announce a structure that is not in the source.
   */
  const list = document.createElement('ul');
  list.className = 'outline__list';
  for (const heading of headings) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline__item';
    button.dataset.line = String(heading.line);
    button.style.paddingLeft = `${(heading.level - 1) * 12 + 8}px`;
    button.textContent = heading.text;
    // Indentation is the only visible cue for the level, and indentation is not
    // announced -- so the level goes in the accessible name instead.
    button.setAttribute('aria-label', `Heading level ${heading.level}: ${heading.text}`);
    button.addEventListener('click', () => onChoose(heading.line));
    item.append(button);
    list.append(item);
  }
  nav.append(list);
  return nav;
}

export interface OutlineHandle {
  destroy(): void;
}

/**
 * Mounts the sidebar into `parent` and keeps it in step with the document.
 *
 * Takes the `EditorView` as a plain argument rather than reaching for
 * `getEditorView()`, the same as `preview/pane.ts` and for the same reason:
 * that helper throws when no view is set, and this module stays testable
 * without the ambient state.
 */
export function mountOutline(parent: HTMLElement, view: EditorView): OutlineHandle {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let endDrag: (() => void) | null = null;
  /**
   * The rendered list, flattened. The headings are recomputed from scratch on
   * every edit, so the array is always a fresh one and comparing it by
   * reference would rebuild the DOM on every keystroke -- while typing inside a
   * paragraph, which is most typing, changes nothing about the list.
   */
  let signature = '';

  const column = document.createElement('div');
  column.className = 'outline-column';

  const resizer = document.createElement('div');
  resizer.className = 'outline-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', 'Outline width');
  resizer.tabIndex = 0;

  function headingsNow(): Heading[] {
    const doc = activeDocument(store.getState());
    return doc === null ? [] : outlineHeadings(doc.editorState.doc);
  }

  function signatureOf(headings: readonly Heading[]): string {
    return headings.map((h) => `${h.line}:${h.level}:${h.text}`).join(' ');
  }

  /**
   * Scrolls the heading to the top of the viewport and puts the caret on it.
   *
   * Both, not just the scroll: an outline you can click but that leaves the
   * caret where it was means the next keystroke jumps you straight back.
   * `y: 'start'` rather than the default `'nearest'`, because a heading already
   * just barely on screen should still travel to the top -- that is what "go to
   * this section" means.
   */
  function goTo(line: number): void {
    const doc = view.state.doc;
    // The list describes the last render and an edit can outrun it, so a line
    // the document no longer has is reachable. `doc.line` throws for one.

    if (line < 1 || line > doc.lines) return;
    const pos = doc.line(line).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    });
    view.focus();
  }

  function render(): HTMLElement {
    const headings = headingsNow();
    signature = signatureOf(headings);
    return buildOutline(headings, goTo);
  }

  let nav = render();
  column.append(nav, resizer);

  function refresh(): void {
    const headings = headingsNow();
    const next = signatureOf(headings);
    if (next === signature) return;
    const rebuilt = buildOutline(headings, goTo);
    nav.replaceWith(rebuilt);
    nav = rebuilt;
    signature = next;
  }

  function applyWidth(width: number): void {
    column.style.flexBasis = `${width}px`;
    resizer.setAttribute('aria-valuenow', String(Math.round(width)));
  }

  function setWidth(next: number): void {
    const width = clampOutlineWidth(next);
    if (width === store.getState().outlineWidth) return;

    store.setState((prev) => ({ ...prev, outlineWidth: width }));
    applyWidth(width);

    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist(width);
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Read-modify-write against the whole settings file, the same shape and the
   * same error handling `preview/pane.ts`'s ratio uses -- the resize the user
   * just did already happened, and a failed disk write must not undo it.
   */
  async function persist(width: number): Promise<void> {
    try {
      const settings = await LoadSettings();
      settings.window.outlineWidth = width;
      await SaveSettings(settings);
    } catch (error) {
      console.error('hashpad: failed to persist the outline width', error);
    }
  }

  function beginDrag(event: MouseEvent): void {
    // Without this the drag selects text across the sidebar and the editor.
    event.preventDefault();
    endDrag?.();

    const onMove = (moveEvent: MouseEvent): void => {
      // Measured from the column's own left edge, so the width follows the
      // pointer exactly however far down the window the row sits.
      setWidth(moveEvent.clientX - column.getBoundingClientRect().left);
    };
    const onUp = (): void => endDrag?.();

    endDrag = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      endDrag = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /** Dragging is mouse-only, so without this the width is unreachable by keyboard. */
  function onResizerKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -KEYBOARD_STEP : KEYBOARD_STEP;
    setWidth(store.getState().outlineWidth + step);
  }

  resizer.addEventListener('mousedown', beginDrag);
  resizer.addEventListener('keydown', onResizerKey);

  applyWidth(store.getState().outlineWidth);
  // First child of the workspace row: SPEC §6.9 says left sidebar, and the row
  // has no `order`, so DOM position is what puts it there.
  parent.prepend(column);

  // One subscription, two triggers, exactly as `preview/pane.ts` does it: the
  // selector returns the active `Document`, so an edit (which replaces
  // `editorState`) and a tab switch (a different object) both notify, while an
  // unrelated `setState` hands back the same object and does not.
  const unsubscribe = store.subscribe((state) => activeDocument(state), refresh);

  return {
    destroy(): void {
      unsubscribe();
      endDrag?.();
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      // Focus would otherwise fall to `<body>`, and the next Tab would restart
      // from the top of the window rather than from where the user was.
      if (document.activeElement !== null && column.contains(document.activeElement)) {
        view.focus();
      }
      column.remove();
    },
  };
}
