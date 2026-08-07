/**
 * The tab strip (SPEC §6.2). The window is frameless — there is no OS title
 * bar — so this is the only place in the whole app a filename appears.
 *
 * Same convention as the menu bar (ui/menubar.ts): a tab never calls into
 * `switchToDocument`/`closeDocumentWithPrompt` directly. Every action
 * dispatches a `hashpad:command` event and `main.ts` is the one place that
 * routes commands to effects — see that file's header comment for why.
 *
 * `buildTabStrip` is exported separately from `mountTabBar` so the rendering
 * — one tab per document, the dirty dot, the active marker, the close
 * button, which commands a click dispatches — is testable against a plain
 * array of documents, with no store and no DOM subscription involved.
 */
import { displayName } from '../files/fileops';
import { isDirty, type AppState, type Document } from '../state/document';
import { store } from '../state/appcontext';
import { emitCommand } from './menubar';

const TAB_ACTIVATE_PREFIX = 'tab.activate:';
const TAB_CLOSE_PREFIX = 'tab.close:';
const TAB_REORDER_PREFIX = 'tab.reorder:';

/** The command id `main.ts` recognises as "make this document's tab active". */
export function tabActivateCommand(id: string): string {
  return `${TAB_ACTIVATE_PREFIX}${id}`;
}

/** The command id `main.ts` recognises as "close this document's tab". */
export function tabCloseCommand(id: string): string {
  return `${TAB_CLOSE_PREFIX}${id}`;
}

/** The command id `main.ts` recognises as "move this document's tab to `toIndex`". */
export function tabReorderCommand(id: string, toIndex: number): string {
  return `${TAB_REORDER_PREFIX}${id}:${toIndex}`;
}

/**
 * Reverses `tabActivateCommand`/`tabCloseCommand`/`tabReorderCommand`. A
 * document id is a `crypto.randomUUID()` (state/document.ts), which never
 * contains ':', so splitting the activate/close prefixes off the front is
 * unambiguous. The reorder command carries an extra `:<index>` suffix, so it
 * splits on the *last* ':' instead, to read the index back off the end
 * without disturbing that same guarantee. Exported so main.ts's command
 * router has exactly one place that understands this encoding, rather than
 * re-deriving the prefixes itself.
 */
export function parseTabCommand(
  command: string,
):
  | { kind: 'activate' | 'close'; id: string }
  | { kind: 'reorder'; id: string; toIndex: number }
  | null {
  if (command.startsWith(TAB_ACTIVATE_PREFIX)) {
    return { kind: 'activate', id: command.slice(TAB_ACTIVATE_PREFIX.length) };
  }
  if (command.startsWith(TAB_CLOSE_PREFIX)) {
    return { kind: 'close', id: command.slice(TAB_CLOSE_PREFIX.length) };
  }
  if (command.startsWith(TAB_REORDER_PREFIX)) {
    const rest = command.slice(TAB_REORDER_PREFIX.length);
    const sep = rest.lastIndexOf(':');
    if (sep === -1) return null;
    const toIndex = Number(rest.slice(sep + 1));
    if (!Number.isInteger(toIndex)) return null;
    return { kind: 'reorder', id: rest.slice(0, sep), toIndex };
  }
  return null;
}

/**
 * Where a tab dragged from `fromIndex` lands once dropped on the tab at
 * `overIndex`, given which half of that tab the pointer was over on release.
 * `reorderDocument` (state/documents.ts) removes the dragged document from
 * the array before reinserting it, so any target index at or past
 * `fromIndex` has already shifted one place left by the time the insert
 * happens -- miss that and every left-to-right drag lands one tab short of
 * where the user actually dropped it. Dropping a tab on itself is a no-op
 * regardless of which half was hit: there is no removal-then-insert to
 * reason about when the source and target are the same document.
 *
 * Extracted as its own pure function (rather than inlined in the `drop`
 * handler) specifically so this arithmetic -- the one part of this feature
 * that is easy to get subtly wrong -- can be tested directly, without going
 * through DOM drag events at all.
 */
export function dropIndex(fromIndex: number, overIndex: number, afterMidpoint: boolean): number {
  if (overIndex === fromIndex) return fromIndex;
  const shifted = overIndex > fromIndex ? overIndex - 1 : overIndex;
  return afterMidpoint ? shifted + 1 : shifted;
}

// Drag-to-reorder state (SPEC §6.2), module-local rather than read back from
// `dataTransfer` during `dragover` -- that payload is string-only and, across
// browsers, not reliably readable until `drop`, which is too late to drive a
// live insertion-point indicator. There is only ever one tab strip mounted at
// a time, so one set of module-level variables is enough; `dragend` always
// clears both, so a rebuild between drags never inherits stale state.
let draggedId: string | null = null;
let indicatorTab: HTMLElement | null = null;

/** The nearest ancestor-or-self `.tab`, typed as an element rather than the
 * bare `Element` `closest` normally returns -- every caller here immediately
 * needs `classList`/`dataset`, which `Element` alone doesn't have. */
