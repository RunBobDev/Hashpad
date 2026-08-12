import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The palette is only worth having if it is legible, and "legible" is a number.
 * This parses variables.css rather than importing a JS copy of the values,
 * because the CSS file is what ships -- a JS mirror could drift from it and
 * this test would happily verify the mirror.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../styles/variables.css', import.meta.url)),
  'utf8',
);

const TOKENS = [
  'keyword',
  'string',
  'literal',
  'comment',
  'function',
  'type',
  'variable',
  'invalid',
] as const;

/** sRGB hex to WCAG relative luminance. */
function luminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const n = parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The value of `--name` inside the light `:root` block or the dark block. */
function tokenValue(name: string, theme: 'light' | 'dark'): string {
  const start = theme === 'light' ? CSS.indexOf(':root') : CSS.indexOf("[data-theme='dark']");
  expect(start, `no ${theme} block in variables.css`).toBeGreaterThan(-1);
  const block = CSS.slice(
    start,
    theme === 'light' ? CSS.indexOf("[data-theme='dark']") : undefined,
  );
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  expect(match, `--${name} not found in the ${theme} block, or not a 6-digit hex`).not.toBeNull();
  return match![1]!;
}

describe('the fenced-code palette clears WCAG AA in both themes', () => {
  it.each(['light', 'dark'] as const)('%s', (theme) => {
    const background = tokenValue('bg-editor', theme);
    const failures: string[] = [];
    for (const token of TOKENS) {
      const value = tokenValue(`syn-code-${token}`, theme);
      const ratio = contrast(value, background);
      if (ratio < 4.5) {
        failures.push(`--syn-code-${token} ${value} on ${background} = ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('defines every token in both themes', () => {
    for (const token of TOKENS) {
      expect(tokenValue(`syn-code-${token}`, 'light')).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tokenValue(`syn-code-${token}`, 'dark')).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
