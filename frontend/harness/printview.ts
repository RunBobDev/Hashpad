/**
 * The real print view in a real browser, with Go stood in for.
 *
 * jsdom has no layout and no pdf.js, and the real exe has no devtools, so
 * questions of layout and scrolling are asked here: open the view, then read
 * it with the browser's own tools. The PDF is testpdf.ts's; the bindings
 * below answer as Go would, and "print" only records what it was asked.
 *
 * connect-src carries `blob:` in this page only, for the stand-in PDF's
 * address; the app's PDFs are same-origin.
 */
import '../src/styles/app.css';
import { openPrintView } from '../src/export/printview';
import { testPdf } from './testpdf';

const calls: string[] = [];
let pages = 5;

declare global {
  interface Window {
    go: unknown;
    printView: {
      open(pageCount: number): Promise<void>;
      calls(): string[];
      viewer(): HTMLElement | null;
    };
  }
}

window.go = {
  app: {
    App: {
      LoadSettings: () =>
        Promise.resolve({
          print: {
            title: true,
            date: true,
            pageNumbers: true,
            paper: 'a4',
            orientation: 'portrait',
          },
        }),
      SaveSettings: () => Promise.resolve(),
      MakePrintPdf: (kind: string, paper: string, orientation: string) => {
        calls.push(`MakePrintPdf ${kind} ${paper} ${orientation}`);
        const blob = new Blob([testPdf(pages)], { type: 'application/pdf' });
        return Promise.resolve(URL.createObjectURL(blob));
      },
      ShowExportDialog: () => Promise.resolve(''),
      SavePrintPdf: () => Promise.resolve(),
      ShowPrintDialog: () => {
        calls.push('ShowPrintDialog');
        return Promise.resolve();
      },
      ClosePrint: () => {
        calls.push('ClosePrint');
        return Promise.resolve();
      },
    },
  },
};

window.printView = {
  async open(pageCount) {
    pages = pageCount;
    const root = document.createElement('div');
    root.innerHTML = '<h1>Harness</h1>';
    document.body.append(root);
    void openPrintView({ stem: 'harness', title: 'Harness', root });
    // The view builds asynchronously; give it the preview.
    for (let i = 0; i < 100 && !document.querySelector('.print-page'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
  calls: () => [...calls],
  viewer: () => document.querySelector<HTMLElement>('.print-view__pages'),
};
