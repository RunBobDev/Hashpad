/**
 * ` ```mermaid ` fences become diagram placeholders (SPEC §7.2).
 *
 * The parser's half only, exactly as `rules/math.ts` is: this marks the fence
 * and holds its source; `preview/diagrams.ts` turns the mark into an SVG. The
 * placeholder is what survives sanitisation, for the reason design §4.29 gives
 * -- Mermaid's SVG carries a `<style>` element and inline styles, both of which
 * `render.ts`'s config strips.
 *
 * **This wraps the existing fence renderer rather than replacing it.**
 * `render.ts` configures markdown-it's `highlight` hook, which the *default*
 * fence renderer calls; replacing the rule outright would silently turn off
 * syntax highlighting for every other language. So the previous renderer is
 * captured and everything that is not a mermaid fence is handed straight back
 * to it.
 */
// See sourceline.ts for why this imports `MarkdownIt` as a named type from the
// package root rather than a `markdown-it/lib/...` subpath.
import type { MarkdownIt } from 'markdown-it';
import { sourceLineAttr } from './sourceline';

/** The class `preview/diagrams.ts` looks for, shared so the two cannot drift. */
export const DIAGRAM_CLASS = 'preview-mermaid';

/**
 * The info string that makes a fence a diagram.
 *
 * Only the first word, because that is all markdown-it hands the `highlight`
 * hook and matching more here would make the two disagree about the same fence
 * (`codehighlight.ts` records that divergence). ` ```mermaid ` and
 * ` ```mermaid something ` both count.
 */
function isMermaid(info: string): boolean {
  return info.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid';
}

export function mermaidPlugin(md: MarkdownIt): void {
  const previous =
    md.renderer.rules.fence ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index]!;
    if (!isMermaid(token.info)) return previous(tokens, index, options, env, self);

    // The source goes in as *text*, which markdown-it escapes -- so a label
    // containing `<` cannot become a tag, and `preview/diagrams.ts` reads the
    // original back with `textContent`. The same arrangement math uses, and for
    // the same reason.
    //
    // `sourceLineAttr` rather than a hand-rolled copy: a rule that writes its
    // own HTML string bypasses the attribute rendering markdown-it would
    // otherwise do, and without the anchor a document's diagrams are holes in
    // the scroll-sync map. `rules/math.ts` made exactly that mistake, which is
    // why the helper now lives in the file that owns the attribute.
    return (
      `<div class="${DIAGRAM_CLASS}"${sourceLineAttr(md, token)}>` +
      `${md.utils.escapeHtml(token.content)}</div>\n`
    );
  };
}
