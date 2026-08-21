/**
 * The CM6 theme reads the same custom properties as the app chrome (SPEC §5.3),
 * so switching themes is one `data-theme` attribute on <html> — no editor
 * reconfiguration, no re-instantiation, no flash of unstyled content.
 *
 * One thing colours cannot carry is CM6's `darkTheme` facet, which extensions
 * read to decide non-colour behaviour. That lives in a Compartment so it can be
 * reconfigured on theme change without rebuilding the editor.
 */
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export const darkThemeCompartment = new Compartment();

export const hashpadTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg-editor)',
    color: 'var(--fg-primary)',
    fontFamily: 'var(--font-editor)',
    fontSize: 'var(--size-editor)',
  },
  '.cm-content': {
    padding: 'var(--pad-editor) 0',
    lineHeight: 'var(--line-editor)',
    caretColor: 'var(--fg-primary)',
    // settings.editor.maxContentWidth. Centred rather than left-aligned,
    // because a capped column pinned to the left of a maximised window reads as
    // a broken layout rather than a deliberate measure.
    //
    // On `.cm-content` and not on `.cm-scroller`: the scroller is what scrolls,
    // and capping it would move the scrollbar into the middle of the window.
    // The active-line highlight is drawn per `.cm-line`, so it ends at the
    // column edge too -- which is right, since that is where the line ends.
    maxWidth: 'var(--max-content-width)',
    marginInline: 'auto',
  },
  '.cm-line': {
    padding: '0 var(--pad-editor)',
  },
  '&.cm-focused': {
    // The window chrome already shows focus; an outline around the whole editor
    // is noise. Focus within the text is the caret.
    outline: 'none',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--fg-primary)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  // highlightActiveLine() ships its own hard-coded #cceeff44 / #99eeff33 in
  // @codemirror/view's base theme. Overriding it is not cosmetic: without this
  // rule the active line is the one part of the editor whose colour does not
  // come from variables.css, so it would not follow the theme or the accent.
  '.cm-activeLine': {
    backgroundColor: 'var(--bg-active-line)',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    overflow: 'auto',
  },
});

export function setEditorDark(view: EditorView, isDark: boolean): void {
  view.dispatch({
    effects: darkThemeCompartment.reconfigure(EditorView.darkTheme.of(isDark)),
  });
}
