import {
  EditorView,
  type Command,
  type ViewUpdate,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  history,
  defaultKeymap,
  historyKeymap,
  indentLess,
  indentMore,
} from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { findNext, findPrevious, openSearchPanel, search } from '@codemirror/search';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { darkThemeCompartment, hashpadTheme } from './theme';
import { Compartment } from '@codemirror/state';
import { blockquoteLines } from './blockquote';
import { markdownSupport } from './highlight';
import { COMMANDS, toEditorCommand } from './commands';
import { activeFormats } from './marks';
import { buildFindPanel, openReplacePanel } from '../ui/findreplace';
import { suppressEditorFileDrop } from '../ui/filedrop';
import { pasteImage } from '../files/imageops';
import { emitCommand } from '../ui/menubar';
import { store } from '../state/appcontext';
import { DEFAULT_BEHAVIOUR, statusOf, type EditorBehaviour } from '../state/document';

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
 * Publishes the caret position and the word/character counts for the status bar
 * (SPEC §6.11).
 *
 * Fires on the same two triggers as `syncActiveFormats` and for the same
 * reason: a selection-only move changes both the column and -- because the
 * counts describe the selection when there is one -- the counts as well.
 * Folding it into that listener would save a function call and cost the reader
 * the ability to see the two concerns separately.
 *
 * No early-out on an unchanged value here, unlike `publishActiveFormats`
 * above. That one compares a string it has already built; this would have to
 * compare five fields to skip a `setState` that store.ts's `isEqual` already
 * makes free -- a selector over `status` does not notify when the fields match.
 * The check would be a second, weaker copy of the store's own.
 */
function syncStatus(update: ViewUpdate): void {
  if (!update.docChanged && !update.selectionSet) return;
  publishStatus(update.state);
}

/**
 * The same publish without a `ViewUpdate` -- see `publishActiveFormats` for why
 * every seam that swaps the view's state outside a transaction has to call one
 * of these itself. The seams are the same two: `switchToDocument` and
 * `main.ts`'s bootstrap.
 */
export function publishStatus(state: EditorState): void {
  store.setState((prev) => ({ ...prev, status: statusOf(state) }));
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
export function buildExtensions(
  isDark: boolean,
  wordWrap = true,
  behaviour: EditorBehaviour = DEFAULT_BEHAVIOUR,
): Extension[] {
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
    // On by default (SPEC §6.6), and a toggle since G.1. In a compartment for
    // the same reason the theme is: reconfiguring is the only way to change it
    // on the live view without rebuilding the state, which would throw away the
    // undo history and the selection.
    wordWrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
    // Line numbers, tab width and what Tab inserts (SPEC §6.13). In a
    // compartment for the same reason word wrap is: reconfiguring is the only
    // way to change them on a live view without throwing away the undo
    // history and the selection.
    behaviourCompartment.of(behaviourExtensions(behaviour)),
    /**
     * SPEC §6.7 names this package. The panel is ours (`ui/findreplace.ts`):
     * the spec asks for it styled to match the app, and match highlighting is
     * gated on CodeMirror's panel being open, so a panel rendered elsewhere in
     * the chrome would have silently cost the highlights.
     */
    search({ top: true, createPanel: buildFindPanel }),
    // A dropped file opens as a tab (SPEC §6.4, ui/filedrop.ts), so the
    // editor's own "read the file and insert its text" default must not also
    // run. See that function for why returning true is enough.
    suppressEditorFileDrop(),
    // Ctrl+V with an image on the clipboard writes it beside the document and
    // inserts the markdown (SPEC §6.10). Registered as an extension handler so
    // it runs ahead of CodeMirror's own paste, which would otherwise insert the
    // clipboard's *text* flavour -- for a screenshot, usually nothing at all.
    // Text pastes fall through untouched: `pasteImage` returns false when there
    // is no image, and does so synchronously, because an await would land long
    // after the event could still be prevented.
    EditorView.domEventHandlers({ paste: (event, view) => pasteImage(view, event) }),
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
        { key: 'Mod-Shift-o', run: dispatchCommand('view.outline') },
        // SPEC §6.14. Through the bus rather than called directly, because
        // the menu triggers the same thing and one implementation should
        // serve both -- the arrangement every other view toggle here uses.
        { key: 'F11', run: dispatchCommand('view.fullscreen') },
        /**
         * Tab indents (SPEC §6.13's `tabSize`/`insertSpaces`, which mean
         * nothing without it). CodeMirror leaves Tab unbound by default and
         * says why: it takes away the keyboard's way out of the editor.
         *
         * Two ways back out, and **both already ship** -- no binding needed
         * here, which mutation testing is what established: removing a
         * `Mod-m` entry added here left the suite green, because
         * `defaultKeymap` already carries `Ctrl-m` -> `toggleTabFocusMode`.
         * And CodeMirror turns tab-focus mode on for two seconds after
         * Escape all by itself, which is the route a user will actually
         * find. Both are pinned in extensions.test.ts, because they are the
         * accessibility answer to binding Tab at all and nothing else in
         * this codebase would record that they exist.
         */
        { key: 'Tab', run: indentOnTab, shift: indentLess },
        // Find (SPEC §6.7, §6.14). These are `@codemirror/search`'s own
        // commands rather than `hashpad:command` ids: they act on the editor's
        // search state and nothing outside the editor has an opinion about
        // them, so routing them through the bus would add a hop that only
        // main.ts would ever unwrap. The Edit menu goes the other way and
        // dispatches `edit.find`, which main.ts turns back into this command --
        // one implementation, two triggers, the same as every format command.
        { key: 'Mod-f', run: openSearchPanel },
        { key: 'Mod-h', run: openReplacePanel },
        { key: 'Mod-g', run: findNext, shift: findPrevious },
        // F3 is the Windows convention and Notepad's own binding; SPEC §6.14
        // says match it wherever one exists.
        { key: 'F3', run: findNext, shift: findPrevious },
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
    EditorView.updateListener.of(syncStatus),
  ];
}

