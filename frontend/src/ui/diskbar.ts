/**
 * SPEC §7.4's bar: "This file changed on disk. Reload / Keep mine". Compare is
 * a later step (design §4.30).
 *
 * Non-blocking is the requirement, and it is meant literally: the bar appears
 * without taking focus, so it never swallows the next keystroke of someone
 * typing. It shows the *active* document's state; a background tab's change
 * waits until that tab is shown, and the save guard in files/fileops.ts covers
 * it if it never is.
 */
import { keepMine, reloadFromDisk } from '../files/diskwatch';
import { getEditorView, store } from '../state/appcontext';
import type { AppState } from '../state/document';
import { activeDocument } from '../state/documents';

/** Flat and primitive, so the store's shallow comparison can skip unchanged states. */
interface BarState {
  id: string | null;
  change: 'changed' | 'deleted' | null;
}

function barState(state: AppState): BarState {
  const doc = activeDocument(state);
  const change = doc?.diskChange ?? null;
  return {
    id: doc?.id ?? null,
    change: change === null ? null : change === 'deleted' ? 'deleted' : 'changed',
  };
}

export function mountDiskBar(
  parent: HTMLElement,
  before: HTMLElement,
): { element: HTMLElement; unmount: () => void } {
  let current = barState(store.getState());

  const bar = document.createElement('div');
  bar.className = 'disk-bar';
  bar.setAttribute('role', 'status');

  const message = document.createElement('span');
  message.className = 'disk-bar__message';

  const button = (label: string, act: (id: string) => void): HTMLButtonElement => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'disk-bar__button';
    el.textContent = label;
    el.addEventListener('click', () => {
      if (current.id === null) return;
      act(current.id);
      // The button vanishes with the bar. Focus left on it would strand the
      // keyboard on nothing.
      getEditorView().focus();
    });
    return el;
  };
  const reload = button('Reload', reloadFromDisk);
  const keep = button('Keep mine', keepMine);

  bar.append(message, reload, keep);
  parent.insertBefore(bar, before);

  const render = (state: BarState): void => {
    current = state;
    bar.hidden = state.change === null;
    message.textContent =
      state.change === 'deleted'
        ? 'This file was deleted on disk. Save to keep it.'
        : 'This file changed on disk.';
    reload.hidden = state.change !== 'changed';
    keep.hidden = state.change !== 'changed';
  };
  render(current);
  const unsubscribe = store.subscribe(barState, render);

  return {
    element: bar,
    unmount: () => {
      unsubscribe();
      bar.remove();
    },
  };
}
