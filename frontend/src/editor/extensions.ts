import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';
import { darkThemeCompartment, hashpadTheme } from './theme';

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
    keymap.of([...defaultKeymap, ...historyKeymap]),
    hashpadTheme,
    darkThemeCompartment.of(EditorView.darkTheme.of(isDark)),
  ];
}
