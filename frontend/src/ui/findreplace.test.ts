// @vitest-environment jsdom
/**
 * A real `EditorView` with the real `buildExtensions`, so the panel is opened
 * the way the app opens it -- through `@codemirror/search`'s own
 * `openSearchPanel` against the `search({ createPanel })` wired into the
 * extensions. Building the panel by hand would prove it renders and nothing
 * about whether it is ever reachable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import { buildExtensions } from '../editor/extensions';
import { countMatches, matchLabel } from './findreplace';

const NL = String.fromCharCode(10);
const views: EditorView[] = [];

afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
  document.body.replaceChildren();
});

function editor(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: buildExtensions(false) }),
    parent: document.body.appendChild(document.createElement('div')),
  });
  views.push(view);
  return view;
}

function open(doc: string): EditorView {
  const view = editor(doc);
  openSearchPanel(view);
  return view;
}

function panel(view: EditorView): HTMLElement {
  const found = view.dom.querySelector<HTMLElement>('.findbar');
  expect(found, 'the find panel should be in the editor DOM').not.toBeNull();
  return found!;
}

function field(view: EditorView): HTMLInputElement {
  return panel(view).querySelector<HTMLInputElement>('.findbar__input')!;
}

function countText(view: EditorView): string {
  return panel(view).querySelector('.findbar__count')!.textContent ?? '';
}

/** Types into the field the way a user does, firing the `input` event. */
function type(view: EditorView, text: string): void {
  const input = field(view);
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(view: EditorView, key: string, init: KeyboardEventInit = {}): void {
  field(view).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
}

function query(search: string, options: Partial<{ regexp: boolean }> = {}): SearchQuery {
  return new SearchQuery({ search, ...options });
}

describe('countMatches', () => {
  const state = (doc: string, anchor = 0, head = anchor): EditorState =>
    EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });

  it('counts every match', () => {
    expect(countMatches(state('one two one two one'), query('one'))).toMatchObject({ total: 3 });
  });

  /**
   * The state the panel opens in: matches exist, none is selected. Claiming
   * "1 of 3" there would tell the user a search had run when none had.
   */
  it('reports no current match when the selection is not on one', () => {
    expect(countMatches(state('one two one'), query('one')).current).toBe(0);
  });

  /** A caret *inside* a match is not the same as having found it. */
  it('does not count a caret inside a match as being on it', () => {
    expect(countMatches(state('one two one', 1, 1), query('one')).current).toBe(0);
  });

  it('reports which match the selection is exactly on', () => {
    // 'one two one' -- the second 'one' is 8..11.
    expect(countMatches(state('one two one', 8, 11), query('one')).current).toBe(2);
  });

  /** An unfinished regex is not a search, and must not throw on the way past. */
  it('answers nothing for an invalid query', () => {
    expect(countMatches(state('aaa'), query('(', { regexp: true }))).toEqual({
      total: 0,
      current: 0,
      capped: false,
    });
  });

  /**
   * Counting is linear in the document, and a one-character query matches on
   * nearly every line -- so it stops rather than walking a huge file on every
   * keystroke.
   */
  it('stops at the cap rather than counting a whole large document', () => {
    const result = countMatches(state('a'.repeat(5000)), query('a'));

    expect(result.capped).toBe(true);
    expect(result.total).toBe(999);
  });
});

describe('matchLabel', () => {
  it.each([
    ['', { total: 0, current: 0, capped: false }, ''],
    ['x', { total: 0, current: 0, capped: false }, 'No results'],
    ['x', { total: 1, current: 0, capped: false }, '1 match'],
    ['x', { total: 5, current: 0, capped: false }, '5 matches'],
    ['x', { total: 5, current: 2, capped: false }, '2 of 5'],
    ['x', { total: 999, current: 0, capped: true }, '999+ matches'],
    ['x', { total: 999, current: 3, capped: true }, '3 of 999+'],
  ])('says %s -> %s', (search, count, expected) => {
    expect(matchLabel(query(search), count)).toBe(expected);
  });

  /** A half-typed regex is a normal state to be in, not an error to hide. */
  it('says so for an invalid pattern rather than "No results"', () => {
    expect(matchLabel(query('(', { regexp: true }), { total: 0, current: 0, capped: false })).toBe(
      'Bad pattern',
    );
  });
});

