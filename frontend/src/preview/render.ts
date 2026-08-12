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
import markdownItMark from 'markdown-it-mark';
import markdownItFootnote from 'markdown-it-footnote';
import DOMPurify, { type Config } from 'dompurify';

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
  .use(markdownItFootnote);

/**
 * `<!-- … -->` is this project's annotation mechanism (SPEC §6.8): visible in
 * the editor, absent from the preview.
 *
 * Checked empirically against the installed dompurify@3.4.13: its default
 * ALLOWED_TAGS already excludes comment nodes, so with this config nothing
 * below is currently load-bearing for comment removal -- disabling it does
 * not surface in a failing test. It stays anyway as an explicit,
 * version-independent guarantee: SPEC §6.8 is a product requirement, not an
 * incidental side effect of DOMPurify's current defaults, and should not go
 * unnoticed if a future DOMPurify upgrade or a config change (e.g. an
 * ALLOWED_TAGS override) ever re-admits comments.
 */
// Not `as const`: DOMPurify's `Config.FORBID_TAGS`/`FORBID_ATTR` are typed as
// mutable `string[]`, which a `readonly [...]` tuple doesn't satisfy.
const PURIFY_CONFIG: Config = {
  ALLOW_DATA_ATTR: true,
  FORBID_TAGS: ['style'],
  FORBID_ATTR: ['style'],
};

// The brief named this hook `uponSanitizeNode`; no such hook exists in
// dompurify@3.4.13 (checked both its .d.ts and dist/purify.cjs.js -- addHook
// silently no-ops on an unrecognised entry point, so that spelling would have
// compiled to a dead call). `uponSanitizeElement` is misleadingly named but
// fires for every visited node, comments included -- DOMPurify's own
// documented pattern for stripping comment nodes. currentNode.nodeType === 8
// is COMMENT_NODE.
DOMPurify.addHook('uponSanitizeElement', (currentNode) => {
  if (currentNode.nodeType === 8) currentNode.parentNode?.removeChild(currentNode);
});

export function renderMarkdown(text: string, ctx: RenderContext): RenderResult {
  void ctx; // Task 3's image rule is the first consumer.
  const rendered = md.render(text);
  const html = DOMPurify.sanitize(rendered, PURIFY_CONFIG);
  return { html, anchors: [] };
}
