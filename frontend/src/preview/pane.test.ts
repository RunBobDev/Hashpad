// @vitest-environment jsdom
/**
 * The pane is driven the way the app drives it: a real `EditorView` built from
 * `buildExtensions`, a real store holding the document that view is showing,
 * and real keystrokes dispatched into the view. That indirection is the point.
 * `editor/extensions.ts`'s `syncActiveDocument` is what carries an edit from
 * the view into the store, and the pane subscribes to the store -- a test that
 * poked the store directly would pass even if nothing were wired to the editor
 * at all, which is exactly the failure this suite has to be able to see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from '../editor/extensions';
import { store } from '../state/appcontext';
import { createUntitledDocument, type Document } from '../state/document';
import { activateDocument } from '../state/documents';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { mountPreview, type PreviewHandle } from './pane';

/**
 * Everything a test mounts, torn down in `afterEach` rather than at the end of
 * each test body. A failing assertion aborts the test before its own
 * `destroy()` line, and a handle that outlives its test keeps its store
 * subscription -- the store being module state shared by the whole file. One
 * real failure would then arrive wearing three unrelated ones. Destroying
 * twice is deliberately harmless.
 *
 * The views matter as much as the handles: `mount()` replaces `document.body`
 * wholesale, so a view that is not destroyed is merely orphaned, and it keeps
 * its DOMObserver, its listeners and its measure loop running against nodes
 * that are no longer in the tree.
 */
const handles: PreviewHandle[] = [];
const views: EditorView[] = [];

/**
 * Lets a test make `renderMarkdown` throw without losing real rendering
 * everywhere else in the file -- the error path has to be provoked, and
 * replacing the renderer wholesale would make every other assertion here about
 * a stub instead of about markdown.
 */
const { renderFailure, languageListeners } = vi.hoisted(() => ({
  renderFailure: { message: null as string | null },
  languageListeners: new Set<() => void>(),
}));

vi.mock('./render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render')>();
  return {
    ...actual,
    renderMarkdown: (text: string, ctx: { documentDir: string | null }) => {
      if (renderFailure.message !== null) throw new Error(renderFailure.message);
      return actual.renderMarkdown(text, ctx);
    },
  };
});

/**
 * Only `onLanguageLoaded` is replaced; `highlightCode` stays real, so what
 * render.ts does with a fence is unchanged. A grammar arriving is otherwise
 * only observable by waiting on a real dynamic import to settle, which would
 * make the teardown test depend on chunk-loading timing.
 */
vi.mock('./codehighlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codehighlight')>();
  return {
    ...actual,
    onLanguageLoaded: (callback: () => void) => {
      languageListeners.add(callback);
      return () => languageListeners.delete(callback);
    },
  };
});

vi.mock('../../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  LoadSettings: vi.fn(),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  ShowWindow: vi.fn(),
  SystemThemeIsDark: vi.fn(),
  WriteFile: vi.fn(),
}));

function seedStore(documents: Document[], activeId: string, ratio = 0.5): void {
  store.setState(() => ({
    documents,
    activeDocumentId: activeId,
    isDark: false,
    closedPaths: [],
    activeFormats: '',
    pinnedToolbarCommands: [],
    previewSplitRatio: ratio,
  }));
}

/** A document the pane will render: `viewMode` is 'split' or nothing renders. */
function splitDoc(id: string, text: string, filePath: string | null = null): Document {
  const state = EditorState.create({ doc: text, extensions: buildExtensions(false) });
  return { ...createUntitledDocument(state), id, filePath, viewMode: 'split' };
}

/** The split container with a real editor in it, the shape main.ts builds. */
function mount(text = '# One\n', filePath: string | null = null, ratio = 0.5) {
  document.body.innerHTML = '<div class="editor-split"><div class="editor-area"></div></div>';
  const split = document.querySelector<HTMLElement>('.editor-split')!;
  const doc = splitDoc('a', text, filePath);
  const view = new EditorView({
    state: doc.editorState,
    parent: split.querySelector<HTMLElement>('.editor-area')!,
  });
  views.push(view);
  seedStore([doc], 'a', ratio);
  const handle = mountPreview(split);
  handles.push(handle);
  return { split, view, handle };
}

