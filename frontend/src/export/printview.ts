/**
 * File > Print's own view (design §4.34): the whole window, settings on the
 * left, the pages on the right.
 *
 * The engine makes a **preview PDF** -- no title, date or numbers -- once, and
 * again only when paper or orientation moves the page breaks. Those three are
 * drawn over the pages (pdfpages.ts's marks layer), so every switch and number
 * shows at once at any length. The **final PDF**, with them, is made only for
 * Save, while its dialog is up: the engine lays a PDF out on the page's own
 * thread, so made at any other time it froze the view (about 5 ms a page).
 *
 * Save and Print… both write the final page CSS just before their engine job:
 * so Print… hands Windows' dialog exactly what Save would write.
 *
 * Engine jobs run one at a time through `enqueue`.
 */
import {
  ClosePrint,
  LoadSettings,
  MakePrintPdf,
  SavePrintPdf,
  ShowExportDialog,
  ShowPrintDialog,
} from '../../wailsjs/go/app/App';
import { persistSettings } from '../settings/live';
import { showPages, type PageList } from './pdfpages';
import { fitWideMath } from './printfit';
import {
  DEFAULT_PRINT_OPTIONS,
  MARGIN_MM,
  MARK_STYLE,
  markDate,
  pageCss,
  pageMarks,
  printableWidthMm,
  shortTitle,
  type Orientation,
  type PageMarks,
  type Paper,
  type PrintOptions,
} from './printpage';

/** app.css: the copy, out of the screen's layout but not out of print. */
const IDLE_CLASS = 'export-root--idle';

export type PrintViewOutcome = 'closed' | 'fallback';

export interface PrintViewArgs {
  stem: string;
  title: string;
  /** The hidden copy, already marked for print. The caller removes it. */
  root: HTMLElement;
}

async function rememberedOptions(): Promise<PrintOptions> {
  try {
    const p = (await LoadSettings()).print;
    return {
      ...DEFAULT_PRINT_OPTIONS,
      title: p.title,
      date: p.date,
      numbers: p.pageNumbers,
      paper: p.paper === 'letter' ? 'letter' : 'a4',
      orientation: p.orientation === 'landscape' ? 'landscape' : 'portrait',
    };
  } catch {
    return { ...DEFAULT_PRINT_OPTIONS };
  }
}

function remember(o: PrintOptions): void {
  void persistSettings('print', (settings) => {
    Object.assign(settings.print, {
      title: o.title,
      date: o.date,
      pageNumbers: o.numbers,
      paper: o.paper,
      orientation: o.orientation,
    });
  });
}

function row(text: string, control: HTMLElement): HTMLElement {
  const label = document.createElement('label');
  label.className = 'settings-dialog__row';
  const span = document.createElement('span');
  span.className = 'settings-dialog__label';
  span.textContent = text;
  label.append(span, control);
  return label;
}

function group(legendText: string, rows: HTMLElement[]): HTMLElement {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'settings-dialog__group';
  const legend = document.createElement('legend');
  legend.className = 'settings-dialog__legend';
  legend.textContent = legendText;
  fieldset.append(legend, ...rows);
  return fieldset;
}

function choice<T extends string>(value: T, options: [T, string][]): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'settings-dialog__control';
  for (const [v, text] of options) select.add(new Option(text, v, false, v === value));
  return select;
}

/**
 * Fills one page's marks layer. Exported so the harness can draw marks the
 * way the view does and measure them against a real PDF.
 */
export function drawPageMarks(layer: HTMLElement, marks: PageMarks): void {
  if (layer.childElementCount === 0) layer.append(markRow('top'), markRow('bottom'));
  const [top, bottom] = [...layer.children] as HTMLElement[];
  top!.children[0]!.textContent = marks.date;
  top!.children[1]!.textContent = marks.title;
  bottom!.children[0]!.textContent = marks.number;
}

