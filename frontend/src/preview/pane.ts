/**
 * The preview pane: the divider, the split width, and what makes a re-render
 * happen. This module is imported **lazily**, from main.ts's first
 * Ctrl+Shift+P, so markdown-it, DOMPurify and everything under `preview/` stay
 * out of the entry bundle (design §2.4). Nothing in the startup path may
 * import it, directly or transitively.
 *
 * `mountPreview` takes the split container and nothing else. The plan's
 * interface also took the `EditorView`, for an `EditorView.updateListener` on
 * `docChanged` -- but there is no way to attach one to the already-constructed
 * view that survives a tab switch. Measured: an extension added with
 * `StateEffect.appendConfig` stops firing the moment
 * `files/documentops.ts`'s `switchToDocument` calls `view.setState(...)`,
 * because configuration comes from the state being installed, so a listener
 * added that way would silently stop updating the preview after the first tab
 * switch. The store is the trigger instead, and it is strictly better here:
 * `editor/extensions.ts`'s `syncActiveDocument` is a permanent member of
 * `buildExtensions`, so every keystroke lands in the active document's
 * `editorState` anyway, and one subscription then covers both triggers the
 * decision table names -- an edit and a tab switch.
 *
 * Reading the text from the store rather than from the view is not incidental
 * either: `switchToDocument` updates the store *before* it calls
 * `view.setState`, so a render driven off `view.state` at that instant would
 * paint the outgoing document.
 */
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { documentDirOf } from '../files/documentops';
import { store } from '../state/appcontext';
import { clampSplitRatio, MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '../state/document';
import { activeDocument } from '../state/documents';
import { onLanguageLoaded } from './codehighlight';
import { renderMarkdown } from './render';

export interface PreviewHandle {
  show(): void;
  hide(): void;
  destroy(): void;
}

/**
 * Long enough that a burst of typing renders once, short enough that the pane
 * feels attached to the keyboard. Rendering re-parses the whole document and,
 * for a document with fenced code, re-highlights every fence
 * (codehighlight.ts's measured 5.8x HTML growth), so this is the debounce that
 * comment says to reach for before caching anything.
 */
const RENDER_DEBOUNCE_MS = 150;

/** A drag emits a mousemove per pixel; without this each one writes the file. */
const SAVE_DEBOUNCE_MS = 300;

/** How far Left/Right move the divider per press. */
const KEYBOARD_STEP = 0.05;

export function mountPreview(split: HTMLElement): PreviewHandle {
  let pane: HTMLElement | null = null;
  let divider: HTMLElement | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set for the duration of a mouse drag; removes the window-level listeners. */
  let endDrag: (() => void) | null = null;
  let lastActiveId = activeDocument(store.getState())?.id ?? null;

  function clearRenderTimer(): void {
    if (renderTimer === null) return;
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  /**
   * Renders now. Skipped entirely while the pane is hidden or the active
   * document is not in split mode -- the handle outlives a `hide()`, and a
   * background document must not pay for a render nobody is looking at.
   */
  function render(): void {
    clearRenderTimer();
    if (pane === null) return;

    const doc = activeDocument(store.getState());
    if (doc === null || doc.viewMode !== 'split') return;

    try {
      // `documentDirOf` answers `''` for a document with no directory to
      // resolve against (unsaved, or a bare filename); `RenderContext` spells
      // the same state `null`, which is what rules/images.ts checks to render
      // its "save the document to load local images" placeholder. Mapping the
      // two is what stops every local image in a saved document from showing
      // that placeholder forever.
      const dir = documentDirOf(doc.filePath);
      const { html } = renderMarkdown(doc.editorState.doc.toString(), {
        documentDir: dir === '' ? null : dir,
      });
      // Sanitised by renderMarkdown -- see render.ts, where `html: true` and
      // DOMPurify are documented as a pair that must not be separated.
      pane.innerHTML = html;
    } catch (error) {
      // A renderer that throws must not leave the last good render on screen
      // pretending to be current, so this replaces the content rather than
      // appending to it. `textContent`, never `innerHTML`: the message can
      // carry anything, including markup from the document that caused it.
      const failure = document.createElement('div');
      failure.className = 'preview-error';
      failure.textContent = error instanceof Error ? error.message : String(error);
      pane.replaceChildren(failure);
    }
  }

  function scheduleRender(): void {
    // What this guard actually buys: while the pane is hidden the handle stays
    // subscribed, so every keystroke would otherwise arm a 150 ms timer whose
    // only job is to call `render()` and have it bail on the same null pane.
    //
    // An earlier version of this comment claimed the guard also stopped a
    // toggle costing a second render. It does not, and the toggle does cost
    // one: `main.ts`'s viewMode subscription is registered at module load and
    // this one inside `mountPreview`, so on Ctrl+Shift+P main.ts's fires
    // first, `show()` renders, and *then* this one fires with a live pane and
    // schedules a second, identical render 150 ms later. Measured: one toggle,
    // two `renderMarkdown` calls. Left alone deliberately -- it is one extra
    // parse per toggle, never per keystroke, and every way of suppressing it
    // costs more machinery than the render it saves.
    if (pane === null) return;
    clearRenderTimer();
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, RENDER_DEBOUNCE_MS);
  }

  /**
   * One subscription, two triggers. The selector returns the active `Document`
   * object: store.ts's `isEqual` compares one level of own keys, so an edit
   * (which replaces `editorState`) and a tab switch (a different object)
   * both notify, while an unrelated `setState` -- a theme flip, our own
   * `previewSplitRatio` write -- hands back the same object and does not.
   *
   * A switch renders immediately and an edit is debounced, per the decision
   * table. `lastActiveId` is what tells them apart.
   */
  const unsubscribeStore = store.subscribe(
    (state) => activeDocument(state),
    (doc) => {
      const id = doc?.id ?? null;
      if (id !== lastActiveId) {
        lastActiveId = id;
        render();
      } else {
        scheduleRender();
      }
    },
  );

  /**
   * A grammar chunk arriving (codehighlight.ts) is the one render trigger with
   * no user action behind it, and the fence it repaints is already on screen
   * unhighlighted -- so it renders immediately rather than joining the typing
   * debounce.
   */
  const unsubscribeLanguage = onLanguageLoaded(render);

  function applyRatio(ratio: number): void {
    // `flex-basis`, not `width`: the pane is a flex item in `.editor-split`,
    // and app.css gives it `flex: 0 0 auto` so this is the size that sticks.
    if (pane !== null) pane.style.flexBasis = `${(ratio * 100).toFixed(2)}%`;
    divider?.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  function setRatio(next: number): void {
    const ratio = clampSplitRatio(next);
    if (ratio === store.getState().previewSplitRatio) return;

    store.setState((prev) => ({ ...prev, previewSplitRatio: ratio }));
    applyRatio(ratio);

    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist(ratio);
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Read-modify-write against the whole settings file, the same shape
   * main.ts's `setThemeMode` and `setToolbarPinned` use -- and with the same
   * error handling, because the resize the user just did already happened and
   * a failed disk write must not undo it.
   */
  async function persist(ratio: number): Promise<void> {
    try {
      const settings = await LoadSettings();
      settings.window.previewSplitRatio = ratio;
      await SaveSettings(settings);
    } catch (error) {
      console.error('hashpad: failed to persist the preview split ratio', error);
    }
  }

  function beginDrag(event: MouseEvent): void {
    // Without this the drag selects text across the editor and the preview.
    event.preventDefault();
    endDrag?.();

    const onMove = (moveEvent: MouseEvent): void => {
      const bounds = split.getBoundingClientRect();
      // A row with no measured width divides into nothing, and the division
      // below would hand `setRatio` a NaN. Real in jsdom, where every rect is
      // zero; not expected in the running app.
      if (bounds.width === 0) return;
      // The ratio is the *preview's* share, so it is measured from the right
      // edge: dragging left grows the pane.
      setRatio((bounds.right - moveEvent.clientX) / bounds.width);
    };
    const onUp = (): void => endDrag?.();

    endDrag = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      endDrag = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /**
   * The keyboard half of the drag. Dragging is inherently mouse-only, so
   * without this the split has a capability no keyboard user can reach --
   * the same reasoning that put Ctrl+Shift+Left/Right on the tab strip.
   */
  function onDividerKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    // Left moves the divider left, which grows the pane to its right.
    setRatio(
      store.getState().previewSplitRatio +
        (event.key === 'ArrowLeft' ? KEYBOARD_STEP : -KEYBOARD_STEP),
    );
  }

  function show(): void {
    if (pane !== null) return;

    divider = document.createElement('div');
    divider.className = 'preview-divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.setAttribute('aria-label', 'Preview width');
    // A focusable separator is a splitter, and a splitter that reports no
    // position tells a screen-reader user nothing about what Left/Right did.
    divider.setAttribute('aria-valuemin', String(Math.round(MIN_SPLIT_RATIO * 100)));
    divider.setAttribute('aria-valuemax', String(Math.round(MAX_SPLIT_RATIO * 100)));
    divider.tabIndex = 0;
    divider.addEventListener('mousedown', beginDrag);
    divider.addEventListener('keydown', onDividerKey);

    pane = document.createElement('div');
    pane.className = 'preview-pane';

    // Appended, so they land after `.editor-area`: `.editor-split` is a plain
    // flex row with no `order`, so DOM order is left-to-right order.
    split.append(divider, pane);
    applyRatio(store.getState().previewSplitRatio);
    render();
  }

  function hide(): void {
    clearRenderTimer();
    endDrag?.();
    // Removing the focused element drops focus to `<body>`, and the next Tab
    // then restarts from the top of the window rather than from where the user
    // was. The divider is the only focus stop this module adds, so returning
    // focus to the editor is both the obvious destination and the one the user
    // was working in before they reached for the split.
    if (divider !== null && document.activeElement === divider) {
      split.querySelector<HTMLElement>('.cm-content')?.focus();
    }
    divider?.remove();
    pane?.remove();
    divider = null;
    pane = null;
  }

  function destroy(): void {
    // Takes the nodes, the divider's own listeners with them, the render
    // timer, and any in-flight drag's window-level listeners.
    hide();
    // A drag inside its 300 ms window is dropped rather than flushed. destroy()
    // is a teardown contract with no caller in the running app today; adding
    // flush semantics for a path nobody takes would be inventing a behaviour
    // that no test could justify.
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    unsubscribeStore();
    unsubscribeLanguage();
  }

  return { show, hide, destroy };
}