/** Types `text` at the end, the way a keystroke reaches the pane. */
function type(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

function paneOf(split: HTMLElement): HTMLElement {
  return split.querySelector<HTMLElement>('.preview-pane')!;
}

function dividerOf(split: HTMLElement): HTMLElement {
  return split.querySelector<HTMLElement>('.preview-divider')!;
}

/** jsdom measures every rect as zero, so the drag needs a stated geometry. */
function giveWidth(split: HTMLElement, left: number, right: number): void {
  split.getBoundingClientRect = () =>
    ({ left, right, width: right - left, top: 0, bottom: 0, height: 0 }) as DOMRect;
}

beforeEach(() => {
  renderFailure.message = null;
  languageListeners.clear();
  // A partial app.Settings. The pane only reads and writes `window`, and
  // spelling out the other five blocks would assert nothing -- the double cast
  // is what says "deliberately partial" rather than hiding it behind `any`.
  vi.mocked(LoadSettings).mockResolvedValue({
    window: { previewSplitRatio: 0.5 },
  } as unknown as Awaited<ReturnType<typeof LoadSettings>>);
  vi.mocked(SaveSettings).mockResolvedValue(undefined);
});

afterEach(() => {
  // `splice` first, then tear down: a `destroy()` that throws must not leave
  // the rest of the list queued for the next test's afterEach to trip over.
  const [pending, orphaned] = [handles.splice(0), views.splice(0)];
  for (const handle of pending) handle.destroy();
  for (const view of orphaned) view.destroy();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('mountPreview', () => {
  it('adds nothing to the DOM until shown', () => {
    const { split, handle } = mount();
    expect(split.querySelector('.preview-pane')).toBeNull();
    expect(split.querySelector('.preview-divider')).toBeNull();
    handle.destroy();
  });

  it('inserts the divider and pane after the editor area, in that order', () => {
    const { split, handle } = mount();
    handle.show();
    expect(Array.from(split.children).map((el) => el.className)).toEqual([
      'editor-area',
      'preview-divider',
      'preview-pane',
    ]);
    handle.destroy();
  });

  it('removes both again on hide', () => {
    const { split, handle } = mount();
    handle.show();
    handle.hide();
    expect(Array.from(split.children).map((el) => el.className)).toEqual(['editor-area']);
    handle.destroy();
  });

  it('renders the document when shown', () => {
    const { split, handle } = mount('# Heading\n');
    handle.show();
    expect(paneOf(split).querySelector('h1')?.textContent).toBe('Heading');
    handle.destroy();
  });

  /**
   * The skip is what keeps a background document from paying for a render
   * nobody is looking at, and it is also what `main.ts` relies on to make a
   * toggle cost exactly one render.
   */
  it('renders nothing while the active document is not in split mode', () => {
    const { split, handle } = mount('# Heading\n');
    store.setState((prev) => ({
      ...prev,
      documents: prev.documents.map((doc) => ({ ...doc, viewMode: 'source' as const })),
    }));

    handle.show();

    expect(paneOf(split).innerHTML).toBe('');
    handle.destroy();
  });
});

describe('the divider', () => {
  it('is a keyboard-reachable separator', () => {
    const { split, handle } = mount();
    handle.show();
    const divider = dividerOf(split);
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.tabIndex).toBe(0);
    handle.destroy();
  });

  it('sizes the pane from the stored ratio', () => {
    const { split, handle } = mount('# One\n', null, 0.3);
    handle.show();
    expect(parseFloat(paneOf(split).style.flexBasis)).toBeCloseTo(30);
    expect(dividerOf(split).getAttribute('aria-valuenow')).toBe('30');
    handle.destroy();
  });

  /**
   * Dragging is inherently mouse-only, so without these the split has a
   * capability no keyboard user can reach.
   */
  it('grows the pane by 5% on ArrowLeft and shrinks it on ArrowRight', () => {
    const { split, handle } = mount();
    handle.show();
    const divider = dividerOf(split);

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    expect(store.getState().previewSplitRatio).toBeCloseTo(0.55);
    expect(parseFloat(paneOf(split).style.flexBasis)).toBeCloseTo(55);
    // The whole point of a splitter reporting its position is that it keeps
    // reporting it. Without this the attribute could be set once at show() and
    // frozen for the session with every other assertion here still passing.
    expect(divider.getAttribute('aria-valuenow')).toBe('55');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    expect(store.getState().previewSplitRatio).toBeCloseTo(0.45);

    handle.destroy();
  });

  it('stops at the far edge rather than collapsing either side', () => {
    const { split, handle } = mount();
    handle.show();
    const divider = dividerOf(split);

    for (let i = 0; i < 20; i += 1) {
      divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
    }

    expect(store.getState().previewSplitRatio).toBeCloseTo(0.85);
    handle.destroy();
  });

  it('leaves an unrelated key alone', () => {
    const { split, handle } = mount();
    handle.show();

    dividerOf(split).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }),
    );

    expect(store.getState().previewSplitRatio).toBeCloseTo(0.5);
    handle.destroy();
  });

  it('resizes on drag, measuring the pane from the right edge', () => {
    const { split, handle } = mount();
    handle.show();
    giveWidth(split, 0, 1000);

    dividerOf(split).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));

    expect(store.getState().previewSplitRatio).toBeCloseTo(0.3);
    expect(parseFloat(paneOf(split).style.flexBasis)).toBeCloseTo(30);
    handle.destroy();
  });

  it('stops following the mouse once the button is released', () => {
    const { split, handle } = mount();
    handle.show();
    giveWidth(split, 0, 1000);

    dividerOf(split).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }));

    expect(store.getState().previewSplitRatio).toBeCloseTo(0.3);
    handle.destroy();
  });

  it('persists the ratio once, after the drag goes quiet', async () => {
    vi.useFakeTimers();
    const { split, handle } = mount();
    handle.show();
    giveWidth(split, 0, 1000);

    dividerOf(split).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    for (const x of [700, 690, 680]) {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x }));
    }
    window.dispatchEvent(new MouseEvent('mouseup'));

    await vi.advanceTimersByTimeAsync(299);
    expect(SaveSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(SaveSettings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SaveSettings).mock.calls[0]![0].window.previewSplitRatio).toBeCloseTo(0.32);

    handle.destroy();
  });
});

