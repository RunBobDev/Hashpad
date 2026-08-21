/**
 * SPEC §6.3 wants the Windows-10-era Save / Don't Save / Cancel prompt. Wails v2
 * cannot produce a three-button native dialog on Windows — its QuestionDialog
 * maps to MB_YESNO, with no Cancel at all — so this is built in-app.
 *
 * <dialog> is used rather than a hand-rolled overlay because showModal() brings
 * real modal semantics with it: the top layer, an inert background, focus
 * trapping, and Escape handling. Reimplementing those correctly is more code
 * and more bugs than using the element designed for it.
 */

export type SaveChoice = 'save' | 'dontsave' | 'cancel';

interface ChoiceButton {
  choice: SaveChoice;
  label: string;
  primary: boolean;
}

const BUTTONS: ChoiceButton[] = [
  { choice: 'save', label: 'Save', primary: true },
  { choice: 'dontsave', label: "Don't Save", primary: false },
  { choice: 'cancel', label: 'Cancel', primary: false },
];

/**
 * Builds the dialog and wires every dismissal path to `onChoice`, without
 * showing it.
 *
 * Split out from `confirmSave` purely for testability: `showModal()` does not
 * exist in jsdom, so anything downstream of it is unreachable in tests. With
 * construction separated, the parts where bugs actually live — a click
 * resolving with the right choice, settling exactly once, the element being
 * removed — are all exercisable with plain EventTarget dispatch, which jsdom
 * does implement.
 */
/**
 * The plumbing both dialogs need: settle exactly once, always tear the element
 * down, and treat Escape as the safe answer.
 *
 * Generic over the choice type because the two prompts do not share one -- the
 * save prompt has three answers and the link prompt has two -- but they do share
 * every hard part, and those are the parts worth having one copy of.
 *
 * `escapeWith` is a parameter rather than a convention: "the answer that loses
 * nothing" is Cancel for the save prompt and "don't open it" for the link
 * prompt, and neither should be inferred from button order.
 */
function buildDialog<T>(
  text: string,
  buttons: readonly { choice: T; label: string; primary?: boolean }[],
  escapeWith: T,
  onChoice: (choice: T) => void,
): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirm-dialog';
  dialog.setAttribute('aria-labelledby', 'confirm-dialog-message');

  const message = document.createElement('p');
  message.id = 'confirm-dialog-message';
  message.className = 'confirm-dialog__message';
  message.textContent = text;

  const actions = document.createElement('div');
  actions.className = 'confirm-dialog__actions';

  // Settle exactly once and always tear the dialog down, so a caller awaiting
  // this can never be left hanging on a dialog the user already dismissed.
  let settled = false;
  const finish = (choice: T): void => {
    if (settled) return;
    settled = true;
    // Guarded because jsdom implements <dialog> as a bare HTMLElement with no
    // close(). Skipping it there costs nothing — the element is removed on the
    // next line either way — and lets the teardown path be tested at all.
    dialog.close?.();
    dialog.remove();
    onChoice(choice);
  };

  for (const button of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = button.label;
    if (button.primary) el.classList.add('confirm-dialog__button--primary');
    el.addEventListener('click', () => finish(button.choice));
    actions.append(el);
  }

  // Escape means "I didn't decide", which is the answer that loses nothing. A
  // backdrop click is deliberately NOT wired to the same thing: verified against
  // real Chromium that clicking outside the dialog box neither fires 'cancel'
  // nor closes it, and that inertness matches native Windows modal prompts,
  // which do not light-dismiss on an outside click either.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    finish(escapeWith);
  });

  dialog.append(message, actions);
  return dialog;
}

export function buildConfirmDialog(
  filename: string,
  onChoice: (choice: SaveChoice) => void,
): HTMLDialogElement {
  return buildDialog(`Do you want to save changes to ${filename}?`, BUTTONS, 'cancel', onChoice);
}

/**
 * The prompt before a preview link leaves for the OS browser.
 *
 * It shows the **href**, not the link text, and that is the whole reason it
 * exists rather than opening straight away: a document is untrusted content, and
 * markdown lets the visible text say one thing while the destination says
 * another. Seeing the real URL is the only way to notice.
 *
 * Escape declines, per `buildDialog`'s contract -- not opening is what loses
 * nothing.
 */
export function buildLinkDialog(url: string, onChoice: (open: boolean) => void): HTMLDialogElement {
  return buildDialog(
    `Open this link in your browser?

${url}`,
    [
      { choice: true, label: 'Open', primary: true },
      { choice: false, label: 'Cancel' },
    ],
    false,
    onChoice,
  );
}

/**
 * SPEC §6.10 step 1: an image needs a folder to be written into, and an
 * untitled document has none.
 *
 * A prompt rather than opening Save As straight away. Ctrl+V is not a save
 * gesture, so a file dialog appearing out of it reads as the app having lost
 * the plot; one sentence saying why costs a click and removes the confusion.
 *
 * Escape declines, per `buildDialog`'s contract -- not saving is what loses
 * nothing, since the image is still on the clipboard afterwards.
 */
export function buildImageSaveDialog(onChoice: (save: boolean) => void): HTMLDialogElement {
  return buildDialog(
    'Save this document before adding an image?\n\n' +
      'Images are stored in a folder next to the document, so it needs a location first.',
    [
      { choice: true, label: 'Save', primary: true },
      { choice: false, label: 'Cancel' },
    ],
    false,
    onChoice,
  );
}

export function confirmSaveForImage(): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = buildImageSaveDialog(resolve);
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('.confirm-dialog__button--primary')?.focus();
  });
}

export function confirmOpenLink(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = buildLinkDialog(url, resolve);
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function confirmSave(filename: string): Promise<SaveChoice> {
  return new Promise((resolve) => {
    const dialog = buildConfirmDialog(filename, resolve);
    document.body.append(dialog);
    dialog.showModal();

    // Focus Save: it is both the safe default and the most common intent.
    dialog.querySelector<HTMLButtonElement>('.confirm-dialog__button--primary')?.focus();
  });
}
