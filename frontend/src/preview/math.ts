/**
 * KaTeX, loaded on demand and applied *after* sanitisation (SPEC §7.2).
 *
 * **Why after.** `render.ts`'s sanitiser forbids the `style` attribute, and
 * KaTeX's output is inline-`style` dependent -- struts, vlists and
 * vertical-align all carry their geometry there. Under that config math renders
 * as garbage rather than as an error, which is the kind of failure that looks
 * like a KaTeX bug for an afternoon.
 *
 * Three ways round that were weighed (design §4.29). Relaxing `FORBID_ATTR`
 * globally would let a document's own raw `<div style="position:fixed…">` cover
 * the pane. Allowing `style` only under `.katex` is forgeable, because a
 * document can write that class itself. So the sanitiser is left exactly as it
 * is, and the generated output never passes through it: `rules/math.ts` emits a
 * placeholder holding the expression as text, and this file replaces the
 * placeholder's contents once the pane's HTML is in the DOM.
 *
 * **That moves a trust boundary, so it is worth being precise about which
 * one.** DOMPurify is there to distrust the *document's HTML*. What goes in
 * here is not the document's HTML -- it is KaTeX's rendering of the document's
 * *text*, and KaTeX escapes its own input. The two options that matter are
 * asserted in `math.test.ts` rather than assumed: `trust: false` (no `\href`)
 * and `strict` left at its default (no `\htmlClass`). Both happen to be
 * KaTeX 0.18's defaults; they are passed and tested anyway, because a default
 * is not a promise.
 *
 * **Asynchronous work behind a synchronous interface**, the same shape
 * `codehighlight.ts` uses and for the same reason: the module arrives by
 * dynamic `import()`, so the first pass over a document with math renders
 * nothing, starts the load, and tells subscribers when it settles. The pane
 * re-renders and the math appears. One flash per session, and until then the
 * LaTeX source is on screen -- which is a better fallback than a blank.
 */
import { MATH_DISPLAY_CLASS, MATH_INLINE_CLASS } from './rules/math';

/**
 * KaTeX's stylesheet, which is not optional -- the class names its output
 * carries mean nothing without it.
 *
 * **Imported here rather than lazily, because `vite.config.ts` sets
 * `cssCodeSplit: false`** and every stylesheet in the build ends up in one
 * file regardless of where it is imported. So this is 24 kB in the entry
 * stylesheet for every document, math or not. The fonts stay lazy on their own:
 * a browser fetches a `@font-face` file only when a rule using it matches
 * something, and nothing matches until math is on screen.
 */
import 'katex/dist/katex.min.css';

type Katex = typeof import('katex').default;

let katex: Katex | null = null;
/** So a second pass before the first load settles does not start it again. */
let requested = false;
const listeners = new Set<() => void>();

/** Told when KaTeX arrives, so the pane can render again with math this time. */
export function onMathLoaded(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function load(): void {
  if (requested) return;
  requested = true;
  void import('katex').then(
    (module) => {
      katex = module.default;
      for (const listener of listeners) listener();
    },
    () => {
      // A chunk that fails to arrive must not land in the webview console as an
      // unhandled rejection, and must not pin math as "requested" for the rest
      // of the session. Deliberately no notification: telling listeners would
      // re-render, and a re-render is what retries, which is a loop. The next
      // edit tries again.
      requested = false;
    },
  );
}

/**
 * Marks a placeholder as done, so a second pass over the same DOM is a no-op.
 *
 * Needed because `katex.render` *replaces* the element's children, and the
 * element's children are where the expression lives -- a second pass would hand
 * KaTeX its own output as LaTeX. The pane rebuilds its HTML wholesale on every
 * render so this should not arise, but "should not arise" is a property of a
 * caller, and this is one class name.
 */
const DONE = 'preview-math-done';

const SELECTOR = `.${MATH_INLINE_CLASS}:not(.${DONE}), .${MATH_DISPLAY_CLASS}:not(.${DONE})`;

/**
 * Typesets every math placeholder under `root`, if KaTeX is here; starts
 * loading it if not.
 *
 * Takes a root rather than reaching for the pane itself, so it is testable
 * against a detached element and so the pane keeps ownership of its own DOM.
 */
export function renderMathIn(root: ParentNode): void {
  const nodes = root.querySelectorAll<HTMLElement>(SELECTOR);
  // The common case: no math in the document, nothing loaded, nothing to pay.
  if (nodes.length === 0) return;

  if (katex === null) {
    load();
    return;
  }

  for (const node of nodes) {
    // Read before rendering: `katex.render` replaces these children.
    const expression = node.textContent ?? '';
    node.classList.add(DONE);
    katex.render(expression, node, {
      // `$$…$$` centres on its own line; `$…$` sits in the sentence.
      displayMode: node.classList.contains(MATH_DISPLAY_CLASS),
      // **Load-bearing, and the default is the other way.** Without this a
      // missing brace throws, and `pane.ts` catches renderer exceptions by
      // replacing the *whole pane* with an error card -- a wildly
      // disproportionate response to a typo you are halfway through. With it,
      // KaTeX renders the offending source in red and the document around it
      // keeps working.
      throwOnError: false,
      // The security half of the post-sanitise decision above. `\href` and
      // friends stay inert, so nothing KaTeX emits can be a link or carry a
      // class the document chose.
      trust: false,
    });
  }
}