describe('render triggers', () => {
  /**
   * Asserted through real edits rather than by calling an internal helper:
   * what matters is that three keystrokes produce one render.
   */
  it('renders once for a burst of keystrokes, after the quiet period', () => {
    const { split, view, handle } = mount('# One\n');
    handle.show();
    vi.useFakeTimers();
    const pane = paneOf(split);

    type(view, '\n\n## Two\n');
    type(view, '\n## Three\n');
    type(view, '\n## Four\n');

    // Nothing yet: the pane still shows only the initial render.
    expect(pane.querySelectorAll('h2')).toHaveLength(0);

    vi.advanceTimersByTime(149);
    expect(pane.querySelectorAll('h2')).toHaveLength(0);

    vi.advanceTimersByTime(2);
    expect(pane.querySelectorAll('h2')).toHaveLength(3);
    handle.destroy();
  });

  /**
   * A tab switch is not debounced -- there is no burst to absorb, and 150 ms
   * of the outgoing document still on screen would read as a stutter.
   */
  it('renders the incoming document immediately on a tab switch', () => {
    const { split, handle } = mount('# One\n');
    handle.show();
    vi.useFakeTimers();
    store.setState((prev) => ({
      ...prev,
      documents: [...prev.documents, splitDoc('b', '# Two\n')],
    }));

    store.setState((prev) => activateDocument(prev, 'b'));

    expect(paneOf(split).querySelector('h1')?.textContent).toBe('Two');
    handle.destroy();
  });

  it('re-renders when a language grammar finishes loading', () => {
    const { split, view, handle } = mount('# One\n');
    handle.show();
    type(view, '\n## Two\n');

    for (const listener of languageListeners) listener();

    // Immediate, with no timer advanced: the fence it repaints is already on
    // screen unhighlighted.
    expect(paneOf(split).querySelectorAll('h2')).toHaveLength(1);
    handle.destroy();
  });
});

