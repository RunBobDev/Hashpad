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
 * re-measures, which is the reveal rule. `window.renderedLines()` shows K.3's
 * table padding as the DOM actually has it, and `window.images()` /
 * `window.brokenImages()` show which thumbnails loaded.
 *
 * **K.4's measurement runs here too**, and needs both panels: the cost of a
 * keystroke means nothing on its own, only against the same editor with the
 * feature off. `window.sourceView` is that control. Load a 5,000-line document
 * into one panel, time forty `dispatch` + `measure` pairs, clear it, then do the
 * other -- one big document in the page at a time, alternating which panel goes
 * first, because whichever is measured first pays for the JIT.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions, setDocumentDir, setLivePreview } from '../src/editor/extensions';
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
  '|a|bb|ccc|',
  '|-|:-:|-|',
  '|dddd|e|ff|',
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
  '![a data: URI](data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNDAnIGhlaWdodD0nOTAnPjxyZWN0IHdpZHRoPScxNDAnIGhlaWdodD0nOTAnIGZpbGw9J3N0ZWVsYmx1ZScvPjxjaXJjbGUgY3g9JzcwJyBjeT0nNDUnIHI9JzI4JyBmaWxsPSdnb2xkJy8+PC9zdmc+)',
  '',
  '![a missing file](nope.png) becomes the dashed card.',
  '',
  '![a remote one](https://example.com/p.png) stays as markdown.',
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
  //
  // **The folder is set because K.3's thumbnails need one.** `imageSource`
  // answers `null` for a document that has never been saved, so without this
  // every local image stays as markdown and the panel proves nothing about
  // images. The path does not have to exist: vite has no asset handler, so
  // `nope.png` 404s and the widget's `error` branch draws the dashed card --
  // which is exactly the case worth looking at.
  if (live) {
    setLivePreview(view, true);
    setDocumentDir(view, 'C:\\notes');
  }
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
    renderedLines: () => string[];
    images: () => { src: string; width: number; height: number }[];
    brokenImages: () => string[];
    caretTo: (line: number) => Report;
    caretLine: () => number;
    arrowDown: () => number;
    liveView: EditorView;
    sourceView: EditorView;
    scrollDrift: (
      which: 'live' | 'source',
      dir?: number,
      steps?: number,
    ) => Promise<{
      which: string;
      direction: string;
      steps: number;
      /** Times CodeMirror wrote `scrollTop` to compensate a height correction. */
      corrections: number;
      worstCorrection: number;
      /** Times the content moved on screen by something other than the step. */
      visualJumps: number;
      worstVisual: number;
    }>;
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
// The control for K.4's measurement: the same document and the same editor with
// live preview off, so a keystroke's cost can be attributed to this feature
// rather than to CodeMirror.
window.sourceView = off;

window.livePreview = () => [measure('off', off), measure('on', on)];

/**
 * The live panel's lines exactly as the DOM has them, padding widgets included.
 *
 * **This is the only way to see K.3's table alignment.** The decoration set says
 * "insert three spaces here"; whether the columns actually line up is a question
 * about a monospace font in a real layout engine, and `padded()` in the unit
 * tests answers a different one -- it expands the widgets by arithmetic, which
 * is exactly the assumption under test.
 */
window.renderedLines = () => Array.from(on.contentDOM.children, (line) => line.textContent ?? '');

/**
 * Every thumbnail's source and its measured box. A zero height means the file
 * never arrived -- which for `nope.png` is the point, and for the `data:` URI
 * would be a failure.
 */
window.images = () =>
  // **`.cm-live-image img`, not `img`.** CodeMirror puts a zero-width
  // `<img class="cm-widgetBuffer">` either side of every widget it draws, so a
  // bare tag selector reports 63 images in a document with two -- which is how
  // the first version of this probe read.
  Array.from(on.contentDOM.querySelectorAll('.cm-live-image img'), (img) => ({
    src: img.getAttribute('src') ?? '',
    width: img.clientWidth,
    height: img.clientHeight,
  }));

