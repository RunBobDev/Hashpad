// @vitest-environment jsdom
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { store, setEditorView } from '../state/appcontext';
import {
  DEFAULT_OUTLINE_WIDTH,
  EMPTY_STATUS,
  createUntitledDocument,
  isDirty,
  DEFAULT_BEHAVIOUR,
  type EditorBehaviour,
} from '../state/document';
import { COMMAND_EVENT } from '../ui/menubar';
import { COMMANDS, toEditorCommand } from './commands';
import { buildExtensions, setWordWrap } from './extensions';

/**
 * The baseline `AppState` every describe block below resets to in its
 * `afterEach`, so a mounted view's writes in one test (a document, an active
 * id, a published `activeFormats` string) don't leak into another test that
 * happens to run in the same worker. Pulled out once rather than repeated at
 * each call site -- Task 5 added `activeFormats`, and duplicating the literal
 * in three places would have meant three chances to forget it.
 */
function resetStore(): void {
  store.setState(() => ({
    documents: [],
    activeDocumentId: null,
    isDark: false,
    closedPaths: [],
    activeFormats: '',
    pinnedToolbarCommands: [],
    previewSplitRatio: 0.5,
    syncScroll: true,
    wordWrap: true,
    editorBehaviour: DEFAULT_BEHAVIOUR,
    defaultViewMode: 'source',
    status: EMPTY_STATUS,
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
  }));
}

/**
 * Mounts a real `EditorView` on the app's actual extension stack
 * (`buildExtensions`), so a test exercises the same keymap precedence and the
 * same update listeners (`syncActiveDocument`, `syncActiveFormats`) the
 * running app does -- not a hand-built state that happens to look similar.
 * The cursor starts at the document's head; tests that care about a specific
 * position or selection dispatch it themselves (see the bold test below).
 */
function mountView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: buildExtensions(false) }),
    parent: document.createElement('div'),
  });
}

/**
 * Dispatches a real `KeyboardEvent` on the view's editable root so
 * CodeMirror's own keymap dispatch runs -- calling a command function
 * directly would prove the command works, not that the *binding* fires,
 * which is the point of every test that uses this. Returns whether the key
 * was left unhandled (mirrors `tab command keymap`'s local `press` below).
 */
function pressKey(view: EditorView, init: KeyboardEventInit): boolean {
  return view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }));
}

/**
 * Records every `hashpad:command` dispatched on `document` while active.
 * Shared at file scope (rather than living only inside `describe('tab
 * command keymap')`, where it started) because the formatting keymap tests
 * below need it too: `Mod-1`'s heading binding sits right next to the
 * `Mod-Alt-1..9` tab-position loop in extensions.ts, and proving Ctrl+1
 * "does not switch tabs" means proving no `tab.goto*` event fired, not just
 * that the document changed.
 */
function captureCommands(): { seen: string[]; stop: () => void } {
  const seen: string[] = [];
  const listener = (event: Event): void => {
    seen.push((event as CustomEvent<string>).detail);
  };
  document.addEventListener(COMMAND_EVENT, listener);
  return { seen, stop: () => document.removeEventListener(COMMAND_EVENT, listener) };
}

/**
 * The rest of the suite runs under Vitest's default DOM-less `node`
 * environment (see vite.config.ts), because CodeMirror's `EditorView`
 * genuinely needs a `document` to construct itself — it always builds its
 * own DOM subtree even when given no `parent` to mount into. This file
 * opts into jsdom (the `// @vitest-environment jsdom` docblock above, which
 * must stay on line 1) specifically so it can construct a real `EditorView`
 * and prove the update listener registered in `buildExtensions` actually
 * fires end-to-end, rather than asserting only that the right callback was
 * passed to `EditorView.updateListener.of(...)`.
 */
