import {
  EditorView,
  type ViewUpdate,
  drawSelection,
  highlightActiveLine,
  keymap,
} from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { darkThemeCompartment, hashpadTheme } from './theme';
import { blockquoteLines } from './blockquote';
import { markdownSupport } from './highlight';
import { COMMANDS, toEditorCommand } from './commands';
import { activeFormats } from './marks';
import { emitCommand } from '../ui/menubar';
import { store } from '../state/appcontext';

/**
 * Builds a CodeMirror command that dispatches the given `hashpad:command` id
 * on `document` instead of calling a file-operation function directly. The
 * menu bar (ui/menubar.ts) dispatches the exact same event for the exact same
 * ids, so File > Save and Ctrl+S run through one implementation
 * (files/fileops.ts's `saveActive`, wired up in main.ts) rather than two —
 * the pattern the toolbar will reuse in a later checkpoint. Returning `true`
 * marks the key as handled, which stops CodeMirror from also trying its own
 * bindings for the same chord and prevents the browser's default action
 * (e.g. Ctrl+S's save-page-as).
 */
function dispatchCommand(id: string): () => boolean {
  return () => {
    emitCommand(id);
    return true;
  };
}

/**
 * The store's `Document.editorState` is only ever set at the moment a
 * document is created, opened, or saved — nothing pushes the live view's
 * state back into it as the user types, which is what let `isDirty` (see
 * state/document.ts) stay permanently false for a never-saved document and
 * permanently true after a save. This listener is the fix: it writes the
 * updated `EditorState` into whichever document is currently active.
 *
 * Two guards keep this cheap and safe:
 * - `update.docChanged` filters out pure selection/cursor moves, which don't
 *   affect dirty state and would otherwise wake the store on every arrow key.
 * - The active document is looked up fresh from the store each time
 *   (`store.getState().activeDocumentId`) rather than captured in a closure,
 *   so this always targets whatever document the view is currently showing.
 *   That matters because the view is shared and reused across documents
 *   (see files/documentops.ts's `switchToDocument`, which calls
 *   `view.setState(...)` to swap documents in place) — a stale captured id
 *   would let this write into the wrong document across a swap.
 *
 * No debounce needed: the title subscription in main.ts selects a `{
 * filePath, dirty }` pair, and the store's `Object.is`/shallow-equal check
 * (state/store.ts) already skips re-notifying when neither actually
 * changed, so a burst of keystrokes that keeps `dirty` at `true` only
 * notifies once, on the first keystroke that flips it.
 */
function syncActiveDocument(update: ViewUpdate): void {
  if (!update.docChanged) return;

  const activeId = store.getState().activeDocumentId;
  if (activeId === null) return;

  store.setState((prev) => ({
    ...prev,
    documents: prev.documents.map((doc) =>
      doc.id === activeId ? { ...doc, editorState: update.state } : doc,
    ),
  }));
}

/**
 * Publishes which formatting the cursor sits inside, for the toolbar's active
 * state (SPEC §6.5). Stored as a sorted, `|`-joined string rather than a Set
 * or array because store.ts's `isEqual` compares one level and falls back to
 * reference equality — a freshly built collection would never compare equal,
 * so the toolbar would rebuild on every keystroke. ui/tabbar.ts's
 * tabStripSummary solves the same problem the same way.
 *
 * A separate listener from `syncActiveDocument` rather than folded into it:
 * this one cares about selection-only moves (arrowing into or out of bold
 * text with nothing typed), which `syncActiveDocument` deliberately ignores
 * because they don't affect dirty state. Folding the two together would mean
 * either running this on every keystroke `syncActiveDocument` already
 * filters out, or teaching `syncActiveDocument` a second reason to fire.
 */
function syncActiveFormats(update: ViewUpdate): void {
  if (!update.docChanged && !update.selectionSet) return;
  publishActiveFormats(update.state);
}

/**
 * The same publish, callable without a `ViewUpdate`.
 *
 * `EditorView.setState` reinitialises the view's plugins rather than running
 * a transaction, so it never constructs a `ViewUpdate` and never invokes
 * `updateListener` — see the comment in files/documentops.ts's
 * `switchToDocument`, which relies on that for `syncActiveDocument`. What is
 * a safeguard there is a hole here: without this, switching tabs would leave
 * the store advertising the *previous* document's formatting until the user
 * happened to type or move the cursor, and a file opened with the caret
 * already inside `**bold**` would publish nothing at all. The toolbar would
 * light the wrong buttons in both cases.
 *
 * So every seam that swaps the view's state without a transaction has to call
 * this itself: `switchToDocument` and the bootstrap in main.ts.
 */
