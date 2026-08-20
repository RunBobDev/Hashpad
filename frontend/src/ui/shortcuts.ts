/**
 * Keyboard shortcuts when the editor does not have focus.
 *
 * Every shortcut in this app except zoom lives in `editor/extensions.ts`'s
 * keymap, and CodeMirror installs that as a `keydown` listener on
 * `view.contentDOM`. A key pressed while focus is anywhere else -- the preview
 * pane, the divider, a tab, a toolbar button, or `<body>` at startup before
 * anything has been clicked -- never reaches it. Reported by the owner: "the
 * only time I can use macros is when I press inside the editor".
 *
 * `runScopeHandlers` is CodeMirror's own entry point for exactly this: it runs
 * the bindings registered in a scope against a `KeyboardEvent` that did not
 * originate in the editor. So this forwards rather than re-declaring anything,
 * and there is still one definition of every binding -- which is the property
 * SPEC §6.5 asks for and the reason this is not a second keymap on `window`.
 *
 * Unlike `ui/zoom.ts`, which owns its two bindings outright, this file owns
 * none. It is a router.
 */
import { runScopeHandlers, type EditorView } from '@codemirror/view';

/**
 * Only chorded keys are forwarded, and this guard is what makes the whole
 * approach safe rather than merely convenient.
 *
 * Forwarding *everything* would mean an unmodified key doing the editor's thing
 * while the user is aiming it at something else: Enter on a focused menu-bar
 * button is bound to `insertNewlineAndIndent` in `defaultKeymap`, so it would
 * both press the button and put a newline in the document. Left/Right on the
 * preview divider (`preview/pane.ts`'s `onDividerKey`) would move the caret as
 * well as the divider. Escape would reach the editor from inside an open
 * dialog.
 *
 * Every app-level shortcut is Ctrl-chorded, so restricting to modifiers loses
 * nothing and removes that entire class. Shift alone does not count -- it is
 * how capitals are typed, not a chord.
 */
function isChord(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

/**
 * Whether the event came from somewhere the user is typing.
 *
 * The find panel (G.4a) is the first text field in the app, and it lives inside
 * `.cm-editor` but *outside* `contentDOM` -- so it falls straight through the
 * guard below and every chord typed in it would be forwarded to the editor.
 * Ctrl+A in the find field would select the whole document instead of the
 * field's own text.
 *
 * Deliberately not written until there was a field to need it: until G.4a the
 * app had no text input anywhere, and a guard for a case that cannot arise is
 * a guard no test can justify.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // Tag names only, deliberately. `isContentEditable` was here too and is gone:
  // the one contenteditable in this app is CodeMirror's own `contentDOM`, which
  // the guard above already excludes, so the branch was unreachable -- and
  // unfalsifiable, since jsdom does not implement the property at all and the
  // test for it passed whether the branch was there or not.
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

/**
 * Wires the fallback and returns a teardown.
 *
 * Three things are deliberately left alone:
 *
 * - **Events the editor already saw.** CodeMirror's listener is on
 *   `contentDOM`, so an event targeting it or anything inside it has already
 *   been handled; forwarding it again would run the command twice.
 * - **An open modal.** `ui/confirmdialog.ts` uses a real `<dialog>` with
 *   `showModal()`, which puts focus in the top layer, outside `contentDOM` --
 *   so without this, Ctrl+S while the Save/Don't Save prompt is up would start
 *   a save behind the prompt that is asking about it.
 * - **A text field.** The find panel sits inside `.cm-editor` but outside
 *   `contentDOM`, so it lands here -- and Ctrl+A there means "select what I have
 *   typed", not "select the whole document".
 * - **Anything the keymap does not claim.** `runScopeHandlers` returns false
 *   for an unbound chord, and the browser's own default is then left intact.
 */
export function mountShortcuts(view: EditorView, target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isChord(event)) return;
    if (view.contentDOM.contains(event.target as Node | null)) return;
    if (isTextEntry(event.target)) return;
    if (document.querySelector('dialog[open]') !== null) return;

    // `runScopeHandlers` reports whether a binding claimed the key but does not
    // suppress the browser's own behaviour -- inside the editor that is
    // `EditorView.domEventHandlers`' job, and here there is nothing doing it.
    // Without this, Ctrl+O opens Chromium's file picker on top of ours.
    if (runScopeHandlers(view, event, 'editor')) event.preventDefault();
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
