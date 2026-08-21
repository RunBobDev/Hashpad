/**
 * The typography half of SPEC §6.13, pushed into CSS custom properties.
 *
 * `styles/variables.css` was built for this: it already declares `--font-ui`,
 * `--font-editor`, `--font-preview` and the three size tokens, with a comment
 * saying that wiring them to settings is a later checkpoint's job "for both
 * panes at once". This is that job. Nothing else has to change -- the editor
 * theme, the preview stylesheet and the chrome all read the tokens already, so
 * setting them on `:root` retints everything in one go, with no reconfiguration
 * and no re-render.
 *
 * **Every value here comes from a file the user can hand-edit**, so every value
 * is clamped or sanitised. `settings.json` with `"fontSize": 0` must give a
 * readable editor, not an invisible one; `LoadSettingsFrom` only guarantees the
 * file *parsed*, never that the numbers in it are sane.
 */
import type { app } from '../../wailsjs/go/models';

/**
 * Fallbacks appended after whatever the user asked for, so a name that is not
 * installed still lands on something sensible. These match the compiled-in
 * defaults in variables.css -- the point of the setting is to prepend a
 * preference, not to replace the whole stack and risk ending up with nothing.
 */
const EDITOR_FALLBACK = 'Consolas, ui-monospace, monospace';
const PREVIEW_FALLBACK = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";

/** Limits for the hand-editable numbers. Wide enough to be useful, narrow enough to stay usable. */
const LIMITS = {
  uiFontSize: { min: 10, max: 24, fallback: 14 },
  editorFontSize: { min: 8, max: 48, fallback: 14 },
  previewFontSize: { min: 8, max: 48, fallback: 15 },
  lineHeight: { min: 1, max: 3, fallback: 1.6 },
  maxContentWidth: { min: 320, max: 4000, fallback: 900 },
} as const;

interface Limit {
  min: number;
  max: number;
  fallback: number;
}

/**
 * A number from settings, made safe.
 *
 * `Number.isFinite` first, and not just a range check: JSON can carry `null`,
 * and a hand-edited file can carry a string or `1e999`. `NaN` fails every
 * comparison silently, so `Math.min/max` alone would propagate it into the
 * stylesheet as `NaNpx` -- which the browser drops, leaving the token unset and
 * the cause invisible.
 */
export function clampSetting(value: number, limit: Limit): number {
  if (!Number.isFinite(value)) return limit.fallback;
  return Math.min(Math.max(value, limit.min), limit.max);
}

/**
 * A font-family list built from the user's choice.
 *
 * Names are split on commas so both `Cascadia Mono` and
 * `Cascadia Mono, Fira Code` work, then stripped to the characters a family
 * name can actually contain and quoted. Quoting is what makes a name with a
 * space or a digit valid CSS; stripping is what stops a hand-edited value being
 * anything other than a name.
 *
 * This is not an injection defence and should not be read as one -- CSS
 * variable substitution cannot introduce a new declaration, because a `;` in a
 * value makes the *substituting* declaration invalid rather than ending it. It
 * is here so a malformed value degrades to the fallback instead of quietly
 * killing the font for the whole app.
 */
export function fontStack(requested: string, fallback: string): string {
  // Not just belt-and-braces: `LoadSettingsFrom` returns whatever unmarshalled,
  // and the numbers get `Number.isFinite` above for the same reason. A missing
  // or non-string family would throw on `.split` here, inside bootstrap, before
  // `ShowWindow` -- an invisible window, which is the failure this codebase has
  // already had once (see `statusBarTeardown` in main.ts).
  if (typeof requested !== 'string') return fallback;

  const names = requested
    .split(',')
    .map((name) => name.replace(/['"]/g, '').trim())
    // Letters, digits, spaces and hyphens: enough for every real family name,
    // including `Cascadia Mono`, `PT Sans`, `SF Mono` and `Fira Code`.
    .filter((name) => name !== '' && /^[\w -]+$/.test(name))
    .map((name) => `'${name}'`);

  return names.length === 0 ? fallback : `${names.join(', ')}, ${fallback}`;
}

/**
 * The size tokens keep their `* var(--zoom)` factor.
 *
 * Ctrl+scroll and Ctrl+Plus/Minus work by changing `--zoom` alone (ui/zoom.ts),
 * and only the two *content* sizes multiply by it -- that is what makes "zoom
 * never scales the chrome" a property of the tokens rather than a rule someone
 * has to remember. Overwriting `--size-editor` with a plain `14px` would break
 * zoom silently, and only for users who had touched the font size.
 */
function zoomable(pixels: number): string {
  return `calc(${pixels}px * var(--zoom))`;
}

/**
 * Applies the typography settings. Idempotent, and safe to call on every change.
 *
 * `root` is injectable for tests; in the app it is always `<html>`, because that
 * is where variables.css declares the tokens and an inline property on the same
 * element is what overrides them.
 */
export function applyTypography(
  settings: app.Settings,
  root: HTMLElement = document.documentElement,
): void {
  const { appearance, editor, preview } = settings;

  root.style.setProperty(
    '--size-ui',
    `${clampSetting(appearance.uiFontSize, LIMITS.uiFontSize)}px`,
  );

  root.style.setProperty('--font-editor', fontStack(editor.fontFamily, EDITOR_FALLBACK));
  root.style.setProperty(
    '--size-editor',
    zoomable(clampSetting(editor.fontSize, LIMITS.editorFontSize)),
  );
  root.style.setProperty(
    '--line-editor',
    String(clampSetting(editor.lineHeight, LIMITS.lineHeight)),
  );

  root.style.setProperty('--font-preview', fontStack(preview.fontFamily, PREVIEW_FALLBACK));
  root.style.setProperty(
    '--size-preview',
    zoomable(clampSetting(preview.fontSize, LIMITS.previewFontSize)),
  );

  // Zero means "no limit", which is the only way to say that in the settings
  // file -- there is no null, and any positive number is a width. `none` is a
  // valid `max-width`, so the CSS needs no special case for it.
  root.style.setProperty(
    '--max-content-width',
    editor.maxContentWidth === 0
      ? 'none'
      : `${clampSetting(editor.maxContentWidth, LIMITS.maxContentWidth)}px`,
  );
}