/** One edge's marks, placed in CSS mm on the 96 px/in layer pdfpages.ts sizes. */
function markRow(edge: 'top' | 'bottom'): HTMLElement {
  const rowEl = document.createElement('div');
  rowEl.className = 'print-marks';
  Object.assign(rowEl.style, {
    position: 'absolute',
    [edge]: '0',
    left: `${MARGIN_MM.side}mm`,
    right: `${MARGIN_MM.side}mm`,
    height: `${edge === 'top' ? MARGIN_MM.top : MARGIN_MM.bottom}mm`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: edge === 'top' ? 'space-between' : 'flex-end',
    fontFamily: MARK_STYLE.fontFamily,
    fontSize: `${MARK_STYLE.fontSizePt}pt`,
    color: MARK_STYLE.color,
    whiteSpace: 'nowrap',
  });
  rowEl.append(document.createElement('span'));
  if (edge === 'top') rowEl.append(document.createElement('span'));
  return rowEl;
}

export function openPrintView({ stem, title, root }: PrintViewArgs): Promise<PrintViewOutcome> {
  return new Promise((resolve) => void build(resolve));

  async function build(resolve: (outcome: PrintViewOutcome) => void): Promise<void> {
    const options = await rememberedOptions();
    const meta = { date: markDate(new Date()), title: shortTitle(title) };
    const style = document.createElement('style');
    document.head.append(style);

    let pages: PageList | null = null;
    let count = 0;
    let finalKey = '';
    let outcome: PrintViewOutcome = 'closed';
    let queue: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
      const run = queue.then(job, job);
      queue = run.catch(() => undefined);
      return run;
    };

    const dialog = document.createElement('dialog');
    dialog.className = 'print-view';
    const panel = document.createElement('div');
    panel.className = 'print-view__panel';
    const heading = document.createElement('h2');
    heading.className = 'settings-dialog__title print-view__title';
    heading.textContent = 'Print or Save as PDF';
    const body = document.createElement('div');
    body.className = 'settings-dialog__body';
    const status = document.createElement('p');
    status.className = 'print-view__status';
    status.setAttribute('role', 'status');
    const fallback = document.createElement('button');
    fallback.type = 'button';
    fallback.className = 'print-view__fallback';
    fallback.textContent = 'Use the standard print preview';
    fallback.hidden = true;
    fallback.addEventListener('click', () => {
      outcome = 'fallback';
      dialog.close();
    });
    const viewer = document.createElement('div');
    viewer.className = 'print-view__pages';
    // Focusable, so a click on the pages lets PageDown and the arrows scroll
    // them; otherwise the keys go to whichever field was touched last.
    viewer.tabIndex = 0;
    viewer.setAttribute('aria-label', 'Pages');

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog__actions print-view__actions';
    const button = (text: string, onClick: () => void, primary = false): HTMLButtonElement => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = text;
      if (primary) el.classList.add('confirm-dialog__button--primary');
      el.addEventListener('click', onClick);
      actions.append(el);
      return el;
    };

    function report(error: unknown): void {
      console.error('hashpad: print view', error);
      // Wails rejects a bound call with a bare string, not an Error.
      const reason = error instanceof Error ? error.message : String(error);
      busy(false);
      status.textContent = `Couldn't make the PDF: ${reason}`;
      fallback.hidden = false;
    }

    function busy(on: boolean, text = ''): void {
      viewer.setAttribute('aria-busy', String(on));
      print.disabled = save.disabled = on;
      if (on) status.textContent = text;
      else if (pages) onPage(pages.currentPage(), count);
    }

    function onPage(page: number, total: number): void {
      if (viewer.getAttribute('aria-busy') !== 'true' && fallback.hidden) {
        status.textContent = `Page ${page} of ${total}`;
      }
    }

    function drawMarks(layer: HTMLElement, position: number): void {
      drawPageMarks(layer, pageMarks(position, options, meta));
    }

    async function makePreview(): Promise<void> {
      busy(true, 'Updating…');
      const start = pages?.currentPage() ?? 1;
      // Fitting measures, so the copy is laid out for that moment only.
      root.classList.remove(IDLE_CLASS);
      fitWideMath(root, printableWidthMm(options));
      root.classList.add(IDLE_CLASS);
      style.textContent = pageCss(options, meta, 0, false);
      const url = await MakePrintPdf('preview', options.paper, options.orientation);
      const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
      pages?.destroy();
      pages = await showPages(viewer, data, { startPage: start, marks: drawMarks, onPage });
      count = pages.count;
      style.textContent = pageCss(options, meta, count, true);
      finalKey = '';
      busy(false);
    }

    async function makeFinal(): Promise<void> {
      const key = JSON.stringify(options);
      if (key === finalKey) return;
      style.textContent = pageCss(options, meta, count, true);
      await MakePrintPdf('final', options.paper, options.orientation);
      finalKey = key;
    }

    /**
     * Switches and numbers: drawn at once, no engine job. The page CSS waits
     * for Save or Print…, which write it just before they need it.
     */
    function marksChanged(): void {
      pages?.refreshMarks();
    }

    const number = (key: 'countFrom' | 'firstShown'): HTMLInputElement => {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'settings-dialog__control settings-dialog__control--number';
      input.min = '1';
      input.value = String(options[key]);
      input.addEventListener('input', () => {
        // Mid-edit an empty field is NaN; skip that keystroke, as the settings
        // dialog does.
        if (!Number.isFinite(input.valueAsNumber)) return;
        options[key] = Math.max(1, Math.round(input.valueAsNumber));
        marksChanged();
      });
      return input;
    };
    const countFrom = number('countFrom');
    const firstShown = number('firstShown');
    countFrom.disabled = firstShown.disabled = !options.numbers;

    const check = (text: string, key: 'title' | 'date' | 'numbers'): HTMLElement => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'settings-dialog__control settings-dialog__control--check';
      input.checked = options[key];
      input.addEventListener('change', () => {
        options[key] = input.checked;
        countFrom.disabled = firstShown.disabled = !options.numbers;
        remember(options);
        marksChanged();
      });
      return row(text, input);
    };

    const paper = choice<Paper>(options.paper, [
      ['a4', 'A4'],
      ['letter', 'Letter'],
    ]);
    const orientation = choice<Orientation>(options.orientation, [
      ['portrait', 'Portrait'],
      ['landscape', 'Landscape'],
    ]);
    for (const [select, key] of [
      [paper, 'paper'],
      [orientation, 'orientation'],
    ] as const) {
      select.addEventListener('change', () => {
        Object.assign(options, { [key]: select.value });
        remember(options);
        void enqueue(makePreview).catch(report);
      });
    }

    body.append(
      group('On every page', [
        check('Title', 'title'),
        check('Date and time', 'date'),
        check('Page numbers', 'numbers'),
      ]),
      group('Page numbers', [
        row('Start counting on page', countFrom),
        row('Show numbers from page', firstShown),
      ]),
      group('Paper', [row('Paper', paper), row('Orientation', orientation)]),
      status,
      fallback,
    );

    button('Close', () => dialog.close());
    const print = button('Print…', () => {
      void enqueue(async () => {
        style.textContent = pageCss(options, meta, count, true);
        await ShowPrintDialog();
      }).catch(report);
    });
    const save = button(
      'Save PDF…',
      () => {
        void (async () => {
          busy(true, 'Making the PDF…');
          // Both at once: the engine's freeze falls while the save dialog is up.
          const [path] = await Promise.all([
            ShowExportDialog(`${stem}.pdf`, 'pdf'),
            enqueue(makeFinal),
          ]);
          busy(false);
          if (path === '') return;
          await SavePrintPdf(path);
          // Saved: back to the document, as the other exports go (owner's call).
          dialog.close();
        })().catch(report);
      },
      true,
    );

    panel.append(heading, body, actions);
    dialog.append(panel, viewer);
    dialog.addEventListener('close', () => {
      // The standard preview, if that is next, measures the copy again.
      root.classList.remove(IDLE_CLASS);
      pages?.destroy();
      style.remove();
      dialog.remove();
      void ClosePrint();
      resolve(outcome);
    });
    document.body.append(dialog);
    dialog.showModal();
    await enqueue(makePreview).catch(report);
  }
}