describe('syncActiveDocument update listener', () => {
  afterEach(resetStore);

  it('writes a document change back into the store, flipping the active document dirty', () => {
    const initialState = EditorState.create({ doc: 'hello', extensions: buildExtensions(false) });
    const view = new EditorView({ state: initialState, parent: document.createElement('div') });
    setEditorView(view);

    // Mirrors main.ts's bootstrap: the document's EditorState is the same
    // instance the view was constructed with, so the two start in sync.
    const doc = createUntitledDocument(initialState);
    store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));
    expect(isDirty(store.getState().documents[0]!)).toBe(false);

    view.dispatch({ changes: { from: 5, insert: '!' } });

    const updated = store.getState().documents.find((d) => d.id === doc.id);
    expect(updated).toBeDefined();
    expect(updated!.editorState.doc.toString()).toBe('hello!');
    expect(isDirty(updated!)).toBe(true);

    view.destroy();
  });

  it('does not touch the store on a selection-only update', () => {
    const initialState = EditorState.create({ doc: 'hello', extensions: buildExtensions(false) });
    const view = new EditorView({ state: initialState, parent: document.createElement('div') });
    setEditorView(view);

    const doc = createUntitledDocument(initialState);
    store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));

    view.dispatch({ selection: { anchor: 1 } });

    const updated = store.getState().documents.find((d) => d.id === doc.id);
    expect(updated).toBeDefined();
    // Same EditorState reference: the listener never fired a store write.
    expect(updated!.editorState).toBe(doc.editorState);
    expect(isDirty(updated!)).toBe(false);

    view.destroy();
  });
});

/**
 * The status bar's data (SPEC 6.11). Its own listener rather than a branch of
 * `syncActiveDocument` above, and these two tests are why: the column and --
 * because the counts describe the selection when there is one -- the counts
 * both change on a selection-only move, which `syncActiveDocument` deliberately
 * ignores.
 */
describe('syncStatus update listener', () => {
  afterEach(resetStore);

  function mountView(doc: string): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: buildExtensions(false) }),
      parent: document.createElement('div'),
    });
    setEditorView(view);
    return view;
  }

  it('publishes the caret and the counts on an edit', () => {
    const view = mountView('one two');

    // `selection` as well as `changes`, because that is what typing does -- an
    // insert on its own leaves a caret that sits before it exactly where it was,
    // so the column would not move and the assertion would pin nothing.
    view.dispatch({ changes: { from: 7, insert: ' three' }, selection: { anchor: 13 } });

    expect(store.getState().status).toEqual({
      line: 1,
      col: 14,
      words: 3,
      chars: 13,
      selection: false,
    });

    view.destroy();
  });

  /**
   * The distinguishing case. `syncActiveDocument` returns early here, so a
   * status bar wired to the store's active document instead of to this listener
   * would freeze its column the moment the user stopped typing and started
   * arrowing around.
   */
  it('publishes on a selection-only move, which syncActiveDocument ignores', () => {
    const view = mountView('one two three');
    view.dispatch({ selection: { anchor: 0 } });
    const before = store.getState().status;

    view.dispatch({ selection: { anchor: 4, head: 7 } });

    const after = store.getState().status;
    expect(before.selection).toBe(false);
    expect(after).toEqual({ line: 1, col: 8, words: 1, chars: 3, selection: true });

    view.destroy();
  });
});

/**
 * The tab keymap lives inside a real `Prec.high(keymap.of([...]))` block, and
 * CodeMirror's key handling (`handleKeyEvents` in @codemirror/view) is wired
 * up as a `keydown` DOM listener on `view.contentDOM` -- so the only way to
 * prove a binding actually fires (as opposed to merely appearing in the
 * `keymap.of([...])` array with the right-looking `key` string) is to
 * construct a real `EditorView` and dispatch a real `KeyboardEvent` at it,
 * the same technique the describe block above already established works
 * under jsdom.
 *
 * `dispatchEvent`'s return value doubles as a "was this consumed" check:
 * `dispatchCommand`'s handler always returns `true`, which CodeMirror's
 * `runHandlers` treats as "call `event.preventDefault()`", which makes
 * `dispatchEvent` itself return `false`. That is what lets the plain-Tab test
 * below assert not just "no command fired" but "the key was left alone",
 * which is the actual regression this task's hazard warns about.
 */
