/**
 * SPEC §6.12 asks for six to eight accent presets. `--accent` resolves
 * straight to `--accent-base` on the light theme (variables.css), and
 * `--syn-link`/link colour reuse `--accent`, so every preset here is checked
 * against the light theme's white editor background (`--bg-editor: #ffffff`)
 * and must clear WCAG AA for normal text (4.5:1) there. The dark theme is not
 * at risk from these choices: variables.css lightens `--accent-base` toward
 * white for dark mode, which only ever raises contrast on a near-black
 * surface.
 *
 * Ratios below are computed via the standard WCAG relative-luminance formula
 * against #ffffff (L = 1.0): (1.05) / (L_colour + 0.05).
 */
export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: 'Blue', value: '#0078d4' }, // 4.53:1 -- current default (Windows accent blue)
  { name: 'Purple', value: '#8764b8' }, // 4.62:1
  { name: 'Green', value: '#107c10' }, // 5.37:1
  { name: 'Red', value: '#d13438' }, // 4.93:1
  { name: 'Teal', value: '#008272' }, // 4.73:1
  { name: 'Magenta', value: '#c239b3' }, // 4.64:1
  { name: 'Brown', value: '#8e562e' }, // 5.96:1
  { name: 'Crimson', value: '#a4262c' }, // 7.26:1
];
