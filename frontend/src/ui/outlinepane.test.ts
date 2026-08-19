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
import { store } from '../state/appcontext';
import {
  createUntitledDocument,
  DEFAULT_OUTLINE_WIDTH,
  EMPTY_STATUS,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  type Document,
} from '../state/document';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { buildOutline, mountOutline, type OutlineHandle } from './outline';

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

  it('removes itself and stops listening when destroyed', () => {
    const { workspace, view } = mount('# One');

    handles.pop()!.destroy();
    expect(workspace.querySelector('.outline-column')).toBeNull();

    // A subscription that outlived the node would throw here, or resurrect it.
    view.dispatch({ changes: { from: view.state.doc.length, insert: `${NL}## Two` } });
    expect(workspace.querySelector('.outline-column')).toBeNull();
  });
});