describe('tab command keymap', () => {
  afterEach(resetStore);

  function buildView(): EditorView {
    return new EditorView({
      state: EditorState.create({ doc: '', extensions: buildExtensions(false) }),
      parent: document.createElement('div'),
    });
  }

  /** Dispatches a real keydown on the view's editable root; returns whether it was left unhandled. */
  function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): boolean {
    return view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, cancelable: true, ...modifiers }),
    );
  }

  it('dispatches tab.close on Mod-w and consumes the key', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    const notHandled = press(view, 'w', { ctrlKey: true });

    expect(seen).toEqual(['tab.close']);
    expect(notHandled).toBe(false);

    stop();
    view.destroy();
  });

  /**
   * SPEC §6.14, and reported by the owner as not working: the View entry was
   * greyed out and the shortcut did nothing. F11 has no modifier, so unlike the
   * chords around it there is nothing to consume it from the browser -- what
   * matters is only that the binding is reached.
   */
  it('dispatches view.fullscreen on F11', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    press(view, 'F11');

    expect(seen).toEqual(['view.fullscreen']);

    stop();
    view.destroy();
  });

  it('dispatches tab.reopen on Mod-Shift-t', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    press(view, 't', { ctrlKey: true, shiftKey: true });

    expect(seen).toEqual(['tab.reopen']);

    stop();
    view.destroy();
  });

  // Ctrl+Shift+P is a Chromium chord (it opens the command menu in DevTools),
  // so like the Ctrl-Tab case below this one has to be consumed, not merely
  // observed.
  it('dispatches view.preview on Mod-Shift-p and consumes the key', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    const notHandled = press(view, 'p', { ctrlKey: true, shiftKey: true });

    expect(seen).toEqual(['view.preview']);
    expect(notHandled).toBe(false);

    stop();
    view.destroy();
  });

  it('dispatches tab.next on Ctrl-Tab and consumes the key', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    const notHandled = press(view, 'Tab', { ctrlKey: true });

    expect(seen).toEqual(['tab.next']);
    // The genuine hazard this task calls out: if Ctrl-Tab were left
    // unconsumed, WebView2 could still treat it as its own tab-switching
    // chord even after our handler ran.
    expect(notHandled).toBe(false);

    stop();
    view.destroy();
  });

  it('dispatches tab.previous on Ctrl-Shift-Tab', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    press(view, 'Tab', { ctrlKey: true, shiftKey: true });

    expect(seen).toEqual(['tab.previous']);

    stop();
    view.destroy();
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('dispatches tab.goto%i on Mod-Alt-%i', (n) => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    press(view, String(n), { ctrlKey: true, altKey: true });

    expect(seen).toEqual([`tab.goto${n}`]);

    stop();
    view.destroy();
  });

  /**
   * Plain Tab must not reach a *tab-switching* command -- the original point of
   * this test, when Tab was unbound entirely and the worry was Ctrl-Tab's
   * high-precedence binding swallowing a bare one.
   *
   * Tab is bound now (H.2: `insertSpaces` means nothing otherwise), so what it
   * must not do has changed from "anything" to "anything but indent". The
   * separate question of *what* it inserts is covered in the indentation suite
   * below.
   */
  it('routes plain Tab to indentation, never to a tab command', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    const notHandled = press(view, 'Tab');

    expect(seen).toEqual([]);
    // Consumed now, where it used to fall through: an editor that indents on
    // Tab has to claim the key.
    expect(notHandled).toBe(false);

    stop();
    view.destroy();
  });
});