describe('a renderer that throws', () => {
  it('replaces the content with the message rather than leaving a stale render', () => {
    const { split, view, handle } = mount('# Heading\n');
    handle.show();
    expect(paneOf(split).querySelector('h1')).not.toBeNull();
    vi.useFakeTimers();

    renderFailure.message = 'parser exploded';
    type(view, 'more\n');
    vi.advanceTimersByTime(200);

    const pane = paneOf(split);
    expect(pane.querySelector('.preview-error')?.textContent).toBe('parser exploded');
    expect(pane.querySelector('h1')).toBeNull();
    handle.destroy();
  });
});

describe('local images', () => {
  // The folder rides in the URL rather than being published to Go ahead of the
  // render, which is what makes this assertion worth making here: it is the
  // whole chain -- the active document's `filePath`, through `documentDirOf`,
  // into the `dir=` the handler will resolve against -- in one string.
  it('resolves them against the active document’s folder', () => {
    const { split, handle } = mount('![a](pic.png)\n', 'C:\\notes\\post.md');
    handle.show();

    expect(paneOf(split).querySelector('img')?.getAttribute('src')).toBe(
      '/__hashpad/asset?dir=C%3A%5Cnotes&path=pic.png',
    );
    handle.destroy();
  });

  /**
   * `documentDirOf` answers `''` for a document with no folder; `RenderContext`
   * spells that `null`. Without the mapping every local image in a *saved*
   * document would show this placeholder instead.
   */
  it('shows the placeholder when the document has never been saved', () => {
    const { split, handle } = mount('![a](pic.png)\n', null);
    handle.show();

    const pane = paneOf(split);
    expect(pane.querySelector('img')).toBeNull();
    expect(pane.querySelector('.preview-image-placeholder')?.textContent).toContain(
      'Local image unavailable',
    );
    handle.destroy();
  });
});

