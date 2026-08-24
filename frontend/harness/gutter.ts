/**
 * Does `showLineNumbers` actually put a *visible* gutter on the editor?
 *
 * jsdom answers "is the extension in the stack" and nothing else -- it has no
 * layout and paints nothing, so `.cm-lineNumbers` existing in the DOM there says
 * nothing about whether a user sees numbers. The owner asked "what line
 * numbers?", which is a question only a browser can answer.
 *
 * Two editors, one per theme, so the answer covers both: CodeMirror's base theme
 * hard-codes the gutter's colours (`#f5f5f5`/`#6c6c6c` light, `#333338`/`#ccc`
 * dark) and nothing in `editor/theme.ts` overrides them -- the same gap the
 * active-line highlight had, and that file documents.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildExtensions, setEditorBehaviour } from '../src/editor/extensions';
import { DEFAULT_BEHAVIOUR } from '../src/state/document';
import '../src/styles/app.css';

const DOC = ['# Heading', '', 'A paragraph of text.', '', '- one', '- two', '', 'Last line.'].join(
  '\n',
);

function panel(label: string, isDark: boolean, showLineNumbers: boolean): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.style.cssText = 'flex:1 1 0;min-width:0;display:flex;flex-direction:column;height:320px';
  wrapper.dataset.theme = isDark ? 'dark' : 'light';

  const heading = document.createElement('h2');
  heading.textContent = label;
  heading.style.cssText = 'font:12px sans-serif;margin:4px 8px;color:#888';
  wrapper.append(heading);

  const host = document.createElement('div');
  host.style.cssText = 'flex:1 1 auto;min-height:0;overflow:hidden;border:1px solid #999';
  wrapper.append(host);

  new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: buildExtensions(isDark, true, { ...DEFAULT_BEHAVIOUR, showLineNumbers }),
    }),
    parent: host,
  });

  return wrapper;
}

/**
 * The path the *app* actually takes: the editor is built before settings load,
 * so line numbers arrive by reconfiguring a live view rather than by being in
 * the extensions it was constructed with. Panels above cannot tell the two
 * apart, and only this one matches what the owner is running.
 */
function reconfigured(label: string): HTMLElement {
  const wrapper = panel(label, false, false);
  const view = EditorView.findFromDOM(wrapper.querySelector('.cm-editor')!);
  if (view) setEditorBehaviour(view, { ...DEFAULT_BEHAVIOUR, showLineNumbers: true });
  return wrapper;
}

const app = document.querySelector('#app')!;
app.setAttribute('style', 'display:flex;gap:12px;padding:12px;font-family:sans-serif');
app.append(
  panel('light · built ON', false, true),
  panel('light · off', false, false),
  panel('dark · built ON', true, true),
  reconfigured('light · reconfigured ON'),
);

/** What the probe reports back, so the answer is measured rather than eyeballed. */
interface GutterReport {
  present: boolean;
  width: number;
  background: string;
  colour: string;
  firstNumber: string;
}

declare global {
  interface Window {
    gutter: () => GutterReport[];
  }
}

window.gutter = () =>
  [...document.querySelectorAll('.cm-editor')].map((editor) => {
    const gutters = editor.querySelector('.cm-gutters');
    if (!gutters) {
      return { present: false, width: 0, background: '', colour: '', firstNumber: '' };
    }
    const style = getComputedStyle(gutters);
    return {
      present: true,
      width: gutters.getBoundingClientRect().width,
      background: style.backgroundColor,
      colour: style.color,
      firstNumber: editor.querySelector('.cm-lineNumbers .cm-gutterElement')?.textContent ?? '',
    };
  });