/**
 * SPEC §6.13's `tabSize` and `insertSpaces`, which are the two settings that
 * cannot be observed without a Tab binding -- CodeMirror ships none by default,
 * and `defaultKeymap` has no Tab entry, so before H.2 both settings were fields
 * in a JSON file with nothing reading them.
 */
describe('indentation from settings', () => {
  afterEach(resetStore);

  function viewWith(behaviour: Partial<EditorBehaviour>, doc = ''): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: buildExtensions(false, true, { ...DEFAULT_BEHAVIOUR, ...behaviour }),
      }),
      parent: document.createElement('div'),
    });
  }

  /**
   * `keyCode: 9` is load-bearing, not ceremony. CodeMirror's tab-focus-mode
   * guard tests `event.keyCode == 9` rather than `key`, and jsdom leaves
   * `keyCode` at 0 for a synthetic event -- so without it the escape-hatch test
   * below passes for the wrong reason, and would keep passing with the whole
   * mechanism removed.
   */
  function tab(view: EditorView, modifiers: KeyboardEventInit = {}): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, cancelable: true, ...modifiers }),
    );
  }

  it('inserts spaces when insertSpaces is on', () => {
    const view = viewWith({ insertSpaces: true, tabSize: 2 });

    tab(view);

    expect(view.state.doc.toString()).toBe('  ');
    view.destroy();
  });

  it('takes the number of spaces from tabSize', () => {
    const view = viewWith({ insertSpaces: true, tabSize: 4 });

    tab(view);

    expect(view.state.doc.toString()).toBe('    ');
    view.destroy();
  });

  /**
   * The setting's whole point, and the reason `@codemirror/commands`' own
   * `insertTab` could not be used: it hard-codes a literal tab, so with it
   * `insertSpaces` would have had nothing to change.
   */
  it('inserts a tab character when insertSpaces is off', () => {
    const view = viewWith({ insertSpaces: false, tabSize: 4 });

    tab(view);

    expect(view.state.doc.toString()).toBe(String.fromCharCode(9));
    view.destroy();
  });

  /**
   * With something selected, Tab indents whole lines rather than replacing the
   * selection with two spaces -- which is what typing any other character does,
   * and would silently delete the user's text.
   */
  it('indents the selected lines rather than replacing them', () => {
    const view = viewWith({ insertSpaces: true, tabSize: 2 }, 'one\ntwo');
    view.dispatch({ selection: { anchor: 0, head: 7 } });

    tab(view);

    expect(view.state.doc.toString()).toBe('  one\n  two');
    view.destroy();
  });

  it('outdents on Shift+Tab', () => {
    const view = viewWith({ insertSpaces: true, tabSize: 2 }, '    one');
    view.dispatch({ selection: { anchor: 0, head: 7 } });

    tab(view, { shiftKey: true });

    expect(view.state.doc.toString()).toBe('  one');
    view.destroy();
  });

  /**
   * Binding Tab takes away the keyboard's way out of the editor, which
   * CodeMirror's own docs warn about. Two ways back, and both are the package's
   * own rather than anything invented here.
   *
   * Asserted as "the document is unchanged", because that is the user-visible
   * half. Whether focus then moves is the browser's business, and jsdom does not
   * model it.
   */
  it('stops indenting after Ctrl+M turns tab-focus mode on', () => {
    const view = viewWith({ insertSpaces: true, tabSize: 2 });

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', keyCode: 77, ctrlKey: true, cancelable: true }),
    );
    tab(view);

    expect(view.state.doc.toString()).toBe('');
    view.destroy();
  });

  /**
   * The discoverable one, and it needed no binding at all: CodeMirror turns
   * tab-focus mode on for two seconds after Escape. Worth a test because it is
   * the route a user will actually find, and because nothing in this codebase
   * would otherwise record that it exists.
   */
  it('stops indenting for a moment after Escape', () => {
    const view = viewWith({ insertSpaces: true, tabSize: 2 });

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, cancelable: true }),
    );
    tab(view);

    expect(view.state.doc.toString()).toBe('');
    view.destroy();
  });

  /** A literal tab in an opened document renders at the configured width. */
  it('sets the tab width for tabs already in the document', () => {
    const view = viewWith({ tabSize: 7 });

    expect(view.state.tabSize).toBe(7);
    view.destroy();
  });
});

