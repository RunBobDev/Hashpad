// @vitest-environment jsdom
/**
 * Two layers, tested separately for the reason `ui/tabbar.ts`'s header gives:
 * `statusSegments`/`buildStatusBar` are pure functions of a plain model, so
 * what the row *says* is tested without a store, and `mountStatusBar`'s tests
 * are only about subscribing, rebuilding in place, and tearing down.
 *
 * The counting rules themselves live in `state/document.test.ts`, next to
 * `statusOf` -- they need an `EditorState` and no DOM at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { store } from '../state/appcontext';
import {
  createUntitledDocument,
  EMPTY_STATUS,
  statusOf,
  type Document,
  type EditorStatus,
} from '../state/document';
import { COMMAND_EVENT } from './menubar';
import { closePopupMenu } from './popupmenu';
import {
  buildStatusBar,
  encodingCommand,
  lineEndingCommand,
  mountStatusBar,
  parseStatusCommand,
  segmentItems,
  statusBarModel,
  statusSegments,
  type StatusBarModel,
} from './statusbar';

const teardowns: (() => void)[] = [];

afterEach(() => {
  // Before the DOM is cleared: the popup is a module singleton appended to
  // `document.body`, so a test that leaves one open leaves this module holding
  // a reference to a detached node -- and `--sequence.shuffle` decides which
  // test finds out.
  closePopupMenu();
  while (teardowns.length > 0) teardowns.pop()!();
  document.body.replaceChildren();
});

function model(overrides: Partial<StatusBarModel> = {}): StatusBarModel {
  return {
    ...EMPTY_STATUS,
    encoding: 'utf-8',
    lineEnding: 'lf',
    viewMode: 'source',
    mixedLineEndings: false,
    ...overrides,
  };
}

/** Just the readouts, which is what most of these cases are about. */
function texts(model: StatusBarModel): string[] {
  return statusSegments(model).map((segment) => segment.text);
}

function docWith(text: string, overrides: Partial<Document> = {}): Document {
  return { ...createUntitledDocument(EditorState.create({ doc: text })), ...overrides };
}

function seed(documents: Document[], activeId: string | null, status: EditorStatus): void {
  store.setState((prev) => ({ ...prev, documents, activeDocumentId: activeId, status }));
}

