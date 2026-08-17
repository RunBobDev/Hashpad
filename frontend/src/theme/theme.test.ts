import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidAccent, resolveIsDark } from './theme';
import { ACCENT_PRESETS } from './accents';

describe('resolveIsDark', () => {
  it('follows the system when the mode is system', () => {
    expect(resolveIsDark('system', true)).toBe(true);
    expect(resolveIsDark('system', false)).toBe(false);
  });

  // SPEC §6.12: follow-system silently falls back to the manual setting when
  // the system preference cannot be determined.
  it('falls back to light when the system is undeterminable', () => {
    expect(resolveIsDark('system', null)).toBe(false);
  });

  it('ignores the system when the mode is explicit', () => {
    expect(resolveIsDark('dark', false)).toBe(true);
    expect(resolveIsDark('light', true)).toBe(false);
  });
});

describe('isValidAccent', () => {
  it.each(['#0078d4', '#FFF', '#abcdef'])('accepts %s', (color) => {
    expect(isValidAccent(color)).toBe(true);
  });

  // The value goes straight into a CSS custom property. Anything that is not a
  // hex colour could carry arbitrary CSS -- `red; --bg-app: red` would repaint
  // the whole app from a settings file.
  it.each(['red', 'rgb(0,0,0)', '#12345', 'javascript:alert(1)', '#0078d4; --bg-app: red', ''])(
    'rejects %s',
    (color) => {
      expect(isValidAccent(color)).toBe(false);
    },
  );
});

describe('ACCENT_PRESETS', () => {
  it('ships between six and eight presets, as SPEC §6.12 asks', () => {
    expect(ACCENT_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(ACCENT_PRESETS.length).toBeLessThanOrEqual(8);
  });

  it('every preset is a valid accent', () => {
    for (const preset of ACCENT_PRESETS) expect(isValidAccent(preset.value)).toBe(true);
  });

  it('every preset has a distinct name and value', () => {
    expect(new Set(ACCENT_PRESETS.map((p) => p.name)).size).toBe(ACCENT_PRESETS.length);
    expect(new Set(ACCENT_PRESETS.map((p) => p.value)).size).toBe(ACCENT_PRESETS.length);
  });

  /**
   * `accents.ts` is the one file outside `variables.css` that names colours, and
   * it is deliberate: these are user-selectable *data*, a menu of values, not
   * style declarations. What is not deliberate is that one of them is the same
   * colour as `--accent-base`, written out twice with nothing tying the two
   * together. `accents.ts` marks Blue "current default"; retune `--accent-base`
   * and that label silently becomes a lie, with the picker showing no preset as
   * selected on a fresh install.
   *
   * Pinned rather than deduplicated: `accents.ts` cannot read a CSS custom
   * property without a DOM, and importing one into the other to save a literal
   * would couple a data table to the stylesheet for no gain. This test is the
   * link.
   */
  it("the preset marked default is the same colour as variables.css's --accent-base", () => {
    const css = readFileSync(
      fileURLToPath(new URL('../styles/variables.css', import.meta.url)),
      'utf8',
    );
    const base = /--accent-base:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1];
    expect(base, 'variables.css declares no --accent-base').toBeDefined();
    expect(ACCENT_PRESETS.map((p) => p.value)).toContain(base!.toLowerCase());
  });
});