/** SPEC §6.13's `showLineNumbers`, off by default. */
describe('line numbers from settings', () => {
  afterEach(resetStore);

  function gutters(behaviour: Partial<EditorBehaviour>): number {
    const view = new EditorView({
      state: EditorState.create({
        extensions: buildExtensions(false, true, { ...DEFAULT_BEHAVIOUR, ...behaviour }),
      }),
      parent: document.createElement('div'),
    });
    const count = view.dom.querySelectorAll('.cm-lineNumbers').length;
    view.destroy();
    return count;
  }

  it('shows no gutter by default', () => {
    expect(gutters({})).toBe(0);
  });

  it('shows one when the setting is on', () => {
    expect(gutters({ showLineNumbers: true })).toBe(1);
  });
});

/**
 * `testdoc.ts`'s `testState` enables `EditorState.allowMultipleSelections`
 * for the command test suites, with a comment that used to claim the shipped
 * editor did not need the same facet because nothing in it created multiple
 * cursors yet. That was true when it was written and became false the moment
 * multi-cursor commands shipped, and nothing would have caught the drift: a
 * state built the normal way (`EditorState.create({ extensions:
 * buildExtensions(...) })`) would silently collapse any multi-range
 * selection back to one, in production, while every command test kept
 * passing against `testState`'s more permissive state. This test builds a
 * state the same way the app does and asserts the facet is actually on,
 * so a future change that drops it here fails a test instead of only
 * showing up as "second cursor doesn't work" in the running app.
 */
describe('allowMultipleSelections', () => {
  it('permits a state built from buildExtensions to carry more than one selection range', () => {
    const state = EditorState.create({ doc: 'one two', extensions: buildExtensions(false) });

    const next = state.update({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
    }).state;

    expect(next.selection.ranges).toHaveLength(2);
  });
});

/**
 * Task 5: every formatting command bound to its shortcut, through the same
 * `toEditorCommand` adapter the toolbar will use later. These tests dispatch
 * real `KeyboardEvent`s at `view.contentDOM` (via `pressKey` above) rather
 * than calling `COMMANDS.bold` directly, because a command existing is not
 * the same claim as a *binding* existing -- Task 2-4's own test files already
 * cover the commands themselves.
 */
