// @vitest-environment jsdom
/**
 * The editor's half of `settings.editor.maxContentWidth` (SPEC §6.13).
 *
 * The preview's half is a stylesheet and is checked in `styles/layout.test.ts`;
 * this half lives in a CodeMirror theme object, which that file cannot parse.
 *
 * **This reads the CSS the theme emits, not `getComputedStyle`.** The first
 * version did the latter, and it could not fail: re-adding `margin-inline: auto`
 * -- the exact regression it existed to catch -- left it green, because jsdom
 * does not implement the `margin-inline` shorthand and reported `margin-left`
 * as `0px` either way. Found by mutation testing.
 *
 * `@codemirror/view` injects the theme through StyleModule as a real `<style>`,
 * with a generated scope class (`.ͼ5`), so the rule is matched on the
 * `.cm-content` suffix rather than on a whole selector.
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { hashpadTheme } from './theme';

/** The declarations the theme emits for `.cm-content`. */
function contentRule(): string {
  const view = new EditorView({
    state: EditorState.create({ doc: 'hello', extensions: [hashpadTheme] }),
    parent: document.body,
  });
  const css = [...document.head.querySelectorAll('style')]
    .map((style) => style.textContent ?? '')
    .join('\n');
  view.destroy();

  // **Ours, not CodeMirror's.** The base theme emits its own `.cm-content` rule
  // (`margin: 0; flex-grow: 2; ...`) and it comes first, so taking the first
  // match tested the package's CSS instead of this file's -- which passed the
  // centring assertion for a reason that had nothing to do with our theme.
  // `--pad-editor` is a token only this theme uses, so it identifies the rule.
  const rules = [...css.matchAll(/\.cm-content \{([^}]*)\}/g)]
    .map((match) => match[1]!)
    .filter((declarations) => declarations.includes('var(--pad-editor)'));

  expect(rules, 'the theme should emit exactly one .cm-content rule').toHaveLength(1);
  return rules[0]!;
}

describe('the editor content column', () => {
  it('is capped by the content-width token', () => {
    expect(contentRule()).toMatch(/max-width:\s*var\(--max-content-width\)/);
  });

  /**
   * **The bug this exists for.** The first version centred the capped column,
   * and the owner reported the editor's text starting a third of the way across
   * the window -- at the default 900px cap on a maximised display that is a gap
   * of about 500px. It also contradicted SPEC §6.1's "roughly 24px horizontal"
   * padding, which is what the text should actually be inset by.
   *
   * A maximum is a maximum: it bounds how far a line runs, it does not move
   * where the line starts.
   *
   * Matched against *any* auto margin rather than one property, so the next
   * person reaching for `margin: 0 auto` or `margin-left: auto` trips it too.
   */
  it('starts at the left rather than being centred', () => {
    expect(contentRule()).not.toMatch(/margin[a-z-]*:[^;]*auto/);
  });
});