describe('statusSegments', () => {
  it('shows SPEC 6.11 six segments in 6.1 order', () => {
    const segments = texts(model({ line: 12, col: 4, words: 1247, chars: 6891 }));

    // Separators come from `toLocaleString`, which is the product behaviour --
    // follow the OS. Hard-coding the comma would red this suite on a machine
    // that resolves to de-DE or hr-HR, where Node yields '1.247', for a reason
    // that has nothing to do with the status bar.
    expect(segments).toEqual([
      'Ln 12, Col 4',
      `${(1247).toLocaleString()} words`,
      `${(6891).toLocaleString()} chars`,
      'UTF-8',
      'LF',
      'Source',
    ]);
  });

  /**
   * The counts change subject when there is a selection (SPEC 6.11), and a
   * number dropping from 1,247 to 12 with nothing to explain it reads as data
   * loss. The suffix is the explanation.
   */
  it('says so when the counts describe a selection', () => {
    const segments = texts(model({ words: 12, chars: 74, selection: true }));

    expect(segments[1]).toBe('12 words selected');
    expect(segments[2]).toBe('74 chars selected');
  });

  it('names every encoding, line ending and view mode', () => {
    const labels = (overrides: Partial<StatusBarModel>): string[] =>
      texts(model(overrides)).slice(3);

    expect(labels({ encoding: 'utf-8-bom', lineEnding: 'crlf' })).toEqual([
      'UTF-8 BOM',
      'CRLF',
      'Source',
    ]);
    expect(labels({ encoding: 'utf-16le', viewMode: 'split' })).toEqual([
      'UTF-16 LE',
      'LF',
      'Split',
    ]);
    expect(labels({ viewMode: 'live' })).toEqual(['UTF-8', 'LF', 'Live']);
  });

  /**
   * Not reachable while the row is mounted -- `main.ts` seeds a document at
   * module scope, well before bootstrap mounts this -- but `activeDocument` is
   * typed nullable, and three blank segments would read as a broken encoding
   * detector rather than as "no file yet" if that ever changed.
   */
  it('omits the document segments when there is no document', () => {
    const segments = texts(model({ encoding: null, lineEnding: null, viewMode: null }));

    expect(segments).toEqual(['Ln 1, Col 1', '0 words', '0 chars']);
  });

  /**
   * Which segments are clickable is a product decision, not an accident of
   * rendering: SPEC 6.11 names the encoding and the line ending. The view mode
   * is deliberately not one -- it already has Ctrl+Shift+P and a View menu item,
   * and a third way in that looked identical to its two neighbours would imply
   * all three are the same kind of control.
   */
  it('makes exactly the encoding and line-ending segments clickable', () => {
    const menus = statusSegments(model()).map((segment) => segment.menu);

    expect(menus).toEqual([undefined, undefined, undefined, 'encoding', 'lineEnding', undefined]);
  });

  /**
   * Saving flattens a mixed file to one convention, which is a change the user
   * never asked for -- Go reports it (`FileContents.Mixed`) so the row can warn
   * before it happens.
   */
  it('warns on the line-ending segment when the file mixes conventions', () => {
    const mixed = statusSegments(model({ mixedLineEndings: true }))[4];
    const clean = statusSegments(model({ mixedLineEndings: false }))[4];

    expect(mixed?.title).toContain('CRLF and LF');
    expect(clean?.title).toBeUndefined();
  });
});

describe('parseStatusCommand', () => {
  it('round-trips both kinds', () => {
    expect(parseStatusCommand(encodingCommand('utf-8-bom'))).toEqual({
      kind: 'encoding',
      value: 'utf-8-bom',
    });
    expect(parseStatusCommand(lineEndingCommand('crlf'))).toEqual({
      kind: 'lineEnding',
      value: 'crlf',
    });
  });

  /**
   * The value is validated, not cast. These ids travel on a `document`-level
   * event bus anything can dispatch to, and the value ends up in
   * `Document.encoding` and then in Go's `WriteFile` -- so an unrecognised one
   * has to be refused here rather than become an encoding no decoder knows.
   */
  it('refuses a value it does not recognise', () => {
    expect(parseStatusCommand('document.encoding:latin-1')).toBeNull();
    expect(parseStatusCommand('document.lineEnding:cr')).toBeNull();
    expect(parseStatusCommand('document.encoding:')).toBeNull();
  });

  it('ignores commands belonging to anything else', () => {
    expect(parseStatusCommand('view.preview')).toBeNull();
    expect(parseStatusCommand('tab.close:abc')).toBeNull();
  });
});

describe('segmentItems', () => {
  it('offers every encoding, with the current one ticked', () => {
    const items = segmentItems('encoding', model({ encoding: 'utf-16le' }));

    expect(items.map((item) => item.label)).toEqual(['UTF-8', 'UTF-8 BOM', 'UTF-16 LE']);
    expect(items.map((item) => item.checked)).toEqual([false, false, true]);
    expect(items[2]?.id).toBe(encodingCommand('utf-16le'));
  });

  /**
   * The menu names the platform where the row does not. 'LF' is enough as a
   * readout for someone who already knows; it is not enough as a choice.
   */
  it('names the platform in the line-ending menu', () => {
    const items = segmentItems('lineEnding', model({ lineEnding: 'crlf' }));

    expect(items.map((item) => item.label)).toEqual(['LF (Unix)', 'CRLF (Windows)']);
    expect(items.map((item) => item.checked)).toEqual([false, true]);
  });
});