describe('formatting command keymap', () => {
  afterEach(resetStore);

  it('applies bold with Ctrl+B', () => {
    const view = mountView('hello');
    view.dispatch({ selection: EditorSelection.range(0, 5) });
    pressKey(view, { key: 'b', ctrlKey: true });
    expect(view.state.doc.toString()).toBe('**hello**');
    view.destroy();
  });

  // `Mod-1` (heading) sits right next to the `Mod-Alt-1..9` tab-position loop
  // in extensions.ts -- a stray `Alt` in either binding's spelling would
  // route Ctrl+1 to `tab.goto1` instead. `captureCommands` makes "does not
  // switch tabs" a direct assertion, not just an inference from the document
  // changing (dispatchCommand's handlers never touch the document, so a
  // heading-shaped result already implies no tab command fired -- but
  // asserting it directly is what actually matches the test's name).
  it('applies a heading with Ctrl+1 and does not switch tabs', () => {
    const view = mountView('Title');
    const { seen, stop } = captureCommands();

    pressKey(view, { key: '1', ctrlKey: true });

    expect(view.state.doc.toString()).toBe('# Title');
    expect(seen).toEqual([]);

    stop();
    view.destroy();
  });

  // Verified Facts §3: event.key is '*' for this chord, and CodeMirror matches
  // it through the base-layout name derived from keyCode. If this test fails,
  // the whole shifted-punctuation family is broken, not just this one.
  it('applies a bullet list with Ctrl+Shift+8', () => {
    const view = mountView('item');
    pressKey(view, { key: '*', code: 'Digit8', keyCode: 56, ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe('- item');
    view.destroy();
  });

  // SPEC §6.5 assigns Ctrl+Shift+T to Table, but §6.2/§6.14 assign it to
  // Reopen Closed Tab, which shipped in Checkpoint C. The owner kept
  // reopen-tab and moved Table to Ctrl+Alt+T.
  //
  // `keyCode` is load-bearing here, not decoration. CodeMirror stores the
  // binding lowercased (`Ctrl-Shift-t`) and does no case folding, so an event
  // carrying only `key: 'T'` matches *no binding at all* -- the test would
  // then pass even if someone bound Table to Mod-Shift-t, which is the one
  // regression it exists to catch. A real keyboard supplies keyCode 84, and
  // `base[84] === 't'` is what drives the match.
  it('leaves Ctrl+Shift+T to reopen-tab rather than inserting a table', () => {
    const view = mountView('x');
    const { seen, stop } = captureCommands();
    pressKey(view, { key: 'T', code: 'KeyT', keyCode: 84, ctrlKey: true, shiftKey: true });
    stop();
    expect(seen).toEqual(['tab.reopen']);
    expect(view.state.doc.toString()).toBe('x');
    view.destroy();
  });

  it('inserts a table with Ctrl+Alt+T', () => {
    const view = mountView('');
    pressKey(view, { key: 't', code: 'KeyT', keyCode: 84, ctrlKey: true, altKey: true });
    expect(view.state.doc.toString()).toContain('| Column 1 |');
    view.destroy();
  });

  // The bindings not covered individually above. A transposition between two
  // chords in the same family -- Ctrl+Shift+7 on bulletList instead of
  // numberedList -- produces a document, so a test asserting only "something
  // changed" would miss it. Each row pins the document the *named* command
  // produces.
  it.each([
    ['italic', { key: 'i', code: 'KeyI', keyCode: 73, ctrlKey: true }, '*word*'],
    [
      'strikethrough',
      { key: 'X', code: 'KeyX', keyCode: 88, ctrlKey: true, shiftKey: true },
      '~~word~~',
    ],
    [
      'highlight',
      { key: 'H', code: 'KeyH', keyCode: 72, ctrlKey: true, shiftKey: true },
      '==word==',
    ],
    ['inlineCode', { key: '`', code: 'Backquote', keyCode: 192, ctrlKey: true }, '`word`'],
    [
      'numberedList',
      { key: '&', code: 'Digit7', keyCode: 55, ctrlKey: true, shiftKey: true },
      '1. word',
    ],
    [
      'taskList',
      { key: '(', code: 'Digit9', keyCode: 57, ctrlKey: true, shiftKey: true },
      '- [ ] word',
    ],
    [
      'blockquote',
      { key: '>', code: 'Period', keyCode: 190, ctrlKey: true, shiftKey: true },
      '> word',
    ],
    ['heading3', { key: '3', code: 'Digit3', keyCode: 51, ctrlKey: true }, '### word'],
    ['heading5', { key: '5', code: 'Digit5', keyCode: 53, ctrlKey: true }, '##### word'],
    // The five insert commands sit on adjacent lines in the keymap array,
    // which is where a transposition is most plausible.
    ['link', { key: 'k', code: 'KeyK', keyCode: 75, ctrlKey: true }, '[word](url)'],
    [
      'image',
      { key: 'I', code: 'KeyI', keyCode: 73, ctrlKey: true, shiftKey: true },
      '![word](path)',
    ],
    [
      'horizontalRule',
      { key: '_', code: 'Minus', keyCode: 189, ctrlKey: true, shiftKey: true },
      'word\n\n---\n',
    ],
    [
      'footnote',
      { key: 'F', code: 'KeyF', keyCode: 70, ctrlKey: true, shiftKey: true },
      'word[^1]\n\n[^1]: \n',
    ],
    [
      'codeBlock',
      { key: 'K', code: 'KeyK', keyCode: 75, ctrlKey: true, shiftKey: true },
      '```\nword\n```\n',
    ],
  ] as const)('%s fires on its own chord and produces its own markup', (_name, init, expected) => {
    const view = mountView('word');
    view.dispatch({ selection: EditorSelection.range(0, 4) });
    pressKey(view, init);
    expect(view.state.doc.toString()).toBe(expected);
    view.destroy();
  });

  // Both chords are claimed by catch-all bindings sitting *last inside the
  // Prec.high array* (not a lower-precedence one -- what they exist to beat
  // is defaultKeymap, which sits between the two), so that a declining
  // command means nothing happens rather than something else happening.
  //
  // The consumed-ness assertion is the load-bearing one, and it is the whole
  // reason the Ctrl+B row exists. Without it that row cannot fail: bold
  // already declines, so the document and selection are unchanged whether or
  // not the catch-all is there, and only Ctrl+I would redden (via
  // selectParentSyntax). `dispatchEvent` returns false precisely when
  // preventDefault ran, which is what stops Chromium's own bold/italic from
  // reaching a contentDOM that is a real contenteditable.
  it.each([
    ['Ctrl+B', { key: 'b', code: 'KeyB', keyCode: 66, ctrlKey: true }],
    ['Ctrl+I', { key: 'i', code: 'KeyI', keyCode: 73, ctrlKey: true }],
  ] as const)('%s inside a fence consumes the key and changes nothing', (_name, init) => {
    const doc = '```js\nlet x = 1;\n```';
    const view = mountView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('let')) });
    const before = view.state.selection.main;
    expect(pressKey(view, init)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.from).toBe(before.from);
    expect(view.state.selection.main.to).toBe(before.to);
    view.destroy();
  });

  it('publishes active formats to the store on selection change', () => {
    const view = mountView('**bold**');
    view.dispatch({ selection: EditorSelection.cursor(4) });
    expect(store.getState().activeFormats).toBe('bold');
    view.destroy();
  });

  /**
   * `toEditorCommand` must keep returning `false` when its command declines
   * -- that is what lets a chord fall through to another binding, and an
   * "always return true" regression would silently break every fall-through
   * in the file.
   *
   * Asserted against the adapter directly rather than through a keypress.
   * The keymap-level assertion this replaces (`pressKey` returns true, i.e.
   * preventDefault was never called) stopped meaning what its name said the
   * moment `Mod-b`/`Mod-i` gained their fall-through-blocking bindings: the
   * key is now deliberately consumed even though the command declines, so a
   * keypress can no longer distinguish "the adapter returned false" from
   * "the adapter returned true". The two facts are now pinned separately --
   * this test owns the adapter's return value, and the pair above owns the
   * user-visible outcome of pressing the key.
   */
  it('toEditorCommand reports false when its command declines', () => {
    const doc = '```js\nlet x = 1;\n```';
    const view = mountView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('let')) });

    expect(toEditorCommand(COMMANDS.bold)(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);

    // And true where the command does apply, so the test cannot pass by the
    // adapter simply always returning false.
    const view2 = mountView('word');
    view2.dispatch({ selection: EditorSelection.range(0, 4) });
    expect(toEditorCommand(COMMANDS.bold)(view2)).toBe(true);

    view.destroy();
    view2.destroy();
  });
});

