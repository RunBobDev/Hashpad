/**
 * Find and replace (SPEC §6.7).
 *
 * Built on `@codemirror/search`, which SPEC names, with **our own panel**: the
 * spec asks for it "styled to match the app rather than left at its defaults",
 * and `createPanel` is the sanctioned way to say so. That is not only a styling
 * decision -- match highlighting is gated on CodeMirror's panel being open
 * (`searchHighlighter` returns no decorations when `panel` is false), so
 * rendering a panel of our own somewhere else in the chrome would have cost the
 * highlights. Going through `createPanel` keeps them, and keeps Escape,
 * open/close state and the query effect working the way the package intends.
 *
 * Nothing here reaches into the editor directly. The query lives in
 * CodeMirror's search state and every action is one of its commands, so the
 * panel is a view of that state rather than a second copy of it.
 */
import { EditorView, type Panel } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';

/**
 * How many matches to count before giving up and saying "many".
 *
 * The count is recomputed on every keystroke in the field *and* every edit to
 * the document, and counting is linear in document size -- a one-character
 * query in a long file matches on nearly every line. The cap keeps that
 * bounded; the exact number stops being useful long before it is reached
 * anyway, which is why the readout says `999+` rather than pretending.
 */
const MATCH_CAP = 999;

export interface MatchCount {
  /** Matches found, up to `MATCH_CAP`. */
  total: number;
  /** 1-based position of the match the selection is on, or 0 when it is on none. */
  current: number;
  /** Whether counting stopped at the cap. */
  capped: boolean;
}

/**
 * Counts matches, and works out which one the caret is sitting on.
 *
 * Exported and pure so the arithmetic -- especially "no match is selected yet",
 * which is the state the panel opens in -- is testable without a panel.
 */
