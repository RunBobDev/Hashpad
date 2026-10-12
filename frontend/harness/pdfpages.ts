/**
 * Does the print view's page list hold up, in a real browser, under the app's
 * content security policy (copied into pdfpages.html)?
 *
 * 1. pdf.js loads, its worker starts, and a page draws -- nothing refused.
 * 2. A 1,032-page PDF keeps only a handful of canvases, however far it scrolls.
 * 3. Rewriting every drawn page's marks takes well under 0.1 s.
 */
import '../src/styles/app.css';
import { showPages, type PageList } from '../src/export/pdfpages';
import { testPdf } from './testpdf';

const host = document.querySelector<HTMLElement>('#app')!;
let list: PageList | null = null;
const status = { page: 0, count: 0 };

function marks(layer: HTMLElement, position: number): void {
  layer.textContent = `marks for ${position}`;
  layer.style.font = '9pt "Segoe UI"';
}

declare global {
  interface Window {
    pdfPages: {
      open(pages: number): Promise<number>;
      canvases(): number;
      scrollTo(page: number): void;
      status(): typeof status;
      refreshMs(): number;
    };
  }
}

window.pdfPages = {
  async open(pages) {
    list?.destroy();
    list = await showPages(host, testPdf(pages), {
      startPage: 1,
      marks,
      onPage: (page, count) => Object.assign(status, { page, count }),
    });
    return list.count;
  },
  canvases: () => host.querySelectorAll('canvas').length,
  scrollTo(page) {
    const box = host.querySelector<HTMLElement>('.print-page');
    host.scrollTop = (page - 1) * ((box?.offsetHeight ?? 0) + 16);
  },
  status: () => ({ ...status }),
  refreshMs() {
    const start = performance.now();
    list?.refreshMarks();
    return performance.now() - start;
  },
};