function tabAncestor(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest<HTMLElement>('.tab') : null;
}

/** True once the pointer has crossed `tab`'s horizontal midpoint -- the line
 * between "insert before" and "insert after" this tab. */
function isPastMidpoint(event: DragEvent, tab: HTMLElement): boolean {
  const rect = tab.getBoundingClientRect();
  return event.clientX > rect.left + rect.width / 2;
}

function setIndicator(tab: HTMLElement, after: boolean): void {
  if (indicatorTab && indicatorTab !== tab) clearIndicator();
  indicatorTab = tab;
  tab.classList.toggle('tab--insert-after', after);
  tab.classList.toggle('tab--insert-before', !after);
}

/** Removes the insertion marker, if one is showing. Called from `dragleave`
 * (the pointer moved off the candidate tab) and `dragend` (the drag is over,
 * successful or not) -- without the second call, cancelling a drag over the
 * open desktop (Esc, or releasing outside the window) would leave a stale
 * insertion line on screen with no drag in progress to explain it. */
function clearIndicator(): void {
  if (!indicatorTab) return;
  indicatorTab.classList.remove('tab--insert-after', 'tab--insert-before');
  indicatorTab = null;
}

function buildTab(doc: Document, isActive: boolean): HTMLDivElement {
  const name = displayName(doc);
  const dirty = isDirty(doc);

  // A div rather than a button, despite this being a click target. HTML forbids
  // interactive content inside a <button>, and browsers implement that by
  // flattening the button's subtree in the accessibility tree — which would
  // strip the nested close button's role and let its label bleed into the tab's
  // own accessible name. The cost is re-implementing what a button gives free:
  // tabindex and Enter/Space activation, both below.
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.setAttribute('role', 'tab');
  tab.tabIndex = 0;
  tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  // Identifies this tab to the drop handler in buildTabStrip below, which is
  // delegated at the container rather than attached per-tab.
  tab.dataset.docId = doc.id;
  tab.draggable = true;
  // The dirty dot is aria-hidden decoration, and the visible label is only the
  // basename, so without this the single cue the app's save-safety story rests
  // on would reach assistive tech nowhere at all.
  tab.setAttribute('aria-label', dirty ? `${name}, unsaved changes` : name);
  // SPEC §6.2: the tooltip is the full path. An untitled document has no
  // path to show, so it gets no `title` at all rather than an empty string —
  // some screen readers announce an empty title as "blank", which is worse
  // than announcing nothing.
  if (doc.filePath !== null) tab.title = doc.filePath;

  // The dot and the close button live in the same fixed-size slot and are
  // swapped by CSS opacity on :hover/:focus-within (app.css), never by
  // adding or removing nodes at that point — that is what keeps the swap
  // free of layout shift. The dot itself, though, IS conditionally built
  // here: a clean document has nothing to indicate, and the close button
  // alone still fills the slot as its resting (invisible) state.
  const indicator = document.createElement('span');
  indicator.className = 'tab__indicator';

  if (dirty) {
    const dot = document.createElement('span');
    dot.className = 'tab__dot';
    // Decoration only: the tab's own name is what a screen reader needs, so
    // this must not be announced as a separate, meaningless glyph.
    dot.setAttribute('aria-hidden', 'true');
    indicator.append(dot);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab__close';
  close.setAttribute('aria-label', `Close ${name}`);
  close.textContent = '×';
  close.addEventListener('click', (event) => {
    // Without this, the click bubbles to the tab's own listener below and
    // activates the very tab it was just asked to close.
    event.stopPropagation();
    emitCommand(tabCloseCommand(doc.id));
  });
  indicator.append(close);

  const label = document.createElement('span');
  label.className = 'tab__label';
  label.textContent = name;

  tab.append(indicator, label);

  tab.addEventListener('click', () => emitCommand(tabActivateCommand(doc.id)));

  // Restores what dropping <button> cost us. Space is excluded deliberately —
  // it scrolls by default and a tab strip is not a place users expect that, but
  // Enter alone matches how the menu bar's items already behave. Keydown events
  // originating in the close button are ignored so Enter there does not both
  // close and activate.
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target !== tab) return;
    event.preventDefault();
    emitCommand(tabActivateCommand(doc.id));
  });

  // Middle-click closes (SPEC §6.2). A real middle-click fires 'auxclick' in
  // Chromium (WebView2's engine), not 'click' — but 'mousedown' fires for
  // every button and lets this preventDefault() the OS's middle-click
  // autoscroll cursor before it appears, which auxclick's mouseup timing
  // would not.
  tab.addEventListener('mousedown', (event) => {
    if (event.button === 1) {
      event.preventDefault();
      emitCommand(tabCloseCommand(doc.id));
    }
  });

  // Drag-to-reorder (SPEC §6.2). `dragover`/`dragleave`/`drop` are handled
  // once, delegated on the strip's container in buildTabStrip -- only
  // `dragstart`/`dragend` need to live here, since only the tab being
  // dragged ever receives them.
  tab.addEventListener('dragstart', (event) => {
    draggedId = doc.id;
    // Firefox and WebKitGTK (the eventual Linux port's engine) refuse to
    // start a drag at all unless dataTransfer carries something. The value
    // itself is never read back -- draggedId above exists precisely because
    // dataTransfer's string payload isn't reliably readable during dragover.
    event.dataTransfer?.setData('text/plain', doc.id);
    tab.classList.add('tab--dragging');
  });

  tab.addEventListener('dragend', () => {
    draggedId = null;
    tab.classList.remove('tab--dragging');
    clearIndicator();
  });

  return tab;
}

