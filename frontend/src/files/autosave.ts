/**
 * SPEC §3.2's autosave: "off by default. Offer it in settings as an opt-in
 * **for saved files only** (never silently creates files)."
 *
 * That parenthesis is the whole shape of this file. `saveDocument` falls back
 * to `saveDocumentAs` for a document with no path, which opens a file dialog --
 * so autosave filters untitled documents out *itself* rather than relying on
 * the save path to be polite. A dialog appearing on a timer, over work the user
 * never asked to name, is the single worst thing this feature could do.
 *
 * **Debounced from the last edit, not on an interval.** `autosaveDelayMs` is
 * named for a delay, and a delay after typing stops is what a user means by it
 * -- an interval would write mid-word. The trade is that continuous typing with
 * no pause never saves; a two-second gap is common enough in prose that this is
 * the right way round, and the cost of the other choice is a disk write every
 * two seconds forever.
 *
 * **Every dirty saved document, not just the active one.** A tab edited and
 * then switched away from inside the delay window would otherwise sit unsaved
 * with autosave apparently on, which is exactly the case the feature exists to
 * cover. `saveDocument` reads a non-active document's text from its own
 * `editorState`, so this needs nothing special.
 */
import { isDirty, type AppState, type Document } from '../state/document';
import { store } from '../state/appcontext';
import { saveDocument } from './fileops';

let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * Set while a pass is writing.
 *
 * Two passes overlapping would race each other's `markSaved`: both capture a
 * snapshot before their `await`, and the slower one would record its older text
 * as what is on disk, leaving a document that looks clean and is not. A pass
 * skipped here is not a pass lost -- the writes it performs move the store,
 * which reschedules, and so does anything the user types meanwhile.
 */
let writing = false;

/** Dirty, and safe to write without asking anyone anything. */
function saveable(state: AppState): Document[] {
  return state.documents.filter((doc) => doc.filePath !== null && isDirty(doc));
}

function cancel(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

async function run(): Promise<void> {
  timer = null;
  if (writing) return;

  // Re-read rather than trusting what was true when the timer was set:
  // documents can have been saved by hand, or closed, in the seconds since.
  //
  // The setting itself is deliberately *not* re-checked here. `schedule` is the
  // only gate, and it is enough because `autosave` is a store field: turning it
  // off wakes the subscription, which cancels the countdown, so a timer set
  // while it was on cannot survive it being turned off. A second check read
  // like the real protection and was not -- no mutation of it could fail a
  // test, which is how it was found.
  const documents = saveable(store.getState());
  if (documents.length === 0) return;

  writing = true;
  try {
    // Sequential, not `Promise.all`. These are IPC round trips to one Go
    // process writing to one disk, so there is nothing to win by overlapping
    // them, and a failure part-way through leaves a comprehensible state.
    // `saveDocument` logs and returns false on a failed write rather than
    // throwing, so one unwritable file does not abandon the rest.
    for (const doc of documents) await saveDocument(doc.id);
  } finally {
    writing = false;
  }
}

/**
 * Restarts the countdown, if there is anything for it to do.
 *
 * The "anything to do" check is not an optimisation. `saveDocument` writes the
 * store through `markSaved`, which wakes the subscription below, which would
 * schedule another timer -- one that fires, finds nothing dirty and stops. That
 * settles rather than looping, but it is a pointless wakeup after every save,
 * and skipping it is one comparison.
 */
function schedule(): void {
  const state = store.getState();
  if (!state.autosave || saveable(state).length === 0) {
    cancel();
    return;
  }
  cancel();
  timer = setTimeout(() => void run(), state.autosaveDelayMs);
}

/**
 * Wires autosave to the store and returns a teardown.
 *
 * Three subscriptions rather than one on the whole state: `documents` is what
 * an edit moves, and the other two are the setting itself. Subscribing to
 * everything would restart the countdown on a theme change.
 */
export function mountAutosave(): () => void {
  const unsubscribeDocuments = store.subscribe((state) => state.documents, schedule);
  // Turning it on mid-session must not wait for the next keystroke to take
  // effect, and turning it off must cancel a countdown already running --
  // otherwise the switch appears to do nothing for two seconds and then writes.
  const unsubscribeEnabled = store.subscribe((state) => state.autosave, schedule);
  // A shorter delay chosen while a countdown is running should apply now, not
  // after the old one has elapsed.
  const unsubscribeDelay = store.subscribe((state) => state.autosaveDelayMs, schedule);

  return () => {
    cancel();
    unsubscribeDocuments();
    unsubscribeEnabled();
    unsubscribeDelay();
  };
}
