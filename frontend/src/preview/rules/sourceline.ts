/**
 * Stamps `data-source-line` onto every block-level element, so scroll sync can
 * map an editor line to a rendered position instead of guessing from a pixel
 * fraction (design §2.1, deviation §4.17).
 *
 * markdown-it gives block tokens a `map: [startLine, endLine]` that is
 * **0-based**; CodeMirror and the rest of this codebase are 1-based, so every
 * value written here is `map[0] + 1`. Getting that wrong is a silent one-line
 * drift, which is exactly the kind of thing that looks like "sync is a bit
 * off" rather than a bug.
 */
// Named-import `MarkdownIt`/`StateCore`, not a default import or the deep
// `markdown-it/lib/rules_core/state_core` path the original brief used: the
// installed markdown-it@15.0.0 bundles its own generated declarations (see
// its package.json `exports["."].types`) rather than deferring to
// @types/markdown-it@14.1.2, which is still present but no longer consulted
// for anything reachable from `import ... from 'markdown-it'`. The new
// declarations export `MarkdownIt` and `StateCore` as ordinary named types
// from the package root, and the `lib/` subpath the brief relied on no longer
// exists at runtime -- markdown-it@15's package.json `exports` field only
// publishes `.`, `./browser` and `./package.json`, so that deep import fails
// to resolve (TS2307) even though @types/markdown-it still ships a
// declaration file at that path.
import type { MarkdownIt, StateCore, Token } from 'markdown-it';

/** Collected during rendering; read back through the env. */
export interface SourceLineEnv {
  anchors?: number[];
}

/**
 * The `data-source-line` attribute for a token, as an HTML fragment, or `''`.
 *
 * **For rules that write their own HTML string**, which is where this keeps
 * going wrong. markdown-it renders a token's attributes for you; a renderer
 * that builds its own markup does that itself, and silently drops everything it
 * does not mention -- turning that block into a hole in the scroll-sync map.
 *
 * Both L's rules hit it. `rules/mermaid.ts` was written with the attribute
 * copied by hand; `rules/math.ts` was not, and its display blocks went
 * unanchored until someone asked whether the checkpoint was actually finished.
 * One helper, in the file that owns the attribute, so the next such rule has
 * something to reach for rather than a precedent to miss.
 *
 * Carries `data-line-number` too, for the same reason: reading view's line
 * numbers are drawn from it, and a block that drops it has no number.
 */
export function sourceLineAttr(md: MarkdownIt, token: Token): string {
  return ['data-source-line', 'data-line-number']
    .map((name) => {
      const value = token.attrGet(name);
      return value === null ? '' : ` ${name}="${md.utils.escapeHtml(String(value))}"`;
    })
    .join('');
}

/**
 * The parts of a table that must not carry a line number. Drawn from a row, the
 * number becomes a table cell of its own and pushes the row sideways; drawn
 * from the table, it lands on top of the first body row's. Their number goes to
 * the next cell instead.
 */
const TABLE_STRUCTURE = new Set(['table_open', 'thead_open', 'tbody_open', 'tr_open']);

export function sourceLinePlugin(md: MarkdownIt): void {
  md.core.ruler.push('hashpad_source_line', (state: StateCore) => {
    const seen = new Set<number>();
    // A table part's line number, waiting for the cell that will show it.
    let pending: number | null = null;
    for (const token of state.tokens) {
      // Cells have no `map` of their own, so this runs before the check below.
      if (pending !== null && (token.type === 'th_open' || token.type === 'td_open')) {
        token.attrSet('data-line-number', String(pending));
        pending = null;
      }
      // `nesting === -1` is a closing tag and carries no attributes worth
      // marking. Opening and self-closing tokens (`fence`, `hr`, `html_block`)
      // both have `nesting >= 0` and both matter.
      if (!token.map || token.nesting === -1) continue;
      const line = token.map[0]! + 1;
      token.attrSet('data-source-line', String(line));
      // **Reading view's line numbers: the first block on each line only.** A
      // list, its first item and that item's paragraph all start on one line,
      // and numbering each would print that number several times over itself.
      // Tokens arrive outermost first, so the one that keeps it is the block
      // whose top is where the line starts.
      if (!seen.has(line)) {
        if (TABLE_STRUCTURE.has(token.type)) pending = line;
        else token.attrSet('data-line-number', String(line));
      }
      seen.add(line);
    }
    const env = state.env as SourceLineEnv;
    env.anchors = [...seen].sort((a, b) => a - b);
  });
}
