/**
 * Checkpoint O (design §4.35): the last session's tabs, and File > Open Recent.
 *
 * Paths only. Nothing here writes a document's contents: a document is still
 * written only by Save, or by autosave when it is on (owner's condition).
 */
import { ReadFile, RememberTabs } from '../../wailsjs/go/app/App';
import { store } from '../state/appcontext';
import type { AppState } from '../state/document';
import { showNotice } from '../ui/confirmdialog';
import type { MenuItem } from '../ui/menubar';
import { openDocumentInNewTab, switchToDocument } from './documentops';
import { openPendingFiles } from './openwith';
import { forgetRecent, recentFiles, rememberOpened } from './recent';

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

/**
 * Reopens the saved tabs in order. A file that has gone or cannot be read is
 * skipped quietly; the saved active tab is activated, or the first when an
 * unsaved document was active. Not recorded as opening: restoring leaves the
 * recent list's order alone.
 */
export async function restoreTabs(
  paths: readonly string[],
  active: number,
  read: typeof ReadFile = ReadFile,
): Promise<void> {
  for (const path of paths) {
    let contents;
    try {
      contents = await read(path);
    } catch {
      continue;
    }
    openDocumentInNewTab(contents);
  }
  const wanted = paths[active] ?? paths[0];
  const doc = store.getState().documents.find((candidate) => candidate.filePath === wanted);
  if (doc !== undefined) switchToDocument(doc.id);
}

/**
 * Start-up, once the window is shown: the last tabs (the caller passes none
 * when the switch is off), then the files this launch was given -- which end
 * up active -- then the tracking, whose unmount it resolves to.
 */
export async function startSession(
  tabs: readonly string[],
  active: number,
  openPending: () => Promise<void> = openPendingFiles,
): Promise<() => void> {
  try {
    await restoreTabs(tabs, active);
  } catch (error) {
    console.error('hashpad: could not reopen the last tabs', error);
  }
  await openPending();
  return mountTabTracking();
}

/** A path's file name and folder, splitting on both separators as fileops.ts does. */
function nameAndFolder(path: string): { name: string; folder: string } {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return { name: path.slice(cut + 1), folder: path.slice(0, Math.max(cut, 0)) };
}

/**
 * A long folder keeps its start and its last two folders -- C:\…\Notes\2026 --
 * because the end says the most; cut at the end instead, every entry read
 * "C:\Users\…" on the real exe. The tooltip has the whole path.
 */
function shortFolder(folder: string): string {
  const parts = folder.split(/[\\/]/);
  if (folder.length <= 40 || parts.length <= 3) return folder;
  const separator = folder.includes('\\') ? '\\' : '/';
  return [parts[0], '…', ...parts.slice(-2)].join(separator);
}

/** File > Open Recent's entries, newest first, then Clear Recently Opened. */
export function recentMenuItems(): MenuItem[] {
  const list = recentFiles();
  const items: MenuItem[] =
    list.length === 0
      ? [{ id: 'file.noRecent', label: 'No recent files', enabled: false }]
      : list.map((path, index) => {
          const { name, folder } = nameAndFolder(path);
          return {
            id: `file.openRecent.${index}`,
            label: name,
            detail: shortFolder(folder),
            tooltip: path,
            enabled: true,
          };
        });
  items.push({
    id: 'file.clearRecent',
    label: 'Clear Recently Opened',
    enabled: list.length > 0,
    separatorBefore: true,
  });
  return items;
}

/**
 * Opens the recent file at `index`. One that cannot be read -- moved, deleted
 * or locked -- is reported and dropped from the list rather than left to fail
 * again.
 */
export async function openRecent(index: number, read: typeof ReadFile = ReadFile): Promise<void> {
  const path = recentFiles()[index];
  if (path === undefined) return;
  let contents;
  try {
    contents = await read(path);
  } catch {
    void forgetRecent(path);
    await showNotice(
      `Hashpad could not open ${nameAndFolder(path).name}. It may have been moved or deleted, ` +
        'so it has been removed from Open Recent.',
    );
    return;
  }
  openDocumentInNewTab(contents);
  void rememberOpened(path);
}