/**
 * Pure rendering: one tab per document, in order, plus the trailing "+".
 * Takes plain arrays rather than reading the store directly so this (and
 * its test suite) never needs a mounted store.
 */
export function buildTabStrip(documents: Document[], activeId: string | null): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'tabbar';

  const tabs = document.createElement('div');
  tabs.className = 'tabbar__tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Open documents');

  for (const doc of documents) {
    tabs.append(buildTab(doc, doc.id === activeId));
  }

  // Delegated rather than attached per-tab: there is exactly one strip, so
  // one listener per event covers every tab, present or future, without
  // being rebuilt each time buildTab runs. `documents` (this call's own
  // array) is what turns the dragged/target ids into the indices dropIndex
  // needs -- a tab only ever knows its own id, not its neighbours' positions.
  tabs.addEventListener('dragover', (event) => {
    if (draggedId === null) return;
    const target = tabAncestor(event.target);
    if (!target) return;
    // Without this, the browser never fires 'drop' at all.
    event.preventDefault();

    if (target.dataset.docId === draggedId) {
      clearIndicator();
      return;
    }
    setIndicator(target, isPastMidpoint(event, target));
  });

  tabs.addEventListener('dragleave', (event) => {
    const target = tabAncestor(event.target);
    if (!target || target !== indicatorTab) return;
    // relatedTarget is where the pointer went. Moving from the tab onto one
    // of its own children (the label, the close button) also fires
    // dragleave on the tab; without this check the indicator would flicker
    // off and back on as the pointer crosses those children, instead of
    // staying steady until the pointer genuinely leaves the tab.
    const related = event.relatedTarget;
    if (related instanceof Node && target.contains(related)) return;
    clearIndicator();
  });

  tabs.addEventListener('drop', (event) => {
    event.preventDefault();
    const target = tabAncestor(event.target);
    const dragged = draggedId;
    clearIndicator();
    if (dragged === null || !target) return;

    const fromIndex = documents.findIndex((d) => d.id === dragged);
    const overIndex = documents.findIndex((d) => d.id === target.dataset.docId);
    if (fromIndex === -1 || overIndex === -1) return;

    const toIndex = dropIndex(fromIndex, overIndex, isPastMidpoint(event, target));
    emitCommand(tabReorderCommand(dragged, toIndex));
  });

  const newTab = document.createElement('button');
  newTab.type = 'button';
  newTab.className = 'tabbar__new';
  newTab.setAttribute('aria-label', 'New tab');
  newTab.textContent = '+';
  // Reuses the existing file.new command (already wired in main.ts) rather
  // than inventing a separate "new tab" one — a fresh untitled tab is
  // exactly what File > New / Ctrl+N already produce.
  newTab.addEventListener('click', () => emitCommand('file.new'));

  bar.append(tabs, newTab);
  return bar;
}

/**
 * The fields that determine what the strip looks like, reduced to
 * primitives. store.ts's `isEqual` compares one level of an object's own
 * keys and falls back to reference equality for anything nested — so a
 * selector that returned, say, an array of per-document summary objects
 * would never be seen as "unchanged", since a freshly mapped array holds
 * freshly built objects every call. Joining everything into one string
 * keeps every key here a primitive, which is what lets `isEqual` actually
 * skip a re-render when nothing tab-strip-relevant changed (e.g. isDark,
 * closedPaths, or a background document's scroll snapshot).
 */
function tabStripSummary(state: AppState): { activeId: string | null; tabs: string } {
  const tabs = state.documents
    .map((doc) => `${doc.id}:${displayName(doc)}:${isDirty(doc) ? '1' : '0'}`)
    .join('|');
  return { activeId: state.activeDocumentId, tabs };
}

/**
 * Subscribes to the store and mounts the strip, rebuilding it whole on every
 * change `tabStripSummary` detects. Diffing individual tabs would be more
 * code for no visible benefit at the tab counts this app expects.
 */
export function mountTabBar(parent: HTMLElement): void {
  let current = buildTabStrip(store.getState().documents, store.getState().activeDocumentId);
  parent.append(current);

  store.subscribe(tabStripSummary, () => {
    const state = store.getState();
    const next = buildTabStrip(state.documents, state.activeDocumentId);
    current.replaceWith(next);
    current = next;
  });
}
