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
export function toggleInlineMark(mark: InlineMark): MarkdownCommand {
  const delimiter = INLINE_MARK_DELIMITERS[mark];

  return (state) => {
    const ranges = state.selection.ranges;
    if (ranges.some((range) => inFencedCode(state, range.head))) return null;

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
  detect: (lineText: string) => { indent: string; marker: string } | null;
  format: (indent: string, index: number) => string;
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
}): MarkdownCommand {
  const { detect, format, conflict } = options;

  return (state) => {
    const ranges = state.selection.ranges;
    if (ranges.some((range) => inFencedCode(state, range.head))) return null;

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
          const match = own[i]!;
          return {
            from: line.from + match.indent.length,
            to: line.from + match.indent.length + match.marker.length,
          };
        }),
      };
    }

    // At least one line lacks the prefix: give it to all of them.
    return {
      changes: lines.map((line, index) => {
        const match = own[index];
        // `format` returns the *whole* prefix, indent included, so every
        // branch below replaces starting at `line.from` -- inserting it
        // after the existing indent (as opposed to replacing the indent with
        // its own text) would double it.
        if (match) {
          // Already has this exact prefix. Regenerate it through `format`
          // rather than leaving it alone, so numberedList can renumber a
          // line that already carries *a* number but the wrong one.
          return {
            from: line.from,
            to: line.from + match.indent.length + match.marker.length,
            insert: format(match.indent, index),
          };
        }

        const other = conflict?.(line.text);
        if (other) {
          // A different marker from the same family sits in the slot this
          // prefix wants -- replace it instead of prefixing alongside it.
          return {
            from: line.from,
            to: line.from + other.indent.length + other.marker.length,
            insert: format(other.indent, index),
          };
        }

        const indent = /^\s*/.exec(line.text)![0];
        return { from: line.from, to: line.from + indent.length, insert: format(indent, index) };
      }),
    };
  };
}

/**
 * ATX heading marker actually present on a line, at any level -- distinct
 * from `headingLevelAt`, which only reports the level. CommonMark allows the
 * hashes with no trailing space at end of line, so the marker's real width
 * on the page isn't always `level + 1`; slicing the matched text (rather
 * than assuming `'#'.repeat(level) + ' '`) keeps the remove/replace paths
 * from eating or leaving behind a character on that edge case.
 */
function headingMarkerAt(lineText: string): { indent: string; marker: string } | null {
  const match = /^(#{1,6})(\s|$)/.exec(lineText);
  return match ? { indent: '', marker: lineText.slice(0, match[1]!.length + match[2]!.length) } : null;
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

export const COMMANDS = {
  bold: toggleInlineMark('bold'),
  italic: toggleInlineMark('italic'),
  strikethrough: toggleInlineMark('strikethrough'),
  highlight: toggleInlineMark('highlight'),
  inlineCode: toggleInlineMark('inlineCode'),
  bulletList: toggleLinePrefix({
    detect: (text) => blockPrefixAt(text, 'bulletList'),
    format: (indent) => `${indent}- `,
  }),
  numberedList: toggleLinePrefix({
    detect: (text) => blockPrefixAt(text, 'numberedList'),
    format: (indent, index) => `${indent}${index + 1}. `,
  }),
  // A plain bullet is replaced, not prefixed, when a task marker is added:
  // `- item` becomes `- [ ] item`, never `- - [ ] item`. `detect` alone
  // cannot express this -- it only recognises task markers that already have
  // a checkbox -- so the bullet-to-task conflict is spelled out explicitly
  // here rather than folded into one regex that tries to cover both shapes.
  taskList: toggleLinePrefix({
    detect: (text) => blockPrefixAt(text, 'taskList'),
    format: (indent) => `${indent}- [ ] `,
    conflict: (text) => blockPrefixAt(text, 'bulletList'),
  }),
  blockquote: toggleLinePrefix({
    detect: (text) => blockPrefixAt(text, 'blockquote'),
    format: (indent) => `${indent}> `,
  }),
  heading1: toggleHeading(1),
  heading2: toggleHeading(2),
  heading3: toggleHeading(3),
  heading4: toggleHeading(4),
  heading5: toggleHeading(5),
  heading6: toggleHeading(6),
} satisfies Record<string, MarkdownCommand>;

export type CommandId = keyof typeof COMMANDS;
