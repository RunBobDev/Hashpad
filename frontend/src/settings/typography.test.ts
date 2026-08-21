// @vitest-environment jsdom
/**
 * SPEC §6.13's typography settings, pushed onto `:root`.
 *
 * jsdom stores inline custom properties faithfully and resolves nothing, so
 * these read back exactly what was set -- which is the right level for this
 * module. Whether `--size-editor` then *renders* at that size is
 * `styles/variables.css`'s and the editor theme's business, and a browser's to
 * judge (see `docs/testing.md`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { app } from '../../wailsjs/go/models';
import { applyTypography, clampSetting, fontStack } from './typography';

/** Defaults matching internal/app/settings.go's `DefaultSettings`. */
function defaults(): app.Settings {
  return {
    version: 1,
    appearance: { theme: 'system', accentColor: '#0078d4', uiFontSize: 14 },
    editor: {
      fontFamily: 'Cascadia Mono',
      fontSize: 14,
      lineHeight: 1.6,
      wordWrap: true,
      maxContentWidth: 900,
      showLineNumbers: false,
      tabSize: 2,
      insertSpaces: true,
      defaultViewMode: 'source',
    },
    preview: { fontFamily: 'Segoe UI', fontSize: 15, syncScroll: true },
    files: {
      autosave: false,
      autosaveDelayMs: 2000,
      assetFolder: 'assets',
      defaultEncoding: 'utf-8',
    },
    window: {
      width: 1000,
      height: 700,
      maximized: false,
      outlineVisible: false,
      outlineWidth: 240,
      statusBarVisible: true,
      previewSplitRatio: 0.5,
    },
    toolbar: { visible: true, pinned: [] },
  } as unknown as app.Settings;
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
});

/** The value actually written to the element, not a resolved one. */
function token(name: string): string {
  return root.style.getPropertyValue(name);
}

describe('applying the typography settings', () => {
  it('writes every token the stylesheets read', () => {
    applyTypography(defaults(), root);

    expect(token('--size-ui')).toBe('14px');
    expect(token('--line-editor')).toBe('1.6');
    expect(token('--font-editor')).toContain("'Cascadia Mono'");
    expect(token('--font-preview')).toContain("'Segoe UI'");
    expect(token('--max-content-width')).toBe('900px');
  });

  /**
   * **The load-bearing one.** Zoom (Ctrl+scroll, Ctrl+Plus/Minus) works by
   * changing `--zoom` alone, and only the two content sizes multiply by it.
   * Overwriting these with a plain `14px` would disable zoom silently, and only
   * for users who had changed their font size -- so the multiplication has to
   * survive the override.
   */
  it.each([['--size-editor'], ['--size-preview']])('%s keeps its zoom factor', (name) => {
    applyTypography(defaults(), root);

    expect(token(name)).toMatch(/var\(--zoom\)/);
  });

  it('takes the sizes from settings, not from the defaults', () => {
    const settings = defaults();
    settings.appearance.uiFontSize = 18;
    settings.editor.fontSize = 20;
    settings.preview.fontSize = 22;

    applyTypography(settings, root);

    expect(token('--size-ui')).toBe('18px');
    expect(token('--size-editor')).toBe('calc(20px * var(--zoom))');
    expect(token('--size-preview')).toBe('calc(22px * var(--zoom))');
  });

  /**
   * Zero is the only way settings.json can say "no limit" -- there is no null,
   * and every positive number is a width. `none` is a real `max-width`, so the
   * stylesheets need no special case.
   */
  it('treats a zero content width as no limit', () => {
    const settings = defaults();
    settings.editor.maxContentWidth = 0;

    applyTypography(settings, root);

    expect(token('--max-content-width')).toBe('none');
  });

  /**
   * settings.json is hand-editable and `LoadSettingsFrom` only guarantees it
   * parsed -- never that the numbers are sane. A zero font size must not give
   * an invisible editor.
   */
  it.each([
    [0, '8px'],
    [-5, '8px'],
    [500, '48px'],
  ])('clamps an editor font size of %s', (size, expected) => {
    const settings = defaults();
    settings.editor.fontSize = size;

    applyTypography(settings, root);

    expect(token('--size-editor')).toBe(`calc(${expected} * var(--zoom))`);
  });
});

describe('clampSetting', () => {
  const limit = { min: 10, max: 20, fallback: 14 };

  it.each([
    [15, 15],
    [5, 10],
    [50, 20],
  ])('clamps %s to %s', (value, expected) => {
    expect(clampSetting(value, limit)).toBe(expected);
  });

  /**
   * Not a range check away from the others: `NaN` fails every comparison, so
   * `Math.min`/`Math.max` alone propagate it into the stylesheet as `NaNpx`,
   * which the browser drops -- leaving the token unset and the cause invisible.
   * JSON `null` and a hand-typed string both arrive here as non-numbers.
   */
  it.each([
    [NaN],
    [Infinity],
    [-Infinity],
    [undefined as unknown as number],
    [null as unknown as number],
  ])('falls back for %s', (value) => {
    expect(clampSetting(value, limit)).toBe(14);
  });
});

describe('fontStack', () => {
  const fallback = 'Consolas, monospace';

  it('quotes the requested family and keeps the fallbacks', () => {
    expect(fontStack('Cascadia Mono', fallback)).toBe("'Cascadia Mono', Consolas, monospace");
  });

  /** A user may reasonably type a list, and it should mean what it says. */
  it('accepts a comma-separated list', () => {
    expect(fontStack('Fira Code, Iosevka', fallback)).toBe(
      "'Fira Code', 'Iosevka', Consolas, monospace",
    );
  });

  it('strips quotes the user typed rather than doubling them', () => {
    expect(fontStack('"Fira Code"', fallback)).toBe("'Fira Code', Consolas, monospace");
  });

  /**
   * Degrading to the fallback, not blocking an attack: CSS variable
   * substitution cannot introduce a declaration, because a `;` in the value
   * invalidates the declaration doing the substituting. What this buys is that
   * a malformed value loses the font rather than the whole app's typography.
   */
  it.each([[''], ['   '], ['}; body { display: none }'], ['url(evil)']])(
    'falls back for %s',
    (requested) => {
      expect(fontStack(requested, fallback)).toBe(fallback);
    },
  );

  /**
   * A missing family would throw on `.split`, inside bootstrap, before
   * `ShowWindow` -- a permanently invisible window. This codebase has had that
   * failure once already, from a different cause.
   */
  it.each([
    [undefined as unknown as string],
    [null as unknown as string],
    [14 as unknown as string],
  ])('falls back rather than throwing for %s', (requested) => {
    expect(fontStack(requested, fallback)).toBe(fallback);
  });

  it('keeps the good names from a partly bad list', () => {
    expect(fontStack('Fira Code, url(evil)', fallback)).toBe("'Fira Code', Consolas, monospace");
  });
});
