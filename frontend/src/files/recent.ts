/**
 * File > Open Recent's list (design §4.35), held here so the menu can read it
 * synchronously as it opens. Go owns the list (internal/app/session.go): every
 * change goes through it, and this copy is replaced by what Go answers. Paths
 * only.
 *
 * Its own module with no imports from the document code, because the opening
 * code (fileops.ts, documentops.ts) and the restore (session.ts) both need it,
 * and session.ts imports documentops.ts.
 */
import { ClearRecent, ForgetRecent, RememberOpened } from '../../wailsjs/go/app/App';

let recent: readonly string[] = [];

export function recentFiles(): readonly string[] {
  return recent;
}

/** Seeded from settings.json at start-up (main.ts). */
export function setRecentFiles(list: readonly string[] | null | undefined): void {
  recent = [...(list ?? [])];
}

function update(call: Promise<string[]>, what: string): Promise<void> {
  return call.then(setRecentFiles, (error: unknown) => {
    // A failed write costs an entry in a menu, nothing more.
    console.error(`hashpad: could not ${what}`, error);
  });
}

export function rememberOpened(path: string): Promise<void> {
  return update(RememberOpened(path), `add ${path} to Open Recent`);
}

export function forgetRecent(path: string): Promise<void> {
  return update(ForgetRecent(path), `remove ${path} from Open Recent`);
}

export function clearRecent(): Promise<void> {
  return update(ClearRecent(), 'clear Open Recent');
}
