/**
 * Opening files Hashpad was *launched* with (SPEC §6.4).
 *
 * Two routes, because a launch either finds a window or does not:
 *
 * - **This process's own arguments** are collected by `openPendingFiles`, which
 *   asks Go for them. A pull rather than a push, because Go is ready long
 *   before this bundle has parsed, and an event emitted into that gap reaches
 *   nobody. `internal/app/openwith.go` holds them until asked.
 * - **A second launch** — double-clicking another `.md` while Hashpad is
 *   already running — arrives as an event, since by then there is a window
 *   listening. Wails' single-instance lock exits that second process and
 *   forwards its arguments to this one.
 *
 * Both end at `openPaths`, so a file opened from Explorer behaves exactly like
 * one opened from the dialog — including H.10's rule that a file already in a
 * tab is switched to rather than opened twice, which is what makes
 * double-clicking the same file repeatedly harmless.
 */
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { PendingFiles } from '../../wailsjs/go/app/App';
import { openPaths } from './fileops';
import { supportedPaths } from '../ui/filedrop';

/** Matches `openFilesEvent` in `internal/app/openwith.go`. */
export const OPEN_FILES_EVENT = 'app:open-files';

/**
 * Wails' event registrar, narrowed to what this module uses. Injectable for the
 * same reason `ui/filedrop.ts` narrows `OnFileDrop`: the real one reaches for
 * `window.runtime`, which only the desktop runtime provides.
 */
type Subscribe = (event: string, callback: (paths: string[]) => void) => () => void;

/**
 * Opens whatever Go is holding, and empties its queue.
 *
 * Go has already dropped anything that is not a regular file, so what arrives
 * here are real paths; `supportedPaths` then applies SPEC §6.4's extension
 * list. The split is deliberate — Go owns the filesystem question ("is this a
 * file?") and the frontend owns the markdown one ("is this a file we edit?"),
 * and the second answer is shared with drag-and-drop rather than written twice.
 */
export async function openPendingFiles(
  pending: () => Promise<string[]> = PendingFiles,
  open: (paths: readonly string[]) => Promise<void> = openPaths,
): Promise<void> {
  let paths: string[];
  try {
    paths = await pending();
  } catch (error) {
    // Nothing downstream depends on this, and the alternative to swallowing it
    // is an unhandled rejection during bootstrap -- in a packaged app, an error
    // nobody sees attached to a launch that appeared to ignore its file.
    console.error('hashpad: could not read the files this launch was given', error);
    return;
  }

  // No `wanted.length > 0` guard, here or in `mountOpenWith` below. One was
  // written in both places and both came out: `openPaths([])` iterates nothing,
  // so skipping the call changes nothing a user could see. The version here was
  // even killable -- but only by a test asserting the call had not been made,
  // which pins an implementation detail rather than a behaviour, and would have
  // failed against an equally correct version of this function.
  await open(supportedPaths(paths));
}

/**
 * Subscribes to later launches and returns Wails' unsubscribe.
 *
 * Mounted at module scope rather than from `bootstrap`, so that a second launch
 * arriving *during* startup is still heard. Anything earlier than that has
 * nowhere to arrive and is queued by Go instead.
 */
export function mountOpenWith(
  on: Subscribe = EventsOn,
  open: (paths: readonly string[]) => Promise<void> = openPaths,
): () => void {
  return on(OPEN_FILES_EVENT, (paths) => {
    // Wails' event callback is not async-aware, so a rejection here has no
    // caller to reach and would surface as an unhandled promise.
    void open(supportedPaths(paths)).catch((error: unknown) => {
      console.error('hashpad: failed to open files from a second launch', error);
    });
  });
}
