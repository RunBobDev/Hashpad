// @vitest-environment jsdom
/**
 * The sidebar. Its own file rather than a second describe in
 * `outline.test.ts`, because that one deliberately runs under Vitest's default
 * `node` environment -- the scanner needs no DOM, and putting it on jsdom to
 * keep these company would slow it down for nothing.
 *
 * A real `EditorView` throughout: clicking a heading has to move a real caret
 * and scroll a real view, and a stub would only prove that a function was
 * called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from '../editor/extensions';
import { setTopSourceLineReader, store, topSourceLineChanged } from '../state/appcontext';
import {
  createUntitledDocument,
  DEFAULT_OUTLINE_WIDTH,
  EMPTY_STATUS,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  type Document,
} from '../state/document';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { buildOutline, mountOutline, setActiveHeading, type OutlineHandle } from './outline';

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

const NL = String.fromCharCode(10);
const handles: OutlineHandle[] = [];
const views: EditorView[] = [];

beforeEach(() => {
  vi.mocked(LoadSettings).mockResolvedValue({
    window: { outlineWidth: DEFAULT_OUTLINE_WIDTH },
  } as unknown as Awaited<ReturnType<typeof LoadSettings>>);
  vi.mocked(SaveSettings).mockResolvedValue(undefined as never);
});

/**
 * Torn down here rather than in each test body: a failing assertion aborts
 * before the test's own cleanup line, and a handle that outlives its test keeps
 * its store subscription -- the store being module state the whole file shares.
 */
