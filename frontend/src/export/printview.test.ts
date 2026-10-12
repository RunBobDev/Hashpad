// @vitest-environment jsdom
/**
 * The print view's behaviour with the engine and pdf.js stubbed: what it asks
 * Go for, when, and what it leaves behind. Whether the pages look right is the
 * real exe's question (docs/testing.md).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClosePrint,
  LoadSettings,
  MakePrintPdf,
  SavePrintPdf,
  SaveSettings,
  ShowExportDialog,
  ShowPrintDialog,
} from '../../wailsjs/go/app/App';
import { showPages } from './pdfpages';
import { drawPageMarks, openPrintView } from './printview';

vi.mock('../../wailsjs/go/app/App', () => ({
  ClosePrint: vi.fn(() => Promise.resolve()),
  LoadSettings: vi.fn(),
  MakePrintPdf: vi.fn((kind: string) => Promise.resolve(`/__hashpad/print/${kind}.pdf?v=1`)),
  SavePrintPdf: vi.fn(() => Promise.resolve()),
  SaveSettings: vi.fn(() => Promise.resolve()),
  ShowExportDialog: vi.fn(() => Promise.resolve('C:\\out\\notes.pdf')),
  ShowPrintDialog: vi.fn(() => Promise.resolve()),
}));

const list = { count: 3, currentPage: vi.fn(() => 2), refreshMarks: vi.fn(), destroy: vi.fn() };
vi.mock('./pdfpages', () => ({ showPages: vi.fn(() => Promise.resolve(list)) }));

const PRINT = { title: true, date: true, pageNumbers: true, paper: 'a4', orientation: 'portrait' };

function settings(print = PRINT): void {
  vi.mocked(LoadSettings).mockImplementation(() =>
    Promise.resolve({ print: { ...print } } as never),
  );
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * jsdom 30 has no showModal or close (see confirmdialog.test.ts). These cases
 * are about what the view asks the engine for, not about <dialog>, so the two
 * get the least a modal dialog does here: open, and a `close` event on close.
 * What the dialog itself does -- modality, Escape -- is the real exe's check.
 */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterAll(() => {
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
});

let root: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
  document.head.querySelectorAll('style').forEach((s) => s.remove());
  root = document.createElement('div');
  document.body.append(root);
  settings();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(new Uint8Array([37, 80, 68, 70])))),
  );
});

afterEach(() => {
  // Closing runs the view's own clean-up, as on the real exe.
  document.querySelector<HTMLDialogElement>('dialog.print-view')?.close();
  vi.unstubAllGlobals();
});

async function open() {
  const done = openPrintView({ stem: 'notes', title: 'Notes', root });
  await flush();
  await flush();
  const view = document.querySelector<HTMLDialogElement>('dialog.print-view')!;
  const control = (label: string): HTMLInputElement & HTMLSelectElement =>
    [...view.querySelectorAll('label')]
      .find((l) => l.textContent?.startsWith(label))!
      .querySelector('input, select')!;
  const button = (text: string): HTMLButtonElement =>
    [...view.querySelectorAll('button')].find((b) => b.textContent === text)!;
  return { done, view, control, button };
}

