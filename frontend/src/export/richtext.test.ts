// @vitest-environment jsdom
/**
 * Copy as Rich Text (SPEC §7.3).
 *
 * jsdom has no clipboard and no `execCommand`, so `execCommand` is replaced by
 * what Chromium does for `copy`: dispatch a `copy` event whose `clipboardData`
 * collects what the page sets. What a paste into Word or Docs then looks like
 * cannot be checked here -- or anywhere in this VM; that is the owner's manual
 * check. Whether diagrams really become pictures is `harness/export.html`'s
 * question, since jsdom has no layout and no canvas.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEditorView, store } from '../state/appcontext';
import { createUntitledDocument, type Document } from '../state/document';
import { showNotice } from '../ui/confirmdialog';
import { copyActiveAsRichText, richHtml, writeClipboard } from './richtext';

vi.mock('../ui/confirmdialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui/confirmdialog')>()),
  showNotice: vi.fn(() => Promise.resolve()),
}));

/** What the last copy put on the clipboard, by type. */
let clipboard: Map<string, string>;

/** Chromium's `execCommand('copy')`: one `copy` event, at the focused element. */
function copyFires(): void {
  document.execCommand = vi.fn(() => {
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type: string, value: string) => clipboard.set(type, value) },
    });
    document.body.dispatchEvent(event);
    return true;
  });
}

beforeEach(() => {
  clipboard = new Map();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeClipboard', () => {
  it('puts both flavours on the clipboard through one copy event', () => {
    copyFires();

    expect(writeClipboard('<b>x</b>', 'x')).toBe(true);
    expect(clipboard.get('text/html')).toBe('<b>x</b>');
    expect(clipboard.get('text/plain')).toBe('x');
  });

  /** No gesture, no focus: Chromium refuses quietly, and the user must hear about it. */
  it('reports a copy that never happened', () => {
    document.execCommand = vi.fn(() => false);
    expect(writeClipboard('<b>x</b>', 'x')).toBe(false);
  });

  /**
   * CodeMirror's own copy handler sits on the editor and would put the markdown
   * on as plain text, overwriting ours. Captured on the window and stopped there,
   * it never sees the event.
   */
  it('keeps every other copy handler out of it', () => {
    copyFires();
    const editorHandler = vi.fn();
    document.body.addEventListener('copy', editorHandler);

    writeClipboard('<b>x</b>', 'x');

    expect(editorHandler).not.toHaveBeenCalled();
  });
});

describe('richHtml', () => {
  function rooted(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root;
  }

  /**
   * A paste keeps inline styles and drops stylesheets, so a table's borders
   * have to travel on the cells. Read from the computed style, which is where
   * the light palette's real colours are.
   */
  it('writes the computed borders onto table cells', async () => {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = real(element);
      if (element.tagName !== 'TD') return style;
      return {
        ...style,
        getPropertyValue: (property: string) =>
          property === 'border-top' ? '1px solid rgb(1, 2, 3)' : '',
      } as CSSStyleDeclaration;
    });

    const html = await richHtml(rooted('<table><tbody><tr><td>a</td></tr></tbody></table>'));

    expect(html).toContain('border-top: 1px solid rgb(1, 2, 3)');
  });

  it('leaves the live element it was given untouched', async () => {
    const root = rooted('<table><tbody><tr><td>a</td></tr></tbody></table>');
    await richHtml(root);
    expect(root.querySelector('td')!.hasAttribute('style')).toBe(false);
  });

  it('turns internet image placeholders back into images', async () => {
    const html = await richHtml(
      rooted(
        '<span class="preview-image-placeholder" data-src="https://e.com/c.png" data-alt="cat">x</span>',
      ),
    );
    expect(html).toContain('<img src="https://e.com/c.png" alt="cat">');
  });

  /** jsdom lays nothing out, so a diagram has no size to draw at. */
  it('keeps a diagram as SVG when it cannot be drawn as a picture', async () => {
    const html = await richHtml(rooted('<div class="preview-mermaid"><svg></svg></div>'));
    expect(html).toContain('<svg');
  });
});

describe('copyActiveAsRichText', () => {
  function activate(text: string, viewMode: Document['viewMode'], from = 0, to = 0): void {
    const state = EditorState.create({ doc: text, selection: EditorSelection.single(from, to) });
    const doc = { ...createUntitledDocument(state), viewMode };
    store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));
    setEditorView(new EditorView({ state, parent: document.createElement('div') }));
  }

  const TEXT = 'alpha\n\n**beta**';

  it('copies the selection when there is one', async () => {
    copyFires();
    activate(TEXT, 'source', 7, 15);

    await copyActiveAsRichText();

    expect(clipboard.get('text/plain')).toBe('beta\n');
    expect(clipboard.get('text/html')).toContain('<strong>beta</strong>');
    expect(clipboard.get('text/html')).not.toContain('alpha');
  });

  it('copies the whole document when nothing is selected', async () => {
    copyFires();
    activate(TEXT, 'source');

    await copyActiveAsRichText();

    expect(clipboard.get('text/plain')).toBe('alpha\n\nbeta\n');
  });

  /** Reading view shows no editor, so no selection the user can see. */
  it('copies the whole document in reading view, whatever the editor had selected', async () => {
    copyFires();
    activate(TEXT, 'preview', 7, 15);

    await copyActiveAsRichText();

    expect(clipboard.get('text/plain')).toBe('alpha\n\nbeta\n');
  });

  /** Word turns MathML into an equation; KaTeX's HTML needs a stylesheet a paste drops. */
  it('copies math as MathML alone', async () => {
    copyFires();
    activate('Euler: $e^{i\\pi}$', 'source');

    await copyActiveAsRichText();

    expect(clipboard.get('text/html')).toContain('<math');
    expect(clipboard.get('text/html')).not.toContain('katex-html');
  });

  it('tells the user when the clipboard refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    document.execCommand = vi.fn(() => false);
    activate(TEXT, 'source');

    await copyActiveAsRichText();

    expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("Couldn't copy"));
  });

  it('leaves nothing of its own behind on the page', async () => {
    copyFires();
    activate(TEXT, 'source');

    await copyActiveAsRichText();

    expect(document.querySelector('.export-root')).toBeNull();
  });
});
