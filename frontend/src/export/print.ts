/**
 * Print or Save as PDF (SPEC §7.3), over a copy of the document and nothing
 * else. app.css's `@media print` hides everything on the page but
 * `.export-root--print`, so the chrome, the editor and any dialog stay off the
 * paper.
 *
 * **Hashpad's own print view first** (printview.ts, design §4.34): the
 * engine's PDF, previewed and saved inside Hashpad. Where that cannot run --
 * another platform, an old WebView2, a Wails that moved what the bridge reads
 * -- or when the view itself fails, the engine's **standard print preview**,
 * as File > Print worked before the view.
 *
 * **Internet images are the one wrinkle.** Hashpad never loads them (design §3),
 * so printed here they are placeholders. When a document has any, the user is
 * offered the browser instead: the standalone HTML goes to a temporary page,
 * the browser loads the images, and prints from there.
 */
import { OpenInBrowser, PrintSupported } from '../../wailsjs/go/app/App';
import { confirmPrintRemote } from '../ui/confirmdialog';
import { activeSource, buildExport, runExport } from './build';
import { documentTitle, standaloneHtml } from './html';
import { fitWideMath } from './printfit';
import { openPrintView, type PrintViewOutcome } from './printview';

export const PRINT_CLASS = 'export-root--print';

/**
 * The narrowest page the print view offers -- A4 portrait less 16 mm a side.
 * The standard dialog's paper and margins are the user's choice, made after
 * this runs; fitting to the narrowest common page shrinks a little more than
 * strictly needed on wider ones, and never too little.
 */
export const FALLBACK_PRINTABLE_MM = 178;

const WEB = /^https?:/i;

/**
 * Every internet image in a built export: the placeholders `rules/images.ts`
 * leaves, and any raw `<img>` the document wrote itself, which the CSP refuses
 * and which would print as a broken image.
 */
export function remoteImages(root: ParentNode): string[] {
  const placeholders = [...root.querySelectorAll('.preview-image-placeholder[data-src]')].map(
    (span) => span.getAttribute('data-src') ?? '',
  );
  const raw = [...root.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '');
  return [...placeholders, ...raw].filter((src) => WEB.test(src));
}

/**
 * Undoes the last standard print: its copy, its title, its listener. Run on
 * `afterprint`, and again before the next print in case that never came --
 * whether WebView2 always fires it is not something to bet the window title on.
 */
let finishPrint: (() => void) | null = null;

function endPrint(): void {
  finishPrint?.();
  finishPrint = null;
}

/** The engine's own print preview, over the marked copy. */
function standardPrint(root: HTMLElement, stem: string): void {
  fitWideMath(root, FALLBACK_PRINTABLE_MM);
  // Chromium suggests the page title as the PDF's file name, and the page is
  // called "Hashpad".
  const title = document.title;
  document.title = stem;
  finishPrint = () => {
    window.removeEventListener('afterprint', endPrint);
    document.title = title;
    root.remove();
  };
  window.addEventListener('afterprint', endPrint, { once: true });
  window.print();
}

/** File > Print or Save as PDF… */
export function printActive(): Promise<void> {
  return runExport('print', async () => {
    const source = activeSource();
    if (source === null) return;
    endPrint();

    const root = await buildExport(source.text, source.documentDir);
    let printing = false;
    try {
      if (remoteImages(root).length > 0) {
        const choice = await confirmPrintRemote();
        if (choice === 'cancel') return;
        if (choice === 'browser') {
          await OpenInBrowser(await standaloneHtml(root, documentTitle(root, source.stem)));
          return;
        }
      }

      root.classList.add(PRINT_CLASS);
      if (await PrintSupported()) {
        // The PDF's own title, as the standard preview's is.
        const title = document.title;
        document.title = source.stem;
        let outcome: PrintViewOutcome;
        try {
          outcome = await openPrintView({
            stem: source.stem,
            title: documentTitle(root, source.stem),
            root,
          });
        } finally {
          document.title = title;
        }
        if (outcome === 'closed') return;
      }
      printing = true;
      standardPrint(root, source.stem);
    } finally {
      if (!printing) root.remove();
    }
  });
}
