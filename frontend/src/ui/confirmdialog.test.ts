// @vitest-environment jsdom
/**
 * jsdom 30.0.1 does not implement <dialog>'s interactive surface at all. Its
 * generated wrapper (node_modules/jsdom/lib/generated/idl/HTMLDialogElement.js)
 * defines only the reflected `open` content attribute; showModal, show, close,
 * and requestClose are simply absent — not present as no-op stubs, but
 * genuinely undefined, so calling any of them throws
 * `TypeError: dialog.showModal is not a function`.
 *
 * confirmSave() calls dialog.showModal() unconditionally inside the Promise
 * executor, and a Promise executor runs synchronously before `new Promise()`
 * returns. So under jsdom that call throws *before confirmSave() ever hands
 * back its promise*, which permanently rejects it (resolve() on an already-
 * settled promise is a spec-mandated no-op) before a single button exists to
 * be clicked in any way that matters. finish()'s dialog.close() call would
 * fail identically if a click handler ever ran.
 *
 * That forecloses every interaction test the brief's Step 2b asks for except
 * the message text: resolving per button, resolving exactly once, DOM removal
 * after resolving, and the primary button receiving focus are all downstream
 * of the showModal() call that never succeeds under jsdom, so none of them
 * are reachable without stubbing showModal — which the brief explicitly rules
 * out ("a test that passes against a stub of the thing it is testing is worse
 * than no test"). This suite instead covers the DOM confirmSave() builds
 * *before* that call (real, exercised code), plus one explicit assertion
 * that pins the rejection itself: if a future jsdom upgrade adds showModal
 * support, that test starts failing and is the signal to come back and write
 * the real interaction tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConfirmDialog,
  buildResetDialog,
  confirmSave,
  type SaveChoice,
} from './confirmdialog';

/** Clicks the button with the given label inside `dialog`. */
function click(dialog: HTMLDialogElement, label: string): void {
  const button = [...dialog.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`no button labelled ${label}`);
  button.click();
}

afterEach(() => {
  // finish() is the only code path that ever removes the dialog, and it
  // requires dialog.close() to exist — under jsdom it doesn't, so every
  // dialog created below outlives its test. Clear the body so each test
  // only ever sees its own dialog.
  document.body.innerHTML = '';
});

/**
 * These reach the behaviour that matters — which choice a click yields, that it
 * settles once, that the element is torn down — by driving the dialog directly
 * instead of through `confirmSave`, whose `showModal()` call jsdom cannot run.
 * Nothing here is stubbed: the listeners under test are the real ones.
 */
describe('buildConfirmDialog', () => {
  it.each([
    ['Save', 'save'],
    ["Don't Save", 'dontsave'],
    ['Cancel', 'cancel'],
  ])('reports %s as %s', (label, expected) => {
    const onChoice = vi.fn();
    const dialog = buildConfirmDialog('notes.md', onChoice);

    click(dialog, label);

    expect(onChoice).toHaveBeenCalledExactlyOnceWith(expected as SaveChoice);
  });

  it('treats Escape as Cancel', () => {
    const onChoice = vi.fn();
    const dialog = buildConfirmDialog('notes.md', onChoice);

    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));

    expect(onChoice).toHaveBeenCalledExactlyOnceWith('cancel');
  });

  it('settles once even if a second button is clicked', () => {
    const onChoice = vi.fn();
    const dialog = buildConfirmDialog('notes.md', onChoice);

    click(dialog, 'Save');
    click(dialog, 'Cancel');

    expect(onChoice).toHaveBeenCalledExactlyOnceWith('save');
  });

  it('ignores an Escape that arrives after a button was already clicked', () => {
    const onChoice = vi.fn();
    const dialog = buildConfirmDialog('notes.md', onChoice);

    click(dialog, "Don't Save");
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));

    expect(onChoice).toHaveBeenCalledExactlyOnceWith('dontsave');
  });

  it('removes itself from the document once a choice is made', () => {
    const dialog = buildConfirmDialog('notes.md', vi.fn());
    document.body.append(dialog);
    expect(dialog.isConnected).toBe(true);

    click(dialog, 'Cancel');

    expect(dialog.isConnected).toBe(false);
  });
});

