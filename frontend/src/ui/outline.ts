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

/**
 * Half a pixel, added before asking which block the viewport top is in.
 *
 * `ViewState.lineBlockAtHeight` matches with
 * `find(l => l.top <= height && l.bottom >= height)`, and adjacent blocks share
 * `bottom === top` -- so a height landing exactly on a boundary matches the
 * block *above*. Scrolling a line to the top of the viewport lands exactly on
 * its boundary every time, which is precisely what clicking an outline item
 * does: the editor jumped to the right heading and the sidebar then highlighted
 * the one before it. Reported by the owner.
 *
 * Ordinary scrolling almost never lands on a boundary, and when it does the
 * off-by-one is invisible because a body line one early is still in the same
 * section. That is why this only ever showed on a click.
 *
 * `preview/pane.ts` hit the same thing and documents it at length; it since
 * retired its own nudge in favour of a fractional mapping, which this does not
 * need -- an integer line is all a section lookup takes. Any value well under
 * one line height works; CodeMirror's own `scrollAnchorAt` uses 8px for the same
 * job, so there is room.
 */
const BOUNDARY_NUDGE = 0.5;

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

/**
 * Which heading the given source line falls under -- the last one at or before
 * it -- or `-1` for a line above the first heading, where the document is in no
 * section at all.
 *
 * A linear scan rather than a binary search. The list is short (a long document
 * runs to tens of headings, not thousands) and this runs on scroll, where the
 * cost that matters is the DOM write the caller then skips, not the compare.
 */
export function activeHeadingIndex(headings: readonly Heading[], line: number): number {
  let active = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i]!.line > line) break;
    active = i;
  }
  return active;
}

/**
 * Marks one item as the section being read, and unmarks the rest.
 *
 * `aria-current="location"` rather than a class alone: that value is exactly
 * what ARIA defines for "the current item within a set", so a screen-reader user
 * is told which section they are in rather than left to infer it from a colour.
 * The stylesheet hangs off the same attribute, so the two cannot disagree.
 */
export function setActiveHeading(nav: HTMLElement, index: number): void {
  nav.querySelectorAll<HTMLElement>('.outline__item').forEach((item, i) => {
    if (i === index) item.setAttribute('aria-current', 'location');
    else item.removeAttribute('aria-current');
  });
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
  /** The rendered list, kept so the scroll handler need not rescan the document. */
  let headings: Heading[] = [];
  /** Index of the highlighted item, or -1 above the first heading. */
  let active = -1;

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

  /**
   * Joins the flattened list. A newline cannot occur inside a heading -- every
   * one of them is a single source line -- so it cannot shift a boundary and
   * make two different lists compare equal.
   *
   * Spelled out rather than inlined because an earlier version of this line was
   * written with a stray NUL as the separator. It worked, and every gate passed,
   * and the file read as binary to `grep`.
   */
  const SEPARATOR = String.fromCharCode(10);

  function signatureOf(headings: readonly Heading[]): string {
    return headings.map((h) => `${h.line}:${h.level}:${h.text}`).join(SEPARATOR);
  }

  /**
   * Scrolls the heading to the top of the viewport and puts the caret on it.
   *
   * Both, not just the scroll: an outline you can click but that leaves the
   * caret where it was means the next keystroke jumps you straight back.
   * `y: 'start'` rather than the default `'nearest'`, because a heading already
   * just barely on screen should still travel to the top -- that is what "go to
   * this section" means.
   *
   * **`yMargin: 0` is load-bearing, not tidiness.** It defaults to 5, and
   * `scrollRectIntoView` computes `targetTop = rect.top - yMargin` for the
   * `'start'` strategy -- so the heading lands five pixels *below* the top of
   * the viewport, which puts the viewport's own top five pixels *above* the
   * heading, inside the previous block. `refreshActive` then reads the section
   * before the one just clicked, and highlights it. Reported by the owner, twice:
   * the jump was always right, because the jump is this dispatch, while the
   * highlight is derived separately from where the viewport ended up. With no
   * margin the two agree exactly, and `BOUNDARY_NUDGE` handles the boundary they
   * then land on.
   */
  function goTo(line: number): void {
    const doc = view.state.doc;
    // The list describes the last render and an edit can outrun it, so a line
    // the document no longer has is reachable. `doc.line` throws for one.

    if (line < 1 || line > doc.lines) return;
    const pos = doc.line(line).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 0 }),
    });
    view.focus();
  }

  /**
   * The source line at the top of the editor's viewport.
   *
   * `lineBlockAtHeight` measures in the document's own coordinate space, whose
   * origin sits at `documentTop` on screen, while the top of what the user can
   * see is the scroller's own screen top -- the difference between those two is
   * the whole conversion. `preview/pane.ts` does the same sum for scroll sync
   * and is *not* shared with: it needs a fractional line and a clamp against
   * CodeMirror's estimated gap blocks, and this needs neither. Two callers of
   * one three-line conversion, with different requirements, is not an
   * abstraction worth the coupling -- especially as that module is lazily
   * loaded and this one must not pull it in.
   *
   * The nudge is the one piece of that reasoning worth borrowing wholesale; see
   * `BOUNDARY_NUDGE`.
   */
  function topSourceLine(): number {
    const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    const block = view.lineBlockAtHeight(height + BOUNDARY_NUDGE);
    return view.state.doc.lineAt(block.from).number;
  }

  /**
   * SPEC §6.9's "current section highlighted as you scroll".
   *
   * Only touches the DOM when the answer changes, which on a scroll through one
   * long section is almost never -- the scan itself is a few compares over a
   * short list, and the write is what would cost something.
   */
  function refreshActive(): void {
    const next = activeHeadingIndex(headings, topSourceLine());
    if (next === active) return;
    active = next;
    setActiveHeading(nav, active);
    // `nearest`, so an item already visible is left where it is. Anything
    // stronger would yank the sidebar on every section boundary while the user
    // is reading, which is worse than not following at all.
    nav.querySelectorAll('.outline__item')[active]?.scrollIntoView({ block: 'nearest' });
  }

  function render(): HTMLElement {
    headings = headingsNow();
    signature = signatureOf(headings);
    return buildOutline(headings, goTo);
  }

  let nav = render();
  column.append(nav, resizer);

  function refresh(): void {
    const scanned = headingsNow();
    const next = signatureOf(scanned);
    // The active *index* can move even when the list does not -- typing above a
    // heading pushes every line down -- so this runs either way.
    if (next !== signature) {
      headings = scanned;
      signature = next;
      const rebuilt = buildOutline(headings, goTo);
      nav.replaceWith(rebuilt);
      nav = rebuilt;
      // A freshly built list carries no marks, so the cached index would make
      // `refreshActive` below decide nothing had changed and skip the write.
      active = -1;
    }
    refreshActive();
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

  // The editor's scroller outlives this sidebar, so unlike the elements above
  // this listener is a real leak if `destroy` forgets it.
  view.scrollDOM.addEventListener('scroll', refreshActive, { passive: true });
  refreshActive();

  return {
    destroy(): void {
      unsubscribe();
      view.scrollDOM.removeEventListener('scroll', refreshActive);
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
