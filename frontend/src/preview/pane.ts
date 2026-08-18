/**
 * The preview pane: the divider, the split width, and what makes a re-render
 * happen. This module is imported **lazily**, from main.ts's first
 * Ctrl+Shift+P, so markdown-it, DOMPurify and everything under `preview/` stay
 * out of the entry bundle (design §2.4). Nothing in the startup path may
 * import it, directly or transitively.
 *
 * `mountPreview` takes the split container and the `EditorView`. The view is
 * here for scroll sync, which needs the editor's geometry (`scrollDOM`,
 * `lineBlockAt`, `documentTop`) -- and for nothing else. It is passed as a
 * plain argument rather than fetched from `state/appcontext.ts`'s
 * `getEditorView()`, which throws when no view has been set, so this module
 * stays testable without that ambient state.
 *
 * It is deliberately *not* used for the trigger the plan wanted it for: an
 * `EditorView.updateListener` on `docChanged`. There is no way to attach one to
 * the already-constructed view that survives a tab switch. Measured: an
 * extension added with
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
import type { EditorView } from '@codemirror/view';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/app/App';
import { documentDirOf } from '../files/documentops';
import { store } from '../state/appcontext';
import { clampSplitRatio, MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '../state/document';
import { activeDocument } from '../state/documents';
import { onLanguageLoaded } from './codehighlight';
import { renderMarkdown } from './render';
import { lineForOffset, normalizeAnchors, offsetForLine, type AnchorOffset } from './scrollsync';

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

export function mountPreview(split: HTMLElement, view: EditorView): PreviewHandle {
  let pane: HTMLElement | null = null;
  let divider: HTMLElement | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set for the duration of a mouse drag; removes the window-level listeners. */
  let endDrag: (() => void) | null = null;
  let lastActiveId = activeDocument(store.getState())?.id ?? null;
  /**
   * Where each source line ended up, or `null` when the last render invalidated
   * the measurement. Measured on the first scroll after a render rather than at
   * the end of the render itself: reading `getBoundingClientRect` forces a
   * synchronous layout, and the render path runs on every debounced keystroke
   * whether or not anyone ever scrolls. Re-measuring after *every* render is
   * not optional -- every render moves everything.
   */
  let anchors: AnchorOffset[] | null = null;
  /** The scroller this module just wrote to; its next scroll event is the echo. */
  let echoFrom: HTMLElement | null = null;
  let guardFrame: number | null = null;

  /**
   * Off unless someone turns it on from the console with
   * `__hashpadSyncDebug = true`. Scroll sync is the one part of this checkpoint
   * whose inputs are all real geometry, which jsdom cannot supply -- three
   * rounds of fixes were reasoned from the code rather than measured, and the
   * first two were real bugs that were not the one being reported. This is the
   * cheapest way to stop guessing: it prints what the mapping actually saw.
   */
  function trace(record: Record<string, unknown>): void {
    if ((window as unknown as { __hashpadSyncDebug?: boolean }).__hashpadSyncDebug) {
      console.log('sync', JSON.stringify(record));
    }
  }

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
    // Unconditional, and before the early returns: every render moves every
    // element, and a render that bails still leaves the cache describing
    // content that may no longer be on screen.
    anchors = null;
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
      const html = renderMarkdown(doc.editorState.doc.toString(), {
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

  /**
   * Where each `[data-source-line]` element sits, in the pane's own scroll
   * coordinates -- measured once per render, on the first scroll that needs it.
   *
   * Not `offsetTop`, for two reasons. It is relative to the nearest positioned
   * `offsetParent`, so any positioned ancestor silently shifts it away from the
   * pane's frame; and a fenced block anchors on the inline `<code>`, whose box is
   * not comparable to the block elements around it. Subtracting the pane's own
   * rect keeps every anchor in one frame regardless of either.
   *
   * A fenced block's measured top therefore sits one `<pre>` padding below the
   * block's own top. Close enough to scroll to; not measured against a real
   * browser, and `docs/testing.md` carries it as a manual check.
   *
   * `Number(...)` is handed straight over rather than validated here:
   * `normalizeAnchors` drops a line that is not a positive integer, next to the
   * sort that depends on it.
   */
  function anchorOffsets(target: HTMLElement): AnchorOffset[] {
    if (anchors !== null) return anchors;
    const contentTop = target.getBoundingClientRect().top - target.scrollTop;
    const measured = [...target.querySelectorAll<HTMLElement>('[data-source-line]')].map(
      (element) => ({
        line: Number(element.dataset.sourceLine),
        offset: element.getBoundingClientRect().top - contentTop,
      }),
    );
    // Anchors past the editor's last reachable scroll position are dropped, not
    // merged: no scroll position can put those lines at the top of the editor,
    // and keeping them would make the endpoint below the out-of-order one and
    // cost it the reverse pass in `normalizeAnchors`.
    const bounds = endpoints(target, measured);
    const endLine = bounds.length > 1 ? bounds[1]!.line : Infinity;
    anchors = normalizeAnchors([...measured.filter((a) => a.line < endLine), ...bounds]);
    return anchors;
  }

  /**
   * The two synthetic anchors that make the mapping cover the whole of both
   * scrollable ranges, and the fix for the jump the owner kept hitting.
   *
   * Measured anchors are element tops, so the last one sits wherever the last
   * block *begins* -- typically a screenful short of the pane's maximum scroll.
   * The editor saturates somewhere else again: at its own maximum, the line at
   * the top of the viewport is roughly `last line - a screenful`, not the last
   * line. So each side had a dead zone at the end where its own scroll position
   * kept changing while the mapped value did not. Scroll into one and the
   * follower pins; back out and it releases. That is exactly "it jumps all the
   * way down and won't budge until I scroll back to the same position", and it
   * is a property of the anchor list rather than of the interpolation, which is
   * why making the mapping fractional improved the middle and left the ends
   * alone.
   *
   * Pinning the two saturation points to each other removes both dead zones:
   * the position that scrolls the editor to its bottom is the position that
   * scrolls the pane to its bottom, and everything between interpolates as
   * before. Line 1 to offset 0 does the same at the top.
   *
   * `normalizeAnchors` sorts, dedupes and enforces non-decreasing offsets, so
   * these are simply added to the list rather than spliced in at the right
   * place -- and a real anchor for line 1 keeps whichever offset comes first.
   *
   * Both guards matter: jsdom reports every scroll dimension as 0, so without
   * them every test in this file would get two extra anchors describing a
   * viewport that does not exist.
   */
  function endpoints(target: HTMLElement, measured: readonly AnchorOffset[]): AnchorOffset[] {
    const paneMax = target.scrollHeight - target.clientHeight;
    const editorMax = view.contentHeight - view.scrollDOM.clientHeight;
    if (measured.length === 0 || paneMax <= 0 || editorMax <= 0) return [];

    // The last line that can ever sit at the top of the editor's viewport: past
    // this the editor cannot scroll further, so every later line is unreachable
    // as a scroll position and the pane must already be at its end.
    //
    // Deliberately *not* conditional on this line falling past the last measured
    // anchor -- it usually does not, and that is exactly the problem it solves. A
    // long document's last anchor is its final block, but the editor stops
    // scrolling a screenful earlier, so the two saturation points genuinely
    // disagree. Adding this one and letting `normalizeAnchors` raise every later
    // offset to match is what makes them agree: the scroll position that ends
    // the editor is the one that ends the pane.
    return [
      { line: 1, offset: 0 },
      { line: sourcePosition(editorMax), offset: paneMax },
    ];
  }

  /**
   * Scrolling one pane scrolls the other, whose own scroll event would scroll
   * the first one back. What suppresses that echo is a token naming **the
   * scroller we just wrote to**, consumed by the first event that arrives on it.
   *
   * This replaced a single `applying` boolean that blocked *any* sync for a
   * whole animation frame, and that was the bug behind "the pane I am scrolling
   * is smooth, the other one is choppy and jumps". Scroll events fire several
   * times per frame during a wheel or a drag; the flag let the first one
   * through and dropped every one after it until the frame ran. The follower
   * therefore updated at best once a frame, from whichever source position
   * happened to land after a frame boundary, so it lurched between distant
   * positions instead of tracking. A token that names one scroller only ever
   * suppresses the echo, never the user.
   *
   * The frame is still here, as the release valve for a write that produces no
   * scroll event at all -- the browser clamping at the top or bottom, say.
   * Without it the token would sit armed and eat the user's next real scroll on
   * that side.
   *
   * Untested here and worth knowing: this reasoning assumes the write scrolls
   * instantly. Under `scroll-behavior: smooth` the assignment animates over
   * dozens of frames and only the first echo would be inside the token --
   * measured in real Chromium, where the remaining echoes dragged the source
   * scroller back to 0. Nothing in `src/` or `@codemirror/view` sets it today.
   */
  function isEcho(scroller: HTMLElement): boolean {
    if (echoFrom !== scroller) return false;
    // Consume it: the token is good for exactly one event.
    releaseGuard();
    return true;
  }

  function writeTo(scroller: HTMLElement, top: number): void {
    // An assignment that changes nothing fires no scroll event, so arming the
    // token would leave it waiting for an echo that never comes -- and eating
    // the user's next real scroll on that side instead.
    if (scroller.scrollTop === top) return;
    releaseGuard();
    echoFrom = scroller;
    guardFrame = requestAnimationFrame(() => {
      guardFrame = null;
      echoFrom = null;
    });
    scroller.scrollTop = top;
  }

  /**
   * A pending frame would clear the flag against a pane that no longer exists,
   * and a flag left set would wedge the sync for the next `show()` -- both
   * invisible from the DOM.
   */
  function releaseGuard(): void {
    if (guardFrame !== null) {
      cancelAnimationFrame(guardFrame);
      guardFrame = null;
    }
    echoFrom = null;
  }

  /**
   * Editor -> preview. `lineBlockAtHeight` measures in the document's own
   * coordinate space, whose origin sits at `documentTop` on screen; the top edge
   * of what the user can see is the scroller's own screen top. The difference
   * between those two is the whole conversion.
   *
   * Not `scrollDOM.scrollTop - documentTop`, which the brief had: that mixes the
   * scroller's scroll coordinates with screen ones, and the two agree only when
   * the scroller sits at y = 0. In the real window it sits below the menu bar,
   * the tab strip and the toolbar.
   *
   * The half pixel is not padding. Scrolling to a line's top lands exactly on a
   * block boundary, and `lineBlockAtHeight` resolves that to the block *above* --
   * so without the nudge every such position reports the line that has just
   * scrolled out of sight. Measured: at line 3's top of a four-line document it
   * answers line 2. Where the sync is interesting that is not a one-line
   * rounding error: when the block above is a tall image, the anchor it picks is
   * an image's height too high.
   *
   * "Resolves to the block above" is true of the path this hits and is **not** an
   * API-wide rule -- an earlier version of this comment claimed it was. In
   * `@codemirror/view`, `ViewState.lineBlockAtHeight` matches the viewport with
   * `find(l => l.top <= height && l.bottom >= height)`, and adjacent blocks share
   * `bottom === top`, so `find` returns the earlier one. The fallback for a
   * height outside the viewport goes through `HeightMapBranch.lineAt`, which at
   * equality descends *right* -- the block below. The nudge makes both paths
   * agree, which is the reason it is a nudge on the input rather than a
   * correction on the output.
   *
   * Half a pixel, and the only constraint that matters is that it stay well
   * under one line height -- it has to cross a boundary without skipping a line.
   * CodeMirror's own `scrollAnchorAt` uses 8 px for the same job, so there is
   * headroom. Unverified against a real line height: jsdom's height oracle
   * estimates 14 px per line, so the suite pins the sign and nothing else.
   */
  function syncFromEditor(): void {
    const target = pane;
    if (target === null || !store.getState().syncScroll) return;
    const list = anchorOffsets(target);
    // Nothing to map against, so stand aside rather than guess. Both mapping
    // functions answer 0 for an empty list, and acting on that would pin the
    // pane to the top on every editor scroll -- with `syncFromPreview` then
    // yanking the editor back to line 1, so the two would fight over the top of
    // the document. Reachable: `html_block` drops the source-line attribute, so
    // a document that is one block of raw HTML scrolls and has no anchors.
    if (list.length === 0) return;
    if (isEcho(view.scrollDOM)) return;

    const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    const at = sourcePosition(height);
    const to = offsetForLine(list, at);
    trace({
      dir: 'editor->preview',
      height: Math.round(height),
      line: Number(at.toFixed(2)),
      to: Math.round(to),
      paneWas: Math.round(target.scrollTop),
      paneMax: target.scrollHeight - target.clientHeight,
      anchors: list.length,
      lastAnchor: list[list.length - 1],
    });
    writeTo(target, to);
  }

  /**
   * The viewport top as a **fractional** source line, e.g. 12.4 for "40% of the
   * way down line 12".
   *
   * Whole line numbers were the second half of the choppiness. `lineBlockAtHeight`
   * answers a block, so scrolling within a line changed nothing at all and
   * crossing a line boundary moved the preview by that line's entire rendered
   * height in one step. Where a source line is a heading, an image or a fence,
   * that step is enormous -- which is the "jumps all the way down and won't
   * budge until I scroll back" report: the same line resolved for a whole range
   * of scroll positions, so the write was identical each time and nothing moved.
   *
   * A block can span several source lines (a wrapped paragraph is one block), so
   * the fraction is spread across the lines the block actually covers rather
   * than assumed to be one.
   *
   * This also retires the old `+ 0.5` nudge. That existed because
   * `lineBlockAtHeight` resolves an exact boundary to the block *above*; with a
   * fraction that is self-correcting, since the block above at its own bottom
   * gives progress 1, which is the first line of the block below.
   */
  function sourcePosition(height: number): number {
    const block = view.lineBlockAtHeight(height);
    const doc = view.state.doc;
    const first = doc.lineAt(block.from).number;
    const spanned = doc.lineAt(block.to).number - first + 1;
    // Clamped, and this is the bug behind the jumping rather than a tidy-up.
    // CodeMirror measures only the rendered viewport; outside it the height map
    // answers with an *estimated gap block* that can span dozens of lines, and
    // `lineBlockAtHeight` also returns the nearest block for a height past the
    // document rather than refusing. In both cases `height` sits outside the
    // block that comes back, so the ratio is not a fraction: measured at 40.9
    // on a three-line document, which `first + 40.9 * spanned` turns into a line
    // number the document does not have and the pane into a scroll position
    // nowhere near the text. Unclamped it also moved discontinuously, because
    // the estimate is replaced by real geometry as the viewport renders.
    //
    // This is what the owner meant by "look at the topmost line, not the text
    // block": a block outside the viewport is a guess about many lines, while
    // the line at the top of the viewport is always real. Clamping is what keeps
    // the answer inside the block the line is actually in.
    const raw = block.height > 0 ? (height - block.top) / block.height : 0;
    const progress = Math.min(Math.max(raw, 0), 1);
    return first + progress * spanned;
  }

  /**
   * Preview -> editor, the inverse. `BlockInfo.top` is in that same document
   * coordinate space, so `documentTop + top` is where the line is on screen, and
   * the distance from there to the scroller's own top is how much further it has
   * to scroll. `+=`, not `=`: `scrollTop` is not in that space, so only the
   * delta translates between the two.
   *
   * Both ends of the clamp are load-bearing, and `doc.line` throws -- inside a
   * scroll handler, where a throw takes the sync down with it -- for anything
   * outside them. Above: `anchors` describes the last render, which typing leaves
   * up to a debounce behind, so deleting the tail of a document briefly leaves
   * anchors naming lines it no longer has. Below: `lineForOffset` can answer 0
   * for an offset above the first anchor.
   */
  function syncFromPreview(): void {
    const target = pane;
    if (target === null || !store.getState().syncScroll) return;
    const list = anchorOffsets(target);
    // See `syncFromEditor`: an empty list means "no mapping", not "line 1".
    if (list.length === 0) return;
    if (isEcho(target)) return;

    // The inverse, and fractional for the same reason: rounding to a line and
    // scrolling to its top made the editor lurch a line at a time and sit still
    // in between.
    const doc = view.state.doc;
    const exact = lineForOffset(list, target.scrollTop);
    // `doc.line` throws for anything outside the document, inside a scroll
    // handler where a throw takes the sync down with it. Above: `anchors`
    // describes the last render, which typing leaves a debounce behind, so
    // deleting the tail briefly leaves anchors naming lines that are gone.
    // Below: `lineForOffset` answers 0 for an offset above the first anchor.
    const line = Math.min(Math.max(Math.floor(exact), 1), doc.lines);
    const block = view.lineBlockAt(doc.line(line).from);
    const first = doc.lineAt(block.from).number;
    const spanned = doc.lineAt(block.to).number - first + 1;
    const progress = Math.min(Math.max((exact - first) / spanned, 0), 1);
    const scroller = view.scrollDOM;
    const delta =
      view.documentTop + block.top + progress * block.height - scroller.getBoundingClientRect().top;
    trace({
      dir: 'preview->editor',
      paneTop: Math.round(target.scrollTop),
      line: Number(exact.toFixed(2)),
      delta: Math.round(delta),
      editorWas: Math.round(scroller.scrollTop),
      anchors: list.length,
    });
    writeTo(scroller, scroller.scrollTop + delta);
  }

  function applyRatio(ratio: number): void {
    // Narrowing the pane rewraps its text and rescales its images, so every
    // measured offset is stale -- and a drag never renders, so nothing else
    // clears the cache. The pane's subscription selects the active `Document`,
    // and a ratio write hands back the same object, so store.ts's `isEqual`
    // does not notify (see the subscription's own comment). Without this line a
    // drag-then-scroll replays the pre-drag offsets until the next keystroke.
    anchors = null;
    // `flex-basis`, not `width`: the pane is a flex item in `.editor-split`,
    // and app.css gives it `flex: 0 0 auto` so this is the size that sticks.
    if (pane !== null) pane.style.flexBasis = `${(ratio * 100).toFixed(2)}%`;
    divider?.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  /**
   * The other two ways the offsets go stale without a render.
   *
   * A window resize rewraps the pane exactly as a divider drag does. And an
   * image reserves no height until it decodes -- `rules/images.ts` emits no
   * `width`/`height` -- so everything below one shifts when it arrives. That is
   * not an edge case here: a tall image is the whole reason this sync is
   * line-anchored rather than proportional, so measuring before it loads gets
   * the headline case wrong.
   *
   * `load` does not bubble from an `<img>`, hence the capture phase.
   */
  function invalidateAnchors(): void {
    anchors = null;
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
    pane.addEventListener('scroll', syncFromPreview);
    pane.addEventListener('load', invalidateAnchors, true);
    // The editor's scroller outlives the pane, so unlike the pane's own listener
    // this one is a real leak if `hide()` forgets it -- and it would keep
    // measuring against a pane that is no longer there.
    view.scrollDOM.addEventListener('scroll', syncFromEditor);
    // Same reasoning as the `load` listener above, for the other thing that
    // rewraps the pane without rendering it.
    window.addEventListener('resize', invalidateAnchors);

    // Appended, so they land after `.editor-area`: `.editor-split` is a plain
    // flex row with no `order`, so DOM order is left-to-right order.
    split.append(divider, pane);
    applyRatio(store.getState().previewSplitRatio);
    render();
  }

  function hide(): void {
    clearRenderTimer();
    endDrag?.();
    pane?.removeEventListener('scroll', syncFromPreview);
    pane?.removeEventListener('load', invalidateAnchors, true);
    view.scrollDOM.removeEventListener('scroll', syncFromEditor);
    // `window` outlives everything here, so this is the one of the four that
    // leaks for the life of the process if it is forgotten.
    window.removeEventListener('resize', invalidateAnchors);
    releaseGuard();
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