describe('confirmSave under jsdom (see file header for why this list is short)', () => {
  it('rejects because jsdom has no HTMLDialogElement.showModal', async () => {
    await expect(confirmSave('notes.md')).rejects.toThrow(/showModal/);
  });

  it('names the passed-in file in the message', async () => {
    // The message element is built and appended before the showModal() call
    // that fails, so it is real, exercised output — the rejection is
    // incidental to this assertion, not its subject.
    await confirmSave('report.md').catch(() => {
      /* see the dedicated rejection test above */
    });
    const message = document.querySelector('.confirm-dialog__message');
    expect(message?.textContent).toBe('Do you want to save changes to report.md?');
  });

  it("creates exactly Save, Don't Save, and Cancel, in that order", async () => {
    await confirmSave('x.md').catch(() => {});
    const labels = [...document.querySelectorAll('.confirm-dialog__actions button')].map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(['Save', "Don't Save", 'Cancel']);
  });

  it('marks Save, and only Save, as the primary button', async () => {
    await confirmSave('x.md').catch(() => {});
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('.confirm-dialog__actions button'),
    ];
    const primary = buttons.filter((button) =>
      button.classList.contains('confirm-dialog__button--primary'),
    );
    expect(primary).toHaveLength(1);
    expect(primary[0]?.textContent).toBe('Save');
  });

  it('labels the dialog via aria-labelledby pointing at the message id', async () => {
    await confirmSave('x.md').catch(() => {});
    const dialog = document.querySelector('.confirm-dialog');
    const message = document.querySelector('.confirm-dialog__message');
    expect(message?.id).toBeTruthy();
    expect(dialog?.getAttribute('aria-labelledby')).toBe(message?.id);
  });

  it('gives every action button type="button" so none of them can submit a form', async () => {
    await confirmSave('x.md').catch(() => {});
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('.confirm-dialog__actions button'),
    ];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.type === 'button')).toBe(true);
  });
});

/**
 * The settings dialog's Reset prompt. Driven directly for the same reason every
 * other case here is: `confirmReset`'s `showModal()` does not exist in jsdom.
 */
describe('buildResetDialog', () => {
  it.each([
    ['Reset', true],
    ['Cancel', false],
  ])('reports %s as %s', (label, expected) => {
    const onChoice = vi.fn();
    const dialog = buildResetDialog(onChoice);

    click(dialog, label);

    expect(onChoice).toHaveBeenCalledExactlyOnceWith(expected);
  });

  /** Escape means "I didn't decide", and not deciding must not reset anything. */
  it('treats Escape as Cancel', () => {
    const onChoice = vi.fn();
    const dialog = buildResetDialog(onChoice);

    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));

    expect(onChoice).toHaveBeenCalledExactlyOnceWith(false);
  });

  /**
   * **Cancel is the primary here, unlike every other prompt in this file.** The
   * other two ask about work the user just did and the likely answer is yes;
   * this one asks whether to throw work away. `confirmReset` focuses the
   * primary button, so which button carries the class decides what Enter does.
   */
  it('makes Cancel the primary button', () => {
    const dialog = buildResetDialog(vi.fn());

    const primary = dialog.querySelector('.confirm-dialog__button--primary');
    expect(primary?.textContent).toBe('Cancel');
  });

  /**
   * The prompt has to name what is at stake beyond the dialog it was launched
   * from: a reset takes the pinned toolbar and the window size with it, and
   * those two only come back on the next launch.
   */
  it('says what a reset costs that the settings dialog does not show', () => {
    const dialog = buildResetDialog(vi.fn());

    const text = dialog.querySelector('.confirm-dialog__message')!.textContent!;
    expect(text).toContain('toolbar');
    expect(text).toContain('next launch');
    expect(text).toContain('cannot be undone');
  });
});
