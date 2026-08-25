// @vitest-environment jsdom
/**
 * SPEC §6.13's two **document defaults** -- `editor.defaultViewMode` and
 * `files.defaultEncoding` (Checkpoint H.3) -- proven against a real bootstrap.
 *
 * In one file because they are one question asked twice: what does a document
 * that nobody has configured open as, and does the setting reach both the
 * startup document (minted at module scope, before `LoadSettings` resolves) and
 * the tabs opened after it. One bootstrap answers both.
 *
 * In *its own* file for the reason main.toolbarSeed.test.ts is: a bootstrap
 * runs once per module instance, and this one needs a settings file whose
 * values are deliberately **not** the compiled-in defaults, so "the store was
 * seeded from settings" is falsifiable rather than true by coincidence.
 * main.preview.test.ts has already committed to a mock that omits
 * `defaultViewMode` (its toggle cases start from source on purpose), and Vitest
 * gives every test *file* a fresh module registry.
 *
 * The view-mode half also covers the launch half of an owner report -- "close
 * the app and the preview disappears" -- and one path no other file reaches:
 * the pane arrives through a dynamic import that only `togglePreview` used to
 * perform, so restoring a saved `"split"` at startup runs it with nobody having
 * clicked anything and the handle still null.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { store } from './state/appcontext';
import { activeDocument } from './state/documents';
import { isDirty, type Document } from './state/document';
import { COMMAND_EVENT } from './ui/menubar';
import { ShowWindow } from '../wailsjs/go/app/App';

/**
 * Hoisted so the `vi.mock` factory below can close over it -- the factory is
 * lifted above the imports, and a plain `let` here would still be in its
 * temporal dead zone when it runs.
 *
 * `ShowWindow` records whether the pane was already in the tree at the moment
 * it was called. That ordering is the point, not a detail: main.ts applies the
 * theme and the fonts before the window appears precisely so the user does not
 * watch them change on every launch, and a preview pane sliding in a frame
 * later is the same flaw.
 *
 * Moving the restore after `ShowWindow()` does currently fail the other three
 * cases too -- but only by timing, because `beforeAll` releases on `ShowWindow`
 * and the restore is then still in flight. That is a race, not an assertion:
 * one more `await` in the harness and those three would go green over a window
 * the user watches rearrange itself. This is the only case that pins the order
 * by construction.
 */
const probe = vi.hoisted(() => ({ paneWasUpAtShowWindow: null as boolean | null }));

vi.mock('../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
  Quit: vi.fn(),
  WindowMinimise: vi.fn(),
  // ui/filedrop.ts subscribes at module load. A missing export here is a hard
  // mock error rather than a silent fallback, which is how these five files
  // announced themselves the moment main.ts imported it.
  OnFileDrop: vi.fn(),
  OnFileDropOff: vi.fn(),
  // ui/fullscreen.ts reads this at startup. It returns a promise, so a bare
  // vi.fn() would make `await` yield undefined and set the flag to that.
  WindowIsFullscreen: vi.fn(async () => false),
  WindowFullscreen: vi.fn(),
  WindowUnfullscreen: vi.fn(),
  WindowSetBackgroundColour: vi.fn(),
  WindowSetTitle: vi.fn(),
  WindowShow: vi.fn(),
  WindowToggleMaximise: vi.fn(),
}));

vi.mock('../wailsjs/go/app/App', () => ({
  ConfirmQuit: vi.fn(),
  ShowWindow: vi.fn(() => {
    probe.paneWasUpAtShowWindow = document.querySelector('.preview-pane') !== null;
  }),
  LoadSettings: vi.fn().mockResolvedValue({
    appearance: { theme: 'system', accentColor: '#0078d4' },
    toolbar: { visible: true, pinned: ['bold'] },
    window: {
      previewSplitRatio: 0.3,
      statusBarVisible: true,
      outlineVisible: false,
      outlineWidth: 240,
    },
    preview: { syncScroll: true },
    // The whole reason this file exists. `'source'` is both Go's default and
    // the store's pre-bootstrap placeholder, so a bootstrap that never read the
    // key would be indistinguishable from one that read it and got `'source'`.
    editor: { wordWrap: true, defaultViewMode: 'split' },
    // Not `'utf-8'`, for exactly the same reason -- and `'utf-16le'` rather
    // than `'utf-8-bom'` because it differs from the default in more than a
    // byte order mark, so a half-applied value has nowhere to hide.
    files: { defaultEncoding: 'utf-16le' },
  }),
  ReadFile: vi.fn(),
  SaveSettings: vi.fn(),
  ShowOpenDialog: vi.fn(),
  ShowSaveDialog: vi.fn(),
  SystemThemeIsDark: vi.fn().mockResolvedValue(false),
  WriteFile: vi.fn(),
}));

