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
    //
    // Each branch replaces the run from `line.from` through whatever occupies
    // the prefix slot -- the indent, plus any marker being replaced -- and
    // writes back the same indent followed by the new marker. Preserving the
    // indent is this function's job, not `format`'s (see the option's doc).
    return {
      changes: lines.map((line, index) => {
        // Already has this exact prefix. Regenerate rather than leave alone,
        // so numberedList renumbers a line carrying *a* number but the wrong
        // one. `conflict` is a different marker from the same family
        // occupying the slot -- a plain bullet where a task is wanted, or
        // another heading level. Falling through to neither means the slot
        // holds nothing but indent.
        // Safe on both: each is null-checked before its properties are read.
        const occupant = own[index] ?? conflict?.(line.text) ?? null;
        const indent = occupant ? occupant.indent : /^\s*/.exec(line.text)![0];
        const occupiedTo = indent.length + (occupant ? occupant.marker.length : 0);

        return {
          from: line.from,
          to: line.from + occupiedTo,
          insert: indent + format(index),
        };
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
 * `- [ ] item` is a bullet item too, so removing "the bullet" from it has to
 * take the checkbox with it. Matching only `- ` would delete the dash and
 * leave `[ ] item` behind as literal text -- visibly not what the button
 * says it does. Task markers are therefore tried first, and only a line that
 * is not a task falls through to the plain bullet pattern.
 */
function bulletOrTaskAt(lineText: string): { indent: string; marker: string } | null {
  return blockPrefixAt(lineText, 'taskList') ?? blockPrefixAt(lineText, 'bulletList');
}

export const COMMANDS = {
  bold: toggleInlineMark('bold'),
  italic: toggleInlineMark('italic'),
  strikethrough: toggleInlineMark('strikethrough'),
  highlight: toggleInlineMark('highlight'),
  inlineCode: toggleInlineMark('inlineCode'),
  bulletList: toggleLinePrefix({
    detect: bulletOrTaskAt,
    format: () => '- ',
  }),
  numberedList: toggleLinePrefix({
    detect: (text) => blockPrefixAt(text, 'numberedList'),
    format: (index) => `${index + 1}. `,
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
} satisfies Record<string, MarkdownCommand>;

export type CommandId = keyof typeof COMMANDS;
