/**
 * Every formatting command, as a pure `(EditorState) => TransactionSpec | null`
 * (design §5.4). Pure because SPEC §10 requires Vitest coverage of every one
 * of them and their selection/toggle edge cases; a pure function needs no DOM,
 * no jsdom, and no mounted `EditorView` to test, so the tests stay fast enough
 * to actually run on every change.
 *
 * `null` means "this command does not apply here" and is what makes the
 * keymap fall through to whatever else is bound, rather than swallowing the
 * key with a no-op transaction.
 */
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { Command } from '@codemirror/view';
import {
  INLINE_MARK_DELIMITERS,
  blockPrefixAt,
  enclosingInlineMark,
  headingLevelAt,
  headingMarkerAt,
  inFencedCode,
  type InlineMark,
  type MarkSpan,
} from './marks';

export type MarkdownCommand = (state: EditorState) => TransactionSpec | null;

/**
 * The one adapter that turns a pure command into a CodeMirror `Command` —
 * SPEC §6.5's "one implementation, two triggers". The keymap wraps each
 * command with this; so does the toolbar, which is why a button and its
 * shortcut cannot drift apart.
 *
 * `view.focus()` is for the toolbar's sake: clicking a button moves focus to
 * the button, and without this the user would have to click back into the
 * editor before typing. It is a no-op on the keyboard path, where the editor
 * already has focus.
 */
export function toEditorCommand(command: MarkdownCommand): Command {
  return (view) => {
    const spec = command(view.state);
    if (!spec) return false;
    view.dispatch(spec);
    view.focus();
    return true;
  };
}

/**
 * Every formatting command except `codeBlock` declines inside fenced or
 * indented code: turning someone's source into a heading or a list item by
 * mistake is worse than doing nothing.
 *
 * Deliberately checks *every* range, not just the main one. Declining too
 * often is recoverable -- the user moves the cursor and tries again -- while
 * writing a marker into a code sample is the kind of edit people notice much
 * later, in a diff.
 */
function declinesInFence(state: EditorState): boolean {
  return state.selection.ranges.some((range) => inFencedCode(state, range.head));
}

/**
 * Toggles `mark` (bold/italic/strikethrough/highlight/inlineCode) across every
 * selection range. SPEC §6.5: "Toggle, don't just insert" and "respect
 * selection" -- both requirements live here rather than in `toEditorCommand`
 * because they're about what markdown text to produce, not about how a
 * CodeMirror `Command` gets invoked.
 *
 * Declines (returns null) if any range's cursor sits inside a fenced code
 * block: inserting `**`/`~~`/etc. there would add literal punctuation to the
 * user's source rather than formatting rendered prose.
 */
function toggleInlineMark(mark: InlineMark): MarkdownCommand {
  const delimiter = INLINE_MARK_DELIMITERS[mark];

  return (state) => {
    const ranges = state.selection.ranges;
    if (declinesInFence(state)) return null;

    const spans = ranges.map((range) => enclosingInlineMark(state, range.head, mark));

    // Remove path: only when every range sits inside a span of this mark.
    // Spans are deduped by their enclosing node's `from` so two cursors
    // inside the same span delete its markers once, not twice.
    if (spans.every((span): span is MarkSpan => span !== null)) {
      const bySpanStart = new Map<number, MarkSpan>();
      for (const span of spans) bySpanStart.set(span.from, span);

      const changes = [...bySpanStart.values()]
        .flatMap((span) => [
          { from: span.openFrom, to: span.openTo },
          { from: span.closeFrom, to: span.closeTo },
        ])
        .sort((a, b) => a.from - b.from);

      // No `selection` here: CodeMirror maps the existing selection through
      // the deletion, which is what keeps a previously selected word selected.
      return { changes };
    }

    // Add path.
    return state.changeByRange((range) => {
      let from = range.from;
      let to = range.to;

      if (range.empty) {
        const word = state.wordAt(range.head);
        if (!word) {
          return {
            changes: { from: range.head, insert: delimiter + delimiter },
            range: EditorSelection.cursor(range.head + delimiter.length),
          };
        }
        from = word.from;
        to = word.to;
      }

      return {
        changes: [
          { from, insert: delimiter },
          { from: to, insert: delimiter },
        ],
        range: EditorSelection.range(from + delimiter.length, to + delimiter.length),
      };
    });
  };
}