describe('destroy', () => {
  it('stops rendering on further edits', () => {
    vi.useFakeTimers();
    const { split, view, handle } = mount('# One\n');
    handle.show();
    const pane = paneOf(split);
    handle.destroy();

    type(view, '\n\n## Two\n');
    vi.advanceTimersByTime(500);

    expect(pane.querySelectorAll('h2')).toHaveLength(0);
  });

  /**
   * Asserted on the subscription rather than on the pixels, and that is the
   * whole point of it. `hide()` nulls the pane and every render path bails on
   * a null pane, so a `destroy()` that skipped this call would leak a live
   * subscription for the rest of the session while looking, from the DOM,
   * exactly like a correct one -- mutation-tested, and the two behavioural
   * teardown tests below both stayed green with the call removed.
   */
  it('releases its store subscription', () => {
    const subscribe = store.subscribe.bind(store);
    const released = vi.fn();
    const spy = vi
      .spyOn(store, 'subscribe')
      .mockImplementation(<T>(selector: (s: never) => T, listener: (value: T) => void) => {
        const stop = subscribe(selector as never, listener);
        return () => {
          released();
          stop();
        };
      });

    const { handle } = mount();
    spy.mockRestore();
    handle.show();
    expect(released).not.toHaveBeenCalled();

    handle.destroy();

    expect(released).toHaveBeenCalledTimes(1);
  });

  /** Same hole, same reasoning: the mocked `onLanguageLoaded` is the witness. */
  it('releases its language-load subscription', () => {
    const { handle } = mount();
    handle.show();
    expect(languageListeners.size).toBe(1);

    handle.destroy();

    expect(languageListeners.size).toBe(0);
  });

  it('stops re-rendering when a grammar arrives afterwards', () => {
    const { split, view, handle } = mount('# One\n');
    handle.show();
    const pane = paneOf(split);
    type(view, '\n## Two\n');
    handle.destroy();

    for (const listener of languageListeners) listener();

    expect(pane.querySelectorAll('h2')).toHaveLength(0);
  });

  /**
   * A pending render is not merely inert -- `hide()` nulls the pane, so the
   * callback would find nothing to do -- it is a timer nobody will ever clear.
   * The count is the only place that difference is visible.
   */
  it('leaves no pending render timer', () => {
    const { split, view, handle } = mount('# One\n');
    handle.show();
    vi.useFakeTimers();
    const before = vi.getTimerCount();

    type(view, '\n## Two\n');
    expect(vi.getTimerCount()).toBe(before + 1);

    handle.destroy();
    expect(vi.getTimerCount()).toBe(before);
    expect(split.querySelector('.preview-pane')).toBeNull();
  });

  /**
   * The handle stays subscribed across a `hide()`, so without the null-pane
   * guard in `scheduleRender` every keystroke in a hidden preview would arm a
   * 150 ms timer whose only job is to call `render()` and have it bail on the
   * same null pane. Invisible through the DOM -- the timer count is the only
   * place it shows.
   */
  it('arms no render timer for edits made while hidden', () => {
    const { view, handle } = mount('# One\n');
    handle.show();
    handle.hide();
    vi.useFakeTimers();
    const before = vi.getTimerCount();

    type(view, '\n## Two\n');

    expect(vi.getTimerCount()).toBe(before);
  });

  /**
   * An immediate render (a tab switch, a grammar arriving) must also cancel
   * whatever the debounce had queued. Without this a keystroke followed by a
   * tab switch renders the incoming document twice: once now, once when the
   * outgoing document's timer fires.
   */
  it('cancels a queued render when one happens immediately', () => {
    const { view, handle } = mount('# One\n');
    handle.show();
    vi.useFakeTimers();
    const before = vi.getTimerCount();

    type(view, '\n## Two\n');
    expect(vi.getTimerCount()).toBe(before + 1);

    // A grammar arriving is the cheapest immediate-render trigger to reach.
    for (const listener of languageListeners) listener();

    expect(vi.getTimerCount()).toBe(before);
  });

  /**
   * Removing the focused element drops focus to `<body>`, so the next Tab
   * restarts from the top of the window instead of from where the user was.
   */
  it('returns focus to the editor when the focused divider is removed', () => {
    const { split, handle } = mount('# One\n');
    handle.show();
    const divider = dividerOf(split);
    divider.focus();
    expect(document.activeElement).toBe(divider);

    handle.hide();

    expect(document.activeElement).toBe(split.querySelector('.cm-content'));
  });

  it('drops a pending ratio write rather than leaving the timer armed', async () => {
    const { split, handle } = mount();
    handle.show();
    giveWidth(split, 0, 1000);
    vi.useFakeTimers();

    dividerOf(split).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    const armed = vi.getTimerCount();
    handle.destroy();

    expect(vi.getTimerCount()).toBe(armed - 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(SaveSettings).not.toHaveBeenCalled();
  });

  it('releases a drag that was still in progress', () => {
    const { split, handle } = mount();
    handle.show();
    giveWidth(split, 0, 1000);

    dividerOf(split).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    handle.destroy();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }));

    expect(store.getState().previewSplitRatio).toBeCloseTo(0.5);
  });
});