export function countMatches(state: EditorState, query: SearchQuery): MatchCount {
  if (!query.valid) return { total: 0, current: 0, capped: false };

  const { from, to } = state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    // The caret is "on" a match only when the selection is exactly it, which is
    // what running `findNext` leaves behind. A caret merely inside one -- the
    // user clicked into the word -- is not the same thing and must not claim a
    // position, or the readout would say "3 of 12" for a search nobody ran.
    if (next.value.from === from && next.value.to === to) current = total;
    if (total >= MATCH_CAP) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

/** The readout beside the field: "3 of 12", "No results", "" for an empty query. */
export function matchLabel(query: SearchQuery, count: MatchCount): string {
  if (query.search === '') return '';
  if (!query.valid) return 'Bad pattern';
  if (count.total === 0) return 'No results';
  const total = count.capped ? `${count.total}+` : String(count.total);
  if (count.current !== 0) return `${count.current} of ${total}`;
  // Singular when there is exactly one and the count is not capped. "1 matches"
  // is the kind of thing that reads as unfinished work every time it is seen.
  return count.total === 1 && !count.capped ? '1 match' : `${total} matches`;
}

interface Toggle {
  /** The `SearchQuery` field this flips. */
  key: 'caseSensitive' | 'wholeWord' | 'regexp';
  label: string;
  title: string;
}

/**
 * The three toggles SPEC §6.7 asks for. Short glyph labels because the row is
 * one line of chrome, with the real name in the tooltip and the accessible
 * name -- `Aa` alone tells a screen-reader user nothing.
 */
const TOGGLES: Toggle[] = [
  { key: 'caseSensitive', label: 'Aa', title: 'Match case' },
  { key: 'wholeWord', label: 'ab', title: 'Whole word' },
  { key: 'regexp', label: '.*', title: 'Regular expression' },
];

/**
 * A new query with one field changed, carrying the rest over.
 *
 * `SearchQuery` is immutable, so every change is a fresh one built from the old
 * -- and `replace` is carried too, though nothing sets it yet, so that G.4b's
 * replace text is not silently dropped the moment a toggle is clicked.
 */
function withChange(
  query: SearchQuery,
  change: Partial<ConstructorParameters<typeof SearchQuery>[0]>,
): SearchQuery {
  return new SearchQuery({
    search: query.search,
    caseSensitive: query.caseSensitive,
    literal: query.literal,
    regexp: query.regexp,
    wholeWord: query.wholeWord,
    replace: query.replace,
    ...change,
  });
}

/**
 * The find panel. Handed to `search({ createPanel })`, so CodeMirror owns when
 * it exists and this owns what it looks like.
 */
export function buildFindPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'findbar';
  // Not a `<form>`: Enter inside one submits, and the CSP sets
  // `form-action 'none'`, so the submit would be blocked rather than ignored.
  dom.setAttribute('role', 'search');
  dom.setAttribute('aria-label', 'Find in document');

  const input = document.createElement('input');
  input.className = 'findbar__input';
  input.type = 'text';
  input.placeholder = 'Find';
  input.setAttribute('aria-label', 'Find');
  // Marks this as the field find should return to. The package reads it when
  // Ctrl+F is pressed while the panel is *already* open; focusing it on first
  // open is `mount`'s job below.
  input.setAttribute('main-field', 'true');

  const count = document.createElement('span');
  count.className = 'findbar__count';
  // Polite, not assertive: the number changes on every keystroke, and a screen
  // reader interrupting the user's own typing to read it would be unusable.
  count.setAttribute('aria-live', 'polite');

  function currentQuery(): SearchQuery {
    return getSearchQuery(view.state);
  }

  function apply(query: SearchQuery): void {
    view.dispatch({ effects: setSearchQuery.of(query) });
  }

  const toggles = TOGGLES.map((toggle) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'findbar__toggle';
    button.dataset.toggle = toggle.key;
    button.textContent = toggle.label;
    button.title = toggle.title;
    button.setAttribute('aria-label', toggle.title);
    button.addEventListener('click', () => {
      const query = currentQuery();
      apply(withChange(query, { [toggle.key]: !query[toggle.key] }));
      // Focus stays in the field: a toggle is a refinement of the search, not a
      // departure from it, and the next thing the user does is keep typing.
      input.focus();
    });
    return { toggle, button };
  });

  function action(
    label: string,
    title: string,
    run: (view: EditorView) => boolean,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'findbar__action';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', () => {
      run(view);
      view.focus();
    });
    return button;
  }

  const previous = action('‹', 'Previous match', findPrevious);
  const next = action('›', 'Next match', findNext);
  const close = action('×', 'Close find', closeSearchPanel);
  close.classList.add('findbar__close');

  const replaceInput = document.createElement('input');
  replaceInput.className = 'findbar__input findbar__replace';
  replaceInput.type = 'text';
  replaceInput.placeholder = 'Replace';
  replaceInput.setAttribute('aria-label', 'Replace with');

  /**
   * Replace, made to work on the first click.
   *
   * `replaceNext` only replaces when the selection is *exactly* a match; with
   * the caret anywhere else it merely moves to the next one. Typing a query and
   * clicking Replace leaves the caret wherever it was, so the button would do
   * nothing visible the first time and replace on the second -- and the same for
   * Enter in the replace field.
   *
   * Stepping to a match first makes one click mean one replacement. The count is
   * capped and this runs on a click rather than a keystroke, so walking the
   * document to ask "are we on a match" is affordable here in a way it would not
   * be on the typing path.
   */
  function replaceCurrent(target: EditorView): boolean {
    if (countMatches(target.state, getSearchQuery(target.state)).current === 0) findNext(target);
    return replaceNext(target);
  }

  const replaceOne = action('Replace', 'Replace this match', replaceCurrent);
  const replaceEvery = action('Replace All', 'Replace every match', replaceAll);
  replaceOne.classList.add('findbar__wide');
  replaceEvery.classList.add('findbar__wide');

  replaceInput.addEventListener('input', () => {
    apply(withChange(currentQuery(), { replace: replaceInput.value }));
  });

  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Enter in the *replace* field replaces, rather than searching on -- which
      // is what every editor with this bar does, and the only reading of Enter
      // here that is not just "the find field, but further away".
      replaceCurrent(view);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });

  input.addEventListener('input', () => {
    apply(withChange(currentQuery(), { search: input.value }));
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Shift+Enter searches backwards, the convention every editor shares.
      (event.shiftKey ? findPrevious : findNext)(view);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
      // Back to the text, or Escape would leave focus on a panel that is gone.
      view.focus();
    }
  });

  // Two rows, and the second is hidden until Ctrl+H asks for it. Ctrl+F is the
  // common case by a wide margin, and a replace field nobody asked for is a
  // second thing to read past every time you look for a word.
  const findRow = document.createElement('div');
  findRow.className = 'findbar__row';
  findRow.append(input, count, previous, next, ...toggles.map((t) => t.button), close);

  const replaceRow = document.createElement('div');
  replaceRow.className = 'findbar__row findbar__row--replace';
  replaceRow.append(replaceInput, replaceOne, replaceEvery);

  dom.append(findRow, replaceRow);

  /** Pushes the search state into the DOM. The panel never holds its own copy. */
  function sync(): void {
    const query = currentQuery();
    if (input.value !== query.search) input.value = query.search;
    if (replaceInput.value !== query.replace) replaceInput.value = query.replace;
    for (const { toggle, button } of toggles) {
      button.setAttribute('aria-pressed', query[toggle.key] ? 'true' : 'false');
    }
    count.textContent = matchLabel(query, countMatches(view.state, query));
  }

  return {
    dom,
    // Above the editor, where every Windows editor puts it.
    top: true,
    mount() {
      sync();
      // **The panel has to focus itself.** `openSearchPanel` only focuses a
      // panel that is *already* open: when there is none it dispatches
      // `togglePanel` and returns, so the first Ctrl+F opened a bar nobody was
      // typing into and a second press was needed to get into it. Reported by
      // the owner. CodeMirror's own default panel does exactly this in its own
      // `mount`, which is what makes `main-field` work at all -- the attribute
      // marks the field, it does not focus it.
      //
      // Both, explicitly. CodeMirror's own panel calls only `select()` and
      // relies on it focusing as a side effect, which real browsers do and
      // jsdom does not -- so leaning on that would have made this untestable
      // here and left the fix resting on an implicit behaviour. `select()` is
      // still wanted for its actual job: it selects whatever query is already
      // in the box, so reopening find and typing replaces the last search
      // rather than appending to it.
      input.focus();
      input.select();
    },
    update(update) {
      // The count depends on the document and on which match is selected, not
      // only on the query -- so an edit or a `findNext` has to refresh it too.
      if (update.docChanged || update.selectionSet || update.transactions.length > 0) sync();
    },
  };
}