/**
 * The shape every line-prefix command shares: look at each line the
 * selection touches, and either strip the prefix from all of them or give it
 * to all of them. Never alternate per line -- a command whose meaning
 * depends on which line you happened to start on has no stable meaning at
 * all.
 *
 * `format` receives the line's zero-based index within the affected block,
 * so an ordered list can number 1., 2., 3. from it.
 *
 * Declines (returns null) if any range's cursor sits inside a fenced code
 * block, for the same reason `toggleInlineMark` does: turning source code
 * into a heading or list item by mistake is worse than doing nothing.
 */
function toggleLinePrefix(options: {
  /**
   * Whether the line already carries this prefix, and if so where it ends.
   *
   * `indent` must be the line's **whole** leading whitespace, not part of it.
   * Both paths measure from `line.from` and replace `indent.length +
   * marker.length` characters, so a detector reporting a partial indent would
   * strand the remainder after the new marker.
   */
  detect: (lineText: string) => { indent: string; marker: string } | null;
  /**
   * The marker alone -- `"- "`, `"> "`, `"1. "` -- **without** the line's
   * indent. `toggleLinePrefix` re-emits the indent itself around every call.
   *
   * That split is deliberate and was a bug once: when `format` owned the
   * whole prefix, every one of the three add branches had to remember to
   * include the indent, and `toggleHeading` -- the one caller that isn't a
   * `blockPrefixAt` wrapper -- forgot. It deleted the leading whitespace on
   * every heading toggle and turned `  # Title` into `# # Title`. With the
   * indent out of `format`'s hands there is nothing left for a caller to
   * forget.
   *
   * `index` is the line's position within the affected block, so an ordered
   * list can number 1., 2., 3. from it.
   */
  format: (index: number) => string;
  /**
   * A different marker from the same family that already occupies the slot
   * this prefix wants, and so should be replaced rather than prefixed
   * alongside it -- e.g. a plain bullet when a task marker is wanted, or a
   * different heading level when this one is wanted. Left unset where no
   * such ambiguity exists: a bullet and a blockquote marker, for instance,
   * can coexist on the same line (a quoted list item), so blockquote has
   * nothing to replace.
   */
  conflict?: (lineText: string) => { indent: string; marker: string } | null;
  /**
   * Whether a line that *already* satisfies `detect` should have its marker
   * rewritten when the command runs over a mixed selection. Defaults to
   * never, which is the safe answer: rewriting a marker can destroy state the
   * old one carried, and a new command's author gets that for free.
   *
   * The two commands that opt in do so for opposite-looking reasons, and both
   * come down to whether the existing marker holds information the new one
   * would not:
   *
   * - `numberedList` always rewrites, because its marker encodes a position.
   *   Numbering `1. one / two` has to renumber or the result is wrong.
   * - `bulletList` rewrites plain bullets but not tasks. `* one / two` must
   *   normalise to `- one / - two`, because CommonMark reads a change of
   *   bullet character as the start of a *new* list, so leaving the `*` gives
   *   the user two adjacent one-item lists instead of one list of two. But
   *   `- [x] done` must be left alone: a task item is a bullet item, and
   *   rewriting it as `- ` discards the checked state.
   */
  regenerate?: (lineText: string) => boolean;
}): MarkdownCommand {
  const { detect, format, conflict, regenerate = () => false } = options;

  return (state) => {
    const ranges = state.selection.ranges;
    if (declinesInFence(state)) return null;

    // Deduped, sorted line numbers across every range -- so two cursors on
    // the same line toggle it once, and two cursors on different lines each
    // get their own line toggled, independent of how many ranges the
    // selection has.
    const lineNumbers = new Set<number>();
    for (const range of ranges) {
      const fromLine = state.doc.lineAt(range.from).number;
      const toLine = state.doc.lineAt(range.to).number;
      for (let n = fromLine; n <= toLine; n++) lineNumbers.add(n);
    }
    const lines = [...lineNumbers].sort((a, b) => a - b).map((n) => state.doc.line(n));

    const own = lines.map((line) => detect(line.text));

    if (own.every((match) => match !== null)) {
      // Every affected line already has the prefix: strip it from all of
      // them, keeping the indent -- delete only the marker.
      return {
        changes: lines.map((line, i) => {
          // Safe: this branch runs only when `every` found no null.
          const match = own[i]!;
          return {
            from: line.from + match.indent.length,
            to: line.from + match.indent.length + match.marker.length,
          };
        }),
      };
    }

    // At least one line lacks the prefix: give it to all of them.
    //
    // One expression, replacing the run from `line.from` through whatever
    // occupies the prefix slot -- the indent, plus any marker being replaced
    // -- and writing back that same indent followed by the new marker.
    // Preserving the indent is this function's job, not `format`'s (see the
    // option's doc). `occupiedTo` measures from `line.from`, which is why
    // `detect` and `conflict` must report the line's *whole* indent.
    return {
      changes: lines.flatMap((line, index) => {
        const already = own[index];

        // Already carries this prefix. Left untouched unless the command asks
        // to rewrite it -- see the `regenerate` option for why that is the
        // safe default and which two commands opt out of it.
        if (already && !regenerate(line.text)) return [];

        // `conflict` is a different marker from the same family holding the
        // slot -- a plain bullet where a task is wanted, or another heading
        // level. Neither means the slot holds nothing but indent.
        const occupant = already ?? conflict?.(line.text) ?? null;
        // Safe: `\s*` matches at every position, so this exec cannot be null.
        const indent = occupant ? occupant.indent : /^\s*/.exec(line.text)![0];
        const occupiedTo = indent.length + (occupant ? occupant.marker.length : 0);

        return [
          {
            from: line.from,
            to: line.from + occupiedTo,
            insert: indent + format(index),
          },
        ];
      }),
    };
  };
}

