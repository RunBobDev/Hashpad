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

export function confirmSave(filename: string): Promise<SaveChoice> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-message');

    const message = document.createElement('p');
    message.id = 'confirm-dialog-message';
    message.className = 'confirm-dialog__message';
    message.textContent = `Do you want to save changes to ${filename}?`;

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog__actions';

    // Resolve exactly once and always tear the dialog down, so a caller
    // awaiting this can never be left hanging on a dialog the user dismissed.
    let settled = false;
    const finish = (choice: SaveChoice): void => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(choice);
    };

    for (const button of BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = button.label;
      if (button.primary) el.classList.add('confirm-dialog__button--primary');
      el.addEventListener('click', () => finish(button.choice));
      actions.append(el);
    }

    // Escape means "I didn't decide", which is Cancel — the safe answer,
    // since it is the only one that loses nothing. A backdrop click is
    // deliberately NOT wired to the same thing: verified against real
    // Chromium that clicking outside the dialog box neither fires 'cancel'
    // nor closes it, and that inertness matches native Windows modal
    // prompts, which do not light-dismiss on an outside click either.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish('cancel');
    });

    dialog.append(message, actions);
    document.body.append(dialog);
    dialog.showModal();

    // Focus Save: it is both the safe default and the most common intent.
    dialog.querySelector<HTMLButtonElement>('.confirm-dialog__button--primary')?.focus();
  });
}
