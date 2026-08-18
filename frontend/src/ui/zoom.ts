/**
 * Zoom, per SPEC §6.6: Ctrl+scroll and Ctrl+Plus/Minus, Ctrl+0 to reset.
 *
 * One number, `--zoom`, which only `--size-editor` and `--size-preview`
 * multiply by. "Zooms editor and preview content only, never the UI chrome" is
 * therefore a property of `variables.css` rather than a rule this file has to
 * enforce -- there is no code path here that could scale the menu bar.
 *
 * **Per session, not persisted.** SPEC is explicit, so nothing here touches
 * settings.json, and nothing puts it in the store either: no other module reacts
 * to zoom, and a store field would exist only to be written.
 *
 * Listeners are on `window` rather than in the editor's keymap because zoom is
 * not an editor command -- it has to work with the caret in the editor, the
 * focus in the preview, or nothing focused at all.
 */
const MIN = 0.5;
const MAX = 3;
/** A 10% step, which is roughly what browsers use and what fingers expect. */
const STEP = 1.1;

let level = 1;

function apply(): void {
  document.documentElement.style.setProperty('--zoom', String(level));
}

/** Clamped, and rounded so repeated steps cannot drift into 1.0000000002. */
function setLevel(next: number): void {
  level = Math.round(Math.min(Math.max(next, MIN), MAX) * 1000) / 1000;
  apply();
}

export function zoomIn(): void {
  setLevel(level * STEP);
}

export function zoomOut(): void {
  setLevel(level / STEP);
}

export function zoomReset(): void {
  setLevel(1);
}

/** Test-only: the current factor, which is otherwise write-only state. */
export function zoomLevel(): number {
  return level;
}

/**
 * Wires the two input paths and returns a teardown.
 *
 * `Ctrl+=` as well as `Ctrl++`: the plus on the main row needs Shift, and every
 * browser treats the unshifted `=` as zoom-in for that reason. `Ctrl+NumpadAdd`
 * arrives as `+` already.
 *
 * `preventDefault` on the wheel path stops WebView2 doing its own page zoom on
 * top of ours -- which would scale the chrome, the one thing SPEC rules out.
 * The listener is `passive: false` because a passive listener is forbidden from
 * preventing anything, and Chromium defaults wheel listeners to passive.
 */
export function mountZoom(target: Window = window): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (!event.ctrlKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') zoomIn();
    else if (event.key === '-') zoomOut();
    else if (event.key === '0') zoomReset();
    else return;
    event.preventDefault();
  };

  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (event.deltaY < 0) zoomIn();
    else if (event.deltaY > 0) zoomOut();
  };

  target.addEventListener('keydown', onKey);
  target.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    target.removeEventListener('keydown', onKey);
    target.removeEventListener('wheel', onWheel);
  };
}
