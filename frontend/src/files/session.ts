/**
 * Checkpoint O (design §4.35): the last session's tabs, and File > Open Recent.
 *
 * Paths only. Nothing here writes a document's contents: a document is still
 * written only by Save, or by autosave when it is on (owner's condition).
 */
import { RememberTabs } from '../../wailsjs/go/app/App';
import { store } from '../state/appcontext';
import type { AppState } from '../state/document';

/** Long enough that switching through tabs writes once, short enough to survive a quick quit. */
export const TAB_SAVE_DELAY_MS = 300;

/** The open files in tab order, and the active one's index among them (-1: an unsaved document). */
export function sessionTabs(state: Pick<AppState, 'documents' | 'activeDocumentId'>): {
  paths: string[];
  active: number;
} {
  const files = state.documents.filter((doc) => doc.filePath !== null);
  return {
    paths: files.map((doc) => doc.filePath as string),
    active: files.findIndex((doc) => doc.id === state.activeDocumentId),
  };
}

let flushPending: (() => Promise<void>) | null = null;

/**
 * Sends the tabs to Go whenever their files, order or the active one change,
 * debounced. Mounted after the restore (`startSession`), so the moment at
 * start-up with only the blank tab is never written over the saved list.
 */
export function mountTabTracking(
  save: (paths: string[], active: number) => Promise<void> = RememberTabs,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const { paths, active } = sessionTabs(store.getState());
    return save(paths, active).catch((error: unknown) => {
      console.error('hashpad: could not remember the open tabs', error);
    });
  };
  const unsubscribe = store.subscribe(
    (state) => JSON.stringify(sessionTabs(state)),
    () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void send(), TAB_SAVE_DELAY_MS);
    },
  );
  flushPending = () => (timer === null ? Promise.resolve() : send());
  // Written once now: what the restore found -- or the switch left out -- is
  // the session from here on.
  void send();
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    flushPending = null;
  };
}

/** Writes a change still waiting out its delay; awaited before quitting. */
export function flushTabTracking(): Promise<void> {
  return flushPending?.() ?? Promise.resolve();
}
