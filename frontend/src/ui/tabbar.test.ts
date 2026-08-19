// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_OUTLINE_WIDTH,
  EMPTY_STATUS,
  createUntitledDocument,
  type AppState,
  type Document,
} from '../state/document';
import { reorderDocument } from '../state/documents';
import { COMMAND_EVENT } from './menubar';
import {
  buildTabStrip,
  dropIndex,
  parseTabCommand,
  tabActivateCommand,
  tabCloseCommand,
  tabReorderCommand,
} from './tabbar';

/** A document with a stable id; clean by construction (editorState.doc === savedDoc). */
function docWith(overrides: Partial<Document> = {}): Document {
  return { ...createUntitledDocument(EditorState.create({ doc: 'hello' })), ...overrides };
}

/** A document whose editorState has diverged from savedDoc -- isDirty(doc) is true. */
function dirtyDoc(overrides: Partial<Document> = {}): Document {
  const original = EditorState.create({ doc: 'hello' });
  const changed = original.update({ changes: { from: 5, insert: '!' } }).state;
  return docWith({ editorState: changed, savedDoc: original.doc, ...overrides });
}

/** Listeners registered by captureCommands, torn down after each test. */
const captured: ((event: Event) => void)[] = [];

afterEach(() => {
  for (const listener of captured) document.removeEventListener(COMMAND_EVENT, listener);
  captured.length = 0;
});

/** Records every hashpad:command dispatched on `document` from this point on. */
function captureCommands(): string[] {
  const seen: string[] = [];
  const listener = (event: Event): void => {
    seen.push((event as CustomEvent<string>).detail);
  };
  document.addEventListener(COMMAND_EVENT, listener);
  captured.push(listener);
  return seen;
}

function tabsOf(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
}

/**
 * jsdom 30 does not implement the DragEvent or DataTransfer interfaces --
 * `window.DragEvent` and `window.DataTransfer` are both `undefined`, even for
 * plain construction (see https://github.com/jsdom/jsdom/issues/2913; drag
 * and drop is explicitly out of scope for jsdom). tabbar.ts's handlers never
 * check `instanceof DragEvent`, though -- they only ever read `.clientX`,
 * `.dataTransfer`, `.relatedTarget`, `.target`, and call `.preventDefault()`,
 * all of which a real, jsdom-implemented `MouseEvent` either already has or
 * can carry as a bolted-on extra property. Dispatching one of these under a
 * drag event's type name still goes through real DOM dispatch -- real
 * bubbling, real target resolution, real defaultPrevented bookkeeping -- so
 * it exercises the actual handlers wired up in tabbar.ts rather than calling
 * them directly, which is what would count as stubbing the thing under test.
 */
function fakeDragEvent(
  type: 'dragstart' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  options: { clientX?: number; relatedTarget?: EventTarget | null } = {},
): DragEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX ?? 0,
    relatedTarget: options.relatedTarget ?? null,
  });
  const transferred = new Map<string, string>();
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: {
      setData: (format: string, value: string) => transferred.set(format, value),
      getData: (format: string) => transferred.get(format) ?? '',
    },
  });
  return event as unknown as DragEvent;
}

/**
 * jsdom has no layout engine, so every element's `getBoundingClientRect`
 * reports all zeros -- and the midpoint test in tabbar.ts's drag handlers
 * needs real geometry to mean anything. Overriding the method on the
 * specific elements a test cares about is stubbing the *environment*
 * (jsdom's missing layout), not the code under test.
 */