describe('buildStatusBar', () => {
  it('renders one span per segment', () => {
    const bar = buildStatusBar(model({ line: 3, col: 9 }));
    const text = [...bar.querySelectorAll('.statusbar__segment')].map((s) => s.textContent);

    expect(bar.className).toBe('statusbar');
    expect(text).toEqual(['Ln 3, Col 9', '0 words', '0 chars', 'UTF-8', 'LF', 'Source']);
  });

  /**
   * A labelled landmark, so a screen-reader user can jump to the counts -- and
   * emphatically *not* a live region. The column changes on every keystroke and
   * every arrow key, so `role="status"` here would narrate the caret's whole
   * journey across the document. `aria-live` is asserted absent rather than
   * `'off'`: silencing a live region with an attribute leaves a role that lies
   * about what it is, which was this row's first version.
   */
  it('is a labelled landmark, not a live region', () => {
    const bar = buildStatusBar(model());

    expect(bar.getAttribute('role')).toBe('region');
    expect(bar.getAttribute('aria-label')).toBe('Editor status');
    expect(bar.hasAttribute('aria-live')).toBe(false);
  });

  /**
   * Real buttons, not spans with click handlers. A button is focusable, reached
   * by Tab, operable with Enter and Space, and announced as something that does
   * something -- none of which comes free (SPEC 10). The readouts stay spans so
   * they are not in the tab order at all.
   */
  it('renders the clickable segments as buttons and the rest as spans', () => {
    const bar = buildStatusBar(model());
    const tags = [...bar.children].map((child) => child.tagName);

    expect(tags).toEqual(['SPAN', 'SPAN', 'SPAN', 'BUTTON', 'BUTTON', 'SPAN']);
    for (const button of bar.querySelectorAll('button')) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
    }
  });
});

describe('statusBarModel', () => {
  it('reads the encoding, line ending and view mode off the active document', () => {
    const other = docWith('x', { encoding: 'utf-8', lineEnding: 'lf' });
    const active = docWith('y', { encoding: 'utf-16le', lineEnding: 'crlf', viewMode: 'split' });
    seed([other, active], active.id, { line: 2, col: 5, words: 7, chars: 30, selection: false });

    expect(statusBarModel(store.getState())).toEqual({
      line: 2,
      col: 5,
      words: 7,
      chars: 30,
      selection: false,
      encoding: 'utf-16le',
      lineEnding: 'crlf',
      viewMode: 'split',
      mixedLineEndings: false,
    });
  });

  /**
   * The whole point of the flat shape: store.ts's `isEqual` compares one level
   * of own keys, so two calls describing the same state must compare equal even
   * though each builds a fresh object.
   *
   * What that buys is precise, and worth not overstating -- typing rebuilds this
   * row every keystroke, because both the column and the character count really
   * did change. It buys immunity to every *other* store write: nesting the
   * `Document` here would compare by reference, and `syncActiveDocument`
   * replaces that object constantly, so the row would also rebuild for writes
   * that leave all six strings alone.
   */
  it('is flat, so equal state gives an equal object', () => {
    const doc = docWith('hello');
    seed([doc], doc.id, EMPTY_STATUS);

    const a = statusBarModel(store.getState());
    const b = statusBarModel(store.getState());
    const nested = Object.values(a).filter((value) => value !== null && typeof value === 'object');
    const allSame = Object.entries(a).every(([key, value]) =>
      Object.is(value, b[key as keyof StatusBarModel]),
    );

    expect(a).not.toBe(b);
    expect(nested).toEqual([]);
    expect(allSame).toBe(true);
  });
});