/** The dashed cards a failed load left behind, by their accessible name. */
window.brokenImages = () =>
  Array.from(
    on.contentDOM.querySelectorAll('.cm-live-image .preview-image-placeholder'),
    (box) => box.getAttribute('aria-label') ?? '',
  );

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

/**
 * **Does the editor stay where it is put while scrolling?**
 *
 * Owner report after Checkpoint L: scrolling down jumps a little up every few
 * ticks, and scrolling up jumps a little down -- in every view mode *except*
 * live preview. The panels here are the same editor with the feature on and
 * off, which is exactly the comparison that report draws, and why the probe
 * belongs on this page rather than a new one.
 *
 * **Two numbers, because the obvious one is the wrong one.** CodeMirror
 * corrects its own height estimates as lines render, and compensates by writing
 * `scrollDOM.scrollTop += diff` (`@codemirror/view`, `EditorView.measure`, the
 * `scrollAnchorHeight` block). So `scrollTop` moving against the direction of
 * travel is *expected* and says nothing about what a person sees: the whole
 * point of the write is to hold the content still while the numbers move under
 * it. `corrections` counts those writes. `visualJumps` is the one that matters
 * -- it tracks a real document position's screen coordinates through the step
 * and reports how far the content moved *other* than by the amount asked for.
 *
 * Measured, 2026-09-20: on a heading-dense document, corrections of 13 and
 * 16 px in **both** panels, with the scroll height moving 30-68 px in the same
 * step; on a realistically-shaped one, none in either over 240 steps. Visual
 * jumps: zero, everywhere, always.
 *
 * **This page cannot show the reported symptom, and the reason is worth
 * knowing.** Native smooth wheel scrolling is the one ingredient it needs, and
 * the automation browser this was driven from has it switched off --
 * `scrollBy({ behavior: 'smooth' })` there moves nothing at all. Stepping
 * `scrollTop` is an instant scroll, which gives CodeMirror's compensation a
 * still target to land on. WebView2 on Windows animates a wheel tick over
 * dozens of frames instead. So a clean run here is evidence about the height
 * map, not about the wheel.
 *
 * `dir` is 1 for down, -1 for up.
 */
window.scrollDrift = async (which, dir = 1, steps = 30) => {
  const view = which === 'live' ? on : off;
  const scroller = view.scrollDOM;
  const wait = (ms: number): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

  // From an end, not from the middle: the drift lives in never-measured lines,
  // and starting anywhere the probe has already been warms the height map.
  scroller.scrollTop = dir > 0 ? 0 : scroller.scrollHeight - scroller.clientHeight;
  await wait(400);

  let taken = 0;
  let corrections = 0;
  let worstCorrection = 0;
  let visualJumps = 0;
  let worstVisual = 0;

  for (let i = 0; i < steps; i++) {
    const box = scroller.getBoundingClientRect();
    // A document position halfway down the viewport, followed by its screen
    // coordinates rather than by the height map's opinion of them.
    const pos = view.posAtCoords({ x: box.left + 20, y: box.top + scroller.clientHeight / 2 });
    const before = pos === null ? null : view.coordsAtPos(pos);

    const want = Math.round(scroller.scrollTop) + dir * 90;
    // Stop before the ends: past them the browser clamps, and a clamp is not a
    // drift however much it looks like one in the numbers.
    if (want <= 0 || want >= scroller.scrollHeight - scroller.clientHeight) break;
    scroller.scrollTop = want;
    await wait(90);
    taken++;

    const correction = Math.round(scroller.scrollTop) - want;
    if (correction !== 0) {
      corrections++;
      worstCorrection = Math.max(worstCorrection, Math.abs(correction));
    }

    const after = pos === null ? null : view.coordsAtPos(pos);
    if (before !== null && after !== null) {
      const error = Math.round(before.top - after.top) - dir * 90;
      if (Math.abs(error) > 1) {
        visualJumps++;
        worstVisual = Math.max(worstVisual, Math.abs(error));
      }
    }
  }

  return {
    which,
    direction: dir > 0 ? 'down' : 'up',
    steps: taken,
    corrections,
    worstCorrection,
    visualJumps,
    worstVisual,
  };
};