/**
 * One heading level's command: removes it when the line is already exactly
 * this level, otherwise replaces whatever ATX prefix is there -- or inserts
 * one -- with `level` hashes and a space. Built on `toggleLinePrefix` like
 * the four block prefixes below; heading's own "family" is the six levels of
 * itself, so `conflict` here is "some heading marker is present, whatever
 * its level" rather than the block-prefix lookup the other commands use.
 */
function toggleHeading(level: number): MarkdownCommand {
  const prefix = '#'.repeat(level) + ' ';

  return toggleLinePrefix({
    detect: (text) => (headingLevelAt(text) === level ? headingMarkerAt(text) : null),
    format: () => prefix,
    conflict: headingMarkerAt,
  });
}

/**
 * What `bulletList` counts as "already a bullet". A task item is a bullet
 * item with a checkbox, so both shapes qualify, and the task pattern is tried
 * first because it is the longer match.
 *
 * This drives both halves of the toggle, and the reason matters in each:
 * - Removing: the whole marker goes, checkbox included. Matching only `- `
 *   would delete the dash and leave `[ ] item` behind as literal text.
 * - Adding over a mixed selection: a task line already counts as a bullet, so
 *   `toggleLinePrefix` leaves it alone (`regenerate` is off for this command)
 *   and only the non-bullet lines gain a marker. `- [x] done` keeps its
 *   checked state instead of being flattened to `- done`.
 */
function bulletOrTaskAt(lineText: string): { indent: string; marker: string } | null {
  return blockPrefixAt(lineText, 'taskList') ?? blockPrefixAt(lineText, 'bulletList');
}

/**
 * `link`, `image`, `table`, `horizontalRule`, `footnote`, and `codeBlock`
 * (below) are a different kind of command from everything above: they
 * *insert* a construct rather than toggling one on and off, and none of them
 * has a remove path. That is deliberate, not an oversight -- SPEC §6.5's
 * "toggle, don't just insert" is about formatting that *wraps* text, where
 * the wrapped text survives the toggle either way (`**bold**` <-> `bold`).
 * There is no equivalent for these: a table has no "unwrapped" form to
 * revert to, and a document either has a horizontal rule at some position or
 * it does not -- there is nothing sensible to select and un-table.
 */