/**
 * SPEC §6.6: on by default, toggleable, and it must survive the toggle without
 * costing the document its undo history -- which is why it is a Compartment and
 * not a rebuild of the state.
 *
 * `EditorView.lineWrapping` is a theme extension, so the observable is the class
 * CodeMirror puts on the content element rather than a facet value.
 */
describe('word wrap', () => {
  function viewWith(wordWrap: boolean): EditorView {
    return new EditorView({
      state: EditorState.create({ doc: 'x', extensions: buildExtensions(false, wordWrap) }),
    });
  }

  it('wraps by default', () => {
    const view = viewWith(true);
    expect(view.contentDOM.className).toContain('cm-lineWrapping');
    view.destroy();
  });

  it('does not wrap when built with it off', () => {
    const view = viewWith(false);
    expect(view.contentDOM.className).not.toContain('cm-lineWrapping');
    view.destroy();
  });

  it('turns off and back on without rebuilding the state', () => {
    const view = viewWith(true);
    const before = view.state;

    setWordWrap(view, false);
    expect(view.contentDOM.className).not.toContain('cm-lineWrapping');

    setWordWrap(view, true);
    expect(view.contentDOM.className).toContain('cm-lineWrapping');

    // Same document, reconfigured -- not a new EditorState, which would have
    // thrown away the undo history and the selection.
    expect(view.state.doc).toBe(before.doc);
    view.destroy();
  });
});

