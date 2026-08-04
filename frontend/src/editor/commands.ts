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
  enclosingInlineMark,
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

export const COMMANDS = {
  bold: toggleInlineMark('bold'),
  italic: toggleInlineMark('italic'),
  strikethrough: toggleInlineMark('strikethrough'),
  highlight: toggleInlineMark('highlight'),
  inlineCode: toggleInlineMark('inlineCode'),
} satisfies Record<string, MarkdownCommand>;

export type CommandId = keyof typeof COMMANDS;