/**
 * Shared by `table`, `horizontalRule`, and `codeBlock`: inserts `text` as its
 * own block, surrounded by however many newlines it takes to keep it one.
 *
 * A block construct needs a *blank line* on each side, not merely a line of
 * its own, and getting that wrong does not produce ugly markdown -- it
 * produces different markdown. Checked against this project's own parser:
 *
 *   foo\n---\nbar          -> SetextHeading2   (the rule underlines `foo`!)
 *   foo\n\n---\n\nbar      -> Paragraph, HorizontalRule, Paragraph
 *   foo\n<table>\nbar      -> `bar` is swallowed as a table row
 *   foo\n\n<table>\n\nbar  -> Paragraph, Table, Paragraph
 *
 * So the rule is about the neighbouring *lines being blank*, not about
 * landing on column zero: inserting at the start of a line that sits directly
 * under a paragraph still needs a blank line opened above it.
 *
 * `replaceSelection` distinguishes the two kinds of caller. `codeBlock`
 * consumes the selection -- the selected text becomes the fence's contents --
 * while `table` and `horizontalRule` have no use for it and must leave it
 * alone. Replacing it there silently deleted whatever the user had selected.
 *
 * `cursorOffset` is measured from the start of `text` itself, i.e. *after*
 * any prefix this function adds, so callers need not know whether it fired.
 * It may point past the end of `text` into the trailing newlines --
 * `horizontalRule` does exactly that, because there is no useful position
 * inside a rule and the caret belongs on the line after it.
 */
function blockInsert(
  state: EditorState,
  text: string,
  cursorOffset: number,
  options: { replaceSelection?: boolean; selectLength?: number } = {},
): TransactionSpec {
  const { doc } = state;
  const { from, to } = state.selection.main;

  // Where the construct goes. A caller that does not consume the selection
  // inserts after it rather than over it, so nothing is destroyed.
  const start = options.replaceSelection ? from : to;
  const end = to;

  const { selectLength = 0 } = options;

  // The context above is read at `start` and the context below at `end`. For
  // an insertion the two are the same position, but a `replaceSelection`
  // caller is about to delete everything between them -- so what follows the
  // construct is whatever follows `end`, not the selected text at `start`.
  const startLine = doc.lineAt(start);
  const endLine = doc.lineAt(end);
  const column = start - startLine.from;
  const restOfLine = endLine.text.slice(end - endLine.from);
  const previousBlank = startLine.number === 1 || doc.line(startLine.number - 1).text.trim() === '';
  const nextBlank = endLine.number === doc.lines || doc.line(endLine.number + 1).text.trim() === '';

  // Enough newlines to leave a blank line above, given what is already there.
  let prefix = '';
  if (start > 0) {
    if (column > 0) prefix = '\n\n';
    else if (!previousBlank) prefix = '\n';
  }

  // And below, counting what the document already supplies. Text still to
  // come on this line becomes its own paragraph and needs a full blank line;
  // at the end of a line the document's own newline is already there, so one
  // more is enough -- adding two would leave a stray empty line, which is the
  // most common case of all and the easiest to get wrong.
  let suffix: string;
  if (restOfLine !== '') suffix = '\n\n';
  else if (end < doc.length && nextBlank) suffix = '';
  else suffix = '\n';

  const caret = start + prefix.length + cursorOffset;
  return {
    changes: { from: start, to: end, insert: prefix + text + suffix },
    // A zero `selectLength` collapses to a plain cursor, so callers with no
    // placeholder to offer say nothing and get one.
    selection: EditorSelection.range(caret, caret + selectLength),
  };
}