function emit(command: string): void {
  document.dispatchEvent(new CustomEvent<string>(COMMAND_EVENT, { detail: command }));
}

/**
 * The document the app started with, snapshotted as bootstrap left it.
 *
 * Not re-read through `activeDocument` at assertion time, and that is not
 * fussiness: several cases below run `file.new`, so under
 * `--sequence.shuffle.tests` "the active document" is whichever tab a sibling
 * case happened to leave in front. Every one of those tabs also carries the
 * defaults, so the assertions would still pass -- while quietly no longer
 * testing the startup document at all, which is the one minted before
 * `LoadSettings` resolved and the only one bootstrap has to catch up.
 *
 * A snapshot works because the store hands out new objects rather than
 * mutating: this holds the post-bootstrap state whatever happens afterwards.
 */
let startupDocument: Document;

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import('./main');
  await vi.waitFor(() => expect(ShowWindow).toHaveBeenCalled());
  startupDocument = activeDocument(store.getState())!;
});

describe('bootstrap restoring the saved view mode', () => {
  /**
   * The startup document is minted at module scope, before `LoadSettings`
   * resolves, so it is always holding the compiled-in `'source'` when it is
   * created -- the same situation as the theme, the fonts and
   * `editorBehaviour`. Bootstrap catching it up is what this asserts.
   */
  it('opens the startup document in the saved mode', () => {
    expect(startupDocument.viewMode).toBe('split');
  });

  it('has the pane on screen', () => {
    expect(document.querySelector('.preview-pane')).not.toBeNull();
  });

  /** See `probe`: applied before the window appears, not a frame after it. */
  it('mounts the pane before the window is shown', () => {
    expect(probe.paneWasUpAtShowWindow).toBe(true);
  });

  /**
   * Seeded into the store as well as onto the startup document, which is what
   * carries the mode to tabs opened later in the session -- a bootstrap that
   * only fixed up the one document would leave the second tab in source mode
   * and put the owner's report straight back.
   */
  it('seeds the store, so the next tab inherits it', () => {
    expect(store.getState().defaultViewMode).toBe('split');

    emit('file.new');

    expect(activeDocument(store.getState())!.viewMode).toBe('split');
    expect(document.querySelector('.preview-pane')).not.toBeNull();
  });
});

describe('bootstrap applying the saved default encoding', () => {
  /**
   * The startup document is minted at module scope with the compiled-in
   * `'utf-8'`, before `LoadSettings` resolves. Without bootstrap catching it
   * up, the tab the app opens with would be written as UTF-8 while every tab
   * opened a second later used the configured encoding.
   */
  it('opens the startup document in the saved encoding', () => {
    expect(startupDocument.encoding).toBe('utf-16le');
  });

  /**
   * **The trap.** `isDirty` compares `encoding` against `savedEncoding`, so
   * moving one without the other puts a dirty dot on a document nobody has
   * touched and prompts to save it on close. Asserted as `isDirty` rather than
   * as the field, because the dot is the thing the user would actually see.
   */
  it('leaves that document clean, not dirty over its own encoding', () => {
    expect(startupDocument.savedEncoding).toBe('utf-16le');
    expect(isDirty(startupDocument)).toBe(false);
  });

  it('seeds the store, so the next tab is minted with it too', () => {
    expect(store.getState().defaultEncoding).toBe('utf-16le');

    emit('file.new');

    const doc = activeDocument(store.getState())!;
    expect(doc.encoding).toBe('utf-16le');
    expect(isDirty(doc)).toBe(false);
  });

  /**
   * The line ending is deliberately *not* a document default: there is no
   * `defaultLineEnding` in SPEC §6.13's block, so a new document stays on the
   * platform's CRLF and the status bar is the only way to change it. Pinned
   * here so that adding one later is a deliberate act rather than a side
   * effect of touching this function.
   */
  it('does not touch the line ending', () => {
    expect(startupDocument.lineEnding).toBe('crlf');
  });
});
