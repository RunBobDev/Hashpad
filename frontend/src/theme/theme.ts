/**
 * Resolves, applies, and validates the app theme. `variables.css` already
 * carries a complete light/dark palette keyed on `data-theme`, and
 * `editor/theme.ts`'s CM6 theme reads the same custom properties, so
 * "applying a theme" here is exactly one attribute plus one Compartment
 * reconfigure -- never a re-render of anything.
 */
import { WindowSetBackgroundColour } from '../../wailsjs/runtime/runtime';
import { getEditorView, store } from '../state/appcontext';
import { setEditorDark } from '../editor/theme';

export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * `systemIsDark` is `null` when the OS preference could not be read (a
 * missing registry key, an unsupported platform -- see
 * `SystemThemeIsDark`'s doc comment). SPEC §6.12 says follow-system silently
 * falls back rather than guessing, and light is the app's long-standing
 * default, so `null` resolves to light exactly like an explicit 'light' mode
 * would.
 */
export function resolveIsDark(mode: ThemeMode, systemIsDark: boolean | null): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return systemIsDark ?? false;
}

/**
 * Sets `data-theme` (which repaints the whole app via variables.css) and
 * reconfigures the editor's `darkTheme` facet through its Compartment --
 * colours alone don't reach that facet, so it needs its own call. Also
 * updates the store's `isDark` so anything reading resolved theme state
 * (SPEC §5.1) stays in sync with what's actually on screen.
 */
export function applyTheme(isDark: boolean): void {
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  store.setState((prev) => ({ ...prev, isDark }));
  setEditorDark(getEditorView(), isDark);
  syncWindowBackground();
}

/**
 * Tells Wails what colour the *window* is, as opposed to the page.
 *
 * `main.go` sets an opaque white `BackgroundColour` so the window does not flash
 * a dark frame before CSS applies. That is right at startup and wrong
 * afterwards: while a window is being resized, Windows fills the newly exposed
 * strip with the window's own background before WebView2 has painted anything
 * there. In the dark theme that strip is white, which is the flashing the owner
 * reported down the edge being dragged.
 *
 * Read back out of `--bg-app` rather than hard-coded here, so this stays
 * governed by variables.css (SPEC §5.3) and cannot drift from the theme it is
 * meant to match. Called after the `data-theme` flip above, because that is what
 * decides which value `--bg-app` now resolves to.
 */
function syncWindowBackground(): void {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim();
  const rgb = parseHex(value);
  if (rgb === null) return;
  WindowSetBackgroundColour(rgb.r, rgb.g, rgb.b, 255);
}

/**
 * `#RGB` or `#RRGGBB` to channels, or `null` for anything else.
 *
 * Null rather than a fallback colour: the only caller is asking "what should the
 * window match?", and the honest answer to an unparseable value is "leave it
 * alone" -- guessing white would reintroduce the exact flash this is fixing.
 * variables.css only ever uses hex for `--bg-app`, so this is a guard rather
 * than a conversion library.
 */
function parseHex(value: string): { r: number; g: number; b: number } | null {
  if (!HEX_COLOR.test(value)) return null;
  const hex =
    value.length === 4
      ? value
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(1);
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * Strict hex-only: `#RGB` or `#RRGGBB`. This value is a hand-edited
 * settings.json field written straight into a CSS custom property
 * (`applyAccent`), so anything looser -- named colours, `rgb()`, or a value
 * that merely starts with a hex colour -- is a stylesheet-injection vector.
 * `#0078d4; --bg-app: red` must be rejected, not just the CSS keyword forms.
 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidAccent(color: string): boolean {
  return HEX_COLOR.test(color);
}

/** Sets the one colour this task touches: `--accent-base`, from which every theme derives its own readable `--accent` (variables.css). */
export function applyAccent(color: string): void {
  document.documentElement.style.setProperty('--accent-base', color);
}
