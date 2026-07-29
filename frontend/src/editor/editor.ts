import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions } from './extensions';

/**
 * CodeMirror owns the document text; the store does not duplicate it
 * (design §4.2). Checkpoint C swaps EditorStates through this one view when
 * switching tabs.
 */
export function createEditor(parent: HTMLElement, doc: string, isDark: boolean): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: buildExtensions(isDark) }),
    parent,
  });
}
