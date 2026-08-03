/**
 * Resolves, applies, and validates the app theme. `variables.css` already
 * carries a complete light/dark palette keyed on `data-theme`, and
 * `editor/theme.ts`'s CM6 theme reads the same custom properties, so
 * "applying a theme" here is exactly one attribute plus one Compartment
 * reconfigure -- never a re-render of anything.
 */
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
