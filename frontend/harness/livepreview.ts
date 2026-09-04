/**
 * Do the asterisks actually *disappear*?
 *
 * `livepreview.test.ts` proves which ranges get a `replace` decoration, and
 * that is the whole of the logic -- but a decoration is only a claim about
 * rendering, and jsdom renders nothing. CodeMirror does not even build line
 * content without a layout engine, so the one question that matters to a person
 * looking at the screen is unanswerable there.
 *
 * The measurement is the gap between two strings: what the *document* holds and
 * what the *DOM* shows. Live preview working means `**bold**` in the first and
 * `bold` in the second, at the same instant. That difference is impossible to
 * fake and impossible to observe in jsdom, which is why this file exists.
 *
 * `window.livePreview()` reports it; `window.caretTo(line)` moves the caret and
 * re-measures, which is the reveal rule.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions, setLivePreview } from '../src/editor/extensions';
import '../src/styles/app.css';

const DOC = [
  '# Heading loses its hash, keeps its size',
  '',
  'Some **bold** and *italic* on one line.',
  '',
  'Also ~~struck~~, ==marked== and `code`.',
  '',
  'Nested ***bold italic*** and **_mixed_**.',
  '',
  'A `**literal**` inside code stays literal.',
  '',
  '| Column | Another | Third |',
  '| ------ | ------- | ----- |',
  '| short  | wider   | x     |',
  '',
  'A Setext heading',
  '================',
  '',
  'And a Setext h2',
  '---------------',
  '',
  '### Deeper heading ###',
  '',
  'See [the docs](https://example.com "Title") for more.',
  '',
  'A [reference][ref] link stays whole.',
  '',
  '![alt text](pic.png) stays whole too, until K.3.',
  '',
  '- a bullet becomes a glyph',
  '- and so does this one',
  '',
  '1. an ordered marker does not',
  '',
  '```js',
  "const fence = 'stays visible';",
  '```',
].join('\n');

function panel(label: string, live: boolean): EditorView {
  const wrapper = document.createElement('section');
  wrapper.style.cssText = 'flex:1 1 0;min-width:0;display:flex;flex-direction:column;height:760px';

  const heading = document.createElement('h2');
  heading.textContent = label;
  heading.style.cssText = 'font:12px sans-serif;margin:4px 8px;color:#888';
  wrapper.append(heading);

  const host = document.createElement('div');
  host.style.cssText = 'flex:1 1 auto;min-height:0;overflow:hidden;border:1px solid #999';
  wrapper.append(host);
  document.querySelector('#app')!.append(wrapper);

  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: buildExtensions(false),
      selection: EditorSelection.single(0),
    }),
    parent: host,
  });

  // **`setLivePreview`, never a second `livePreviewCompartment.of()`.**
  // `buildExtensions` already seeds the compartment, and CodeMirror throws
  // "Duplicate use of compartment in extensions" on a state that mentions one
  // twice -- which is what the first version of this file did, and what this
  // harness caught within a minute of loading. It is also the more faithful
  // arrangement: the app has no path that builds an editor with live preview
  // already on. It builds in source mode and reconfigures, exactly like this.
  if (live) setLivePreview(view, true);
  return view;
}

const app = document.querySelector('#app')!;
// `flex-direction:row` spelled out: `app.css` styles `#app` as a flex *column*
// (it is the real app's chrome stack), and an inline `display:flex` alone
// inherits that direction, which stacked the two panels and made the
// comparison unreadable.
app.setAttribute(
  'style',
  'display:flex;flex-direction:row;gap:12px;padding:12px;font-family:sans-serif',
);

const off = panel('live OFF — source mode', false);
const on = panel('live ON — via setLivePreview()', true);

interface Report {
  label: string;
  /** What the document holds. The markers must still be here. */
  document: string;
  /** What the DOM shows. The markers must be gone from all but the caret's line. */
  rendered: string;
  /** True when the two differ -- i.e. something is actually hidden. */
  hiding: boolean;
}

function measure(label: string, view: EditorView): Report {
  // `.cm-content`'s textContent, not the decoration set: this is the rendered
  // result after CodeMirror has applied every replace, which is what a person
  // sees.
  const rendered = (view.contentDOM.textContent ?? '').replace(/\s+/g, ' ').trim();
  const document = view.state.doc.toString().replace(/\s+/g, ' ').trim();
  // **Whitespace removed, not collapsed, and only for this comparison.** The
  // DOM puts no character between two lines while the document has a newline,
  // so collapsing left the two strings different even with nothing hidden --
  // the first version of this probe reported `hiding: true` for the panel with
  // live preview *off*. A flag that is true either way measures nothing.
  const bare = (text: string): string => text.replace(/\s/g, '');
  return { label, document, rendered, hiding: bare(rendered) !== bare(document) };
}

declare global {
  interface Window {
    livePreview: () => Report[];
    caretTo: (line: number) => Report;
    caretLine: () => number;
    arrowDown: () => number;
    liveView: EditorView;
  }
}

/**
 * Which line the caret is actually on in the live panel.
 *
 * Exists because a `display: none` line raises a question no assertion about
 * decorations can answer: CodeMirror moves the caret vertically by
 * *coordinates*, and a line with no geometry could be stepped straight over.
 * Press a real arrow key, then ask this.
 */
window.caretLine = () => on.state.doc.lineAt(on.state.selection.main.head).number;

/**
 * One line's worth of vertical caret movement, through the same call the arrow
 * key runs -- `cursorLineDown` in `@codemirror/commands` is a thin wrapper over
 * `view.moveVertically`.
 *
 * Driving it this way rather than sending a synthetic key, because a synthetic
 * key was tried first and moved nothing *even on an ordinary line*: it never
 * reached CodeMirror, and reading that as "the hidden line traps the caret"
 * would have invented a bug. This calls the code the key would have called.
 */
window.arrowDown = () => {
  const moved = on.moveVertically(on.state.selection.main, true);
  on.dispatch({ selection: { anchor: moved.head } });
  return window.caretLine();
};

// Exposed so caret-movement questions can be asked with the target line
// scrolled into view and measured first -- without that, `moveVertically` has
// no coordinates for an off-screen line and returns the end of the document.
window.liveView = on;

window.livePreview = () => [measure('off', off), measure('on', on)];

/**
 * Puts the caret on a line of the live panel and reports what changed. The
 * reveal rule is the half of the feature a static screenshot cannot show: the
 * markers have to come *back*.
 */
window.caretTo = (line: number) => {
  const pos = on.state.doc.line(line).from;
  on.dispatch({ selection: EditorSelection.single(pos) });
  on.focus();
  return measure(`on · caret line ${String(line)}`, on);
};