export function publishActiveFormats(state: EditorState): void {
  const next = activeFormats(state).join('|');
  if (next === store.getState().activeFormats) return;
  store.setState((prev) => ({ ...prev, activeFormats: next }));
}

/**
 * Assembled deliberately rather than using the `basicSetup` bundle: basicSetup
 * pulls in line numbers, fold gutters, autocompletion, and bracket matching,
 * most of which SPEC §6.13 has off by default and all of which cost bundle size.
 *
 * A factory rather than a module-level constant array: a shared array bakes
 * `darkThemeCompartment.of(...)` in with whatever `isDark` was passed the one
 * time the array was built, so every `EditorState` constructed from it —
 * including ones created later, e.g. for a newly opened tab — would carry
 * that same value forever. `setEditorDark` only reconfigures the compartment
 * on the view's *current* state, it does not change what new states are
 * seeded with. Calling `buildExtensions(isDark)` fresh for every new
 * `EditorState` is what keeps future tabs in sync with the theme at the
 * moment they're created; `setEditorDark` remains the way to flip the theme
 * on a state that already exists. Both are needed — one seeds, one updates.
 */
export function buildExtensions(isDark: boolean): Extension[] {
  return [
    history(),
    drawSelection(),
    // Off by default in CodeMirror. `drawSelection()` above is what actually
    // renders a second caret/range once one exists -- without it the browser's
    // native selection painting shows only one -- and the formatting commands
    // in commands.ts already operate on every range via `changeByRange` and
    // per-range `enclosingInlineMark` lookups, so turning this on needs no
    // command changes, only this facet contribution to let the editor build a
    // multi-range selection in the first place.
    EditorState.allowMultipleSelections.of(true),
    // Which gesture adds a cursor. CodeMirror's own default is Ctrl+click on
    // Windows (`clickAddsSelectionRange` falls back to `event.ctrlKey` when
    // nothing contributes to the facet), but every editor a Windows user
    // arrives from -- VS Code, Sublime, Notepad++ -- uses Alt+click, and
    // Ctrl+click is what people expect to *follow a link*, which this app has
    // in every document. SPEC §6.14 asks for Windows conventions where one
    // exists; here the convention is Alt, and CodeMirror's default is the odd
    // one out.
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    highlightActiveLine(),
    // Word wrap is on by default (SPEC §6.6). Checkpoint G makes it a toggle.
    EditorView.lineWrapping,
    // High precedence so these file-command shortcuts always win, regardless
    // of what defaultKeymap does or gains in a future CodeMirror version.
    Prec.high(
      keymap.of([
        { key: 'Mod-o', run: dispatchCommand('file.open') },
        { key: 'Mod-s', run: dispatchCommand('file.save') },
        { key: 'Mod-Shift-s', run: dispatchCommand('file.saveAs') },
        { key: 'Mod-n', run: dispatchCommand('file.new') },
        { key: 'Mod-w', run: dispatchCommand('tab.close') },
        { key: 'Mod-Shift-t', run: dispatchCommand('tab.reopen') },
        { key: 'Mod-Shift-p', run: dispatchCommand('view.preview') },
        // Ctrl-Tab/Ctrl-Shift-Tab, spelled with the literal Ctrl- modifier
        // rather than Mod-, because SPEC §6.2 fixes this as a Windows-style
        // chord on every platform, not "whatever this OS calls its primary
        // modifier". WebView2 (Chromium) can treat Ctrl+Tab as its own
        // browser-tab-switching chord before a page ever sees the keydown,
        // so only Prec.high plus dispatchCommand's unconditional `true`
        // return reliably claims it first. There is no separate plain-Tab
        // indent binding here to worry about clobbering: buildExtensions
        // never adds @codemirror/commands' `indentWithTab`, and
        // `defaultKeymap` itself has no Tab entry -- confirmed in
        // extensions.test.ts, which dispatches a plain Tab keydown and
        // checks it is left unhandled both before and after this block.
        { key: 'Ctrl-Tab', run: dispatchCommand('tab.next') },
        { key: 'Ctrl-Shift-Tab', run: dispatchCommand('tab.previous') },
        // The keyboard path for reordering. Drag-and-drop is inherently
        // mouse-only, so without these the strip has a capability no keyboard
        // user can reach, against the project's full-keyboard-navigability
        // constraint. Matches what Firefox and Chrome bind for moving a tab.
        { key: 'Mod-Shift-ArrowLeft', run: dispatchCommand('tab.moveLeft') },
        { key: 'Mod-Shift-ArrowRight', run: dispatchCommand('tab.moveRight') },
        // One binding per position (Mod-Alt-1..9) rather than a single
        // handler reading event.code: CodeMirror's own keymap dispatch
        // already does modifier matching and Mac/Windows normalisation per
        // binding, so this loop gets that for free instead of re-deriving
        // it. Ctrl+Alt rather than plain Ctrl -- see documents.ts's
        // documentAtPosition and the task brief -- because Ctrl+1..6 is
        // reserved for heading levels in a later checkpoint; that collision
        // was resolved deliberately and is not to be undone here.
        ...Array.from({ length: 9 }, (_, i) => ({
          key: `Mod-Alt-${i + 1}`,
          run: dispatchCommand(`tab.goto${i + 1}`),
        })),
        // The sixteen formatting commands (commands.ts), each bound through
        // `toEditorCommand` -- the same adapter the toolbar will wrap its
        // buttons in (SPEC §6.5's "one implementation, two triggers"). Unlike
        // every `dispatchCommand` binding above, these can decline (a command
        // returns `false` when it does not apply, e.g. inside a fenced code
        // block) and are spelled out individually rather than generated,
        // since each maps to a different, spec-fixed chord.
        { key: 'Mod-b', run: toEditorCommand(COMMANDS.bold) },
        { key: 'Mod-i', run: toEditorCommand(COMMANDS.italic) },
        { key: 'Mod-Shift-x', run: toEditorCommand(COMMANDS.strikethrough) },
        { key: 'Mod-Shift-h', run: toEditorCommand(COMMANDS.highlight) },
        { key: 'Mod-`', run: toEditorCommand(COMMANDS.inlineCode) },
        { key: 'Mod-Shift-k', run: toEditorCommand(COMMANDS.codeBlock) },
        { key: 'Mod-Shift-8', run: toEditorCommand(COMMANDS.bulletList) },
        { key: 'Mod-Shift-7', run: toEditorCommand(COMMANDS.numberedList) },
        { key: 'Mod-Shift-9', run: toEditorCommand(COMMANDS.taskList) },
        { key: 'Mod-Shift-.', run: toEditorCommand(COMMANDS.blockquote) },
        { key: 'Mod-k', run: toEditorCommand(COMMANDS.link) },
        { key: 'Mod-Shift-i', run: toEditorCommand(COMMANDS.image) },
        // Ctrl+Alt+T, not SPEC §6.5's Ctrl+Shift+T: that chord is already Reopen
        // Closed Tab (SPEC §6.2/§6.14), shipped since Checkpoint C. The spec collides
        // with itself here; the owner chose to keep reopen-tab and move Table into
        // the Ctrl+Alt namespace this project already uses for tab positions.
        { key: 'Mod-Alt-t', run: toEditorCommand(COMMANDS.table) },
        { key: 'Mod-Shift--', run: toEditorCommand(COMMANDS.horizontalRule) },
        { key: 'Mod-Shift-f', run: toEditorCommand(COMMANDS.footnote) },
        ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
          key: `Mod-${level}`,
          run: toEditorCommand(COMMANDS[`heading${level}`]),
        })),
        // Last in this array on purpose. CodeMirror merges same-key bindings
        // into one ordered run list, so these are tried only after the real
        // commands above have declined -- and they must live in *this* array
        // rather than a lower-precedence one, because what they exist to beat
        // is `defaultKeymap`, which sits between the two.
        //
        // A declining command returns false so the chord can fall through,
        // but for these two what it falls through to is wrong:
        // - `Mod-i` is `selectParentSyntax` in `defaultKeymap`, so Ctrl+I
        //   inside a fenced block (where italic declines) expanded the
        //   selection to the enclosing node instead of doing nothing.
        // - `Mod-b` is bound by nothing on Windows (`emacsStyleKeymap`'s
        //   Ctrl-b is mac-only), so no binding calls preventDefault and the
        //   keydown reaches the DOM. `contentDOM` is a real contenteditable,
        //   so Chromium's own bold command can act on it.
        //
        // Claiming the chord in both cases makes "the command declined" mean
        // nothing happens, which is what the user expects inside code.
        { key: 'Mod-b', run: () => true },
        { key: 'Mod-i', run: () => true },
      ]),
    ),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    // Markdown language + token highlighting (highlight.ts), and the
    // blockquote line decoration it can't express on its own (blockquote.ts)
    // -- see those modules for why markers stay visible and why the
    // decoration is viewport-limited.
    ...markdownSupport(),
    blockquoteLines,
    hashpadTheme,
    darkThemeCompartment.of(EditorView.darkTheme.of(isDark)),
    EditorView.updateListener.of(syncActiveDocument),
    EditorView.updateListener.of(syncActiveFormats),
  ];
}