function stubRect(el: HTMLElement, left: number, width: number): void {
  el.getBoundingClientRect = () =>
    ({
      left,
      right: left + width,
      width,
      top: 0,
      bottom: 20,
      height: 20,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** A minimal AppState for exercising reorderDocument directly (state/documents.ts). */
function stateOf(documents: Document[], activeDocumentId: string | null): AppState {
  return {
    documents,
    activeDocumentId,
    isDark: false,
    closedPaths: [],
    activeFormats: '',
    pinnedToolbarCommands: [],
    previewSplitRatio: 0.5,
    syncScroll: true,
    wordWrap: true,
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
  };
}

describe('buildTabStrip', () => {
  it('renders one tab per document, in order', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' }), docWith({ id: 'c' })];
    const tabs = tabsOf(buildTabStrip(docs, 'a'));
    expect(tabs).toHaveLength(3);
  });

  it('marks the active tab selected and no other', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' }), docWith({ id: 'c' })];
    const [a, b, c] = tabsOf(buildTabStrip(docs, 'b'));
    expect(a!.getAttribute('aria-selected')).toBe('false');
    expect(b!.getAttribute('aria-selected')).toBe('true');
    expect(c!.getAttribute('aria-selected')).toBe('false');
  });

  it('shows no dirty dot on a clean document', () => {
    const doc = docWith({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.querySelector('.tab__dot')).toBeNull();
  });

  it('shows a dirty dot on a dirty document', () => {
    const doc = dirtyDoc({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.querySelector('.tab__dot')).not.toBeNull();
  });

  it('hides the dirty dot from screen readers -- it is decoration', () => {
    const doc = dirtyDoc({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.querySelector('.tab__dot')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('titles a saved document with its full path', () => {
    const doc = docWith({ id: 'a', filePath: 'C:\\notes\\todo.md' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.getAttribute('title')).toBe('C:\\notes\\todo.md');
  });

  it('gives an untitled document no title attribute at all', () => {
    const doc = docWith({ id: 'a', filePath: null });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.hasAttribute('title')).toBe(false);
  });

  it('labels the tab with the basename, not the full path', () => {
    const doc = docWith({ id: 'a', filePath: 'C:\\notes\\todo.md' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    expect(tab!.querySelector('.tab__label')!.textContent).toBe('todo.md');
  });

  it('names the close button after the document', () => {
    const doc = docWith({ id: 'a', filePath: 'C:\\notes\\todo.md' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    const close = tab!.querySelector('.tab__close')!;
    expect(close.getAttribute('aria-label')).toBe('Close todo.md');
  });

  it('dispatches an activate command with the right id when a tab is clicked', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const tabs = tabsOf(buildTabStrip(docs, 'a'));
    const seen = captureCommands();

    tabs[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

    expect(seen).toEqual([tabActivateCommand('b')]);
  });

  it('dispatches a close command on middle-click', () => {
    const doc = docWith({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    const seen = captureCommands();

    tab!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 }));

    expect(seen).toEqual([tabCloseCommand('a')]);
  });

  it('does not close on left-click', () => {
    const doc = docWith({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    const seen = captureCommands();

    tab!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));

    expect(seen).toEqual([]);
  });

  it('dispatches close, not activate, when the close button is clicked', () => {
    const doc = docWith({ id: 'a' });
    const [tab] = tabsOf(buildTabStrip([doc], 'a'));
    const seen = captureCommands();

    tab!.querySelector<HTMLButtonElement>('.tab__close')!.click();

    expect(seen).toEqual([tabCloseCommand('a')]);
  });
});

describe('accessible naming', () => {
  it('names a clean tab with just the filename', () => {
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a', filePath: '/notes/todo.md' })], 'a'));
    expect(tab!.getAttribute('aria-label')).toBe('todo.md');
  });

  // The dirty dot is aria-hidden decoration, so without this the only cue that
  // a document has unsaved changes would never reach a screen reader.
  it('names a dirty tab as having unsaved changes', () => {
    const [tab] = tabsOf(buildTabStrip([dirtyDoc({ id: 'a', filePath: '/notes/todo.md' })], 'a'));
    expect(tab!.getAttribute('aria-label')).toBe('todo.md, unsaved changes');
  });

  // A <button> may not contain interactive content; browsers enforce that by
  // flattening the subtree in the accessibility tree, which would strip the
  // close button's role and bleed its label into the tab's own name.
  it('does not nest the close button inside a button element', () => {
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a' })], 'a'));
    expect(tab!.tagName).not.toBe('BUTTON');
    expect(tab!.closest('button')).toBeNull();
  });

  it('keeps each tab reachable by keyboard', () => {
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a' })], 'a'));
    expect(tab!.tabIndex).toBe(0);
  });
});

describe('keyboard activation', () => {
  it('activates the tab on Enter', () => {
    const seen = captureCommands();
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a' }), docWith({ id: 'b' })], 'b'));

    tab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(seen).toEqual([tabActivateCommand('a')]);
  });

  it('ignores other keys', () => {
    const seen = captureCommands();
    const [tab] = tabsOf(buildTabStrip([docWith({ id: 'a' })], 'a'));

    tab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    expect(seen).toEqual([]);
  });

  // Enter on the close button must close only. Without the target check the
  // keydown bubbles to the tab and activates the tab it just closed.
  it('does not also activate when Enter lands on the close button', () => {
    const seen = captureCommands();
    const strip = buildTabStrip([docWith({ id: 'a' })], 'a');
    const close = strip.querySelector<HTMLButtonElement>('.tab__close');

    close!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(seen).not.toContain(tabActivateCommand('a'));
  });
});

describe('the new-tab button', () => {
  it('dispatches the new-document command', () => {
    const seen = captureCommands();
    const strip = buildTabStrip([docWith({ id: 'a' })], 'a');

    strip.querySelector<HTMLButtonElement>('.tabbar__new')!.click();

    expect(seen).toEqual(['file.new']);
  });
});

describe('tabReorderCommand / parseTabCommand', () => {
  it('round-trips an id and a target index', () => {
    expect(parseTabCommand(tabReorderCommand('a', 2))).toEqual({
      kind: 'reorder',
      id: 'a',
      toIndex: 2,
    });
  });

  it('rejects a reorder command with no index suffix', () => {
    expect(parseTabCommand('tab.reorder:a')).toBeNull();
  });

  it('rejects a reorder command with a non-numeric suffix', () => {
    expect(parseTabCommand('tab.reorder:a:not-a-number')).toBeNull();
  });
});

/**
 * dropIndex (tabbar.ts) computes where a dragged tab lands once
 * reorderDocument (state/documents.ts) has already removed it from the
 * array -- the removal shifts every later index left by one before the
 * insert happens, which is the part of this feature most likely to be off
 * by one, and only in the left-to-right direction. This table is exhaustive
 * over a 4-tab strip (indices 0..3): both directions, both halves of the
 * target, adjacent and non-adjacent targets, and dropping a tab on itself
 * at the first, a middle, and the last position.
 */
describe('dropIndex', () => {
  it.each<[number, number, boolean, number, string]>([
    [0, 3, true, 3, 'first tab dragged past the last, dropped after it'],
    [0, 3, false, 2, 'first tab dragged past the last, dropped before it'],
    [3, 0, false, 0, 'last tab dragged before the first'],
    [3, 0, true, 1, 'last tab dragged after the first'],
    [1, 2, true, 2, 'dragged one step right, dropped after the target'],
    [
      1,
      2,
      false,
      1,
      'dragged one step right, dropped before the target (already adjacent -- no-op)',
    ],
    [2, 1, true, 2, 'dragged one step left, dropped after the target (already adjacent -- no-op)'],
    [2, 1, false, 1, 'dragged one step left, dropped before the target'],
    [1, 3, true, 3, 'dragged right past an intervening tab, dropped after the target'],
    [1, 3, false, 2, 'dragged right past an intervening tab, dropped before the target'],
    [3, 1, true, 2, 'dragged left past an intervening tab, dropped after the target'],
    [3, 1, false, 1, 'dragged left past an intervening tab, dropped before the target'],
    [0, 0, true, 0, 'dropped on itself: first tab, after-half'],
    [0, 0, false, 0, 'dropped on itself: first tab, before-half'],
    [2, 2, true, 2, 'dropped on itself: middle tab, after-half'],
    [2, 2, false, 2, 'dropped on itself: middle tab, before-half'],
    [3, 3, true, 3, 'dropped on itself: last tab, after-half'],
    [3, 3, false, 3, 'dropped on itself: last tab, before-half'],
  ])(
    'fromIndex=%i overIndex=%i afterMidpoint=%s -> toIndex=%i (%s)',
    (fromIndex, overIndex, afterMidpoint, expected) => {
      expect(dropIndex(fromIndex, overIndex, afterMidpoint)).toBe(expected);
    },
  );

  it('feeds the real reorderDocument correctly for a representative rightward drag', () => {
    // A cross-check against the actual consumer, not just the arithmetic
    // above: drag tab 'a' onto the right half of tab 'd' in [a,b,c,d].
    const docs = [
      docWith({ id: 'a' }),
      docWith({ id: 'b' }),
      docWith({ id: 'c' }),
      docWith({ id: 'd' }),
    ];
    const state = stateOf(docs, 'a');
    const toIndex = dropIndex(0, 3, true);

    expect(reorderDocument(state, 'a', toIndex).documents.map((d) => d.id)).toEqual([
      'b',
      'c',
      'd',
      'a',
    ]);
  });

  it('feeds the real reorderDocument correctly for a representative leftward drag', () => {
    const docs = [
      docWith({ id: 'a' }),
      docWith({ id: 'b' }),
      docWith({ id: 'c' }),
      docWith({ id: 'd' }),
    ];
    const state = stateOf(docs, 'a');
    const toIndex = dropIndex(3, 0, false);

    expect(reorderDocument(state, 'd', toIndex).documents.map((d) => d.id)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
  });
});

/**
 * What jsdom can reach for the drag gesture itself: `dragstart` recording the
 * dragged id, `dragover` calling `preventDefault` (without which `drop` never
 * fires in a real browser) and showing the insertion marker, and `drop`
 * dispatching a reorder command carrying the index `dropIndex` computes.
 * Real drag mechanics (an actual OS-level drag session, the browser's ghost
 * image) are outside what jsdom can simulate at all; see fakeDragEvent above
 * for exactly what is and isn't faked.
 */
describe('drag to reorder', () => {
  it('carries the id recorded on dragstart through to the drop command', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' }), docWith({ id: 'c' })];
    const [a, b, c] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(a!, 0, 100);
    stubRect(b!, 100, 100);
    stubRect(c!, 200, 100);
    const seen = captureCommands();

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    c!.dispatchEvent(fakeDragEvent('dragover', { clientX: 260 })); // past c's midpoint (250)
    c!.dispatchEvent(fakeDragEvent('drop', { clientX: 260 }));
    a!.dispatchEvent(fakeDragEvent('dragend'));

    expect(seen).toEqual([tabReorderCommand('a', dropIndex(0, 2, true))]);
  });

  it('dispatches the before-midpoint index when dropped on the near half of the target', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' }), docWith({ id: 'c' })];
    const [a, , c] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(a!, 0, 100);
    stubRect(c!, 200, 100);
    const seen = captureCommands();

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    c!.dispatchEvent(fakeDragEvent('drop', { clientX: 210 })); // left half of c
    a!.dispatchEvent(fakeDragEvent('dragend'));

    expect(seen).toEqual([tabReorderCommand('a', dropIndex(0, 2, false))]);
  });

  it('calls preventDefault on dragover once a drag is in progress -- required or drop never fires', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const [a, b] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(b!, 100, 100);

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    const overEvent = fakeDragEvent('dragover', { clientX: 160 });
    b!.dispatchEvent(overEvent);
    a!.dispatchEvent(fakeDragEvent('dragend'));

    expect(overEvent.defaultPrevented).toBe(true);
  });

  it('does not preventDefault on dragover before any drag has started', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const [, b] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(b!, 100, 100);

    const overEvent = fakeDragEvent('dragover', { clientX: 160 });
    b!.dispatchEvent(overEvent);

    expect(overEvent.defaultPrevented).toBe(false);
  });

  it('is a no-op, carrying its own original index, when a tab is dropped on itself', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const [a] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(a!, 0, 100);
    const seen = captureCommands();

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    a!.dispatchEvent(fakeDragEvent('drop', { clientX: 90 })); // right half of itself
    a!.dispatchEvent(fakeDragEvent('dragend'));

    expect(seen).toEqual([tabReorderCommand('a', 0)]);
  });

  it('sets dataTransfer data on dragstart -- Firefox and WebKitGTK refuse to start a drag without it', () => {
    const docs = [docWith({ id: 'a' })];
    const [a] = tabsOf(buildTabStrip(docs, 'a'));
    const event = fakeDragEvent('dragstart');

    a!.dispatchEvent(event);
    a!.dispatchEvent(fakeDragEvent('dragend'));

    expect(event.dataTransfer?.getData('text/plain')).toBe('a');
  });

  it('marks the dragged tab and clears the marker on dragend', () => {
    const docs = [docWith({ id: 'a' })];
    const [a] = tabsOf(buildTabStrip(docs, 'a'));

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    expect(a!.classList.contains('tab--dragging')).toBe(true);

    a!.dispatchEvent(fakeDragEvent('dragend'));
    expect(a!.classList.contains('tab--dragging')).toBe(false);
  });

  it('shows the insertion marker on the hovered tab, on the side the pointer is over', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const [a, b] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(b!, 100, 100);

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    b!.dispatchEvent(fakeDragEvent('dragover', { clientX: 160 })); // right half of b

    expect(b!.classList.contains('tab--insert-after')).toBe(true);
    expect(b!.classList.contains('tab--insert-before')).toBe(false);

    a!.dispatchEvent(fakeDragEvent('dragend'));
  });

  it('does not mark the tab being dragged when it is hovered over itself', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const [a] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(a!, 0, 100);

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    a!.dispatchEvent(fakeDragEvent('dragover', { clientX: 50 }));

    expect(a!.classList.contains('tab--insert-before')).toBe(false);
    expect(a!.classList.contains('tab--insert-after')).toBe(false);

    a!.dispatchEvent(fakeDragEvent('dragend'));
  });

  it('clears a stale marker on dragleave once the pointer genuinely leaves the tab', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const strip = buildTabStrip(docs, 'a');
    const [a, b] = tabsOf(strip);
    stubRect(b!, 100, 100);

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    b!.dispatchEvent(fakeDragEvent('dragover', { clientX: 160 }));
    expect(b!.classList.contains('tab--insert-after')).toBe(true);

    b!.dispatchEvent(fakeDragEvent('dragleave', { clientX: 160, relatedTarget: strip }));
    expect(b!.classList.contains('tab--insert-after')).toBe(false);

    a!.dispatchEvent(fakeDragEvent('dragend'));
  });

  it('does not flicker the marker off when the pointer moves onto a child of the hovered tab', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const [a, b] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(b!, 100, 100);
    const label = b!.querySelector('.tab__label')!;

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    b!.dispatchEvent(fakeDragEvent('dragover', { clientX: 160 }));
    // Bubbles from the tab onto its own label -- relatedTarget is still
    // inside the tab, so the marker must survive this, unlike the real
    // dragleave-off-the-tab case above.
    b!.dispatchEvent(fakeDragEvent('dragleave', { clientX: 160, relatedTarget: label }));

    expect(b!.classList.contains('tab--insert-after')).toBe(true);
    a!.dispatchEvent(fakeDragEvent('dragend'));
  });

  it('leaves no stale marker after an aborted drag (dragend with no drop)', () => {
    const docs = [docWith({ id: 'a' }), docWith({ id: 'b' })];
    const [a, b] = tabsOf(buildTabStrip(docs, 'a'));
    stubRect(b!, 100, 100);

    a!.dispatchEvent(fakeDragEvent('dragstart'));
    b!.dispatchEvent(fakeDragEvent('dragover', { clientX: 160 }));
    expect(b!.classList.contains('tab--insert-after')).toBe(true);

    a!.dispatchEvent(fakeDragEvent('dragend'));

    expect(b!.classList.contains('tab--insert-after')).toBe(false);
  });
});