/**
 * The editor's stack must swallow file drops, because `ui/filedrop.ts` turns
 * them into tabs (SPEC §6.4). Asserted here, on `buildExtensions`, and not only
 * in `filedrop.test.ts`: that file proves the extension works, this one proves
 * the editor actually has it. Deleting the line in extensions.ts leaves the
 * other file green.
 */
describe('file drops in the editor', () => {
  it('does not paste a dropped file into the document', async () => {
    const view = mountView('hello');

    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [new File(['dropped text'], 'a.md')], getData: () => '' },
    });
    Object.defineProperty(event, 'clientX', { value: 0 });
    Object.defineProperty(event, 'clientY', { value: 0 });
    view.contentDOM.dispatchEvent(event);

    // CodeMirror reads the file with a FileReader, so the insertion this guards
    // against would land after the dispatch returns.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(view.state.doc.toString()).toBe('hello');
    view.destroy();
  });
});

/**
 * The paste handler has to be in the stack, not merely correct in its own file
 * (SPEC §6.10). Deleting the line in extensions.ts leaves imageops.test.ts
 * green, which is the whole reason this lives here.
 *
 * Asserted on the document's contents, not on `defaultPrevented`: CodeMirror's
 * own paste handler claims *every* paste and prevents the default, so that flag
 * is true either way and the first version of this test passed against a stack
 * with the handler removed. What actually differs is that CodeMirror pastes the
 * clipboard's **text** flavour -- for an image copied from Explorer, its file
 * path -- and that is the outcome worth pinning.
 *
 * With no active document `pasteImage` claims the event and stops, so this needs
 * no store, no IPC and no clipboard plumbing beyond the event itself.
 */
describe('pasting an image into the editor', () => {
  function paste(view: EditorView, items: unknown[], text: string): void {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { items, getData: () => text },
    });
    view.contentDOM.dispatchEvent(event);
  }

  const imageItem = {
    kind: 'file',
    type: 'image/png',
    getAsFile: () => new File([new Uint8Array([1])], 'c.png', { type: 'image/png' }),
  };

  it('does not paste the text flavour of an image', () => {
    store.setState((prev) => ({ ...prev, activeDocumentId: null }));
    const view = mountView('hello');

    paste(view, [imageItem], 'the text flavour');

    expect(view.state.doc.toString()).toBe('hello');
    view.destroy();
  });

  /** And an ordinary text paste still goes in. */
  it('leaves a text paste to CodeMirror', () => {
    store.setState((prev) => ({ ...prev, activeDocumentId: null }));
    const view = mountView('hello');

    paste(view, [], 'pasted');

    expect(view.state.doc.toString()).toBe('pastedhello');
    view.destroy();
  });
});
