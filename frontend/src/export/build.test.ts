// @vitest-environment jsdom
/**
 * The export builder (SPEC §7.3).
 *
 * KaTeX is real here -- it builds DOM and jsdom can hold it. Mermaid is not:
 * it measures laid-out text with `getBBox`, which jsdom lacks, so it is stubbed
 * as in `preview/diagrams.test.ts`. What a real diagram looks like in an export
 * is `harness/export.html`'s question.
 *
 * `loadMath`/`loadDiagrams` are wrapped rather than replaced, so the real loads
 * still happen and the cases can also ask whether they were asked for at all.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEditorView, store } from '../state/appcontext';
import { createUntitledDocument } from '../state/document';
import { activeSource, buildExport, runExport } from './build';
import { loadMath } from '../preview/math';
import { loadDiagrams } from '../preview/diagrams';
import { showNotice } from '../ui/confirmdialog';

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    render: () => Promise.resolve({ svg: '<svg class="stub-diagram"></svg>' }),
  },
}));

vi.mock('../preview/math', async (importOriginal) => {
  const real = await importOriginal<typeof import('../preview/math')>();
  return { ...real, loadMath: vi.fn(real.loadMath) };
});

vi.mock('../preview/diagrams', async (importOriginal) => {
  const real = await importOriginal<typeof import('../preview/diagrams')>();
  return { ...real, loadDiagrams: vi.fn(real.loadDiagrams) };
});

vi.mock('../ui/confirmdialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui/confirmdialog')>()),
  showNotice: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('buildExport', () => {
  it('resolves only once math is typeset', async () => {
    const root = await buildExport('Euler: $e^{i\\pi}$', null);
    expect(root.querySelector('.katex')).not.toBeNull();
    root.remove();
  });

  it('resolves only once diagrams are drawn', async () => {
    const root = await buildExport('```mermaid\ngraph TD; A-->B;\n```\n', null);
    expect(root.querySelector('.preview-mermaid .stub-diagram')).not.toBeNull();
    root.remove();
  });

  it('typesets as MathML alone when asked', async () => {
    const root = await buildExport('$x^2$', null, 'mathml');
    expect(root.querySelector('math')).not.toBeNull();
    expect(root.querySelector('.katex-html')).toBeNull();
    root.remove();
  });

  /**
   * Attached, because Mermaid measures laid-out text; light, because exports
   * are light whatever the app is; hidden from assistive tech, because it is
   * off-screen scaffolding rather than content.
   */
  it('renders light, attached and hidden from assistive tech', async () => {
    const root = await buildExport('# Title', null);
    expect(root.isConnected).toBe(true);
    expect([...root.classList]).toEqual(
      expect.arrayContaining(['preview-pane', 'theme-light', 'export-root']),
    );
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    root.remove();
  });

  it('loads neither KaTeX nor Mermaid for a document with neither', async () => {
    const root = await buildExport('Just *prose*.', null);
    expect(loadMath).not.toHaveBeenCalled();
    expect(loadDiagrams).not.toHaveBeenCalled();
    root.remove();
  });
});

describe('activeSource', () => {
  function activate(text: string, filePath: string | null): void {
    const state = EditorState.create({ doc: text });
    const doc = { ...createUntitledDocument(state), filePath, lineEnding: 'crlf' as const };
    store.setState((prev) => ({ ...prev, documents: [doc], activeDocumentId: doc.id }));
    // The active document's text lives in the view, not in `editorState`.
    setEditorView(new EditorView({ state, parent: document.createElement('div') }));
  }

  it('describes the active document', () => {
    activate('# Hi', 'C:\\docs\\notes.md');
    expect(activeSource()).toEqual({
      text: '# Hi',
      documentDir: 'C:\\docs',
      stem: 'notes',
      lineEnding: 'crlf',
    });
  });

  it('has no folder and an Untitled stem when the document was never saved', () => {
    activate('x', null);
    expect(activeSource()).toMatchObject({ documentDir: null, stem: 'Untitled' });
  });
});

describe('runExport', () => {
  // The failure is also logged; that is not what these cases are about.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('tells the user when an export fails', async () => {
    await runExport('export', () => Promise.reject(new Error('disk full')));
    expect(showNotice).toHaveBeenCalledWith("Couldn't export: disk full");
  });

  /** Wails rejects a bound call with a bare string, not an Error. */
  it('reports a string rejection as it is', async () => {
    await runExport('print', () => Promise.reject('access denied'));
    expect(showNotice).toHaveBeenCalledWith("Couldn't print: access denied");
  });

  it('runs one export at a time', async () => {
    let finish: () => void = () => undefined;
    const first = runExport('export', () => new Promise<void>((resolve) => (finish = resolve)));
    const second = vi.fn(() => Promise.resolve());

    await runExport('export', second);
    finish();
    await first;

    expect(second).not.toHaveBeenCalled();
  });

  it('frees the slot once an export is done', async () => {
    await runExport('export', () => Promise.reject(new Error('x')));
    const next = vi.fn(() => Promise.resolve());
    await runExport('export', next);
    expect(next).toHaveBeenCalledOnce();
  });
});