describe('mountStatusBar', () => {
  function mount(): HTMLElement {
    const root = document.createElement('div');
    document.body.append(root);
    teardowns.push(mountStatusBar(root));
    return root;
  }

  function textOf(root: HTMLElement): string[] {
    return [...root.querySelectorAll('.statusbar__segment')].map((s) => s.textContent ?? '');
  }

  it('renders the current store state on mount', () => {
    const doc = docWith('one two three', { encoding: 'utf-8-bom', lineEnding: 'crlf' });
    seed([doc], doc.id, statusOf(doc.editorState));

    expect(textOf(mount())).toEqual([
      'Ln 1, Col 1',
      '3 words',
      '13 chars',
      'UTF-8 BOM',
      'CRLF',
      'Source',
    ]);
  });

  it('follows the store', () => {
    const doc = docWith('a');
    seed([doc], doc.id, EMPTY_STATUS);
    const root = mount();

    store.setState((prev) => ({
      ...prev,
      status: { line: 4, col: 2, words: 99, chars: 500, selection: false },
    }));

    expect(textOf(root).slice(0, 2)).toEqual(['Ln 4, Col 2', '99 words']);
  });

  /**
   * `replaceWith`, not `append`. The row is the last child of `#app` today, so
   * appending a rebuilt one would look identical -- until G.3 or the settings
   * dialog adds anything after it, at which point every keystroke would shuffle
   * the order. The same mistake, caught the same way, as the toolbar's own
   * position test in `main.toolbarSeed.test.ts`.
   */
  it('rebuilds in place rather than appending', () => {
    const doc = docWith('a');
    seed([doc], doc.id, EMPTY_STATUS);
    const root = mount();
    const sentinel = document.createElement('div');
    sentinel.className = 'after';
    root.append(sentinel);

    store.setState((prev) => ({ ...prev, status: { ...EMPTY_STATUS, line: 2 } }));

    expect([...root.children].map((child) => child.className)).toEqual(['statusbar', 'after']);
  });

  /**
   * The whole path: click the segment, pick a value, and see the command on the
   * bus. Nothing here writes the store -- `main.ts` owns document mutation, the
   * same boundary the tab strip and the toolbar keep -- so the command *is* the
   * behaviour as far as this module is concerned.
   */
  it('opens a menu from the encoding segment and emits the chosen command', () => {
    const doc = docWith('a', { encoding: 'utf-8' });
    seed([doc], doc.id, EMPTY_STATUS);
    const root = mount();
    const commands: string[] = [];
    const listen = (event: Event): void => {
      commands.push((event as CustomEvent<string>).detail);
    };
    document.addEventListener(COMMAND_EVENT, listen);

    try {
      const button = root.querySelectorAll('button')[0]!;
      button.click();

      const items = [...document.querySelectorAll('.popup-menu button')];
      expect(items.map((item) => item.textContent)).toEqual(['✓UTF-8', 'UTF-8 BOM', 'UTF-16 LE']);

      (items[1] as HTMLButtonElement).click();
      expect(commands).toEqual([encodingCommand('utf-8-bom')]);
    } finally {
      document.removeEventListener(COMMAND_EVENT, listen);
      closePopupMenu();
    }
  });

  /**
   * Clicking the trigger of an open menu must close it. Without the
   * `isPopupOpenFor` guard the click closes and immediately reopens the same
   * menu, so the button can never dismiss what it opened -- the bug the
   * toolbar's heading button already had to solve.
   */
  it('closes its own menu on a second click', () => {
    const doc = docWith('a');
    seed([doc], doc.id, EMPTY_STATUS);
    const button = mount().querySelectorAll('button')[1]!;

    button.click();
    expect(document.querySelector('.popup-menu')).not.toBeNull();

    button.click();
    expect(document.querySelector('.popup-menu')).toBeNull();
  });

  it('removes the row and stops listening when torn down', () => {
    const doc = docWith('a');
    seed([doc], doc.id, EMPTY_STATUS);
    const root = mount();

    teardowns.pop()!();
    expect(root.querySelector('.statusbar')).toBeNull();

    // A subscription that outlived the node would resurrect it here.
    store.setState((prev) => ({ ...prev, status: { ...EMPTY_STATUS, line: 7 } }));
    expect(root.querySelector('.statusbar')).toBeNull();
  });
});