afterEach(() => {
  while (handles.length > 0) handles.pop()!.destroy();
  while (views.length > 0) views.pop()!.destroy();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function seed(text: string): { workspace: HTMLElement; view: EditorView; doc: Document } {
  const workspace = document.createElement('div');
  const host = document.createElement('div');
  document.body.append(workspace);
  workspace.append(host);

  const view = new EditorView({
    state: EditorState.create({ doc: text, extensions: buildExtensions(false) }),
    parent: host,
  });
  views.push(view);

  const doc = createUntitledDocument(view.state);
  store.setState((prev) => ({
    ...prev,
    documents: [doc],
    activeDocumentId: doc.id,
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
  }));
  return { workspace, view, doc };
}

function mount(text: string): { workspace: HTMLElement; view: EditorView } {
  const seeded = seed(text);
  handles.push(mountOutline(seeded.workspace, seeded.view));
  return seeded;
}

function items(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('.outline__item')];
}

describe('buildOutline', () => {
  it('renders one button per heading, in order', () => {
    const nav = buildOutline(
      [
        { line: 1, level: 1, text: 'One' },
        { line: 5, level: 3, text: 'Three' },
      ],
      () => {},
    );

    expect(items(nav).map((b) => b.textContent)).toEqual(['One', 'Three']);
    expect(items(nav).map((b) => b.dataset.line)).toEqual(['1', '5']);
  });

  /**
   * Indented by `padding-left` from the level rather than by nesting. Markdown
   * headings are a flat sequence that need not nest properly -- an h4 can follow
   * an h1 -- so a tree would mean inventing parents the document does not have.
   */
  it('indents by level without nesting the markup', () => {
    const nav = buildOutline(
      [
        { line: 1, level: 1, text: 'A' },
        { line: 2, level: 3, text: 'B' },
      ],
      () => {},
    );

    const [first, second] = items(nav);
    expect(nav.querySelectorAll('ul')).toHaveLength(1);
    expect(parseInt(second!.style.paddingLeft, 10)).toBeGreaterThan(
      parseInt(first!.style.paddingLeft, 10),
    );
  });

  /**
   * Indentation is the only visible cue for the level and it is not announced,
   * so the level has to be in the accessible name or a screen-reader user gets
   * a flat list of titles with no structure at all.
   */
  it('names the level for a screen reader', () => {
    const nav = buildOutline([{ line: 1, level: 3, text: 'Deep' }], () => {});

    expect(items(nav)[0]!.getAttribute('aria-label')).toBe('Heading level 3: Deep');
    expect(nav.getAttribute('aria-label')).toBe('Document outline');
  });

  it('marks one item and unmarks the rest', () => {
    const nav = buildOutline(
      [
        { line: 1, level: 1, text: 'A' },
        { line: 2, level: 1, text: 'B' },
      ],
      () => {},
    );

    setActiveHeading(nav, 1);
    expect(nav.querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(items(nav)[1]!.getAttribute('aria-current')).toBe('location');

    setActiveHeading(nav, -1);
    expect(nav.querySelectorAll('[aria-current]')).toHaveLength(0);
  });

  /** A blank sidebar reads as broken. Say why it is empty instead. */
  it('says so when there are no headings', () => {
    const nav = buildOutline([], () => {});

    expect(nav.querySelector('.outline__empty')?.textContent).toBe('No headings');
    expect(items(nav)).toHaveLength(0);
  });
});

describe('mountOutline', () => {
  it('mounts as the first child of the row, so the sidebar is on the left', () => {
    const { workspace } = mount('# A');

    expect(workspace.firstElementChild?.className).toBe('outline-column');
  });

  it('lists the active document’s headings', () => {
    const { workspace } = mount(`# One${NL}${NL}## Two`);

    expect(items(workspace).map((b) => b.textContent)).toEqual(['One', 'Two']);
  });

  /**
   * The click marks its own heading, without waiting to be told by a scroll.
   *
   * The highlight used to be derived purely from where the viewport landed,
   * which was exact while the sample point was the top edge. `topSourceLine`
   * now samples one line down, so a heading whose section is a single line --
   * a `###` directly under a `##` -- derives to the *next* heading: click one
   * item, watch another light up, which is G.3b's old defect by a new route.
   *
   * Pinning it on the click is the fix, and it is worth having even at a
   * one-line offset. The earlier attempt used a quarter of the viewport height,
   * where this broke for almost every section rather than only the empty ones.
   */
  it('marks the heading it was told to go to, with no scroll to derive it from', () => {
    const lines = ['# One', 'body', '## Two', '### Three', 'body'];
    const { workspace } = mount(lines.join(NL));

    // 'Three' immediately follows 'Two' -- a section with no body at all, which
    // is the shape that derives wrongly when the answer is not set outright.
    items(workspace)[1]!.click();

    expect(workspace.querySelector('.outline__item[aria-current]')?.textContent).toBe('Two');
  });

  /**
   * The whole point of the sidebar. Both halves matter: the caret moves so the
   * next keystroke lands in the section the user just chose, and the view
   * scrolls so they can see it.
   */
  it('moves the caret to the heading when one is clicked', () => {
    const lines = ['# One', '', 'body', '', '## Two', '', 'more'];
    const { workspace, view } = mount(lines.join(NL));

    items(workspace)[1]!.click();

    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
  });

  /**
   * The reason the highlight was landing one section early, and the half of it
   * jsdom can still see.
   *
   * `yMargin` defaults to **5**, and `scrollRectIntoView` computes
   * `targetTop = rect.top - yMargin` for the `'start'` strategy -- so the heading
   * lands five pixels below the viewport top, putting the viewport's own top
   * five pixels *above* the heading and inside the previous block. The
   * highlight, which is derived from where the viewport ended up rather than
   * from the click, then reads the section before.
   *
   * jsdom cannot scroll, so what is asserted is the request rather than its
   * effect: the effect's `ScrollTarget` carries the margin, and it must be zero.
   * Found by reading `@codemirror/view`'s source after two fixes reasoned from
   * the wrong mechanism -- the manual check in docs/testing.md is what confirms
   * the real thing.
   */
  it('asks for the heading at the very top, with no margin', () => {
    const { workspace, view } = mount(`# One${NL}body${NL}## Two${NL}body`);
    const targets: { y: unknown; yMargin: unknown }[] = [];
    const realDispatch = view.dispatch.bind(view);
    view.dispatch = ((...specs: Parameters<typeof view.dispatch>) => {
      for (const spec of specs) {
        const effects = (spec as { effects?: unknown }).effects;
        for (const effect of Array.isArray(effects) ? effects : [effects]) {
          // Duck-typed: the effect *type* CodeMirror uses for this is module
          // private, so there is no `.is()` to ask. A `ScrollTarget` is the only
          // effect value in this app carrying a `yMargin`.
          const value = (effect as { value?: { y?: unknown; yMargin?: number } } | undefined)
            ?.value;
          if (value !== undefined && typeof value.yMargin === 'number') {
            targets.push({ y: value.y, yMargin: value.yMargin });
          }
        }
      }
      realDispatch(...specs);
    }) as typeof view.dispatch;

    items(workspace)[1]!.click();

    // `'start'` as well as the margin: with `'nearest'` a heading already just
    // barely on screen would not move at all, so the viewport would stay in the
    // previous section and the highlight would never reach the clicked one.
    expect(targets).toEqual([{ y: 'start', yMargin: 0 }]);
  });

  /**
   * The list describes the last render and an edit can outrun it, so a click on
   * a heading whose line no longer exists is reachable -- and `doc.line` throws
   * for a line outside the document, which inside a click handler would take
   * the sidebar down with it.
   */
  it('does nothing when the clicked line is gone', () => {
    const { workspace, view } = mount(`# One${NL}${NL}## Two${NL}${NL}## Three`);
    const button = items(workspace)[2]!;

    // A listener that throws does *not* propagate out of `click()` -- jsdom
    // catches it and reports it as an uncaught error on `window` instead. So
    // `expect(...).not.toThrow()` passes either way; it was the first version of
    // this test and it let the unguarded code through while the suite exited 1
    // on an unhandled error nobody attributed to it. Listening for the report is
    // what actually distinguishes the two.
    const errors: string[] = [];
    const onError = (event: ErrorEvent): void => {
      errors.push(event.message);
    };
    window.addEventListener('error', onError);

    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# One' } });
      button.click();
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(errors).toEqual([]);
    // And the caret stayed put rather than landing somewhere arbitrary.
    expect(view.state.selection.main.head).toBe(0);
  });

  it('follows the document as headings are added', () => {
    const { workspace, view } = mount('# One');

    view.dispatch({ changes: { from: view.state.doc.length, insert: `${NL}${NL}## Two` } });

    expect(items(workspace).map((b) => b.textContent)).toEqual(['One', 'Two']);
  });

  /**
   * Typing inside a paragraph is most typing, and it changes nothing about the
   * list. Rebuilding anyway would throw away the DOM on every keystroke -- and
   * the headings are rescanned from scratch each time, so the array is always a
   * new one and comparing by reference would never match.
   */
  it('leaves the list alone when an edit does not change it', () => {
    const { workspace, view } = mount(`# One${NL}${NL}body`);
    const before = items(workspace)[0]!;

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' more' } });

    expect(items(workspace)[0]).toBe(before);
  });

  it('rebuilds when a heading’s text changes', () => {
    const { workspace, view } = mount('# One');

    view.dispatch({ changes: { from: 2, to: 5, insert: 'Renamed' } });

    expect(items(workspace).map((b) => b.textContent)).toEqual(['Renamed']);
  });

  describe('width', () => {
    it('applies the stored width on mount', () => {
      const { workspace } = mount('# A');

      expect(workspace.querySelector<HTMLElement>('.outline-column')!.style.flexBasis).toBe(
        `${DEFAULT_OUTLINE_WIDTH}px`,
      );
    });

    it('widens and narrows from the keyboard, and reports the width', () => {
      const { workspace } = mount('# A');
      const resizer = workspace.querySelector('.outline-resizer')!;

      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
      const wider = store.getState().outlineWidth;
      expect(wider).toBeGreaterThan(DEFAULT_OUTLINE_WIDTH);
      expect(resizer.getAttribute('aria-valuenow')).toBe(String(Math.round(wider)));

      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }));
      expect(store.getState().outlineWidth).toBe(DEFAULT_OUTLINE_WIDTH);
    });

    /**
     * A sidebar dragged to nothing is a sidebar whose edge the user then has to
     * hunt for, and the resizer would end up under the editor's own left edge.
     */
    it('clamps rather than letting the sidebar vanish', () => {
      const { workspace } = mount('# A');
      const resizer = workspace.querySelector('.outline-resizer')!;

      for (let i = 0; i < 100; i++) {
        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      }
      expect(store.getState().outlineWidth).toBe(MIN_OUTLINE_WIDTH);

      for (let i = 0; i < 100; i++) {
        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      }
      expect(store.getState().outlineWidth).toBe(MAX_OUTLINE_WIDTH);
    });

    it('persists the width, debounced', async () => {
      vi.useFakeTimers();
      const { workspace } = mount('# A');
      const resizer = workspace.querySelector('.outline-resizer')!;

      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      expect(SaveSettings).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
      // Two presses, one write: the debounce is what stops a drag writing the
      // settings file once per pixel.
      expect(SaveSettings).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * SPEC 6.9's "current section highlighted as you scroll". jsdom has no layout,
   * so the editor's real geometry is unavailable -- `lineBlockAtHeight` and
   * `documentTop` are stubbed to state a scroll position, and what is tested is
   * the mapping and the DOM write on top of it. That the numbers a real browser
   * reports are the ones assumed here is a manual check.
   */
  describe('the current section', () => {
    /** Where the editor's scroller sits down the window, once chrome is above it. */
    const SCROLLER_TOP = 100;
    /** Pretend line height, so a height maps back to a line the stub can name. */
    const LINE_HEIGHT = 10;

    /**
     * What CodeMirror's `lineBlockAtHeight` answers, **including at a boundary**.
     *
     * `ViewState.lineBlockAtHeight` matches the viewport with
     * `find(l => l.top <= height && l.bottom >= height)`, and adjacent blocks
     * share `bottom === top` -- so a height landing exactly on a boundary
     * matches the *earlier* block. That is not a detail: scrolling to a line's
     * top lands exactly there every time, which is what an outline click does.
     *
     * The first version of this stub was `Math.round(height / LINE_HEIGHT) + 1`,
     * which silently rounded the boundary the friendly way. Every test passed
     * while the running app marked the section above the one clicked -- reported
     * by the owner. Modelling the real rule is what makes these tests able to
     * see it.
     */
    function blockLineAt(height: number, lines: number): number {
      const raw =
        height > 0 && height % LINE_HEIGHT === 0
          ? height / LINE_HEIGHT
          : Math.floor(height / LINE_HEIGHT) + 1;
      return Math.min(Math.max(raw, 1), lines);
    }

    /**
     * Scrolls the editor so `line` is at the top of its viewport.
     *
     * The geometry is stated rather than stubbed away, and that matters: the
     * conversion under test is `scrollDOM.rect.top - documentTop`, which mixes a
     * screen coordinate with the document's own origin. jsdom reports both as
     * zero, and zero is exactly the arrangement in which reading `scrollTop`
     * instead would give the same answer -- so a test that left them at zero
     * could not tell a correct conversion from a wrong one. It could not: an
     * earlier version stubbed `lineBlockAtHeight` to ignore its argument
     * entirely, and swapping the conversion for `scrollDOM.scrollTop` passed.
     *
     * Same technique, and the same reasoning, as `preview/pane.test.ts`'s
     * `placeScroller`.
     */
    function scrollTopLineTo(view: EditorView, line: number): void {
      const scrolled = (line - 1) * LINE_HEIGHT;
      view.scrollDOM.getBoundingClientRect = () =>
        ({ top: SCROLLER_TOP, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) as DOMRect;
      Object.defineProperty(view, 'documentTop', {
        value: SCROLLER_TOP - scrolled,
        configurable: true,
      });
      // Stubbed alongside the rest of the geometry, or the arithmetic here is
      // incoherent: `topSourceLine` offsets by one line using CodeMirror's own
      // measured `defaultLineHeight`, which under jsdom is its internal estimate
      // and has nothing to do with this file's pretend `LINE_HEIGHT`. With both
      // agreeing, "scroll line N to the top" samples exactly line N+1, which is
      // what the offset means.
      Object.defineProperty(view, 'defaultLineHeight', {
        value: LINE_HEIGHT,
        configurable: true,
      });
      view.lineBlockAtHeight = (height: number) => {
        const target = view.state.doc.line(blockLineAt(height, view.state.doc.lines));
        return { from: target.from, to: target.to, top: 0, height: 10, bottom: 10 } as ReturnType<
          typeof view.lineBlockAtHeight
        >;
      };

      view.scrollDOM.dispatchEvent(new Event('scroll'));
    }

    function currentLabel(root: HTMLElement): string | null {
      return root.querySelector('.outline__item[aria-current]')?.textContent ?? null;
    }

    const DOC = ['# One', 'body', '## Two', 'body', '## Three', 'body'].join(NL);

    /**
     * Reading mode (design §4.27): the editor is covered, so following its
     * scroll position would freeze the highlight while the reader scrolls the
     * preview. `preview/pane.ts` registers a reader and this must prefer it.
     *
     * Driven through the registry rather than through a real pane on purpose --
     * the point being tested is that the outline *asks* it, and mounting a
     * preview here would import the lazy chunk into a test for the entry-bundle
     * module that must never do that.
     */
    it('prefers the registered reader over the editor, and goes back when it clears', () => {
      const { workspace, view } = mount(DOC);

      scrollTopLineTo(view, 1);
      expect(currentLabel(workspace)).toBe('One');

      // The editor has not moved. Only the reader says otherwise.
      setTopSourceLineReader(() => 5);
      expect(currentLabel(workspace)).toBe('Three');

      // `null` is the pane withdrawing on hide; the editor answers again.
      setTopSourceLineReader(null);
      expect(currentLabel(workspace)).toBe('One');
    });

    /**
     * The notify half. Setting a reader is not the only way the answer changes:
     * in reading mode the value moves on every preview scroll, with nothing the
     * outline listens to firing. Without this the highlight would be correct
     * only at the moment the mode was entered.
     */
    it('re-reads when the pane reports a scroll', () => {
      const { workspace, view } = mount(DOC);
      scrollTopLineTo(view, 2);

      let line = 1;
      setTopSourceLineReader(() => line);
      expect(currentLabel(workspace)).toBe('One');

      line = 5;
      topSourceLineChanged();
      expect(currentLabel(workspace)).toBe('Three');

      setTopSourceLineReader(null);
    });

    // Each heading scrolled to the top marks its own section. Reads as the
    // obvious thing to assert, and is only true because of the one-line offset:
    // sampling the top edge exactly would land *on* the heading's own line,
    // which is the boundary case `BOUNDARY_NUDGE` exists for.
    it('marks the section the viewport is in, and follows it', () => {
      const { workspace, view } = mount(DOC);

      scrollTopLineTo(view, 1);
      expect(currentLabel(workspace)).toBe('One');

      scrollTopLineTo(view, 3);
      expect(currentLabel(workspace)).toBe('Two');

      scrollTopLineTo(view, 5);
      expect(currentLabel(workspace)).toBe('Three');
    });

    /**
     * The offset itself, and the reason it is **one line** rather than a share
     * of the viewport.
     *
     * Owner report: a section only highlighted once its heading was scrolled to
     * the very top, so following along meant landing pixel-perfect on each one.
     * A heading sitting one line below the top is, to a reader, the section they
     * are in -- so it is marked.
     *
     * The first fix used a quarter of the viewport height, and was reverted for
     * being far worse: a fraction scales with the *window*, so on a maximised
     * one it spanned hundreds of pixels and skipped every section shorter than
     * that -- the heading plainly on screen while the outline had moved past it.
     * A line cannot do that, because no section is shorter than one line. That
     * is the property this test pins.
     */
    it('marks a heading that is one line below the top, without landing exactly on it', () => {
      const { workspace, view } = mount(DOC);

      // Line 2 is the body under 'One'; line 3 is '## Two'.
      scrollTopLineTo(view, 2);

      expect(currentLabel(workspace)).toBe('Two');
    });

    /**
     * The owner's report: "when I press on anything in the outline it jumps to
     * the correct part of the editor, but the wrong item is highlighted -- always
     * the one above".
     *
     * Clicking scrolls the heading's own line to the *top* of the viewport, so
     * the viewport top lands exactly on that block's boundary -- and at a
     * boundary CodeMirror answers with the block above. Every other way of
     * scrolling lands somewhere in the middle of a line and hides this
     * completely, which is why the cases above pass either way: they scroll to
     * body lines, and a body line resolving one early still sits in the same
     * section.
     */
    it.each([
      [1, 'One'],
      [3, 'Two'],
      [5, 'Three'],
    ])('marks the section when line %i is scrolled exactly to the top', (line, label) => {
      const { workspace, view } = mount(DOC);

      scrollTopLineTo(view, line);

      expect(currentLabel(workspace)).toBe(label);
    });

    /** Exactly one at a time, or the sidebar claims the reader is in two places. */
    it('marks only one item', () => {
      const { workspace, view } = mount(DOC);

      scrollTopLineTo(view, 5);

      expect(workspace.querySelectorAll('.outline__item[aria-current]')).toHaveLength(1);
    });

    /**
     * `aria-current`, not a class: the visible state and the announced one come
     * from one attribute, so a screen-reader user is told which section they are
     * in rather than left to infer it from a colour.
     */
    it('says which section it is through ARIA', () => {
      const { workspace, view } = mount(DOC);

      scrollTopLineTo(view, 4);

      expect(
        workspace.querySelector('.outline__item[aria-current]')?.getAttribute('aria-current'),
      ).toBe('location');
    });

    /** Prose above the first heading is in no section at all. */
    it('marks nothing above the first heading', () => {
      const { workspace, view } = mount(['intro', '', '# One', 'body'].join(NL));

      scrollTopLineTo(view, 1);

      expect(currentLabel(workspace)).toBeNull();
    });

    /**
     * A rebuilt list carries no marks, so the cached index has to be discarded
     * with it -- otherwise the highlight vanishes on the next edit and does not
     * come back until the user scrolls across a boundary.
     */
    it('keeps the mark when an edit rebuilds the list', () => {
      const { workspace, view } = mount(DOC);
      scrollTopLineTo(view, 3);
      expect(currentLabel(workspace)).toBe('Two');

      view.dispatch({ changes: { from: view.state.doc.length, insert: `${NL}## Four` } });

      expect(currentLabel(workspace)).toBe('Two');
    });

    /**
     * The editor's scroller outlives the sidebar, so this listener is the one
     * real leak in the module -- and it is invisible from the DOM once the
     * sidebar is gone. Asserting "nothing threw" cannot see it: `querySelector`
     * on a detached nav is perfectly happy. So this watches the registration
     * itself, which is the only observable difference.
     */
    it('takes its scroll listener off the editor when destroyed', () => {
      const seeded = seed(DOC);
      const added: EventListenerOrEventListenerObject[] = [];
      const removed: EventListenerOrEventListenerObject[] = [];
      const realAdd = seeded.view.scrollDOM.addEventListener.bind(seeded.view.scrollDOM);
      const realRemove = seeded.view.scrollDOM.removeEventListener.bind(seeded.view.scrollDOM);
      seeded.view.scrollDOM.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === 'scroll') added.push(listener);
        realAdd(type, listener, options);
      }) as typeof seeded.view.scrollDOM.addEventListener;
      seeded.view.scrollDOM.removeEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) => {
        if (type === 'scroll') removed.push(listener);
        realRemove(type, listener, options);
      }) as typeof seeded.view.scrollDOM.removeEventListener;

      mountOutline(seeded.workspace, seeded.view).destroy();

      expect(added).toHaveLength(1);
      expect(removed).toEqual(added);
    });
  });

  it('removes itself and stops listening when destroyed', () => {
    const { workspace, view } = mount('# One');

    handles.pop()!.destroy();
    expect(workspace.querySelector('.outline-column')).toBeNull();

    // A subscription that outlived the node would throw here, or resurrect it.
    view.dispatch({ changes: { from: view.state.doc.length, insert: `${NL}## Two` } });
    expect(workspace.querySelector('.outline-column')).toBeNull();
  });
});