/**
 * Word wrap, reconfigurable on the live view.
 *
 * `wordWrap` defaults to on rather than being required at every call site, and
 * that default is SPEC §6.6's rather than an arbitrary one. It works the same
 * way the theme does: a new document is built with whatever the store currently
 * says, and `bootstrap()` corrects the *first* one once settings have loaded --
 * the editor is constructed before `LoadSettings` resolves, so there is a moment
 * where the compiled-in default is all there is.
 */
/**
 * SPEC §6.13's three editor behaviours, in one compartment.
 *
 * One rather than three because they arrive together -- from a single settings
 * load, and later from a single dialog -- and reconfiguring one compartment is
 * one transaction instead of three. They are unrelated to each other otherwise;
 * grouping them is about how they *change*, not what they do.
 */
export const behaviourCompartment = new Compartment();

/**
 * What one press of Tab inserts, as a string.
 *
 * CodeMirror's `indentUnit` facet is a string rather than a width, which is
 * exactly the distinction `insertSpaces` is about: spaces mean N of them, a tab
 * means one `	` however wide `tabSize` renders it.
 */
/**
 * Built from its code point rather than written as a literal. An actual tab
 * inside quotes is invisible in a diff and survives no round trip through a
 * formatter or a code-generating script with any confidence -- this codebase has
 * already had one such character written into a source file by accident, and the
 * escape sequence itself was mangled by tooling on the way in here.
 */
const TAB = String.fromCharCode(9);

function indentString(behaviour: EditorBehaviour): string {
  return behaviour.insertSpaces ? ' '.repeat(behaviour.tabSize) : TAB;
}

export function behaviourExtensions(behaviour: EditorBehaviour): Extension[] {
  return [
    behaviour.showLineNumbers ? lineNumbers() : [],
    // How wide a *literal* tab renders. Worth having even with insertSpaces on:
    // a document written elsewhere is full of tabs this app did not insert.
    EditorState.tabSize.of(behaviour.tabSize),
    indentUnit.of(indentString(behaviour)),
  ];
}

/**
 * Tab: indent the selection, or insert one indent at the caret.
 *
 * `@codemirror/commands` ships `insertTab`, and it is not usable here -- it
 * hard-codes a literal `"	"`, so `insertSpaces` would have nothing to change.
 * `indentMore` is right for a selection but indents *whole lines*, which is not
 * what Tab in the middle of a word should do.
 *
 * So: `indentMore` when something is selected, and otherwise insert the
 * `indentUnit` string the compartment above configured. Reading the facet rather
 * than taking the behaviour as an argument keeps this a plain `Command`, and
 * means the keymap does not have to be rebuilt when the setting changes.
 */
const indentOnTab: Command = (view) => {
  if (view.state.selection.ranges.some((range) => !range.empty)) return indentMore(view);

  view.dispatch({
    ...view.state.replaceSelection(view.state.facet(indentUnit)),
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
};

/** Applies a behaviour change to a live view, without rebuilding its state. */
export function setEditorBehaviour(view: EditorView, behaviour: EditorBehaviour): void {
  view.dispatch({ effects: behaviourCompartment.reconfigure(behaviourExtensions(behaviour)) });
}

export const wordWrapCompartment = new Compartment();

export function setWordWrap(view: EditorView, wordWrap: boolean): void {
  view.dispatch({
    effects: wordWrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []),
  });
}
