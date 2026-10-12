// @vitest-environment jsdom
/**
 * Print or Save as PDF (SPEC §7.3).
 *
 * `window.print` is stubbed -- jsdom only logs "not implemented" -- and the
 * stub is where each case looks at the page as the print dialog would see it.
 * Whether the dialog really shows only the document is the real exe's
 * question; `app.css`'s print rules are pinned as text below.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenInBrowser } from '../../wailsjs/go/app/App';
import { confirmPrintRemote, type PrintChoice } from '../ui/confirmdialog';
import { activeSource, type ExportSource } from './build';
import { PRINT_CLASS, printActive, remoteImages } from './print';
import { fitWideMath } from './printfit';

vi.mock('../../wailsjs/go/app/App', () => ({ OpenInBrowser: vi.fn(() => Promise.resolve()) }));

// An ES module's exports cannot be spied on in place.
vi.mock('./printfit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./printfit')>()),
  fitWideMath: vi.fn(),
}));

vi.mock('../ui/confirmdialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui/confirmdialog')>()),
  confirmPrintRemote: vi.fn(),
  showNotice: vi.fn(() => Promise.resolve()),
}));

vi.mock('./build', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./build')>()),
  activeSource: vi.fn(),
}));

function source(text: string): void {
  const value: ExportSource = { text, documentDir: null, stem: 'notes', lineEnding: 'lf' };
  vi.mocked(activeSource).mockReturnValue(value);
}

function answer(choice: PrintChoice): void {
  vi.mocked(confirmPrintRemote).mockResolvedValue(choice);
}

/** What the print dialog was handed: the print root, if any, and the title. */
let printed: { root: Element | null; title: string } | null;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
  document.title = 'Hashpad';
  printed = null;
  vi.spyOn(window, 'print').mockImplementation(() => {
    printed = { root: document.querySelector(`.${PRINT_CLASS}`), title: document.title };
  });
});

afterEach(() => {
  window.dispatchEvent(new Event('afterprint'));
  vi.restoreAllMocks();
});

const INTERNET_IMAGE = '![cat](https://example.com/cat.png)';

describe('remoteImages', () => {
  it('finds internet images as placeholders and as raw <img>, nothing else', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<span class="preview-image-placeholder" data-src="https://a.example/x.png"></span>' +
      '<span class="preview-image-placeholder" data-alt="local"></span>' +
      '<img src="http://b.example/y.png">' +
      '<img src="data:image/png;base64,AA">' +
      '<img src="/__hashpad/asset?dir=D&amp;path=a.png">';

    expect(remoteImages(root)).toEqual(['https://a.example/x.png', 'http://b.example/y.png']);
  });
});

describe('printActive', () => {
  it('prints the document straight away when nothing is from the internet', async () => {
    source('# Hello');

    await printActive();

    expect(confirmPrintRemote).not.toHaveBeenCalled();
    expect(printed?.root?.querySelector('h1')?.textContent).toBe('Hello');
  });

  /** Chromium suggests the page title as the PDF's name, and the page is "Hashpad". */
  it('names the PDF after the document while printing, and puts the title back', async () => {
    source('# Hello');

    await printActive();
    expect(printed?.title).toBe('notes');

    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('Hashpad');
  });

  it('removes the print copy once printing is over', async () => {
    source('# Hello');

    await printActive();
    window.dispatchEvent(new Event('afterprint'));

    expect(document.querySelector('.export-root')).toBeNull();
  });

  /** If WebView2 ever skips `afterprint`, the next print must not show two documents. */
  it('clears a print copy left over from a print that never finished', async () => {
    source('# First');
    await printActive();
    source('# Second');

    await printActive();

    expect(document.querySelectorAll(`.${PRINT_CLASS}`)).toHaveLength(1);
    expect(printed?.root?.querySelector('h1')?.textContent).toBe('Second');
    // And the title the app gets back is its own, not the first print's.
    window.dispatchEvent(new Event('afterprint'));
    expect(document.title).toBe('Hashpad');
  });

  it('asks first when there are internet images, and Cancel prints nothing', async () => {
    source(INTERNET_IMAGE);
    answer('cancel');

    await printActive();

    expect(confirmPrintRemote).toHaveBeenCalledOnce();
    expect(window.print).not.toHaveBeenCalled();
    expect(OpenInBrowser).not.toHaveBeenCalled();
    expect(document.querySelector('.export-root')).toBeNull();
  });

  it('hands the page to the browser on Open in Browser, internet image and all', async () => {
    source(INTERNET_IMAGE);
    answer('browser');

    await printActive();

    expect(window.print).not.toHaveBeenCalled();
    expect(OpenInBrowser).toHaveBeenCalledOnce();
    expect(vi.mocked(OpenInBrowser).mock.calls[0]![0]).toContain(
      '<img src="https://example.com/cat.png" alt="cat">',
    );
    expect(document.querySelector('.export-root')).toBeNull();
  });

  it('shrinks wide equations to the page before printing', async () => {
    source('$$\na_1 + a_2\n$$');

    await printActive();

    expect(fitWideMath).toHaveBeenCalledWith(expect.any(HTMLElement), 178);
  });

  it('prints here with placeholders on Print Here', async () => {
    source(INTERNET_IMAGE);
    answer('here');

    await printActive();

    expect(printed?.root?.querySelector('.preview-image-placeholder')).not.toBeNull();
  });
});

/**
 * Only the document reaches paper: everything else on `body` is hidden, and
 * the copy drops its off-screen `position: fixed`, which would otherwise repeat
 * it on every printed page.
 */
describe('the print stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');
  const print = /@media print \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? '';

  /**
   * `!important`, because `#app { display: flex }` is an ID selector and
   * outranks this one. Without it the real exe printed the whole app -- menus,
   * toolbar, editor -- across seven pages, while this file's earlier regex,
   * which did not ask for it, passed.
   */
  it('hides everything but the print copy, whatever selector shows it', () => {
    expect(print).toMatch(/body > :not\(\.export-root--print\)\s*\{\s*display: none !important;/);
  });

  it('puts the print copy back into the flow', () => {
    expect(print).toMatch(/\.export-root--print\s*\{[^}]*position: static;/);
  });

  /**
   * Chromium drops backgrounds when printing unless the page asks. A highlight
   * is nothing but its background; the real exe printed `==marked==` as plain
   * text.
   */
  it('keeps backgrounds, which carry meaning in a document', () => {
    expect(print).toMatch(/\.export-root--print\s*\{[^}]*print-color-adjust: exact;/);
  });

  it('lets the page run past one screen', () => {
    expect(print).toMatch(/html,\s*body\s*\{[^}]*height: auto;[^}]*overflow: visible;/);
  });

  /**
   * A scrollbar prints as a scrollbar, and whatever is past it does not print
   * at all: the real exe lost the end of a long code line and of a long
   * equation. Code wraps; an equation cannot, so printfit.ts shrinks it.
   */
  it('wraps long code lines instead of scrolling them', () => {
    expect(print).toMatch(
      /\.preview-pane\.export-root--print pre\s*\{[^}]*white-space: pre-wrap;[^}]*overflow: visible;/,
    );
  });

  it('lets a wide equation overflow rather than scroll, for printfit to shrink', () => {
    expect(print).toMatch(
      /\.preview-pane\.export-root--print \.preview-math-display\s*\{[^}]*overflow: visible;/,
    );
  });
});
