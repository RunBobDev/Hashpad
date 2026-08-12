/**
 * Markdown to sanitised HTML. Pure: no store, no editor, no app state — which
 * is what lets its tests run without either. It does need a `window` for
 * DOMPurify, so its test file opts into jsdom.
 *
 * Returns anchors alongside the HTML rather than a bare string: scroll sync
 * (design §2.1) needs a source-line index, and building it during rendering is
 * the only place the mapping is known. Checkpoint G's outline wants the same
 * list.
 */
import MarkdownIt from 'markdown-it';
import type { Env } from 'markdown-it';
import markdownItMark from 'markdown-it-mark';
import markdownItFootnote from 'markdown-it-footnote';
import DOMPurify, { type Config } from 'dompurify';
import { frontMatterPlugin } from './rules/frontmatter';
import { imagePlugin } from './rules/images';
import { sourceLinePlugin, type SourceLineEnv } from './rules/sourceline';
import { taskListPlugin } from './rules/tasklist';

export interface RenderContext {
  /** Absolute directory of the active document, or null when it is unsaved. */
  documentDir: string | null;
}

export interface RenderResult {
  html: string;
  /**
   * The 1-based source lines present in the output, ascending and unique.
   * Task 3's source-line rule fills this; until then it is empty.
   */
  anchors: number[];
}

/**
 * `html: true` is deliberate and is what SPEC §6.7 asks for — raw HTML is
 * permitted in the document. It is safe only because every byte of output goes
 * through DOMPurify below; the two settings are a pair and must not be
 * separated.
 *
 * `linkify` stays **off**. It would turn a bare `example.com` in prose into an
 * anchor the author did not write, and this editor shows the source beside the
 * render, so the discrepancy would be visible and confusing.
 */
// No `: MarkdownIt` annotation: @types/markdown-it's default export is typed
// as the *constructor* (`MarkdownItConstructor`), so the bare name isn't a
// usable type through a default import here ("refers to a value"). Inferring
// from `new MarkdownIt(...)` gets the instance type without fighting that.
const md = new MarkdownIt({ html: true, linkify: false, typographer: false })
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
export function renderMarkdown(text: string, ctx: RenderContext): RenderResult {
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
  const html = purifier.sanitize(rendered, PURIFY_CONFIG);
  return { html, anchors: anchorsIn(html) };
}

/**
 * The source lines that actually made it into the output, read back out of the
 * sanitised HTML rather than taken from what the source-line rule stamped.
 *
 * Those two are not the same list, which is the point. The rule marks tokens;
 * three things then drop marks before the HTML is final:
 *
 * - an HTML comment is removed entirely -- and comments are SPEC §6.8's
 *   annotation mechanism, a shipped feature, so this is routine, not an edge
 *   case
 * - markdown-it's `html_block` renderer emits `token.content` verbatim and
 *   silently discards the attribute the rule set on it
 * - DOMPurify strips `<style>`/`<script>` blocks outright
 *
 * `RenderResult.anchors` is documented as "the source lines present in the
 * output", and Task 6 looks each one up with
 * `querySelector('[data-source-line="N"]')`. A line in the list with no
 * element behind it is a `null` at exactly the moment scroll sync needs a
 * position. Deriving the list from the finished HTML makes the invariant true
 * by construction instead of by two code paths agreeing.
 */
function anchorsIn(html: string): number[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const lines = new Set<number>();
  for (const element of parsed.querySelectorAll('[data-source-line]')) {
    const line = Number(element.getAttribute('data-source-line'));
    if (Number.isInteger(line) && line > 0) lines.add(line);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Test-only: the instance the hook is registered on. */
export const purifierForTests = purifier;