/**
 * `link` and `image` differ only in the literal that surrounds the inserted
 * text (`[…](url)` vs `![…](path)`) and the two placeholder words, so both
 * are built from this one function rather than duplicated.
 *
 * Follows the same text-source cascade as `toggleInlineMark`'s add path:
 * selection, if there is one, becomes the link text; failing that, the word
 * under a bare cursor; failing that, `textPlaceholder`. Where this diverges
 * from that model is what ends up selected afterwards -- because a link has
 * two blanks to fill in, not one:
 * - Real text was found (a selection or a word): the URL/path placeholder
 *   comes out selected, since the text is already right and the target is
 *   what the user still has to type.
 * - No real text existed: the *text* placeholder comes out selected instead,
 *   on the theory that naming the thing you're linking to comes before
 *   deciding where it points.
 */
function insertReferenceCommand(options: {
  prefix: string;
  textPlaceholder: string;
  targetPlaceholder: string;
}): MarkdownCommand {
  const { prefix, textPlaceholder, targetPlaceholder } = options;

  return (state) => {
    if (declinesInFence(state)) return null;

    return state.changeByRange((range) => {
      let from = range.from;
      let to = range.to;
      let text: string;
      let usedTextPlaceholder = false;

      if (!range.empty) {
        text = state.doc.sliceString(from, to);
      } else {
        const word = state.wordAt(range.head);
        if (word) {
          from = word.from;
          to = word.to;
          text = state.doc.sliceString(from, to);
        } else {
          text = textPlaceholder;
          usedTextPlaceholder = true;
        }
      }

      // Every offset below is derived from the literal shape
      // `${prefix}[${text}](${targetPlaceholder})`, not hard-coded, so a
      // change to either placeholder word can't silently desync the
      // selection from the text it's supposed to cover.
      const textFrom = from + prefix.length + 1;
      const textTo = textFrom + text.length;
      const targetFrom = textTo + 2;
      const targetTo = targetFrom + targetPlaceholder.length;

      return {
        changes: { from, to, insert: `${prefix}[${text}](${targetPlaceholder})` },
        range: usedTextPlaceholder
          ? EditorSelection.range(textFrom, textTo)
          : EditorSelection.range(targetFrom, targetTo),
      };
    });
  };
}

/**
 * Inserts `[^n]` at the cursor and its matching `[^n]: ` definition at the
 * end of the document, numbered past whatever footnote already has the
 * highest number -- scanning the whole document rather than trusting the
 * next integer after the last one written, since footnotes can be inserted
 * out of order or the highest one can sit anywhere in the text.
 *
 * Both edits live in one `changes` array so they apply as a single
 * transaction. Their `from` positions are both measured against the
 * *original* document and sorted ascending (the reference's position is
 * never after the definition's, since a cursor position can't exceed the
 * document length it is being compared against) -- so on a cursor already at
 * the document's end, the reference still lands before the definition
 * instead of the two colliding in an undefined order.
 */
const footnote: MarkdownCommand = (state) => {
  if (declinesInFence(state)) return null;

  const docText = state.doc.toString();
  let highest = 0;
  for (const match of docText.matchAll(/\[\^(\d+)\]/g)) {
    // Safe: the capture group is mandatory in the pattern, so a match
    // guarantees it.
    highest = Math.max(highest, Number(match[1]!));
  }
  const n = highest + 1;

  const pos = state.selection.main.head;
  const reference = `[^${n}]`;
  const definitionLabel = `[^${n}]: `;

  const changes = [
    { from: pos, insert: reference },
    { from: state.doc.length, insert: `\n\n${definitionLabel}\n` },
  ].sort((a, b) => a.from - b.from);

  // The reference is always inserted at or before the definition's position
  // (`pos <= state.doc.length` always holds), so it always shifts the
  // definition's landing spot forward by its own length -- regardless of
  // where in the document the cursor was.
  const cursor = state.doc.length + reference.length + `\n\n${definitionLabel}`.length;

  return { changes, selection: EditorSelection.cursor(cursor) };
};

