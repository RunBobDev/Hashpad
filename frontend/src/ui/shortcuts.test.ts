// @vitest-environment jsdom
/**
 * A real `EditorView` built from the real `buildExtensions`, because the whole
 * point of this module is that it forwards to the keymap that file declares --
 * a stubbed view would prove the forwarding call happens and nothing about
 * whether any binding is reachable through it.
 *
 * Keys are dispatched at `window` with a target *outside* the editor, which is
 * the situation being fixed: focus on the preview, a tab, a toolbar button, or
 * `<body>` at startup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from '../editor/extensions';
import { store, setEditorView } from '../state/appcontext';
import { createUntitledDocument } from '../state/document';
import { COMMAND_EVENT } from './menubar';
import { mountShortcuts } from './shortcuts';

let view: EditorView;
let teardown: () => void;
/** Everything `hashpad:command` carried during a test, in order. */
let commands: string[];

function onCommand(event: Event): void {
  commands.push((event as CustomEvent<string>).detail);
}

beforeEach(() => {
  document.body.replaceChildren();
  const outside = document.createElement('div');
  const host = document.createElement('div');
  document.body.append(host, outside);

  view = new EditorView({
    state: EditorState.create({ doc: 'hello world', extensions: buildExtensions(false) }),
    parent: host,
  });
  setEditorView(view);
  const doc = createUntitledDocument(view.state);
  store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));

  commands = [];
  document.addEventListener(COMMAND_EVENT, onCommand);
  teardown = mountShortcuts(view);
});

afterEach(() => {
  teardown();
  document.removeEventListener(COMMAND_EVENT, onCommand);
  view.destroy();
});

/** The element focus sits on when the user has not clicked into the editor. */
function outsideTarget(): HTMLElement {
  return document.body.lastElementChild as HTMLElement;
}

/**
 * `keyCode` as well as `key`, because CodeMirror needs both to resolve a shifted
 * binding. A real Ctrl+Shift+P delivers `key: 'P'`, and `Mod-Shift-p` is how the
 * binding is written -- CodeMirror bridges the two through `base[event.keyCode]`
 * (w3c-keyname), which maps 80 back to 'p'. A synthetic event without `keyCode`
 * leaves that lookup at `base[0]`, so the chord silently matches nothing and the
 * test fails for a reason the product does not have.
 */
function press(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = outsideTarget(),
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    bubbles: true,
    cancelable: true,
    ...init,
  } as KeyboardEventInit);
  target.dispatchEvent(event);
  return event;
}

describe('mountShortcuts', () => {
  /**
   * The owner's report: "when I open Hashpad and press Ctrl+Shift+P, nothing
   * happens -- the only time I can use macros is when I press inside the
   * editor". Ctrl+Shift+P is routed through the `hashpad:command` bus, so
   * seeing the command on the bus is seeing the whole path work.
   */
  it('runs an app command pressed with focus outside the editor', () => {
    press('P', { ctrlKey: true, shiftKey: true });

    expect(commands).toEqual(['view.preview']);
  });

  /**
   * And an *editor* command, which takes the other path entirely -- it mutates
   * the view instead of emitting an event. Both halves of the keymap have to be
   * reachable or the fix is half a fix.
   */
  it('runs an editor command too, against the editor’s own state', () => {
    view.dispatch({ selection: { anchor: 0, head: 5 } });

    press('b', { ctrlKey: true });

    expect(view.state.doc.toString()).toBe('**hello** world');
  });

  /**
   * `runScopeHandlers` reports that a binding claimed the key but does not
   * suppress the browser's own behaviour -- that is `EditorView`'s DOM handler
   * doing it inside the editor, and there is nothing doing it out here. Without
   * the explicit call, Ctrl+O opens Chromium's file picker over ours.
   */
  it('prevents the browser default for a key the keymap claimed', () => {
    const event = press('o', { ctrlKey: true });

    expect(commands).toEqual(['file.open']);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a chord the keymap does not claim to the browser', () => {
    const event = press('F', { ctrlKey: true, altKey: true, shiftKey: true });

    expect(commands).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  /**
   * The editor's own listener is on `contentDOM`, so an event from inside it has
   * already been handled. Forwarding it again runs the command twice -- which
   * for Ctrl+B means bolding and then immediately unbolding, i.e. a shortcut
   * that silently does nothing.
   */
  it('does not double-handle a key pressed inside the editor', () => {
    press('P', { ctrlKey: true, shiftKey: true }, view.contentDOM);

    // CodeMirror's own handler is what fires here; this module must stay out of
    // the way. One command, not two.
    expect(commands).toEqual(['view.preview']);
  });

  /**
   * Unmodified keys stay with whatever is focused. Enter is bound to
   * `insertNewlineAndIndent` in `defaultKeymap`, so forwarding it would put a
   * newline in the document every time the user pressed Enter on a focused
   * menu-bar button -- and Left/Right would move the caret while the user was
   * dragging the preview divider with the keyboard.
   */
  it.each([['Enter'], ['ArrowLeft'], ['Escape']])('ignores %s, which is not a chord', (key) => {
    const before = view.state.doc.toString();
    const event = press(key);

    expect(commands).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
  });

  /**
   * Shift alone is not a chord -- it is how a capital letter is typed -- and
   * **Shift+Enter is the case that proves it**. `defaultKeymap` binds it (via
   * the Enter binding's `shift` property) to `insertNewlineAndIndent`, so
   * counting Shift as a modifier would put a newline into the document every
   * time the user pressed Shift+Enter with focus anywhere else in the app.
   *
   * The first version of this test used Shift+B, which no binding claims, so it
   * passed whether Shift was treated as a chord or not -- caught by mutation,
   * not by reading.
   */
  it('does not treat Shift alone as a chord', () => {
    const before = view.state.doc.toString();

    const event = press('Enter', { shiftKey: true });

    expect(view.state.doc.toString()).toBe(before);
    expect(event.defaultPrevented).toBe(false);
  });

  /**
   * `ui/confirmdialog.ts` uses a real `<dialog>` with `showModal()`, which puts
   * focus in the top layer -- outside `contentDOM`, so it lands here. Ctrl+S
   * while the Save/Don't Save prompt is up would start a save behind the prompt
   * that is asking about it.
   */
  it('stands aside while a modal dialog is open', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);

    const event = press('s', { ctrlKey: true });

    expect(commands).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  /**
   * The find panel is the app's first text field, and it sits inside
   * `.cm-editor` but *outside* `contentDOM` -- so it falls through the
   * editor-origin guard. Without a guard of its own, Ctrl+A there would select
   * the whole document instead of what the user had typed into the box.
   */
  it.each([['INPUT'], ['TEXTAREA']])('leaves chords typed in a %s alone', (tag) => {
    const box = document.createElement(tag.toLowerCase());
    document.body.append(box);

    const event = press('a', { ctrlKey: true }, box);

    expect(commands).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops forwarding once torn down', () => {
    teardown();

    press('P', { ctrlKey: true, shiftKey: true });

    expect(commands).toEqual([]);
  });

  /** The listener goes on whatever target it was handed, not on the global. */
  it('listens on the target it was given', () => {
    teardown();
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };

    const release = mountShortcuts(view, target as unknown as Window);
    expect(target.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));

    release();
    expect(target.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });
});
