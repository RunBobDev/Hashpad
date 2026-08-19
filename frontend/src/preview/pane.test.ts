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
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from '../editor/extensions';
import { store } from '../state/appcontext';
import { DEFAULT_OUTLINE_WIDTH, EMPTY_STATUS, createUntitledDocument, type Document } from '../state/document';
import { activateDocument } from '../state/documents';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import { confirmOpenLink } from '../ui/confirmdialog';
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

vi.mock('../../wailsjs/runtime/runtime', () => ({ BrowserOpenURL: vi.fn() }));

/**
 * The real prompt calls `showModal`, which jsdom does not implement, so the
 * dialog itself is tested in `ui/confirmdialog.test.ts` and stubbed here. What
 * this file is for is the wiring: that a click is intercepted at all, that the
 * answer is respected, and that the href handed to the browser is the one in
 * the document.
 */
vi.mock('../ui/confirmdialog', () => ({ confirmOpenLink: vi.fn() }));

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

function seedStore(documents: Document[], activeId: string, ratio = 0.5, syncScroll = true): void {
  store.setState(() => ({
    documents,
    activeDocumentId: activeId,
    isDark: false,
    closedPaths: [],
    activeFormats: '',
    pinnedToolbarCommands: [],
    previewSplitRatio: ratio,
    syncScroll,
    wordWrap: true,
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
  }));
}

/** A document the pane will render: `viewMode` is 'split' or nothing renders. */
function splitDoc(id: string, text: string, filePath: string | null = null): Document {
  const state = EditorState.create({ doc: text, extensions: buildExtensions(false) });
  return { ...createUntitledDocument(state), id, filePath, viewMode: 'split' };
}

