/**
 * Image sources, and the three answers this app gives.
 *
 * Remote images are **never fetched** (design §3): SPEC §2.1's zero-network
 * constraint wins over SPEC §6.7's opt-in loading, and the CSP's `img-src`
 * omits `https:` permanently, so a bug here cannot cause a request either. The
 * placeholder shows the URL so the document is still readable.
 *
 * Relative paths are rewritten to a route Wails' AssetServer forwards to a Go
 * handler (design §5.7). Requests stay same-origin, so `img-src 'self'` covers
 * them with no CSP relaxation, and there is exactly one place to reject path
 * traversal — Task 4's handler, not here. This module does no security
 * checking and must not start: two half-checks are worse than one whole one.
 */
// See sourceline.ts for why this imports `MarkdownIt` as a named type from
// the package root rather than the default export.
import type { MarkdownIt } from 'markdown-it';
import type { RenderContext } from '../render';

/** Task 4's Go handler serves exactly this path. */
export const ASSET_ROUTE = '/__hashpad/asset';

/** Anything with a scheme we will not resolve locally. */
const REMOTE = /^[a-z][a-z0-9+.-]*:/i;

function placeholder(md: MarkdownIt, text: string, detail: string): string {
  return (
    `<span class="preview-image-placeholder" role="img" aria-label="${md.utils.escapeHtml(text)}">` +
    `${md.utils.escapeHtml(text)}<span class="preview-image-placeholder__detail">` +
    `${md.utils.escapeHtml(detail)}</span></span>`
  );
}

export function imagePlugin(md: MarkdownIt): void {
  md.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index]!;
    // `attrGet` returns `string | number | null` in markdown-it@15 (widened
    // from @types/markdown-it@14's `string | null`); a `src` is always
    // written as a string by the core image rule, but `String(...)` keeps
    // this correct even if that assumption ever changes, and gives a real
    // `string` for the `.startsWith`/regex use below rather than
    // `string | number`.
    const src = String(token.attrGet('src') ?? '');

    // markdown-it's *own* default `image` rule (the one this rule replaces)
    // fills `alt` from the token's children before rendering -- CommonMark
    // requires `alt` to be the link text with markup stripped, not the raw
    // source, and the parser only stores the raw children, not that string.
    // Skipping this step (as the original brief's snippet did) leaves `alt`
    // as the empty-string placeholder the parser initializes it with, on
    // every image this rule touches, including the untouched `data:` case.
    // Verified against markdown-it@15.0.0's `default_rules.image` in
    // dist/markdown-it.mjs, not assumed from the brief.
    const altIndex = token.attrIndex('alt');
    if (altIndex >= 0) {
      token.attrs![altIndex]![1] = self.renderInlineAsText(token.children ?? [], options, env);
    }

    // `env`'s declared type is markdown-it's own `Env | undefined` (an index
    // signature over `unknown`), which doesn't structurally overlap with our
    // `RenderContext` -- hence the double cast. The real shape at runtime is
    // always `RenderContext & SourceLineEnv`, because `renderMarkdown` is the
    // only caller of `md.render` and always passes one.
    const ctx = env as unknown as RenderContext;

    // data: is local by definition and the CSP already allows it.
    if (src.startsWith('data:')) return self.renderToken(tokens, index, options);

    if (REMOTE.test(src)) {
      return placeholder(md, 'Remote image not loaded', src);
    }

    if (ctx.documentDir === null) {
      return placeholder(md, 'Local image unavailable', 'save the document to load local images');
    }

    token.attrSet('src', `${ASSET_ROUTE}?path=${encodeURIComponent(src)}`);
    return self.renderToken(tokens, index, options);
  };
}