/** The class that reveals the replace row; also how `openReplacePanel` asks. */
const REPLACING = 'findbar--replacing';

/**
 * Ctrl+H: open the panel with the replace row showing, and put the cursor in it.
 *
 * A `Command`, so it slots into the keymap beside `openSearchPanel` and returns
 * the same "I handled this" boolean.
 *
 * Whether the replace row is showing is held as a class on the panel rather than
 * as editor state, and that is a deliberate limit rather than an oversight. It
 * is a property of *this panel instance* -- CodeMirror throws the panel away on
 * close and builds a fresh one on open, so "showing" cannot outlive it anyway,
 * and a `StateField` would be modelling a lifetime the DOM already owns. The
 * cost is that reopening with Ctrl+F shows the find row alone, which is what
 * every editor with this bar does.
 *
 * `openSearchPanel` first: it creates the panel when there is none, and the
 * panel plugin builds it synchronously inside that dispatch, so the DOM below is
 * there by the time this reads it. When one is already open it focuses the find
 * field -- which is why the replace field is focused *after*, not before.
 */
export function openReplacePanel(view: EditorView): boolean {
  openSearchPanel(view);

  const bar = view.dom.querySelector<HTMLElement>('.findbar');
  if (bar === null) return false;

  bar.classList.add(REPLACING);
  const replaceInput = bar.querySelector<HTMLInputElement>('.findbar__replace');
  replaceInput?.focus();
  replaceInput?.select();
  return true;
}
