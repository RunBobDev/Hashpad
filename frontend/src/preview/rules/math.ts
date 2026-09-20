/**
 * `$inline$` and `$$block$$` math (SPEC §7.2), as far as the *parser* is
 * concerned. This file finds math and marks it; `preview/math.ts` is what turns
 * a mark into typeset output.
 *
 * **Two rules rather than a dependency.** `markdown-it-texmath` and
 * `markdown-it-katex` both exist, and SPEC §2.5 asks a dependency to say why
 * nothing lighter will do. Nothing lighter is needed: the delimiters are two
 * characters and the difficulty is entirely in the edge cases below, which are
 * the tests either way. `rules/` already holds four hand-written rules for the
 * same reason.
 *
 * **What this emits is a placeholder, not math**, and that is the checkpoint's
 * central decision (design §4.29). KaTeX's output carries its geometry in
 * inline `style` attributes, which `render.ts`'s sanitiser strips -- so math
 * rendered here would arrive in the pane as pretty nonsense. Instead the rule
 * emits an element that survives sanitisation untouched and holds the
 * expression as its own text, and the pane fills it in afterwards.
 *
 * The happy side effect is that the fallback is free: until KaTeX loads, or if
 * it never does, what you see is the LaTeX source rather than a blank.
 */
// See sourceline.ts for why this imports `MarkdownIt`/`StateInline`/`StateBlock`
// as named types from the package root rather than a `markdown-it/lib/...`
// subpath.
import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';
import { sourceLineAttr } from './sourceline';

const DOLLAR = 0x24;

/**
 * Is the `$` at `pos` escaped by a backslash?
 *
 * Counts the run rather than looking at one character, because `\\$` is an
 * escaped backslash followed by a live `$`. Getting this wrong makes math
 * silently stop working after any line that ends in a backslash.
 */
function escaped(src: string, pos: number): boolean {
  let backslashes = 0;
  while (pos - backslashes > 0 && src.charCodeAt(pos - backslashes - 1) === 0x5c) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * **The rule that keeps prices out of the parser.** `I paid $5 and $10` has two
 * dollar signs with text between them, which is a perfectly good math span as
 * far as the delimiters are concerned.
 *
 * Three guards, all of them borrowed from how this is conventionally done
 * rather than invented, and each with a case in the tests:
 *
 * - the opening `$` is not followed by whitespace, so `$ x$` is not math;
 * - the closing `$` is not preceded by whitespace, so `$x $` is not math;
 * - the closing `$` is not followed by a digit, which is what rejects `$5 and
 *   $10` specifically -- the run ends at `$1`, and `0` follows.
 *
 * An empty span (`$$` with nothing between, as inline) is rejected by the first
 * guard for free.
 */
function closingDollar(src: string, start: number, max: number, run: number): number {
  for (let pos = start; pos < max; pos++) {
    if (src.charCodeAt(pos) !== DOLLAR || escaped(src, pos)) continue;

    // A `$$` close must be matched by a `$$` open and vice versa, or `$$x$`
    // would close one short and leave a stray delimiter in the text.
    let length = 0;
    while (pos + length < max && src.charCodeAt(pos + length) === DOLLAR) length++;
    if (length !== run) {
      pos += length - 1;
      continue;
    }

    if (/\s/.test(src[pos - 1] ?? '')) continue;
    if (/[0-9]/.test(src[pos + run] ?? '')) continue;
    return pos;
  }
  return -1;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== DOLLAR || escaped(src, pos)) return false;

  let run = 0;
  while (pos + run < state.posMax && src.charCodeAt(pos + run) === DOLLAR) run++;
  // Three or more is not a delimiter this rule knows, and consuming it would
  // eat the text after it.
  if (run > 2) return false;

  const start = pos + run;
  if (/\s/.test(src[start] ?? '')) return false;

  const close = closingDollar(src, start, state.posMax, run);
  if (close === -1) return false;

  if (!silent) {
    const token = state.push(run === 2 ? 'math_block_inline' : 'math_inline', '', 0);
    token.content = src.slice(start, close);
    token.markup = '$'.repeat(run);
  }
  state.pos = close + run;
  return true;
}

