/**
 * Help > About Hashpad.
 *
 * The menu item shipped disabled in Checkpoint A with the comment "there is no
 * About dialog yet, so leaving it enabled would mean an item that does nothing
 * when activated", and stayed that way through Phase 1 and three releases. The
 * owner found it: a Help menu whose only item is greyed out reads as an empty
 * menu, which is worse than no Help menu at all.
 *
 * **Reuses `.confirm-dialog` for the shell**, so the frame, the backdrop, the
 * button styling and the dark-theme tokens are the ones every other modal in
 * the app already uses. Only the content classes are new. It does not reuse
 * `buildDialog` from `confirmdialog.ts`, which takes a single string and a row
 * of choice buttons -- generalising that to carry a definition list would
 * complicate a helper four prompts depend on, to serve the one dialog that
 * asks no question.
 */
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';

/** Injected by Vite from `wails.json`'s `info.productVersion`. */
declare const __APP_VERSION__: string;

export const REPOSITORY_URL = 'https://github.com/RunBobDev/Hashpad';

/**
 * Builds the dialog without showing it.
 *
 * Split from `openAbout` for the reason `confirmdialog.ts` splits its own
 * builders: jsdom implements `<dialog>` as a bare `HTMLElement` with no
 * `showModal()`, so everything downstream of showing it is untestable. Every
 * part where a bug would actually live is in here.
 */
export function buildAboutDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirm-dialog about-dialog';
  dialog.setAttribute('aria-labelledby', 'about-dialog-name');

  const name = document.createElement('h2');
  name.id = 'about-dialog-name';
  name.className = 'about-dialog__name';
  name.textContent = 'Hashpad';

  const version = document.createElement('p');
  version.className = 'about-dialog__version';
  version.textContent = `Version ${__APP_VERSION__}`;

  const summary = document.createElement('p');
  summary.className = 'about-dialog__summary';
  summary.textContent = 'A markdown editor for Windows.';

  const facts = document.createElement('dl');
  facts.className = 'about-dialog__facts';
  for (const [term, value] of [
    ['Licence', 'GPL-3.0'],
    // Plain text rather than an anchor. A link in here would have to route
    // through `confirmOpenLink`, which is itself a modal -- and stacking a
    // second `<dialog>` on top of an open one is a arrangement worth avoiding
    // for a URL short enough to read and type. The button below opens it.
    ['Source', REPOSITORY_URL],
  ] as const) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.append(dt, dd);
  }

  const actions = document.createElement('div');
  actions.className = 'confirm-dialog__actions';

  // Settled once and torn down on every path, matching `buildDialog`'s
  // contract -- a dialog left in the DOM after closing would swallow the next
  // `showModal` on some browsers and is invisible until it does.
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    // Guarded because jsdom has no `close()`. Removing on the next line is
    // what actually tears it down, which is why the teardown path is testable.
    dialog.close?.();
    dialog.remove();
  };

  const view = document.createElement('button');
  view.type = 'button';
  view.textContent = 'View source';
  view.addEventListener('click', () => {
    // Straight to the browser, with no confirmation: `confirmOpenLink` exists
    // because a link in a *document* is untrusted content the user may not
    // have read. This URL is compiled in, and the user asked for it by name.
    BrowserOpenURL(REPOSITORY_URL);
    finish();
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.classList.add('confirm-dialog__button--primary');
  close.addEventListener('click', finish);

  actions.append(view, close);

  // Escape closes, like every other modal here. No `preventDefault`: unlike the
  // prompts, there is no choice being made and nothing to lose by dismissing.
  dialog.addEventListener('cancel', finish);

  dialog.append(name, version, summary, facts, actions);
  return dialog;
}

export function openAbout(): void {
  const dialog = buildAboutDialog();
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('.confirm-dialog__button--primary')?.focus();
}
