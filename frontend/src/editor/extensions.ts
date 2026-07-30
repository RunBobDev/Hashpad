import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { Prec, type Extension } from '@codemirror/state';
import { darkThemeCompartment, hashpadTheme } from './theme';
import { COMMAND_EVENT } from '../ui/menubar';

/**
 * Builds a CodeMirror command that dispatches the given `hashpad:command` id
 * on `document` instead of calling a file-operation function directly. The
 * menu bar (ui/menubar.ts) dispatches the exact same event for the exact same
 * ids, so File > Save and Ctrl+S run through one implementation
 * (files/fileops.ts's `saveActive`, wired up in main.ts) rather than two —
 * the pattern the toolbar will reuse in a later checkpoint. Returning `true`
 * marks the key as handled, which stops CodeMirror from also trying its own
 * bindings for the same chord and prevents the browser's default action
 * (e.g. Ctrl+S's save-page-as).
 */
function dispatchCommand(id: string): () => boolean {
  return () => {
    document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: id }));
    return true;
  };
}

/**
 * Assembled deliberately rather than using the `basicSetup` bundle: basicSetup
 * pulls in line numbers, fold gutters, autocompletion, and bracket matching,
 * most of which SPEC §6.13 has off by default and all of which cost bundle size.
 *
 * A factory rather than a module-level constant array: a shared array bakes
 * `darkThemeCompartment.of(...)` in with whatever `isDark` was passed the one
 * time the array was built, so every `EditorState` constructed from it —
 * including ones created later, e.g. for a newly opened tab — would carry
 * that same value forever. `setEditorDark` only reconfigures the compartment
 * on the view's *current* state, it does not change what new states are
 * seeded with. Calling `buildExtensions(isDark)` fresh for every new
 * `EditorState` is what keeps future tabs in sync with the theme at the
 * moment they're created; `setEditorDark` remains the way to flip the theme
 * on a state that already exists. Both are needed — one seeds, one updates.
 */
export function buildExtensions(isDark: boolean): Extension[] {
  return [
    history(),
    drawSelection(),
    highlightActiveLine(),
    // Word wrap is on by default (SPEC §6.6). Checkpoint G makes it a toggle.
    EditorView.lineWrapping,
    // High precedence so these file-command shortcuts always win, regardless
    // of what defaultKeymap does or gains in a future CodeMirror version.
    Prec.high(
      keymap.of([
        { key: 'Mod-o', run: dispatchCommand('file.open') },
        { key: 'Mod-s', run: dispatchCommand('file.save') },
        { key: 'Mod-Shift-s', run: dispatchCommand('file.saveAs') },
        { key: 'Mod-n', run: dispatchCommand('file.new') },
      ]),
    ),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    hashpadTheme,
    darkThemeCompartment.of(EditorView.darkTheme.of(isDark)),
  ];
}
