/**
 * Does the settings dialog actually *look* like a dialog?
 *
 * jsdom implements `<dialog>` as a bare `HTMLElement`: no `showModal()`, no top
 * layer, no backdrop, and no layout at all. So settingsdialog.test.ts can prove
 * every control carries the right value and writes the right thing, and still
 * say nothing about whether the label column lines up, whether the swatch reads
 * as a swatch, or whether any of it is legible in dark mode. That is the gap
 * this page exists for -- the same reason gutter.ts exists.
 *
 * **One dialog, and the theme flipped on the root.** The obvious version of this
 * page -- two panels side by side, `data-theme` on each -- renders two identical
 * *light* copies and looks convincing. variables.css scopes its dark block to
 * `:root[data-theme='dark']`, so the attribute means nothing anywhere but
 * `<html>`. Worth knowing before writing another of these: harness/gutter.ts
 * sets it on a wrapper and has the same flaw.
 */
import { buildSettingsDialog } from '../src/ui/settingsdialog';
import type { app } from '../wailsjs/go/models';
import '../src/styles/app.css';

/** Shaped like Go's, with values a real settings.json would carry. */
function settings(): app.Settings {
  return {
    version: 2,
    appearance: { theme: 'system', accentColor: '#0078d4', uiFontSize: 14 },
    editor: {
      fontFamily: 'Cascadia Mono',
      fontSize: 14,
      lineHeight: 1.6,
      wordWrap: true,
      maxContentWidth: 0,
      showLineNumbers: true,
      tabSize: 2,
      insertSpaces: true,
      defaultViewMode: 'source',
    },
    preview: { fontFamily: 'Segoe UI', fontSize: 15, syncScroll: true },
    files: {
      autosave: false,
      autosaveDelayMs: 2000,
      assetFolder: 'assets',
      defaultEncoding: 'utf-8',
    },
    window: {
      width: 1000,
      height: 700,
      maximized: false,
      outlineVisible: false,
      outlineWidth: 240,
      statusBarVisible: true,
      previewSplitRatio: 0.5,
    },
    toolbar: { visible: true, pinned: ['bold'] },
  } as unknown as app.Settings;
}

const root = document.querySelector<HTMLElement>('#app')!;
root.style.cssText =
  'min-height:100vh;padding:32px;background:var(--bg-app);color:var(--fg-primary);font-family:var(--font-ui)';

// Enough chrome behind it to judge the backdrop and the elevation against
// something, rather than against an empty white page.
const behind = document.createElement('p');
behind.textContent = 'Window content behind the modal — the backdrop dims this.';
behind.style.cssText = 'margin:0 0 24px;font-size:14px';
root.append(behind);

const dialog = buildSettingsDialog(settings());
root.append(dialog);
dialog.showModal();

/**
 * A CSS colour resolved to real sRGB, by painting it and reading the pixel.
 *
 * Not parseable from the string: `--accent` is a `color-mix()` and
 * `getComputedStyle` hands back `oklab(0.76 -0.029 -0.087)` untouched. The
 * obvious `match(/[\d.]+/g)` **drops the minus signs**, turning that into a
 * near-black and reporting the Close button at 1.21:1 -- a contrast failure
 * that was not real. Painting is the only reading that cannot lie.
 */
const swatchCanvas = document.createElement('canvas');
swatchCanvas.width = 1;
swatchCanvas.height = 1;
const swatchCtx = swatchCanvas.getContext('2d', { willReadFrequently: true })!;

function srgb(css: string): [number, number, number] {
  swatchCtx.fillStyle = '#000';
  swatchCtx.fillRect(0, 0, 1, 1);
  swatchCtx.fillStyle = css;
  swatchCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = swatchCtx.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG contrast, to two decimals. AA wants 4.5 for text, 3 for a UI border. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(srgb(a)), relativeLuminance(srgb(b))].sort((x, y) => y - x);
  return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
}

declare global {
  interface Window {
    __setTheme: (theme: 'light' | 'dark') => void;
    __settingsReport: () => Record<string, unknown>;
    __settingsContrast: () => Record<string, unknown>;
  }
}

window.__settingsContrast = () => {
  const surface = getComputedStyle(dialog).backgroundColor;
  const styleOf = (selector: string): CSSStyleDeclaration =>
    getComputedStyle(dialog.querySelector(selector)!);
  const close = styleOf('.settings-dialog__close');
  const control = styleOf('.settings-dialog__control');

  return {
    theme: document.documentElement.dataset.theme,
    title: contrast(styleOf('.settings-dialog__title').color, surface),
    label: contrast(styleOf('.settings-dialog__label').color, surface),
    legend: contrast(styleOf('.settings-dialog__legend').color, surface),
    hint: contrast(styleOf('.settings-dialog__hint').color, surface),
    closeButton: contrast(close.color, close.backgroundColor),
    controlText: contrast(control.color, control.backgroundColor),
    // Non-text, so WCAG 1.4.11 asks for 3:1. This one does not reach it in
    // either theme -- see docs/testing.md; it is `--border-strong` against
    // `--bg-elevated`, the pair the confirm dialog's buttons already use, so it
    // is an app-wide token question rather than this dialog's to answer alone.
    controlBorder: contrast(control.borderTopColor, surface),
  };
};

window.__setTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
};

window.__settingsReport = () => {
  const body = dialog.querySelector<HTMLElement>('.settings-dialog__body')!;
  const box = dialog.getBoundingClientRect();
  const round = (n: number): number => Math.round(n);
  const colourOf = (selector: string): string =>
    getComputedStyle(dialog.querySelector(selector)!).color;

  return {
    theme: document.documentElement.dataset.theme,
    // All equal means the label grid is doing its job across rows.
    labelLefts: [...dialog.querySelectorAll('.settings-dialog__label')].map((el) =>
      round(el.getBoundingClientRect().left),
    ),
    // All equal means the controls line up down the right edge too.
    controlRights: [...dialog.querySelectorAll('.settings-dialog__control')].map((el) =>
      round(el.getBoundingClientRect().right),
    ),
    dialogWidth: round(box.width),
    dialogHeight: round(box.height),
    // The modal has to be on screen and inside the viewport, which is the one
    // thing `position:static` in an earlier version of this page hid.
    inViewport: box.top >= 0 && box.bottom <= window.innerHeight,
    surface: getComputedStyle(dialog).backgroundColor,
    titleColour: colourOf('.settings-dialog__title'),
    legendColour: colourOf('.settings-dialog__legend'),
    hintColour: colourOf('.settings-dialog__hint'),
    closeBackground: getComputedStyle(dialog.querySelector('.settings-dialog__close')!)
      .backgroundColor,
    bodyOverflowY: getComputedStyle(body).overflowY,
    // `0` here would mean the body is not the thing that scrolls.
    bodyScrollable: round(body.scrollHeight - body.clientHeight),
    swatchValue: dialog.querySelector<HTMLInputElement>('input[type="color"]')!.value,
  };
};
