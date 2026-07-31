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
import { COMMAND_EVENT } from './menubar';

const TAB_ACTIVATE_PREFIX = 'tab.activate:';
const TAB_CLOSE_PREFIX = 'tab.close:';

/** The command id `main.ts` recognises as "make this document's tab active". */
export function tabActivateCommand(id: string): string {
  return `${TAB_ACTIVATE_PREFIX}${id}`;
}

/** The command id `main.ts` recognises as "close this document's tab". */
export function tabCloseCommand(id: string): string {
  return `${TAB_CLOSE_PREFIX}${id}`;
}

/**
 * Reverses `tabActivateCommand`/`tabCloseCommand`. A document id is a
 * `crypto.randomUUID()` (state/document.ts), which never contains ':', so
 * splitting on the prefix is unambiguous. Exported so main.ts's command
 * router has exactly one place that understands this encoding, rather than
 * re-deriving the prefixes itself.
 */
export function parseTabCommand(command: string): { kind: 'activate' | 'close'; id: string } | null {
  if (command.startsWith(TAB_ACTIVATE_PREFIX)) {
    return { kind: 'activate', id: command.slice(TAB_ACTIVATE_PREFIX.length) };
  }
  if (command.startsWith(TAB_CLOSE_PREFIX)) {
    return { kind: 'close', id: command.slice(TAB_CLOSE_PREFIX.length) };
  }
  return null;
}

function emit(command: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: command }));
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
    emit(tabCloseCommand(doc.id));
  });
  indicator.append(close);

  const label = document.createElement('span');
  label.className = 'tab__label';
  label.textContent = name;

  tab.append(indicator, label);

  tab.addEventListener('click', () => emit(tabActivateCommand(doc.id)));

  // Restores what dropping <button> cost us. Space is excluded deliberately —
  // it scrolls by default and a tab strip is not a place users expect that, but
  // Enter alone matches how the menu bar's items already behave. Keydown events
  // originating in the close button are ignored so Enter there does not both
  // close and activate.
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target !== tab) return;
    event.preventDefault();
    emit(tabActivateCommand(doc.id));
  });

  // Middle-click closes (SPEC §6.2). A real middle-click fires 'auxclick' in
  // Chromium (WebView2's engine), not 'click' — but 'mousedown' fires for
  // every button and lets this preventDefault() the OS's middle-click
  // autoscroll cursor before it appears, which auxclick's mouseup timing
  // would not.
  tab.addEventListener('mousedown', (event) => {
    if (event.button === 1) {
      event.preventDefault();
      emit(tabCloseCommand(doc.id));
    }
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

  const newTab = document.createElement('button');
  newTab.type = 'button';
  newTab.className = 'tabbar__new';
  newTab.setAttribute('aria-label', 'New tab');
  newTab.textContent = '+';
  // Reuses the existing file.new command (already wired in main.ts) rather
  // than inventing a separate "new tab" one — a fresh untitled tab is
  // exactly what File > New / Ctrl+N already produce.
  newTab.addEventListener('click', () => emit('file.new'));

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