describe('the find panel', () => {
  it('is not there until it is opened, and Ctrl+F is what opens it', () => {
    const view = editor('hello');
    expect(view.dom.querySelector('.findbar')).toBeNull();

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', keyCode: 70, ctrlKey: true, cancelable: true }),
    );

    expect(view.dom.querySelector('.findbar')).not.toBeNull();
    expect(searchPanelOpen(view.state)).toBe(true);
  });

  /**
   * The package focuses whatever carries `main-field` when the panel opens.
   * Without it the panel appears and the user's next keystroke goes into the
   * document instead of the search box.
   */
  it('marks the input as the field to focus', () => {
    expect(field(open('hello')).getAttribute('main-field')).toBe('true');
  });

  it('puts what is typed into the editor’s search state', () => {
    const view = open(`one${NL}two${NL}one`);

    type(view, 'one');

    expect(getSearchQuery(view.state).search).toBe('one');
  });

  it('shows the match count, and updates it as the query narrows', () => {
    const view = open('one two one two one');

    type(view, 'one');
    expect(countText(view)).toBe('3 matches');

    type(view, 'one two');
    expect(countText(view)).toBe('2 matches');

    type(view, 'zzz');
    expect(countText(view)).toBe('No results');
  });

  it('counts down to the current match once one is found', () => {
    const view = open('one two one');

    type(view, 'one');
    press(view, 'Enter');

    expect(countText(view)).toBe('1 of 2');
  });

  /** Shift+Enter goes backwards, the convention every editor shares. */
  it('walks forwards on Enter and backwards on Shift+Enter', () => {
    const view = open('one two one two one');
    type(view, 'one');

    press(view, 'Enter');
    expect(countText(view)).toBe('1 of 3');
    press(view, 'Enter');
    expect(countText(view)).toBe('2 of 3');
    press(view, 'Enter', { shiftKey: true });
    expect(countText(view)).toBe('1 of 3');
  });

  it('wraps around at the end rather than stopping', () => {
    const view = open('one two one');
    type(view, 'one');
    press(view, 'Enter');
    press(view, 'Enter');
    expect(countText(view)).toBe('2 of 2');

    press(view, 'Enter');

    expect(countText(view)).toBe('1 of 2');
  });

  it('closes on Escape', () => {
    const view = open('hello');

    press(view, 'Escape');

    expect(view.dom.querySelector('.findbar')).toBeNull();
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it('closes when the close button is clicked', () => {
    const view = open('hello');

    panel(view).querySelector<HTMLButtonElement>('.findbar__close')!.click();

    expect(view.dom.querySelector('.findbar')).toBeNull();
  });

  describe('the toggles', () => {
    function toggle(view: EditorView, key: string): HTMLButtonElement {
      return panel(view).querySelector<HTMLButtonElement>(`[data-toggle="${key}"]`)!;
    }

    it('offers exactly the three SPEC §6.7 names', () => {
      const keys = [...panel(open('x')).querySelectorAll<HTMLElement>('.findbar__toggle')].map(
        (b) => b.dataset.toggle,
      );

      expect(keys).toEqual(['caseSensitive', 'wholeWord', 'regexp']);
    });

    it('starts off, and reports its state through aria-pressed', () => {
      const view = open('One one');
      expect(toggle(view, 'caseSensitive').getAttribute('aria-pressed')).toBe('false');

      toggle(view, 'caseSensitive').click();

      expect(toggle(view, 'caseSensitive').getAttribute('aria-pressed')).toBe('true');
      expect(getSearchQuery(view.state).caseSensitive).toBe(true);
    });

    it('changes what matches', () => {
      const view = open('One one one');
      type(view, 'one');
      expect(countText(view)).toBe('3 matches');

      toggle(view, 'caseSensitive').click();

      expect(countText(view)).toBe('2 matches');
    });

    /**
     * The search text has to survive a toggle -- `SearchQuery` is immutable, so
     * the new one is built from the old, and dropping a field there would clear
     * the box the user just typed into.
     */
    it('keeps the search text when a toggle is flipped', () => {
      const view = open('one two');
      type(view, 'one');

      toggle(view, 'regexp').click();

      expect(getSearchQuery(view.state).search).toBe('one');
      expect(field(view).value).toBe('one');
    });

    it('makes the pattern a regex when regexp is on', () => {
      const view = open('cat cot cut');
      type(view, 'c.t');
      expect(countText(view)).toBe('No results');

      toggle(view, 'regexp').click();

      expect(countText(view)).toBe('3 matches');
    });

    it('matches only whole words when whole word is on', () => {
      const view = open('one oneself one');
      type(view, 'one');
      expect(countText(view)).toBe('3 matches');

      toggle(view, 'wholeWord').click();

      expect(countText(view)).toBe('2 matches');
    });
  });

  /**
   * The panel is a view of the search state, never a second copy: a query set
   * from anywhere else has to show up in the field. Nothing does that today
   * besides the panel itself, but G.4b's replace and "search for the selection"
   * both will.
   */
  it('follows the search state when it is changed from outside', () => {
    const view = open('alpha beta');

    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'beta' })) });

    expect(field(view).value).toBe('beta');
    expect(countText(view)).toBe('1 match');
  });

  /** Re-opening must not resurrect a stale count from the last time. */
  it('re-renders from the current state when reopened', () => {
    const view = open('one two one');
    type(view, 'one');
    closeSearchPanel(view);

    openSearchPanel(view);

    expect(field(view).value).toBe('one');
    expect(countText(view)).toBe('2 matches');
  });

  /** The count describes the document, so editing it has to move the number. */
  it('recounts when the document changes underneath', () => {
    const view = open('one two');
    type(view, 'one');
    expect(countText(view)).toBe('1 match');

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' one' } });

    expect(countText(view)).toBe('2 matches');
  });
});