describe('openPrintView', () => {
  it('makes the preview with the remembered paper and shows it', async () => {
    settings({ ...PRINT, paper: 'letter', orientation: 'landscape' });
    await open();

    expect(MakePrintPdf).toHaveBeenCalledWith('preview', 'letter', 'landscape');
    expect(showPages).toHaveBeenCalledOnce();
  });

  /** The whole point: a switch never re-makes the preview. */
  it('redraws the marks on a switch, without asking the engine', async () => {
    const { control } = await open();
    vi.mocked(MakePrintPdf).mockClear();

    const title = control('Title');
    title.checked = false;
    title.dispatchEvent(new Event('change'));
    // Long enough for any engine job the change queued to have started.
    await flush();

    expect(list.refreshMarks).toHaveBeenCalled();
    expect(MakePrintPdf).not.toHaveBeenCalledWith('preview', expect.anything(), expect.anything());
  });

  it('remembers the switches', async () => {
    const { control } = await open();
    const date = control('Date and time');
    date.checked = false;
    date.dispatchEvent(new Event('change'));
    await flush();

    expect(vi.mocked(SaveSettings).mock.lastCall?.[0]).toMatchObject({ print: { date: false } });
  });

  it('re-makes the preview on a paper change, staying on the same page', async () => {
    const { control } = await open();
    vi.mocked(MakePrintPdf).mockClear();

    const paper = control('Paper');
    paper.value = 'letter';
    paper.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    expect(MakePrintPdf).toHaveBeenCalledWith('preview', 'letter', 'portrait');
    expect(vi.mocked(showPages).mock.lastCall?.[2].startPage).toBe(2);
  });

  /**
   * The engine lays a PDF out on the page's own thread: on the real exe a
   * background final froze the view about 5 ms a page (5 s at 1,032 pages),
   * a second after opening and after every change.
   */
  it('makes no PDF in the background, however long it waits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { control } = await open();
      const date = control('Date and time');
      date.checked = false;
      date.dispatchEvent(new Event('change'));
      vi.mocked(MakePrintPdf).mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(MakePrintPdf).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /** The final PDF is made while the save dialog is up, where its freeze hides. */
  it('saves: asks where while making the final PDF, then copies it', async () => {
    let made = (): void => undefined;
    const { button } = await open();
    vi.mocked(MakePrintPdf).mockImplementationOnce(
      () => new Promise((resolve) => (made = () => resolve('/__hashpad/print/final.pdf?v=2'))),
    );
    button('Save PDF…').click();
    await flush();

    expect(MakePrintPdf).toHaveBeenLastCalledWith('final', 'a4', 'portrait');
    expect(ShowExportDialog).toHaveBeenCalledWith('notes.pdf', 'pdf');
    expect(SavePrintPdf).not.toHaveBeenCalled();

    made();
    await flush();
    expect(SavePrintPdf).toHaveBeenCalledWith('C:\\out\\notes.pdf');
  });

  it('saves nothing when the save dialog is cancelled, and says so', async () => {
    vi.mocked(ShowExportDialog).mockResolvedValueOnce('');
    const { view, button } = await open();
    button('Save PDF…').click();
    await flush();
    await flush();

    expect(SavePrintPdf).not.toHaveBeenCalled();
    // Not "Making the PDF…" for as long as the view stays open.
    expect(view.querySelector('[role="status"]')?.textContent).toBe('Page 2 of 3');
  });

  it('prints through Windows with the current marks in the page CSS', async () => {
    const { control, button } = await open();
    const title = control('Title');
    title.checked = false;
    title.dispatchEvent(new Event('change'));
    button('Print…').click();
    await flush();

    expect(ShowPrintDialog).toHaveBeenCalledOnce();
    const css = document.head.querySelector('style')?.textContent;
    expect(css).toContain('@top-left');
    expect(css).not.toContain('@top-right');
  });

  /**
   * On the real exe the laid-out copy cost every frame of the view ~50 ms at
   * 1,032 pages, idle or not. The engine prints in print media, where the
   * class hides nothing.
   */
  it('keeps the copy out of the screen layout while open', async () => {
    const { view } = await open();
    expect(root.classList.contains('export-root--idle')).toBe(true);

    view.close();
    expect(root.classList.contains('export-root--idle')).toBe(false);
  });

  it('cleans up on close and reports it', async () => {
    const { done, view } = await open();
    view.close();

    await expect(done).resolves.toBe('closed');
    expect(ClosePrint).toHaveBeenCalledOnce();
    expect(list.destroy).toHaveBeenCalled();
    expect(document.querySelector('dialog.print-view')).toBeNull();
    expect(document.head.querySelector('style')).toBeNull();
  });

  /**
   * On the real exe PageDown did nothing: the pages could not take focus, so
   * the keys went to the last field touched. Focusable, a click on them makes
   * the keyboard scroll them.
   */
  it('lets the keyboard scroll the pages', async () => {
    const { view } = await open();
    const pages = view.querySelector<HTMLElement>('.print-view__pages')!;

    expect(pages.tabIndex).toBe(0);
    expect(pages.getAttribute('aria-label')).toBe('Pages');
  });

  it('offers the standard print preview when the engine fails', async () => {
    vi.mocked(MakePrintPdf).mockRejectedValueOnce('engine broke');
    const { done, view, button } = await open();

    expect(view.textContent).toContain('engine broke');
    button('Use the standard print preview').click();

    await expect(done).resolves.toBe('fallback');
  });
});

describe('drawPageMarks', () => {
  it('writes date and title on top and the number at the bottom', () => {
    const layer = document.createElement('div');

    drawPageMarks(layer, { date: 'today', title: 'Notes', number: '7' });
    drawPageMarks(layer, { date: '', title: 'Notes', number: '8' });

    const [top, bottom] = [...layer.children];
    expect([...top!.children].map((s) => s.textContent)).toEqual(['', 'Notes']);
    expect(bottom!.textContent).toBe('8');
    expect(layer.children).toHaveLength(2);
  });
});
