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
import type { MarkdownIt, StateCore } from 'markdown-it';

/** Collected during rendering; read back through the env. */
export interface SourceLineEnv {
  anchors?: number[];
}

export function sourceLinePlugin(md: MarkdownIt): void {
  md.core.ruler.push('hashpad_source_line', (state: StateCore) => {
    const seen = new Set<number>();
    for (const token of state.tokens) {
      // `nesting === -1` is a closing tag and carries no attributes worth
      // marking. Opening and self-closing tokens (`fence`, `hr`, `html_block`)
      // both have `nesting >= 0` and both matter.
      if (!token.map || token.nesting === -1) continue;
      const line = token.map[0]! + 1;
      token.attrSet('data-source-line', String(line));
      seen.add(line);
    }
    const env = state.env as SourceLineEnv;
    env.anchors = [...seen].sort((a, b) => a - b);
  });
}