/** The split container with a real editor in it, the shape main.ts builds. */
function mount(text = '# One\n', filePath: string | null = null, ratio = 0.5, syncScroll = true) {
  document.body.innerHTML = '<div class="editor-split"><div class="editor-area"></div></div>';
  const split = document.querySelector<HTMLElement>('.editor-split')!;
  const doc = splitDoc('a', text, filePath);
  const view = new EditorView({
    state: doc.editorState,
    parent: split.querySelector<HTMLElement>('.editor-area')!,
  });
  views.push(view);
  seedStore([doc], 'a', ratio, syncScroll);
  const handle = mountPreview(split, view);
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

function rectAt(top: number): DOMRect {
  return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
}

/**
 * States where each `data-source-line` element sits, in document order -- jsdom
 * has no layout engine, so every rect it reports is zero and the pane would
 * otherwise measure every anchor at the same place. Call it after a render: the
 * stubs go on the elements that render produced, and the next one replaces them.
 *
 * `tops` are positions in the pane's *content*, and the stub subtracts the
 * pane's scroll position the way a real rect does -- a bounding rect is a screen
 * position, so scrolling the container moves it. A stub that returned a fixed
 * top would make the pane's measurement look wrong when it is right, since the
 * pane subtracts that same scroll back out.
 *
 * The length assertion is what keeps the fixture honest. It fails the moment a
 * document stops producing the elements a case thinks it is describing.
 */
function giveAnchorTops(pane: HTMLElement, tops: number[]): void {
  pane.getBoundingClientRect = () => rectAt(0);
  const elements = [...pane.querySelectorAll<HTMLElement>('[data-source-line]')];
  expect(elements).toHaveLength(tops.length);
  elements.forEach((element, index) => {
    element.getBoundingClientRect = () => rectAt(tops[index]! - pane.scrollTop);
  });
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

/**
 * What jsdom can and cannot say about this. CodeMirror's *height map* works
 * here -- it estimates line heights rather than measuring them -- so
 * `lineBlockAt`/`lineBlockAtHeight` return real numbers and the editor half of
 * the mapping is genuinely exercised. Nothing else about layout is: every rect
 * is zero and `documentTop` is zero at any scroll position, so the pane's
 * anchor tops and the editor's screen geometry are both stated by the helpers
 * above. What that buys is the arithmetic and the wiring; what it cannot show is
 * that the numbers a real browser reports are the ones assumed here. Only a real
 * build can (see docs/testing.md).
 */
describe('scroll sync', () => {
  /**
   * Line 1 renders to *two* elements -- markdown-it stamps the blockquote and
   * the paragraph inside it with the same line -- and line 3 is the second
   * paragraph. Line 2 is blank and has no element of its own.
   */
  const NESTED = '> quoted\n\npara\n';
  /** In document order: the blockquote, its paragraph, the second paragraph. */
  const TOPS = [0, 12, 600];
  /** Where the editor's scroller sits down the window, once the chrome is above it. */
  const SCROLLER_TOP = 100;
  /** An arbitrary position the editor is already at, so "it moved" isn't enough. */
  const PRIOR_SCROLL = 37;

  function blockTopOf(view: EditorView, line: number): number {
    return view.lineBlockAt(view.state.doc.line(line).from).top;
  }

  /**
   * Gives the editor's scroller the geometry a real one has, and takes it away
   * again: `documentTop` is where the document's origin sits on screen, which is
   * the scroller's own screen top less how far it has been scrolled. jsdom
   * reports both as zero, and zero is exactly the arrangement in which mixing
   * scroll coordinates with screen ones happens to give the right answer -- so a
   * test that left them at zero could not tell the two conversions apart.
   *
   * Removed again immediately: CodeMirror's own measure phase runs on an
   * animation frame and must not be handed this fiction.
   */
  function placeScroller(view: EditorView, scrolledBy: number): () => void {
    view.scrollDOM.scrollTop = scrolledBy;
    view.scrollDOM.getBoundingClientRect = () => rectAt(SCROLLER_TOP);
    Object.defineProperty(view, 'documentTop', {
      value: SCROLLER_TOP - scrolledBy,
      configurable: true,
    });
    return () => {
      Reflect.deleteProperty(view.scrollDOM, 'getBoundingClientRect');
      Reflect.deleteProperty(view, 'documentTop');
    };
  }

  function scrollEditorToLine(view: EditorView, line: number): void {
    const restore = placeScroller(view, blockTopOf(view, line));
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    restore();
  }

  function scrollPaneTo(view: EditorView, pane: HTMLElement, top: number): void {
    const restore = placeScroller(view, PRIOR_SCROLL);
    pane.scrollTop = top;
    pane.dispatchEvent(new Event('scroll'));
    restore();
  }

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  function mountSynced(syncScroll = true) {
    const mounted = mount(NESTED, null, 0.5, syncScroll);
    mounted.handle.show();
    giveAnchorTops(paneOf(mounted.split), TOPS);
    return mounted;
  }

  it('scrolls the preview to where the editor’s top line rendered', () => {
    const { split, view } = mountSynced();

    scrollEditorToLine(view, 3);

    expect(paneOf(split).scrollTop).toBe(600);
  });

  /**
   * Two things at once, both of which have exactly one right answer. Line 2 has
   * no element, so its position is interpolated between the anchors at lines 1
   * and 3 -- 300, not the 375 a proportional mapping of 4 source lines onto
   * 600px would give. And the anchor for line 1 is the blockquote at 0, not the
   * paragraph nested inside it at 12: keeping both would put this at 306.
   */
  it('interpolates a line with no element of its own', () => {
    const { split, view } = mountSynced();

    scrollEditorToLine(view, 2);

    expect(paneOf(split).scrollTop).toBeCloseTo(300);
  });

  it('scrolls the editor to the line the preview is showing', () => {
    const { split, view } = mountSynced();

    scrollPaneTo(view, paneOf(split), 300);

    // Halfway down the anchored range is line 2, and the editor lands on it
    // regardless of where it happened to be scrolled to before.
    expect(view.scrollDOM.scrollTop).toBe(blockTopOf(view, 2));
  });

  /**
   * The anchors describe the last render, and typing leaves that up to a
   * debounce behind the view -- so between a deletion and the render that
   * follows it, the anchors name lines the editor's document no longer has.
   * `doc.line` throws for a line that isn't there, and an uncaught throw in a
   * scroll handler takes the sync down with it.
   */
  it('clamps to the document when the anchors outlive the lines they name', () => {
    const { split, view } = mountSynced();
    const pane = paneOf(split);
    vi.useFakeTimers();

    // A real edit that shortens the document, with its render still queued: the
    // pane is still showing -- and still measuring -- the four-line version.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'x' } });
    scrollPaneTo(view, pane, 600);

    // The anchors say "line 3" and the document has one line, so the honest
    // answer is the *end* of what remains, not the top of it. The fractional
    // mapping lands at the bottom of line 1; the earlier whole-line version
    // snapped to `blockTopOf(view, 1)`, i.e. it threw the editor back to the top
    // of the document whenever the preview was scrolled past stale content --
    // a visible jump in the wrong direction.
    //
    // What actually has to hold is that it stays inside the document and does
    // not throw: `doc.line()` raises for anything outside it, and this runs in a
    // scroll handler where a throw takes the sync down with it.
    const lastLine = view.state.doc.lines;
    const bottom = view.lineBlockAt(view.state.doc.line(lastLine).from);
    expect(view.scrollDOM.scrollTop).toBeGreaterThanOrEqual(blockTopOf(view, 1));
    expect(view.scrollDOM.scrollTop).toBeLessThanOrEqual(bottom.top + bottom.height);
    expect(view.scrollDOM.scrollTop).toBe(bottom.top + bottom.height);
  });

  /**
   * A render can produce no anchors at all: markdown-it's `html_block` renderer
   * emits the block verbatim and drops the attribute the source-line rule set on
   * it, so a document of raw HTML has scrollable height and nothing to map
   * against.
   *
   * With no mapping the sync stands aside, in **both** directions. It has to be
   * both: `offsetForLine` and `lineForOffset` each answer 0 for an empty list, so
   * acting on that would send the pane to the top on every editor scroll and the
   * editor to line 1 on every preview scroll -- the two of them fighting over the
   * top of a document neither can map. An earlier version of this test asserted
   * that yanking-to-line-1 behaviour as if it were the requirement; the clamp it
   * was really pinning (`Math.max(estimate, 1)`, which stops `doc.line(0)`
   * throwing inside a scroll handler) is now covered by the mutation table
   * instead, since this path no longer reaches it.
   */
  it('leaves both scrollers alone when the render produced no anchors at all', () => {
    const mounted = mount('<div>plain</div>\n');
    mounted.handle.show();
    const pane = paneOf(mounted.split);
    giveAnchorTops(pane, []);

    // `PRIOR_SCROLL` is where `scrollPaneTo`'s own geometry setup leaves the
    // editor, so finding it still there is what "the handler did not touch it"
    // looks like. Reading a baseline before the call would read 0 and prove
    // nothing about the handler.
    scrollPaneTo(mounted.view, pane, 300);
    expect(mounted.view.scrollDOM.scrollTop).toBe(PRIOR_SCROLL);

    // Line 2, not 3: this fixture is a two-line document, and `blockTopOf`
    // throws for a line it does not have before the handler is even reached.
    scrollEditorToLine(mounted.view, 2);
    expect(pane.scrollTop).toBe(300);
  });

  /**
   * The ways the mapping goes stale *without* a render, and so without anything
   * else clearing the measurement cache. Each one leaves the anchor list
   * describing a layout that no longer exists, and the pane then scrolls to the
   * wrong place until the next keystroke happens to re-render.
   *
   * All three are asserted the same way: measure once, then change the world,
   * then hand over *different* geometry and check the sync uses the new numbers.
   * Re-stubbing alone proves nothing — a stale cache would keep answering 600
   * whatever the DOM now says.
   */
  describe('invalidating the measurement cache', () => {
    /**
     * Measures the anchors, then re-stubs them 100px higher and re-syncs.
     *
     * The `nextFrame()` is not incidental: the first sync leaves the loop guard
     * set until its animation frame runs, so a second sync in the same tick is
     * suppressed as an echo and the pane would hold 600 whether the cache was
     * cleared or not. Without the wait these tests fail against correct code.
     */
    async function expectRemeasured(
      mounted: ReturnType<typeof mountSynced>,
      disturb: () => void,
    ): Promise<void> {
      const pane = paneOf(mounted.split);
      scrollEditorToLine(mounted.view, 3);
      expect(pane.scrollTop).toBe(600);
      await nextFrame();

      disturb();
      giveAnchorTops(pane, [0, 12, 500]);
      scrollEditorToLine(mounted.view, 3);

      expect(pane.scrollTop).toBe(500);
    }

    // Narrowing the pane rewraps its text and rescales its images. A drag never
    // renders: the pane's subscription selects the active `Document` and a ratio
    // write hands back the same object, so the store does not notify.
    it('re-measures after the divider moves', async () => {
      const mounted = mountSynced();
      await expectRemeasured(mounted, () => {
        dividerOf(mounted.split).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }),
        );
      });
    });

    it('re-measures after the window resizes', async () => {
      const mounted = mountSynced();
      await expectRemeasured(mounted, () => {
        window.dispatchEvent(new Event('resize'));
      });
    });

    /**
     * An image reserves no height until it decodes — `rules/images.ts` emits no
     * `width`/`height` — so everything below one shifts when it arrives. That is
     * the headline case for this whole feature, not an edge case: a tall image is
     * the reason the sync is line-anchored rather than proportional.
     *
     * `load` does not bubble from an `<img>`, so the listener is on the capture
     * phase; dispatching a bubbling event here would pass even without it.
     */
    it('re-measures when an image finishes loading', async () => {
      const mounted = mountSynced();
      await expectRemeasured(mounted, () => {
        const image = document.createElement('img');
        paneOf(mounted.split).append(image);
        image.dispatchEvent(new Event('load'));
      });
    });

    /**
     * The fourth way, and the only one where the *editor* is what moved.
     *
     * The anchor list is not purely a description of the preview: `endpoints`
     * reads `view.contentHeight` to work out the last source line that can sit at
     * the top of the editor's viewport, and every measured anchor past that line
     * is then discarded. So an editor reflow invalidates the list, and none of
     * the three above notices one.
     *
     * Word wrap toggling is the reason this test exists -- it switches the editor
     * between one visual line per source line and many, which is the largest
     * `contentHeight` change the app can produce -- but zoom does it too, and so
     * does CodeMirror simply replacing its own estimate for the unrendered tail
     * with real geometry, which needs no user action at all.
     *
     * Asserted through the shared helper rather than through `endpoints`: jsdom
     * reports every scroll dimension as 0, so `endpoints` returns nothing here
     * and only the cache contract is observable. What the helper pins is exactly
     * the fix -- that a changed editor height re-reads the DOM.
     */
    it('re-measures after the editor reflows', async () => {
      const mounted = mountSynced();
      onTestFinished(() => {
        Reflect.deleteProperty(mounted.view, 'contentHeight');
      });

      await expectRemeasured(mounted, () => {
        Object.defineProperty(mounted.view, 'contentHeight', {
          value: mounted.view.contentHeight + 500,
          configurable: true,
        });
      });
    });
  });

  /**
   * The bug the owner reported: "the side in focus is smooth, the other one is
   * really choppy and jumps a lot, and not to the same text".
   *
   * A wheel or a drag fires several scroll events per frame. The first guard was
   * a single boolean that blocked *any* sync until the next animation frame, so
   * it let one event through and dropped the rest -- the follower moved at best
   * once a frame, from whichever source position happened to land after a frame
   * boundary, which is precisely a lurch to the wrong place rather than a track.
   *
   * No `nextFrame()` between these two on purpose: that is the whole point.
   */
  it('follows every scroll in a burst, not just the first of each frame', () => {
    const { split, view } = mountSynced();
    const pane = paneOf(split);

    scrollEditorToLine(view, 3);
    expect(pane.scrollTop).toBe(600);

    scrollEditorToLine(view, 1);
    expect(pane.scrollTop).toBe(0);

    scrollEditorToLine(view, 3);
    expect(pane.scrollTop).toBe(600);
  });

  /** The same, in the other direction -- the symptom was symmetric. */
  it('follows a burst of preview scrolls too', () => {
    const { split, view } = mountSynced();
    const pane = paneOf(split);

    scrollPaneTo(view, pane, 600);
    const atLine3 = view.scrollDOM.scrollTop;

    scrollPaneTo(view, pane, 0);
    expect(view.scrollDOM.scrollTop).not.toBe(atLine3);
  });

  /**
   * The other half of the owner's report: "when I scroll to about a third of the
   * way and then scroll one more pixel, the preview jumps all the way down and
   * won't budge until I scroll back".
   *
   * `lineBlockAtHeight` answers a *block*, so mapping through a whole line
   * number made every scroll position inside one line produce the identical
   * answer -- no movement at all -- and crossing the boundary move the preview by
   * that line's entire rendered height in one step. Both symptoms, one cause.
   *
   * Scrolling by a fraction of a line here must move the preview by the
   * corresponding fraction, not by nothing and not by everything.
   */
  it('moves the preview for a scroll of less than one line', () => {
    const { split, view } = mountSynced();
    const pane = paneOf(split);

    const top = blockTopOf(view, 1);
    const lineHeight = blockTopOf(view, 3) - top;
    expect(lineHeight, 'fixture must span more than one block').toBeGreaterThan(0);

    const restoreA = placeScroller(view, top);
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    restoreA();
    const before = pane.scrollTop;

    // A quarter of the way into the first block -- well short of a line.
    const restoreB = placeScroller(view, top + lineHeight / 4);
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    restoreB();

    expect(pane.scrollTop).toBeGreaterThan(before);
    // And it is a *fraction* of the way, not a jump to the next anchor.
    expect(pane.scrollTop).toBeLessThan(600);
  });

  /**
   * The dead zones at the two ends, which is what "it jumps all the way down and
   * won't budge until I scroll back" actually was.
   *
   * Measured anchors are element *tops*, so the last one is the last block's
   * top, while the editor stops scrolling a screenful before its own last line.
   * Each side therefore had a range at the end where its scroll position kept
   * moving and the mapped value did not. Scroll into one and the follower pins;
   * back out and it releases.
   *
   * This needs a document long enough for the editor to genuinely scroll --
   * `lineBlockAtHeight` clamps to the document, so a three-line fixture reports
   * the same block for every height past its end and would pass vacuously.
   * jsdom estimates 14px a line, so 40 paragraphs is roughly 1100px of content
   * against a 200px viewport.
   */
  it('keeps moving the preview through the tail of a long document', () => {
    const NL = String.fromCharCode(10);
    const paragraphs = Array.from({ length: 40 }, (_, i) => 'para ' + i).join(NL + NL);
    const mounted = mount(paragraphs + NL);
    mounted.handle.show();
    const pane = paneOf(mounted.split);
    const view = mounted.view;

    // One anchor per paragraph, 50px apart in the rendered pane.
    const tops = Array.from({ length: 40 }, (_, i) => i * 50);
    giveAnchorTops(pane, tops);

    const PANE_VIEWPORT = 400;
    Object.defineProperty(pane, 'scrollHeight', { value: 2400, configurable: true });
    Object.defineProperty(pane, 'clientHeight', { value: PANE_VIEWPORT, configurable: true });
    Object.defineProperty(view.scrollDOM, 'clientHeight', { value: 200, configurable: true });

    const editorMax = view.contentHeight - 200;
    expect(editorMax, 'fixture must give the editor room to scroll').toBeGreaterThan(200);

    const scrollEditorTo = (y: number): number => {
      const restore = placeScroller(view, y);
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      restore();
      return pane.scrollTop;
    };

    // Three positions across the last third, where the last measured anchor
    // (1950) is already behind us and the old mapping had nothing left to say.
    const a = scrollEditorTo(editorMax * 0.7);
    const b = scrollEditorTo(editorMax * 0.85);
    const c = scrollEditorTo(editorMax);

    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // And the end of the editor is the end of the pane, not a screenful short.
    expect(c).toBe(2400 - PANE_VIEWPORT);
  });

  /**
   * A height that lands outside the block CodeMirror hands back must still map
   * to a position *inside* that block.
   *
   * This is reachable in the real editor two ways: past the end of the document,
   * and -- the one that matters -- inside an estimated **gap block**. CodeMirror
   * measures only the rendered viewport; beyond it the height map answers with a
   * single block standing in for dozens of lines. `height` then sits outside the
   * block that comes back, the ratio stops being a fraction (measured at 40.9 on
   * a three-line document), and the mapped line is one the document never had.
   * Worse, it moves discontinuously, because the estimate being divided by is
   * replaced with real geometry as the viewport renders. That is the jump.
   *
   * `lineBlockAtHeight` is stubbed because jsdom's height map has no gap blocks
   * to produce naturally -- and a first version of this test scrolled to an
   * absurd height instead, which proved nothing: `offsetForLine` clamps at the
   * last anchor, so a nonsense line and a merely large one give the same answer.
   * That version passed with the clamp removed.
   */
  it('keeps the mapped position inside the block, even for an estimated one', () => {
    const { split, view } = mountSynced();
    const pane = paneOf(split);

    // A block covering line 1 only, ten pixels tall -- the shape of a measured
    // line -- but queried at a height far outside it, the shape of a gap.
    const line1 = view.state.doc.line(1);
    view.lineBlockAtHeight = () =>
      ({ from: line1.from, to: line1.to, top: 0, height: 10, bottom: 10 }) as ReturnType<
        typeof view.lineBlockAtHeight
      >;

    const restore = placeScroller(view, 1000);
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    restore();

    // Clamped, the position is the end of line 1's block, which is early in the
    // pane. Unclamped it is line 101, which `offsetForLine` pins to the last
    // anchor at 600 -- the far end of the document, from a scroll that never
    // left the first line.
    expect(pane.scrollTop).toBeLessThan(600);
  });

  /**
   * Clicking a link used to navigate the webview off the app entirely. The chrome
   * is HTML, so the window became a browser showing someone else's page with no
   * menu bar and no way back -- and it was a network request besides, which SPEC
   * §2.1 says this app does not make.
   *
   * `preventDefault` is asserted separately from what happens next, because it
   * is what has to be true for *every* anchor. Whether the link then opens is a
   * decision; not navigating is not.
   */
  describe('links', () => {
    function clickLink(pane: HTMLElement, href: string): MouseEvent {
      pane.innerHTML = `<p><a href="${href}">go</a></p>`;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      pane.querySelector('a')!.dispatchEvent(event);
      return event;
    }

    it('opens an external link in the OS browser once confirmed', async () => {
      vi.mocked(confirmOpenLink).mockResolvedValue(true);
      const { split, handle } = mount();
      handle.show();

      const event = clickLink(paneOf(split), 'https://example.com/a?b=1');
      await vi.waitFor(() => expect(BrowserOpenURL).toHaveBeenCalled());

      expect(event.defaultPrevented).toBe(true);
      expect(confirmOpenLink).toHaveBeenCalledWith('https://example.com/a?b=1');
      expect(BrowserOpenURL).toHaveBeenCalledWith('https://example.com/a?b=1');
    });

    it('opens nothing when the prompt is declined', async () => {
      vi.mocked(confirmOpenLink).mockResolvedValue(false);
      const { split, handle } = mount();
      handle.show();

      clickLink(paneOf(split), 'https://example.com/');
      await vi.waitFor(() => expect(confirmOpenLink).toHaveBeenCalled());

      expect(BrowserOpenURL).not.toHaveBeenCalled();
    });

    /**
     * A footnote reference is exactly this shape, so preventing the default
     * without handling it would break a shipped feature.
     */
    it('scrolls to an in-document fragment instead of leaving', () => {
      const { split, handle } = mount();
      handle.show();
      const pane = paneOf(split);
      pane.innerHTML = '<p><a href="#fn1">1</a></p><section id="fn1">note</section>';
      const target = pane.querySelector<HTMLElement>('#fn1')!;
      const scrolled = vi.fn();
      target.scrollIntoView = scrolled;

      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      pane.querySelector('a')!.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(scrolled).toHaveBeenCalled();
      expect(confirmOpenLink).not.toHaveBeenCalled();
    });

    // A relative href has nowhere sensible to go, and navigating is the one
    // outcome that must not happen -- so it is swallowed rather than followed.
    it('swallows a link it cannot open, rather than navigating', () => {
      const { split, handle } = mount();
      handle.show();

      const event = clickLink(paneOf(split), 'notes/other.md');

      expect(event.defaultPrevented).toBe(true);
      expect(confirmOpenLink).not.toHaveBeenCalled();
      expect(BrowserOpenURL).not.toHaveBeenCalled();
    });

    it('catches a click on an element inside the link', () => {
      vi.mocked(confirmOpenLink).mockResolvedValue(false);
      const { split, handle } = mount();
      handle.show();
      const pane = paneOf(split);
      pane.innerHTML = '<p><a href="https://example.com/"><em>go</em></a></p>';

      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      pane.querySelector('em')!.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(confirmOpenLink).toHaveBeenCalledWith('https://example.com/');
    });
  });

  it('leaves the preview alone when sync is off', () => {
    const { split, view } = mountSynced(false);

    scrollEditorToLine(view, 3);

    expect(paneOf(split).scrollTop).toBe(0);
  });

  it('leaves the editor alone when sync is off', () => {
    const { split, view } = mountSynced(false);

    scrollPaneTo(view, paneOf(split), 300);

    expect(view.scrollDOM.scrollTop).toBe(PRIOR_SCROLL);
  });

  /**
   * The echo has to be simulated: jsdom stores a `scrollTop` assignment and
   * fires nothing, where a browser dispatches `scroll` asynchronously afterwards.
   * Without the guard that echo maps the editor's position straight back into the
   * pane, which is the oscillation this exists to stop -- and it is visible here
   * because the pane would land at 0 rather than staying where it was put.
   */
  it('ignores the echo of a scroll it caused itself', () => {
    const { split, view } = mountSynced();
    const pane = paneOf(split);

    scrollPaneTo(view, pane, 300);
    view.scrollDOM.dispatchEvent(new Event('scroll'));

    expect(pane.scrollTop).toBe(300);
  });

  it('is listening again on the next frame', async () => {
    const { split, view } = mountSynced();
    const pane = paneOf(split);
    scrollPaneTo(view, pane, 300);

    await nextFrame();
    scrollEditorToLine(view, 3);

    expect(pane.scrollTop).toBe(600);
  });

  /**
   * The guard's flag is closure state that outlives the pane, so a `hide()` that
   * cancelled its frame without also clearing the flag would leave the sync
   * permanently dead from the next `show()` on -- with nothing in the DOM to say
   * so.
   */
  it('survives a hide and show with the guard still set', () => {
    const { split, view, handle } = mountSynced();
    scrollPaneTo(view, paneOf(split), 300);

    handle.hide();
    handle.show();
    giveAnchorTops(paneOf(split), TOPS);
    scrollEditorToLine(view, 3);

    expect(paneOf(split).scrollTop).toBe(600);
  });

  /**
   * Re-measured after every render, not once. A render replaces the pane's
   * contents outright, so an anchor list left over from the previous one
   * describes elements that are no longer in the tree -- it sends the pane to a
   * position that was right a keystroke ago, with nothing to report.
   */
  it('re-measures after a render', async () => {
    const { split, view } = mountSynced();
    const pane = paneOf(split);
    scrollEditorToLine(view, 3);
    expect(pane.scrollTop).toBe(600);

    // A grammar arriving is the cheapest immediate re-render to reach, and the
    // elements it produces are new objects -- the stubbed geometry with them.
    for (const listener of languageListeners) listener();
    giveAnchorTops(pane, [0, 12, 900]);

    // The loop guard is still holding from the scroll above; a real second
    // gesture is always at least a frame later.
    await nextFrame();
    scrollEditorToLine(view, 3);

    expect(pane.scrollTop).toBe(900);
  });

  it('releases the editor’s scroll listener on hide', () => {
    const { view, handle } = mountSynced();
    const removed = vi.spyOn(view.scrollDOM, 'removeEventListener');

    handle.hide();

    expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  /**
   * Asserted on the call rather than on an effect, and deliberately: after
   * `hide()` every handler bails on the null pane anyway, so a listener left
   * behind is a retained closure rather than a wrong number on screen. Same hole
   * and same reasoning as 'releases its store subscription' below.
   */
  it('releases the pane’s scroll listener on hide', () => {
    const { split, handle } = mountSynced();
    const removed = vi.spyOn(paneOf(split), 'removeEventListener');

    handle.hide();

    expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  /**
   * The only spy in this file on something that outlives its test, so it is
   * restored through `onTestFinished` rather than at the end of the body: a
   * failing assertion aborts before that line, and `window.cancelAnimationFrame`
   * left spied takes down every later test that tears an editor down.
   * Mutation-tested -- with the restore inline, breaking this reddened eleven.
   */
  it('cancels the guard’s pending frame on destroy', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    onTestFinished(() => cancel.mockRestore());
    const { split, view, handle } = mountSynced();
    scrollPaneTo(view, paneOf(split), 300);

    handle.destroy();

    expect(cancel).toHaveBeenCalledTimes(1);
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