/**
 * No fenced-code guard: unlike every other command here, `codeBlock` is the
 * one that is supposed to work *inside* a fence too (see `activeFormats`,
 * which reports `codeBlock` -- and nothing else -- for a cursor inside one).
 *
 * Wraps the selection (empty or not) in a fresh triple-backtick fence and
 * leaves the cursor on the info string, one keystroke away from naming the
 * language -- SPEC's original modal prompt was traded for this by the owner
 * (recorded in the plan), since a language name is optional and a blocking
 * dialog for an optional field is friction the feature doesn't need.
 */
const codeBlock: MarkdownCommand = (state) => {
  const { from, to } = state.selection.main;
  const inner = state.doc.sliceString(from, to);
  // The one caller that consumes the selection: the selected text becomes the
  // fence's contents, so replacing the range is the point rather than a bug.
  return blockInsert(state, '```\n' + inner + '\n```', 3, { replaceSelection: true });
};

const table: MarkdownCommand = (state) => {
  if (declinesInFence(state)) return null;
  const text =
    '| Column 1 | Column 2 | Column 3 |\n' +
    '| --- | --- | --- |\n' +
    '|  |  |  |\n' +
    '|  |  |  |';
  // Selects "Column 1" rather than parking a bare cursor before it, so the
  // first thing a user does with a fresh table -- rename the first header --
  // is one keystroke. A cursor there would have made typing produce
  // `| NameColumn 1 |`. Same convention as link/image's placeholders.
  return blockInsert(state, text, '| '.length, { selectLength: 'Column 1'.length });
};

const horizontalRule: MarkdownCommand = (state) => {
  if (declinesInFence(state)) return null;
  // Past the rule and its newline: there is no meaningful position *inside*
  // a rule to land on, so the cursor goes after it, ready to keep typing.
  return blockInsert(state, '---', '---\n'.length);
};

export const COMMANDS = {
  bold: toggleInlineMark('bold'),
  italic: toggleInlineMark('italic'),
  strikethrough: toggleInlineMark('strikethrough'),
  highlight: toggleInlineMark('highlight'),
  inlineCode: toggleInlineMark('inlineCode'),
  bulletList: toggleLinePrefix({
    detect: bulletOrTaskAt,
    format: () => '- ',
    // Normalise `*` and `+` to `-`, since CommonMark starts a new list at a
    // change of bullet character -- but never rewrite a task, which would
    // throw away its checked state.
    regenerate: (text) => blockPrefixAt(text, 'taskList') === null,
  }),
  numberedList: toggleLinePrefix({
    detect: (text) => blockPrefixAt(text, 'numberedList'),
    format: (index) => `${index + 1}. `,
    // The marker encodes a position, so a line already carrying a number
    // still has to be rewritten -- unconditionally, unlike bulletList.
    regenerate: () => true,
  }),
  // A plain bullet is replaced, not prefixed, when a task marker is added:
  // `- item` becomes `- [ ] item`, never `- - [ ] item`. `detect` alone
  // cannot express this -- it only recognises task markers that already have
  // a checkbox -- so the bullet-to-task conflict is spelled out explicitly
  // here rather than folded into one regex that tries to cover both shapes.
  taskList: toggleLinePrefix({
    detect: (text) => blockPrefixAt(text, 'taskList'),
    format: () => '- [ ] ',
    conflict: (text) => blockPrefixAt(text, 'bulletList'),
  }),
  blockquote: toggleLinePrefix({
    detect: (text) => blockPrefixAt(text, 'blockquote'),
    format: () => '> ',
  }),
  heading1: toggleHeading(1),
  heading2: toggleHeading(2),
  heading3: toggleHeading(3),
  heading4: toggleHeading(4),
  heading5: toggleHeading(5),
  heading6: toggleHeading(6),
  link: insertReferenceCommand({ prefix: '', textPlaceholder: 'text', targetPlaceholder: 'url' }),
  image: insertReferenceCommand({
    prefix: '!',
    textPlaceholder: 'alt',
    targetPlaceholder: 'path',
  }),
  table,
  horizontalRule,
  footnote,
  codeBlock,
} satisfies Record<string, MarkdownCommand>;

export type CommandId = keyof typeof COMMANDS;
