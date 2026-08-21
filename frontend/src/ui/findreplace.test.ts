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
import { undo } from '@codemirror/commands';
import { buildExtensions } from '../editor/extensions';
import { countMatches, matchLabel, openReplacePanel } from './findreplace';

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
   * The owner's report: "when I first press Ctrl+F the bar appears but is not in
   * focus, so I type into the editor".
   *
   * `openSearchPanel` only focuses a panel that is *already* open -- with none
   * open it dispatches `togglePanel` and returns -- so the panel has to focus
   * itself on mount, which is what CodeMirror's own default panel does.
   *
   * The first version of this test asserted the `main-field` attribute instead,
   * and passed the whole time the bar was opening unfocused: the attribute is
   * how the package finds the field on a *second* press, not what focuses it.
   * Asserting the mechanism rather than the outcome is what let this ship.
   */
  it('puts the cursor in the search box on the first press', () => {
    const view = open('hello');

    expect(document.activeElement).toBe(field(view));
    expect(field(view).getAttribute('main-field')).toBe('true');
  });

  /** So reopening find and typing replaces the last search rather than extending it. */
  it('selects the query already in the box when reopened', () => {
    const view = open('one two one');
    type(view, 'one');
    closeSearchPanel(view);

    openSearchPanel(view);

    const input = field(view);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('one'.length);
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

describe('replace', () => {
  function replaceField(view: EditorView): HTMLInputElement {
    return panel(view).querySelector<HTMLInputElement>('.findbar__replace')!;
  }

  function button(view: EditorView, label: string): HTMLButtonElement {
    const found = [...panel(view).querySelectorAll<HTMLButtonElement>('.findbar__action')].find(
      (b) => b.textContent === label,
    );
    expect(found, `there should be a ${label} button`).toBeDefined();
    return found!;
  }

  /** Types into the replace field the way a user does. */
  function typeReplacement(view: EditorView, text: string): void {
    const input = replaceField(view);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function openWithReplace(doc: string): EditorView {
    const view = editor(doc);
    openReplacePanel(view);
    return view;
  }

  /**
   * The panel is one row and always shows both halves, so the only thing Ctrl+H
   * does differently from Ctrl+F is where the cursor lands -- which is the whole
   * difference between "I want to find" and "I want to replace".
   */
  it('opens from Ctrl+H with the cursor in the replace field', () => {
    const view = editor('one two');

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'h', keyCode: 72, ctrlKey: true, cancelable: true }),
    );

    expect(view.dom.querySelector('.findbar')).not.toBeNull();
    expect(document.activeElement).toBe(replaceField(view));
  });

  /** Both halves are on screen from the moment the bar opens, however it opened. */
  it('shows the replace controls even when opened with Ctrl+F', () => {
    const view = open('one two');

    expect(replaceField(view)).not.toBeNull();
    expect(button(view, 'Replace')).toBeDefined();
    expect(button(view, 'Replace All')).toBeDefined();
  });

  /**
   * The owner's order: find, everything about find, replace, everything about
   * replace, then close. Asserted because it is a layout decision someone will
   * otherwise "tidy" -- the close button in particular belongs at the end, not
   * beside the find controls it has nothing to do with.
   *
   * The count's position is load-bearing rather than incidental. It reserves a
   * fixed width, so wherever it sits there is blank space; between the field and
   * the buttons that space read as a gap splitting find from its own controls,
   * which the owner reported as the buttons looking like they belonged to
   * replace. Last in the group, the same width separates find from replace.
   */
  it('lays the row out in one line, in that order', () => {
    const view = open('one two');
    const classes = [...panel(view).children].map((child) => child.className);

    expect(classes).toEqual([
      'findbar__input',
      'findbar__action',
      'findbar__action',
      'findbar__toggle',
      'findbar__toggle',
      'findbar__toggle',
      'findbar__count',
      'findbar__input findbar__replace',
      'findbar__action findbar__wide',
      'findbar__action findbar__wide',
      'findbar__action findbar__close',
    ]);
  });

  /**
   * `openSearchPanel` focuses the *find* field, so the replace field has to be
   * focused after it -- Ctrl+H means "I want to replace", and landing in the
   * find box would make the second keystroke go to the wrong place.
   */
  it('puts the cursor in the replace field', () => {
    const view = openWithReplace('one two');

    expect(document.activeElement).toBe(replaceField(view));
  });

  it('puts what is typed into the query’s replace text', () => {
    const view = openWithReplace('one two');

    typeReplacement(view, 'THREE');

    expect(getSearchQuery(view.state).replace).toBe('THREE');
  });

  it('replaces the current match and leaves the rest', () => {
    const view = openWithReplace('one two one');
    type(view, 'one');
    typeReplacement(view, 'X');

    button(view, 'Replace').click();

    expect(view.state.doc.toString()).toBe('X two one');
  });

  it('replaces every match at once', () => {
    const view = openWithReplace('one two one three one');
    type(view, 'one');
    typeReplacement(view, 'X');

    button(view, 'Replace All').click();

    expect(view.state.doc.toString()).toBe('X two X three X');
  });

  /** Enter in the replace field replaces; it does not search on. */
  it('replaces on Enter in the replace field', () => {
    const view = openWithReplace('one two one');
    type(view, 'one');
    typeReplacement(view, 'X');

    replaceField(view).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(view.state.doc.toString()).toBe('X two one');
  });

  it('closes on Escape from the replace field', () => {
    const view = openWithReplace('one two');

    replaceField(view).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(view.dom.querySelector('.findbar')).toBeNull();
  });

  /**
   * The toggles rebuild the query from the old one, so a dropped field would
   * clear the replacement the user had already typed -- `withChange` carries
   * `replace` for exactly this.
   */
  it('keeps the replacement when a toggle is flipped', () => {
    const view = openWithReplace('One one');
    type(view, 'one');
    typeReplacement(view, 'X');

    panel(view).querySelector<HTMLButtonElement>('[data-toggle="caseSensitive"]')!.click();

    expect(getSearchQuery(view.state).replace).toBe('X');
    expect(replaceField(view).value).toBe('X');
  });

  /** The toggles apply to replacing too, not only to counting. */
  it('respects match case when replacing all', () => {
    const view = openWithReplace('One one one');
    type(view, 'one');
    typeReplacement(view, 'X');
    panel(view).querySelector<HTMLButtonElement>('[data-toggle="caseSensitive"]')!.click();

    button(view, 'Replace All').click();

    expect(view.state.doc.toString()).toBe('One X X');
  });

  /** A replacement is an edit like any other, so one Ctrl+Z must undo it. */
  it('is undoable in one step', () => {
    const view = openWithReplace('one two one');
    type(view, 'one');
    typeReplacement(view, 'X');
    button(view, 'Replace All').click();
    expect(view.state.doc.toString()).toBe('X two X');

    undo(view);

    expect(view.state.doc.toString()).toBe('one two one');
  });

  it('does nothing to the document when there are no matches', () => {
    const view = openWithReplace('one two');
    type(view, 'zzz');
    typeReplacement(view, 'X');

    button(view, 'Replace All').click();

    expect(view.state.doc.toString()).toBe('one two');
  });
});
