// @vitest-environment jsdom
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { store, setEditorView } from '../state/appcontext';
import { createUntitledDocument, isDirty } from '../state/document';
import { COMMAND_EVENT } from '../ui/menubar';
import { buildExtensions } from './extensions';

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

  it('dispatches tab.reopen on Mod-Shift-t', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    press(view, 't', { ctrlKey: true, shiftKey: true });

    expect(seen).toEqual(['tab.reopen']);

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
   * The regression check the task brief asks for by name: verify plain Tab
   * (no modifiers) is untouched by adding Ctrl-Tab. It was already the case
   * before this task that Tab did nothing special here -- buildExtensions
   * never adds @codemirror/commands' `indentWithTab`, and `defaultKeymap`
   * itself carries no Tab entry (checked directly against the installed
   * @codemirror/commands package) -- so there was no indent-on-Tab behaviour
   * to begin with, and none for this task to have broken. What matters is
   * that our new Ctrl-Tab binding, added at high precedence, does not also
   * swallow a bare Tab keydown.
   */
  it('leaves plain Tab unhandled -- no tab command fires and the key is not consumed', () => {
    const view = buildView();
    const { seen, stop } = captureCommands();

    const notHandled = press(view, 'Tab');

    expect(seen).toEqual([]);
    expect(notHandled).toBe(true);

    stop();
    view.destroy();
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

  it('leaves Ctrl+Shift+T to reopen-tab rather than inserting a table', () => {
    const view = mountView('x');
    pressKey(view, { key: 'T', ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe('x');
    view.destroy();
  });

  it('publishes active formats to the store on selection change', () => {
    const view = mountView('**bold**');
    view.dispatch({ selection: EditorSelection.cursor(4) });
    expect(store.getState().activeFormats).toBe('bold');
    view.destroy();
  });

  /**
   * Carried decision #2 (see task-5-report.md): `toEditorCommand` returns
   * `false` when the wrapped command declines, and `bold` declines inside a
   * fenced code block (commands.ts's `declinesInFence`). This pins what that
   * actually does at the binding level: the document is untouched (no
   * literal `**` written into someone's source), and -- unlike every
   * `dispatchCommand`-wrapped file/tab binding just above, which always
   * returns `true` -- the key is left *unconsumed* (`dispatchEvent` returns
   * `true`, meaning `preventDefault` was never called), so it genuinely falls
   * through to whatever the browser would otherwise do with it. jsdom has no
   * native "bold this contenteditable selection" fallback to observe, so this
   * test cannot prove what a real Chromium/WebView2 does next -- only that
   * CodeMirror hands the key onward rather than swallowing it. See the task
   * report for the investigation into what receives it in the real app.
   */
  it('declines Ctrl+B inside a fenced code block and leaves the key unconsumed', () => {
    const doc = '```js\nlet x = 1;\n```';
    const view = mountView(doc);
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('let')) });
    const notHandled = pressKey(view, { key: 'b', ctrlKey: true });
    expect(view.state.doc.toString()).toBe(doc);
    expect(notHandled).toBe(true);
    view.destroy();
  });
});
