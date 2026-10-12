/**
 * Does the print view's page list hold up, in a real browser, under the app's
 * content security policy (copied into pdfpages.html)?
 *
 * 1. pdf.js loads, its worker starts, and a page draws -- nothing refused.
 * 2. A 1,032-page PDF keeps only a handful of canvases, however far it scrolls.
 * 3. Rewriting every drawn page's marks takes well under 0.1 s.
 *
 * The PDF is generated here, so the harness needs no file: plain PDF syntax,
 * one Helvetica line per page.
 */
import '../src/styles/app.css';
import { showPages, type PageList } from '../src/export/pdfpages';

function testPdf(pages: number): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // the page tree, filled in once the kids are known
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (let n = 1; n <= pages; n++) {
    const text = `BT /F1 36 Tf 72 700 Td (Page ${n}) Tj ET`;
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const host = document.querySelector<HTMLElement>('#app')!;
let list: PageList | null = null;
const status = { page: 0, count: 0 };

function marks(layer: HTMLElement, position: number): void {
  layer.textContent = `marks for ${position}`;
  layer.style.font = '9pt "Segoe UI"';
}

declare global {
  interface Window {
    harness: {
      open(pages: number): Promise<number>;
      canvases(): number;
      scrollTo(page: number): void;
      status(): typeof status;
      refreshMs(): number;
    };
  }
}

window.harness = {
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
