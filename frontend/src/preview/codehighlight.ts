/**
 * Syntax highlighting for preview code blocks, from the parsers the editor
 * already carries. No highlight.js, no Shiki (design §6.3): both are heavy,
 * and either would give the app a second opinion about what colour a keyword
 * is. Bridging to Lezer means editor and preview agree by construction.
 *
 * "Agree" is about the *palette*, not about which fences highlight at all.
 * Those two already diverge, upstream of this file: markdown-it hands the
 * `highlight` hook only the first word of the info string, while
 * `@lezer/markdown` hands the editor the whole thing. So ` ```js {1,3} `
 * colours here and not in the editor (measured). The preview is the more
 * correct of the two; noted rather than fixed, because the fix belongs in the
 * editor's info-string handling, not here.
 *
 * **This is asynchronous work behind a synchronous interface.** markdown-it's
 * `highlight` hook must return a string immediately, but
 * `@codemirror/language-data` loads grammars by dynamic import. So
 * `highlightCode` returns `null` on a miss -- the caller renders plain escaped
 * code -- and starts the load in the background. When it settles, subscribers
 * are told and the pane re-renders. The visible consequence is that a code
 * block flashes unhighlighted once per language per session. That is a
 * behaviour, not a defect.
 *
 * Like `render.ts`, this needs a DOM at import time (the mount below), so its
 * test file opts into jsdom.
 */
import { LanguageDescription } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { StyleModule } from 'style-mod';
import { codeHighlightStyle } from '../editor/codetheme';
import { MARKDOWN_CODE_LANGUAGES } from '../editor/languages';

const listeners = new Set<() => void>();
/** Languages whose load has been started, so a miss does not start it twice. */
const requested = new Set<string>();

/**
 * The generated class names only mean anything if their stylesheet is in the
 * document. The editor mounts it when it constructs, and in the running app
 * that always happens first -- but relying on that ordering is the kind of
 * implicit coupling that breaks silently. style-mod adds a module's rules to a
 * root at most once ("Rules are only added to the document once per root"), so
 * doing it here as well is idempotent and makes the preview independent of
 * construction order.
 *
 * `module` is `StyleModule | null` because a `HighlightStyle` built with no
 * rules has nothing to mount; ours has rules, so the branch is only here to
 * satisfy that type.
 */
if (codeHighlightStyle.module) StyleModule.mount(document, codeHighlightStyle.module);

export function onLanguageLoaded(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Highlighted inner HTML for a fenced block, or `null` when the grammar for
 * `lang` is not available yet — in which case a load is started if this is the
 * first ask.
 */
export function highlightCode(code: string, lang: string): string | null {
  const description = LanguageDescription.matchLanguageName(MARKDOWN_CODE_LANGUAGES, lang, true);
  if (!description) return null;

  if (!description.support) {
    if (!requested.has(description.name)) {
      requested.add(description.name);
      void description.load().then(
        () => {
          for (const listener of listeners) listener();
        },
        // A grammar chunk that fails to arrive must not land in the webview
        // console as an unhandled rejection, and must not pin the language as
        // "requested" for the rest of the session. `LanguageDescription.load`
        // clears its own cached promise on failure, so dropping the name here
        // is enough for the next render to try again. Deliberately no
        // notification and no backoff: a failure that told listeners would
        // re-render, and a re-render is what retries, which is a loop.
        () => requested.delete(description.name),
      );
    }
    return null;
  }

  // The whole fence is re-parsed on every render, with no memo. Measured
  // ceiling, under jsdom, on a 500-line JavaScript fence: `highlightCode`
  // itself is ~9 ms, but the ~1,500 extra spans grow the HTML 5.8x and that
  // HTML is parsed twice more downstream -- once by DOMPurify, once by
  // `anchorsIn` -- taking `renderMarkdown` from ~13 ms to ~133 ms. jsdom's DOM
  // is far slower than WebView2's so the absolute numbers will fall a lot; the
  // 5.8x growth and the double parse will not. Task 6 re-renders on document
  // change, which puts this on the typing path. Left uncached deliberately:
  // measure it in the real webview first, and if it needs fixing, debouncing
  // the pane is a better fix than caching trees here.
  const tree = description.support.language.parser.parse(code);
  let html = '';
  let position = 0;

  highlightTree(tree, codeHighlightStyle, (from, to, classes) => {
    if (from > position) html += escapeHtml(code.slice(position, from));
    html += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`;
    position = to;
  });
  if (position < code.length) html += escapeHtml(code.slice(position));

  return html;
}
