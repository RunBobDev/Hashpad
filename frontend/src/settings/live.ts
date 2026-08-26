/**
 * The settings that change the *running* app and are written back — SPEC
 * §6.13's "every setting takes effect immediately, no Apply button, no
 * restart".
 *
 * These lived in main.ts, one function each, and were fine there while the View
 * menu was the only way to reach them. H.4's dialog is a second door onto the
 * same settings, and main.ts is the entry module: importing from it is what
 * made main.ts and fileops.ts mutually dependent once before (see
 * `state/appcontext.ts`'s header for how that ended). So they moved here, and
 * main.ts imports them like everyone else.
 *
 * What did **not** move, and why: the theme, the status bar and the outline all
 * read or write a module local in main.ts -- `themeMode`, a teardown handle --
 * that is the live state itself. A second writer would leave that local behind.
 * Those stay where their state is, and the dialog reaches them through the
 * command bus instead.
 *
 * **Applied first, persisted after, a failed write logged rather than thrown.**
 * That ordering is the contract: a disk error means the choice will not survive
 * a restart, not that it silently did not apply.
 */
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import type { app } from '../../wailsjs/go/models';
import { setEditorBehaviour, setWordWrap } from '../editor/extensions';
import { getEditorView, store } from '../state/appcontext';
import {
  clampAutosaveDelay,
  type Document,
  type EditorBehaviour,
  type Encoding,
} from '../state/document';

/**
 * Reads settings fresh, applies `mutate`, writes them back.
 *
 * Always a read-modify-write, never a held copy. Several of these settings have
 * more than one writer -- the View menu, the dialog, and (for the view mode)
 * the preview toggle -- and a copy loaded before one of the others ran would
 * put its value back.
 *
 * `what` names the setting in the log line, which is the whole reason it is a
 * parameter: "failed to persist a setting" tells nobody which one.
 */
export async function persistSettings(
  what: string,
  mutate: (settings: app.Settings) => void,
): Promise<void> {
  try {
    const settings = await LoadSettings();
    mutate(settings);
    await SaveSettings(settings);
  } catch (err) {
    console.error(`hashpad: failed to persist the ${what} setting`, err);
  }
}

/**
 * SPEC §6.6's word wrap.
 *
 * The store is written as well as the view because a *new* document builds its
 * extensions from the store -- without that, wrapping would revert on the next
 * tab.
 */
export async function setWordWrapSetting(wordWrap: boolean): Promise<void> {
  store.setState((prev) => ({ ...prev, wordWrap }));
  setWordWrap(getEditorView(), wordWrap);

  await persistSettings('word-wrap', (settings) => {
    settings.editor.wordWrap = wordWrap;
  });
}

/**
 * SPEC §6.13's `showLineNumbers`, `tabSize` and `insertSpaces`, as a partial
 * change to the one object that carries all three.
 *
 * The whole `editorBehaviour` object is replaced rather than one field mutated:
 * the store's `isEqual` compares one level of own keys, so a new object is what
 * makes a selector over it notice -- and `documentops.ts` reads the same object
 * when it builds a new tab's state, so a mutation in place would leave the two
 * agreeing by luck.
 *
 * All three keys are written to the file, not just the changed one. The merged
 * object is the truth by that point, so writing it whole costs two assignments
 * and removes three `!== undefined` branches that could each be wrong.
 */
export async function setBehaviourSetting(change: Partial<EditorBehaviour>): Promise<void> {
  const behaviour = { ...store.getState().editorBehaviour, ...change };
  store.setState((prev) => ({ ...prev, editorBehaviour: behaviour }));
  setEditorBehaviour(getEditorView(), behaviour);

  await persistSettings('editor-behaviour', (settings) => {
    settings.editor.showLineNumbers = behaviour.showLineNumbers;
    settings.editor.tabSize = behaviour.tabSize;
    settings.editor.insertSpaces = behaviour.insertSpaces;
  });
}

/**
 * SPEC §6.13's `editor.defaultViewMode` — the mode a document opens in.
 *
 * Two destinations, both needed. The store field is what the *next tab in this
 * session* reads (documentops.ts); the settings file is what the next launch
 * reads. Written by View > Preview as well as by the dialog, which is what
 * makes the preview stick across tabs and launches.
 *
 * Note that this changes no *existing* document. `viewMode` is per document by
 * design (Checkpoint F), so switching the default while three tabs are open
 * leaves all three as they are, and the fourth gets the new value.
 */
export async function setDefaultViewModeSetting(mode: Document['viewMode']): Promise<void> {
  store.setState((prev) => ({ ...prev, defaultViewMode: mode }));

  await persistSettings('view-mode', (settings) => {
    settings.editor.defaultViewMode = mode;
  });
}

/**
 * SPEC §6.13's `preview.syncScroll`.
 *
 * Store only -- no view to reconfigure. Both scroll handlers in
 * `preview/pane.ts` read this field on every scroll event and neither can await
 * an IPC round trip, which is why it is in the store rather than read from the
 * file at the moment it is needed.
 */
export async function setSyncScrollSetting(syncScroll: boolean): Promise<void> {
  store.setState((prev) => ({ ...prev, syncScroll }));

  await persistSettings('sync-scroll', (settings) => {
    settings.preview.syncScroll = syncScroll;
  });
}

/**
 * SPEC §6.13's `files.defaultEncoding` — what a document that has never been
 * read from disk is written as.
 *
 * Changes no *open* document, and that is the whole design rather than a
 * limitation. An opened file's encoding was detected on read and is preserved
 * on save; overriding it from here would transcode the user's file the next
 * time they pressed Ctrl+S. The status bar is where a single document's
 * encoding is changed.
 */
export async function setDefaultEncodingSetting(encoding: Encoding): Promise<void> {
  store.setState((prev) => ({ ...prev, defaultEncoding: encoding }));

  await persistSettings('default-encoding', (settings) => {
    settings.files.defaultEncoding = encoding;
  });
}

/**
 * SPEC §6.13's `files.autosave`.
 *
 * Store only. `files/autosave.ts` subscribes to this field rather than reading
 * the settings file, because it reacts on every edit and cannot await an IPC
 * round trip there -- the same reason `syncScroll` lives in the store.
 */
export async function setAutosaveSetting(autosave: boolean): Promise<void> {
  store.setState((prev) => ({ ...prev, autosave }));

  await persistSettings('autosave', (settings) => {
    settings.files.autosave = autosave;
  });
}

/**
 * SPEC §6.13's `files.autosaveDelayMs`.
 *
 * Clamped before it reaches the store, not only before it reaches the timer:
 * the settings dialog shows this field, and a value that displays as one thing
 * and behaves as another is worse than one that is simply corrected.
 */
export async function setAutosaveDelaySetting(delayMs: number): Promise<void> {
  const clamped = clampAutosaveDelay(delayMs);
  store.setState((prev) => ({ ...prev, autosaveDelayMs: clamped }));

  await persistSettings('autosave-delay', (settings) => {
    settings.files.autosaveDelayMs = clamped;
  });
}
