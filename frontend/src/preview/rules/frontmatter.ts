/**
 * YAML front matter as a muted metadata card, not hidden (design §2.2).
 *
 * Hiding it would make scroll sync lie: the lines exist in the editor, so the
 * preview has to account for them. Parsed by splitting on the first colon
 * rather than with `js-yaml` (~60 KB, design §6.3) — that covers title, date,
 * tags and author, which is essentially all real front matter. A line that
 * does not split is shown raw rather than dropped, so nothing disappears
 * silently.
 */
// See sourceline.ts for why this imports `MarkdownIt`/`StateBlock` as named
// types from the package root rather than a `markdown-it/lib/...` subpath.
import type { MarkdownIt, StateBlock } from 'markdown-it';

const FENCE = '---';

export function frontMatterPlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    'table',
    'hashpad_front_matter',
    (state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean => {
      // Only at the very top of the document. Anywhere else `---` is a
      // horizontal rule or a setext underline, and stealing it would change
      // what existing documents mean.
      if (startLine !== 0) return false;

      const open = state.getLines(startLine, startLine + 1, 0, false).trim();
      if (open !== FENCE) return false;

      let closeLine = -1;
      for (let line = startLine + 1; line < endLine; line++) {
        if (state.getLines(line, line + 1, 0, false).trim() === FENCE) {
          closeLine = line;
          break;
        }
      }
      if (closeLine === -1) return false;
      if (silent) return true;

      const token = state.push('hashpad_front_matter', '', 0);
      token.content = state.getLines(startLine + 1, closeLine, 0, false);
      token.map = [startLine, closeLine + 1];
      token.block = true;
      state.line = closeLine + 1;
      return true;
    },
    { alt: [] },
  );

  md.renderer.rules['hashpad_front_matter'] = (tokens, index) => {
    const token = tokens[index]!;
    // `attrGet` returns `string | number | null` in markdown-it@15 (widened
    // from @types/markdown-it@14's `string | null` to match `attrSet`, which
    // now also accepts numbers) -- irrelevant to the template literal below,
    // which stringifies either.
    const attrs = token.attrGet('data-source-line');
    const lineAttr = attrs !== null ? ` data-source-line="${attrs}"` : '';

    const rows = token.content
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const colon = line.indexOf(':');
        if (colon === -1) {
          return `<div class="preview-frontmatter__raw">${md.utils.escapeHtml(line.trim())}</div>`;
        }
        const key = md.utils.escapeHtml(line.slice(0, colon).trim());
        const value = md.utils.escapeHtml(line.slice(colon + 1).trim());
        return `<dt>${key}</dt><dd>${value}</dd>`;
      })
      .join('');

    return `<dl class="preview-frontmatter"${lineAttr}>${rows}</dl>`;
  };
}
