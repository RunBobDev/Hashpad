/**
 * The print view's pages (design §4.34), drawn by pdf.js -- and only the ones
 * in view. A 1,000-page PDF gets 1,000 empty boxes, which are cheap, and a
 * handful of canvases, which are not; boxes that scroll far away give theirs
 * back.
 *
 * Each box also carries a marks layer: the title, date and number the final
 * PDF will have. The view fills it (`marks`) and rewrites it on every change
 * (`refreshMarks`) without touching a canvas, which is what makes a change
 * instant at any length.
 *
 * pdf.js loads the first time the view opens, never at start-up. `useWasm` is
 * off: the content security policy has no 'wasm-unsafe-eval', and the
 * engine's PDFs need none of the decoders it would speed up.
 */
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

/** Space between pages, and above the first. */
const GAP = 16;
/** Space either side of a page. */
const SIDE = 24;
/** A page never grows past this, however wide the window. */
const MAX_WIDTH = 1000;
/** Canvases this many pages beyond the viewport survive a scroll. */
const KEEP = 2;

type PdfJs = typeof import('pdfjs-dist');
let loading: Promise<PdfJs> | null = null;

function loadPdfjs(): Promise<PdfJs> {
  loading ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([lib, worker]) => {
    // One of Hashpad's own files: script-src 'self' covers it.
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return loading;
}

export interface PageRange {
  first: number;
  last: number;
}

/** Pages (1-based, inclusive) on screen, plus `overscan` either side. */
export function visiblePages(
  scrollTop: number,
  viewportHeight: number,
  pageHeight: number,
  gap: number,
  count: number,
  overscan = 1,
): PageRange {
  if (count === 0) return { first: 1, last: 0 };
  const stride = pageHeight + gap;
  // Page n is on screen while its bottom is below scrollTop and its top is
  // above the viewport's bottom.
  const first = Math.floor((scrollTop - gap - pageHeight) / stride) + 2;
  const last = Math.ceil((scrollTop + viewportHeight - gap) / stride);
  return {
    first: Math.max(1, first - overscan),
    last: Math.min(count, last + overscan),
  };
}

/** The page "Page N of M" names: the one under the viewport's top third. */
export function pageAt(
  scrollTop: number,
  viewportHeight: number,
  pageHeight: number,
  gap: number,
  count: number,
): number {
  const n = Math.floor((scrollTop + viewportHeight / 3 - gap) / (pageHeight + gap)) + 1;
  return Math.min(count, Math.max(1, n));
}

export interface PageListOptions {
  /** Shown first; the view passes the page it was on before a re-make. */
  startPage: number;
  marks: (layer: HTMLElement, position: number) => void;
  onPage: (page: number, count: number) => void;
}

export interface PageList {
  readonly count: number;
  currentPage(): number;
  refreshMarks(): void;
  destroy(): void;
}

interface Slot {
  box: HTMLElement;
  marks: HTMLElement;
  canvas?: HTMLCanvasElement | undefined;
  task?: RenderTask | undefined;
}

export async function showPages(
  host: HTMLElement,
  data: Uint8Array,
  opts: PageListOptions,
): Promise<PageList> {
  const lib = await loadPdfjs();
  // The loading task owns the worker side; destroying it frees the document.
  const loading = lib.getDocument({ data, useWasm: false });
  const doc: PDFDocumentProxy = await loading.promise;
  // Every page of a Hashpad print has the first page's size.
  const base = (await doc.getPage(1)).getViewport({ scale: 1 });
  const count = doc.numPages;

  const sheet = document.createElement('div');
  sheet.className = 'print-pages';
  const slots: Slot[] = Array.from({ length: count }, () => {
    const box = document.createElement('div');
    // Paper is white in a dark app too.
    box.className = 'print-page theme-light';
    const marks = document.createElement('div');
    marks.className = 'print-page__marks';
    box.append(marks);
    sheet.append(box);
    return { box, marks };
  });
  host.replaceChildren(sheet);

  let width = 0;
  let height = 0;

  function layout(): void {
    width = Math.min(MAX_WIDTH, Math.max(200, host.clientWidth - 2 * SIDE));
    height = (base.height / base.width) * width;
    sheet.style.height = `${GAP + count * (height + GAP)}px`;
    const left = Math.max(SIDE, (host.clientWidth - width) / 2);
    // The layer is the page at 96 px to the inch (a PDF point is 1/72 in),
    // scaled onto the box, so the view can place marks in CSS millimetres.
    const pageCssWidth = (base.width * 4) / 3;
    const scale = width / pageCssWidth;
    slots.forEach((slot, i) => {
      Object.assign(slot.box.style, {
        top: `${GAP + i * (height + GAP)}px`,
        left: `${left}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      Object.assign(slot.marks.style, {
        width: `${pageCssWidth}px`,
        height: `${(base.height * 4) / 3}px`,
        transform: `scale(${scale})`,
      });
    });
  }

  function free(slot: Slot): void {
    slot.task?.cancel();
    slot.task = undefined;
    slot.canvas?.remove();
    slot.canvas = undefined;
  }

  async function draw(index: number): Promise<void> {
    const slot = slots[index]!;
    if (slot.canvas) return;
    const canvas = document.createElement('canvas');
    slot.canvas = canvas;
    slot.box.prepend(canvas);
    const page: PDFPageProxy = await doc.getPage(index + 1);
    if (slot.canvas !== canvas) return; // freed while loading
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const task = page.render({ canvas, viewport });
    slot.task = task;
    try {
      await task.promise;
    } catch (error) {
      if (!(error instanceof lib.RenderingCancelledException)) throw error;
    } finally {
      if (slot.task === task) slot.task = undefined;
    }
  }

  function currentPage(): number {
    return pageAt(host.scrollTop, host.clientHeight, height, GAP, count);
  }

  function update(): void {
    const { first, last } = visiblePages(host.scrollTop, host.clientHeight, height, GAP, count);
    slots.forEach((slot, i) => {
      const n = i + 1;
      if (slot.canvas && (n < first - KEEP || n > last + KEEP)) free(slot);
    });
    for (let n = first; n <= last; n++) {
      opts.marks(slots[n - 1]!.marks, n);
      draw(n - 1).catch((error: unknown) => console.error('hashpad: page draw failed', error));
    }
    opts.onPage(currentPage(), count);
  }

  let frame = 0;
  const onScroll = (): void => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  };
  let lastWidth = host.clientWidth;
  const resize = new ResizeObserver(() => {
    if (host.clientWidth === lastWidth) return;
    lastWidth = host.clientWidth;
    const page = currentPage();
    slots.forEach(free);
    layout();
    host.scrollTop = (page - 1) * (height + GAP);
    update();
  });

  layout();
  host.scrollTop = (Math.min(Math.max(1, opts.startPage), count) - 1) * (height + GAP);
  host.addEventListener('scroll', onScroll, { passive: true });
  resize.observe(host);
  update();

  return {
    count,
    currentPage,
    refreshMarks(): void {
      slots.forEach((slot, i) => {
        if (slot.canvas) opts.marks(slot.marks, i + 1);
      });
    },
    destroy(): void {
      cancelAnimationFrame(frame);
      resize.disconnect();
      host.removeEventListener('scroll', onScroll);
      slots.forEach(free);
      sheet.remove();
      void loading.destroy();
    },
  };
}