/**
 * `$$` on a line of its own, with the expression on the lines between.
 *
 * A *block* rule rather than letting the inline one handle it, because only a
 * block rule can span lines -- and because a display equation is a paragraph in
 * its own right rather than something inside one.
 *
 * `$$x$$` written on a single line never reaches here: the inline rule claims
 * it first, and marks it display anyway (`math_block_inline`). That is the
 * behaviour people expect from every other editor that does this.
 */
function mathBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const open = state.bMarks[startLine]! + state.tShift[startLine]!;
  const openMax = state.eMarks[startLine]!;
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  if (state.src.slice(open, open + 2) !== '$$') return false;

  // Anything after the opening `$$` on the same line is a one-line block --
  // `$$ x = 1 $$` typed alone. Handled here rather than left to the inline
  // rule so it renders as a display equation rather than inside a paragraph.
  const rest = state.src.slice(open + 2, openMax).trim();
  if (rest.endsWith('$$') && rest.length > 2) {
    if (silent) return true;
    const token = state.push('math_block', '', 0);
    token.content = rest.slice(0, -2).trim();
    token.markup = '$$';
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }
  if (rest !== '') return false;
  if (silent) return true;

  let line = startLine;
  let closed = false;
  while (++line < endLine) {
    const from = state.bMarks[line]! + state.tShift[line]!;
    if (state.src.slice(from, state.eMarks[line]!).trim() === '$$') {
      closed = true;
      break;
    }
  }
  // **An unterminated block is not math.** Returning false hands the `$$` back
  // to the paragraph rule, so a half-typed equation reads as the text it
  // currently is rather than swallowing the rest of the document -- which is
  // the state it spends most of its life in while you are writing it.
  if (!closed) return false;

  const token = state.push('math_block', '', 0);
  token.content = state.getLines(startLine + 1, line, state.blkIndent, false).trim();
  token.markup = '$$';
  token.map = [startLine, line + 1];
  state.line = line + 1;
  return true;
}

/**
 * The classes `preview/math.ts` looks for. Exported so the two files cannot
 * disagree about the contract between them, and so the tests can assert on a
 * name rather than a literal.
 */
export const MATH_INLINE_CLASS = 'preview-math';
export const MATH_DISPLAY_CLASS = 'preview-math-display';

export function mathPlugin(md: MarkdownIt): void {
  // Before `escape`, so `\$` is still an escape and this rule never sees it --
  // `escaped()` above covers the same ground from the other direction, for the
  // `$` characters this rule reaches on its own.
  md.inline.ruler.before('escape', 'hashpad_math_inline', mathInline);
  // Before `fence`, so a `$$` block is not mistaken for anything else. After
  // nothing in particular otherwise; it claims only lines starting `$$`.
  md.block.ruler.before('fence', 'hashpad_math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  // The expression goes in as *text*, which markdown-it escapes for us. That is
  // what makes `$a < b$` safe without a second escaping pass here, and what
  // lets `preview/math.ts` read the original back with `textContent`.
  md.renderer.rules.math_inline = (tokens, index) =>
    `<span class="${MATH_INLINE_CLASS}">${md.utils.escapeHtml(tokens[index]!.content)}</span>`;

  // **The anchor is carried by hand**, because this renderer writes its own
  // HTML and markdown-it only renders attributes for tokens it renders itself.
  // A display equation is a block with a `map`, so `sourceLinePlugin` stamps
  // one -- and dropping it made every `$$` block a hole in the scroll-sync map,
  // which is a tall hole in exactly the place the tallest blocks are.
  md.renderer.rules.math_block = (tokens, index) => {
    const token = tokens[index]!;
    return (
      `<div class="${MATH_DISPLAY_CLASS}"${sourceLineAttr(md, token)}>` +
      `${md.utils.escapeHtml(token.content)}</div>\n`
    );
  };
  // `$$x$$` inside a paragraph. A `<div>` inside a `<p>` is invalid HTML and
  // the browser closes the paragraph around it, so this one stays a span and
  // takes the display class as a modifier instead.
  md.renderer.rules.math_block_inline = (tokens, index) =>
    `<span class="${MATH_INLINE_CLASS} ${MATH_DISPLAY_CLASS}">${md.utils.escapeHtml(
      tokens[index]!.content,
    )}</span>`;
}
