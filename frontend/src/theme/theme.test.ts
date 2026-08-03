import { describe, expect, it } from 'vitest';
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
});
