// @vitest-environment jsdom
/**
 * Help > About Hashpad.
 *
 * Everything goes through `buildAboutDialog` rather than `openAbout`, for the
 * reason `confirmdialog.test.ts` does the same: jsdom implements `<dialog>` as
 * a bare `HTMLElement` with no `showModal()`, so anything downstream of showing
 * it is unreachable. What is reachable is every part where a bug would live --
 * the content, the teardown, and the button that reaches the browser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildAboutDialog, REPOSITORY_URL } from './aboutdialog';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';

vi.mock('../../wailsjs/runtime/runtime', () => ({ BrowserOpenURL: vi.fn() }));

/**
 * The version `wails.json` actually declares.
 *
 * Resolved from `process.cwd()`, which Vitest sets to the project root
 * (`frontend/`). `new URL('…', import.meta.url)` was the first attempt and
 * fails here with "The URL must be of scheme file" -- the module's URL is not
 * a file URL under Vitest's transform.
 */
const productVersion = (
  JSON.parse(readFileSync(resolve(process.cwd(), '../wails.json'), 'utf8')) as {
    info: { productVersion: string };
  }
).info.productVersion;

describe('the About dialog', () => {
  /**
   * **Compared against `wails.json`, not against a literal.**
   *
   * A hard-coded `'0.3.0'` here would pass while the injection was broken and
   * would need editing on every release -- exactly the second place to remember
   * that the Vite `define` exists to avoid. Reading the same file the build
   * reads means this fails if the wiring breaks *or* if the two ever diverge.
   */
  it('shows the version the build was stamped with', () => {
    const text = buildAboutDialog().querySelector('.about-dialog__version')!.textContent;

    expect(text).toBe(`Version ${productVersion}`);
    // Guards the failure mode where `define` silently substitutes nothing and
    // the assertion above compares two identical empty strings.
    expect(productVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('names the licence and the repository', () => {
    const facts = buildAboutDialog().querySelector('.about-dialog__facts')!;

    expect(facts.textContent).toContain('GPL-3.0');
    expect(facts.textContent).toContain(REPOSITORY_URL);
  });

  it('closes and removes itself', () => {
    const dialog = buildAboutDialog();
    document.body.append(dialog);

    dialog.querySelector<HTMLButtonElement>('.confirm-dialog__button--primary')!.click();

    expect(dialog.isConnected).toBe(false);
  });

  /**
   * Escape closes without `preventDefault`, unlike the prompts in
   * `confirmdialog.ts` -- there is no choice being made here, so nothing is
   * lost by dismissing.
   */
  it('closes on Escape', () => {
    const dialog = buildAboutDialog();
    document.body.append(dialog);

    dialog.dispatchEvent(new Event('cancel'));

    expect(dialog.isConnected).toBe(false);
  });

  /**
   * Straight to the browser with no confirmation prompt, where a link inside a
   * *document* goes through `confirmOpenLink` first. The difference is that
   * this URL is compiled in rather than authored by whoever wrote the file
   * being edited.
   */
  it('opens the repository in the browser and closes', () => {
    const dialog = buildAboutDialog();
    document.body.append(dialog);

    const view = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'View source',
    )!;
    view.click();

    expect(BrowserOpenURL).toHaveBeenCalledWith(REPOSITORY_URL);
    expect(dialog.isConnected).toBe(false);
  });

  /** Teardown runs once, so a second click cannot re-fire anything. */
  it('settles only once', () => {
    const dialog = buildAboutDialog();
    document.body.append(dialog);
    const close = dialog.querySelector<HTMLButtonElement>('.confirm-dialog__button--primary')!;

    close.click();
    close.click();

    expect(dialog.isConnected).toBe(false);
  });
});
