/**
 * Markdown to sanitised HTML. Pure: no store, no editor, no app state — which
 * is what lets its tests run without either. It does need a `window` for
 * DOMPurify, so its test file opts into jsdom.
 *
 * Returns the sanitised HTML and nothing else. It used to hand back a
 * source-line index too -- see the note above `RenderContext` for why that went.
 */
import MarkdownIt from 'markdown-it';
import type { Env } from 'markdown-it';
import markdownItMark from 'markdown-it-mark';
import markdownItFootnote from 'markdown-it-footnote';
import DOMPurify, { type Config } from 'dompurify';
import { highlightCode } from './codehighlight';
import { frontMatterPlugin } from './rules/frontmatter';
import { imagePlugin } from './rules/images';
import { sourceLinePlugin, type SourceLineEnv } from './rules/sourceline';
import { taskListPlugin } from './rules/tasklist';

export interface RenderContext {
  /** Absolute directory of the active document, or null when it is unsaved. */
  documentDir: string | null;
}

/**
 * This used to return `{ html, anchors }`, where `anchors` was the list of
 * source lines present in the output, derived from the sanitised HTML by an
 * `anchorsIn` helper. It was built for scroll sync, and scroll sync ended up not
 * wanting it: `preview/pane.ts` needs an *offset* per line, so it walks the live
 * DOM for `[data-source-line]` and measures as it goes. The list of lines falls
 * out of that walk for free.
 *
 * Keeping both meant a second `DOMParser` pass over the whole output on every
 * render -- on the typing path, and measured as roughly a third of the
 * highlighted-fence cost recorded in `codehighlight.ts` -- producing a list
 * nothing read. The invariant it existed to guarantee ("every line in the list
 * has an element behind it") is now true by construction, because the walk only
 * ever sees elements that survived sanitisation.
 */

/**
 * `html: true` is deliberate and is what SPEC §6.7 asks for — raw HTML is
 * permitted in the document. It is safe only because every byte of output goes
 * through DOMPurify below; the two settings are a pair and must not be
 * separated.
 *
 * `linkify` is **on**, which SPEC §6.8 asks for and which GitHub does. It was
 * off through Checkpoint F on the argument that a bare `example.com` becoming an
 * anchor the author did not write would read as a discrepancy against the source
 * pane. Owner's call, 2026-08-17: that is true of every markdown feature, and a
 * pasted URL not being a link is the more surprising outcome.
 *
 * Sequenced deliberately after `preview/pane.ts` grew a click handler. Until it
 * did, clicking any link navigated the webview off the app -- and linkify's whole
 * job is to create more links.
 */
// No `: MarkdownIt` annotation: @types/markdown-it's default export is typed
// as the *constructor* (`MarkdownItConstructor`), so the bare name isn't a
// usable type through a default import here ("refers to a value"). Inferring
// from `new MarkdownIt(...)` gets the instance type without fighting that.
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  /**
   * Returning `''` tells markdown-it to escape and wrap the code itself,
   * which is exactly the right fallback for a grammar that has not loaded --
   * markdown-it@15's fence renderer does `highlight(...) || escapeHtml(content)`.
   * A non-empty return is inserted raw inside `<pre><code>`, so it must
   * already be escaped; `highlightCode` does that.
   *
   * An infoless fence arrives here with `lang === ''`, which `highlightCode`
   * already answers with `null`; there is no guard for it because a guard
   * would be a second, untested opinion about the same case.
   */
  highlight: (code, lang) => highlightCode(code, lang) ?? '',
})
  .use(markdownItMark)
  .use(markdownItFootnote)
  // Order matters: front matter is a *block* rule and must claim line 0 before
  // anything else looks at it; source lines is a *core* rule pushed last so it
  // sees the final token stream, task list included.
  .use(frontMatterPlugin)
  .use(taskListPlugin)
  .use(imagePlugin)
  .use(sourceLinePlugin);

// Not `as const`: DOMPurify's `Config.FORBID_TAGS`/`FORBID_ATTR` are typed as
// mutable `string[]`, which a `readonly [...]` tuple doesn't satisfy.
const PURIFY_CONFIG: Config = {
  ALLOW_DATA_ATTR: true,
  FORBID_TAGS: ['style'],
  FORBID_ATTR: ['style'],
};

/**
 * Our own DOMPurify instance, not the imported singleton.
 *
 * The hook below is registered at module scope, and on the singleton it would
 * change the behaviour of every `DOMPurify.sanitize` call in the process --
 * including from code that never imported this file. Task 6 loads this module
 * lazily, on the first Ctrl+Shift+P, so that would mean app-wide sanitiser
 * behaviour changing at an arbitrary moment during a session. An instance
 * keeps the hook where it belongs; verified that the global is unaffected.
 */
const purifier = DOMPurify(window);

/**
 * `<!-- … -->` is this project's annotation mechanism (SPEC §6.8): visible in
 * the editor, absent from the preview.
 *
 * The brief named this hook `uponSanitizeNode`. There is no such entry point
 * in dompurify@3.4.13 -- `_createHooksMap` lists nine and that is not among
 * them, and `addHook` returns silently for an unrecognised name. It also does
 * not typecheck (TS2769), so the mistake would have been caught either way.
 * `uponSanitizeElement` is misleadingly named but fires for every visited
 * node, comments included; `nodeType === 8` is COMMENT_NODE.
 *
 * With the *current* config the hook is not what removes comments: DOMPurify's
 * default ALLOWED_TAGS has no `#comment`, so they are dropped by the allowlist
 * before the hook matters, and removing the hook fails no test of ordinary
 * rendering. It stays because SPEC §6.8 is a product requirement rather than a
 * side effect of a library default, and the moment `ALLOWED_TAGS` is
 * overridden -- which any future config change could do -- the default stops
 * applying and only this hook holds. `render.test.ts` pins exactly that
 * configuration, so the hook is falsifiable rather than decorative.
 */
purifier.addHook('uponSanitizeElement', (currentNode) => {
  if (currentNode.nodeType === 8) currentNode.parentNode?.removeChild(currentNode);
});

/**
 * Note what sanitisation deliberately does *not* do: a remote `<img>`, `<a>`
 * or `<form>` survives it untouched. Nothing here blocks the network -- that
 * is `index.html`'s CSP (`img-src` without `https:`, `form-action 'none'`)
 * and, for images specifically, the placeholder rule in `rules/images.ts`.
 * Do not read a passing sanitiser test as evidence of the zero-network
 * constraint; they are separate mechanisms with separate tests.
 */
export function renderMarkdown(text: string, ctx: RenderContext): string {
  // `env` is markdown-it's per-render channel. Passing the context through it
  // rather than rebuilding `md` keeps the parser instance stateless and
  // reusable across documents.
  //
  // Typed `Env & RenderContext & SourceLineEnv`, not just the latter two:
  // markdown-it@15's own `Env` type (unlike @types/markdown-it@14's `any`)
  // declares an index signature, and a value typed only `RenderContext &
  // SourceLineEnv` doesn't structurally satisfy that when passed through a
  // variable rather than as a fresh object literal. The intersection keeps
  // `md.render`'s argument well-typed without a cast.
  const env: Env & RenderContext & SourceLineEnv = { ...ctx };
  const rendered = md.render(text, env);
  return purifier.sanitize(rendered, PURIFY_CONFIG);
}

/** Test-only: the instance the hook is registered on. */
export const purifierForTests = purifier;
