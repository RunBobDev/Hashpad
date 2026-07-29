import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';
import { darkThemeCompartment, hashpadTheme } from './theme';

/**
 * Assembled deliberately rather than using the `basicSetup` bundle: basicSetup
 * pulls in line numbers, fold gutters, autocompletion, and bracket matching,
 * most of which SPEC §6.13 has off by default and all of which cost bundle size.
 */
export const baseExtensions: Extension[] = [
  history(),
  drawSelection(),
  highlightActiveLine(),
  // Word wrap is on by default (SPEC §6.6). Checkpoint G makes it a toggle.
  EditorView.lineWrapping,
  keymap.of([...defaultKeymap, ...historyKeymap]),
  hashpadTheme,
  darkThemeCompartment.of(EditorView.darkTheme.of(false)),
];
