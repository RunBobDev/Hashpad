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
 *
 * **Raw HTML `<img>` bypasses all of this.** `html: true` is on (SPEC §6.7),
 * so `<img src="https://x/p.png">` in a document renders as a live element
 * with no placeholder, and `<img src="assets/p.png">` is not rewritten and so
 * 404s. Zero-network still holds -- the CSP owns that, not this file -- but
 * the policy below only governs markdown image syntax. Rewriting raw HTML
 * would mean parsing it here, ahead of DOMPurify, which is a worse trade.
 */
// See sourceline.ts for why this imports `MarkdownIt` as a named type from
// the package root rather than the default export.
import type { MarkdownIt } from 'markdown-it';
import type { RenderContext } from '../render';

/** Task 4's Go handler serves exactly this path. */
export const ASSET_ROUTE = '/__hashpad/asset';

/**
 * Anything with a URL scheme we will not resolve locally.
 *
 * **Two or more characters before the colon**, deliberately. RFC 3986 allows a
 * one-character scheme, but no real one exists and `C:/docs/pic.png` is a
 * Windows absolute path, not a URL -- matching it here reported "Remote image
 * not loaded" for a local file. With this it falls through to the local
 * branch, the Go handler rejects it as absolute, and the user gets a broken
 * image rather than a wrong explanation.
 */
const REMOTE = /^[a-z][a-z0-9+.-]+:/i;

/**
 * `alt` is the author's description and is the one thing worth keeping when
 * the image itself cannot be shown -- so it becomes the accessible name, and
 * the generic string is only the fallback. A screen reader announcing "Remote
 * image not loaded" tells the user nothing about what they are missing.
 */
function placeholder(md: MarkdownIt, alt: string, text: string, detail: string): string {
  const label = alt.trim() === '' ? text : `${alt} -- ${text}`;
  return (
    `<span class="preview-image-placeholder" role="img" aria-label="${md.utils.escapeHtml(label)}">` +
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
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    if (altIndex >= 0) {
      token.attrs![altIndex]![1] = alt;
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
      return placeholder(md, alt, 'Remote image not loaded', src);
    }

    if (ctx.documentDir === null) {
      return placeholder(
        md,
        alt,
        'Local image unavailable',
        'save the document to load local images',
      );
    }

    // `normalizeLinkText` first, and this is not optional: markdown-it's
    // `normalizeLink` has *already* percent-encoded the src by the time we see
    // it (`mdurl.encode` at the end of it), so encoding again escapes the `%`
    // itself. `assets/café.png` reached the handler as `assets/caf%C3%A9.png`
    // and 404'd -- every image in a document with a non-ASCII or spaced
    // filename. Decoding back to the raw path and encoding once is what makes
    // Go's `r.URL.Query().Get("path")` yield the name that is actually on
    // disk. Round-trip verified for accents, spaces and backslashes.
    // The directory travels in the URL beside the path. It used to live in a
    // field the frontend set over IPC before each render, which raced: on a tab
    // switch the new <img> is in the DOM the moment that call is *dispatched*,
    // so the GET could resolve against the outgoing document's folder. It also
    // meant two documents in different folders produced byte-identical URLs for
    // the same filename, so the webview cache could serve one document's image
    // to the other; distinct URLs fix that as a side effect.
    //
    // Both values go through `encodeURIComponent` separately, which escapes `&`
    // and `=`. That is what keeps a hostile `src` from smuggling in its own
    // `dir` -- see rules.test.ts, and the Go half in assets_test.go.
    const raw = md.normalizeLinkText(src);
    const query = `dir=${encodeURIComponent(ctx.documentDir)}&path=${encodeURIComponent(raw)}`;
    token.attrSet('src', `${ASSET_ROUTE}?${query}`);
    return self.renderToken(tokens, index, options);
  };
}
