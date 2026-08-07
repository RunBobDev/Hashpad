/**
 * Detects what markdown formatting applies at a position -- the one place
 * this question gets answered, so the toggle commands (Task 2) and the
 * toolbar's active-button state (Task 4) read the same tree in the same way
 * and can never disagree about what "bold" or "heading 2" means here. It
 * reads the Lezer tree rather than scanning characters: a regex sees `**` and
 * calls it bold whether or not it actually is (inside a code span, say), and
 * a command built on that misreading would delete the wrong thing.
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

export type InlineMark = 'bold' | 'italic' | 'strikethrough' | 'highlight' | 'inlineCode';

export const INLINE_MARK_DELIMITERS: Record<InlineMark, string> = {
  bold: '**',
  italic: '*',
  strikethrough: '~~',
  highlight: '==',
  inlineCode: '`',
};

/**
 * The Lezer node names behind each mark. Kept module-private and separate
 * from `INLINE_MARK_DELIMITERS`: the delimiter text is a rendering/insertion
 * concern (Task 2 reads it to build replacement text), while these are a
 * parser-shape concern, and `*` vs `**` show the two can diverge -- both are
 * `Emphasis`-family nodes but resolve to different node names entirely.
 */
const INLINE_MARK_NODES: Record<InlineMark, { node: string; mark: string }> = {
  bold: { node: 'StrongEmphasis', mark: 'EmphasisMark' },
  italic: { node: 'Emphasis', mark: 'EmphasisMark' },
  strikethrough: { node: 'Strikethrough', mark: 'StrikethroughMark' },
  highlight: { node: 'Highlight', mark: 'HighlightMark' },
  inlineCode: { node: 'InlineCode', mark: 'CodeMark' },
};

export interface MarkSpan {
  from: number;
  to: number;
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
}

export function enclosingInlineMark(
  state: EditorState,
  pos: number,
  mark: InlineMark,
): MarkSpan | null {
  const { node: nodeName, mark: markName } = INLINE_MARK_NODES[mark];
  const tree = syntaxTree(state);

  // Both sides, so a cursor touching either edge of `**bold**` counts as
  // inside it -- see the Decisions table. resolveInner rather than resolve:
  // the innermost node at that position is the one whose ancestry we want to
  // walk, and `resolve` can stop at a wrapper.
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== nodeName) continue;

      const marks = node.getChildren(markName);
      // A well-formed span always has both runs. Anything else is a grammar
      // shape this code does not understand, and deleting "the first and last
      // mark" of it would corrupt the document -- decline instead.
      if (marks.length < 2) return null;
      // Safe: the length check above guarantees both indices exist.
      const open = marks[0]!;
      const close = marks[marks.length - 1]!;

      return {
        from: node.from,
        to: node.to,
        openFrom: open.from,
        openTo: open.to,
        closeFrom: close.from,
        closeTo: close.to,
      };
    }
  }
  return null;
}

export type BlockPrefix = 'bulletList' | 'numberedList' | 'taskList' | 'blockquote';

const BLOCK_PREFIX_PATTERNS: Record<BlockPrefix, RegExp> = {
  // A task item is a bullet item with a checkbox, so this deliberately
  // matches `- [ ] task` too -- see the test that pins that down.
  bulletList: /^(\s*)([-*+] )/,
  numberedList: /^(\s*)(\d+\. )/,
  taskList: /^(\s*)(- \[[ xX]\] )/,
  blockquote: /^(\s*)(> )/,
};

export function blockPrefixAt(
  lineText: string,
  prefix: BlockPrefix,
): { indent: string; marker: string } | null {
  const match = BLOCK_PREFIX_PATTERNS[prefix].exec(lineText);
  // Safe: every pattern above has exactly two capturing groups, so a match
  // guarantees both indices.
  return match ? { indent: match[1]!, marker: match[2]! } : null;
}

/**
 * CommonMark ATX headings: up to three spaces of indent, then 1-6 `#`
 * characters, then a space or end of line. `#nospace` is a literal word and
 * `#######` (seven) is not a heading at all.
 *
 * Three spaces, not any indent: a fourth would make the line an indented code
 * block, so `    # x` is code and must not read as a heading. Tabs are
 * excluded for the same reason -- a leading tab is already four columns.
 *
 * The one definition of this pattern. `headingMarkerAt` below reads the same
 * match, because the level and the marker's width have to agree: a heading
 * command that detected the level with one regex and deleted the marker with
 * another would eat or leave a character the moment the two drifted.
 */
// No `g` or `y` flag, so this carries no `lastIndex` state and is safe to
// share between the two readers below.
const ATX_HEADING = /^( {0,3})(#{1,6})(\s|$)/;

export function headingLevelAt(lineText: string): number | null {
  const match = ATX_HEADING.exec(lineText);
  // Safe: group 2 is non-optional, so a match guarantees the index.
  return match ? match[2]!.length : null;
}

/**
 * The ATX marker actually present on a line -- its indent and its full width,
 * as opposed to `headingLevelAt`'s level alone.
 *
 * The width is sliced from the match rather than computed as
 * `'#'.repeat(level) + ' '`, because CommonMark allows the hashes with no
 * trailing space at end of line (`##` is a valid empty heading). Assuming the
 * space would delete one character too many on exactly that input.
 */
export function headingMarkerAt(lineText: string): { indent: string; marker: string } | null {
  const match = ATX_HEADING.exec(lineText);
  if (!match) return null;

  // Safe: all three groups are non-optional, so a match guarantees the index.
  const indent = match[1]!;
  return { indent, marker: match[0].slice(indent.length) };
}

export function inFencedCode(state: EditorState, pos: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
  }
  return false;
}

/**
 * Every format active at the cursor, as the command ids the toolbar and
 * keymap already use elsewhere -- so a caller can compare this list against
 * a command id directly rather than translating between two vocabularies.
 * Sorted because the toolbar's active-state check (Task 4) compares this
 * against a joined string; an unsorted array would make that comparison
 * order-dependent for no reason.
 */
export function activeFormats(state: EditorState): string[] {
  const head = state.selection.main.head;

  // `headingLevelAt`/`blockPrefixAt` scan line text, not the tree, so a `#`
  // or `- ` that is literal content inside a fence (e.g. a comment in a code
  // sample) would otherwise read as an active heading or list. Every command
  // except `codeBlock` already declines inside a fence, so reporting anything
  // else here would light a toolbar button whose command refuses to run.
  if (inFencedCode(state, head)) return ['codeBlock'];

  const lineText = state.doc.lineAt(head).text;
  const formats: string[] = [];

  for (const mark of Object.keys(INLINE_MARK_DELIMITERS) as InlineMark[]) {
    if (enclosingInlineMark(state, head, mark)) formats.push(mark);
  }

  for (const prefix of Object.keys(BLOCK_PREFIX_PATTERNS) as BlockPrefix[]) {
    if (blockPrefixAt(lineText, prefix)) formats.push(prefix);
  }

  const level = headingLevelAt(lineText);
  if (level !== null) formats.push(`heading${level}`);

  return formats.sort();
}
