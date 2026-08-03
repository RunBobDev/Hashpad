/**
 * Draws the `.cm-blockquote` line decoration (styled in app.css with
 * `border-left`) down the side of every line inside a markdown Blockquote
 * node. A `HighlightStyle` (highlight.ts) can colour tokens, but it has no
 * mechanism for decorating a whole line -- that's what `Decoration.line`
 * plus a `ViewPlugin` to keep it in sync with the document are for. This is
 * meant to read as a worked example: it's the exact shape (a `DecorationSet`
 * rebuilt from the Lezer tree, limited to what's on screen) that Phase 2's
 * live preview will reuse for hiding/showing markers near the cursor --
 * extending it there should mean adding logic to `blockquoteDecorations`,
 * not restructuring how this plugin walks the tree or tracks updates.
 */
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';

const blockquoteLine = Decoration.line({ class: 'cm-blockquote' });

/**
 * Builds the decoration set for exactly `ranges` -- the caller passes
 * `view.visibleRanges`, never the whole document. SPEC §6.6's performance
 * target is no perceptible lag in a 5,000-line document, and a
 * `syntaxTree(state).iterate({})` with no `from`/`to` walks every node in the
 * document on every call; run on every keystroke or scroll tick against a
 * document that size, that cost would be spent overwhelmingly on lines that
 * are not even on screen. Restricting the walk to the visible ranges makes
 * the cost proportional to what's rendered, not to the document's length.
 */
function blockquoteDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // A nested blockquote ("> > quoted") visits the same line once per level of
  // nesting via `iterate`'s enter callback; `RangeSetBuilder` requires
  // strictly increasing positions, so duplicates have to be filtered before
  // anything is added to it, not merely tolerated.
  const seen = new Set<number>();
  const linePositions: number[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Blockquote') return;
        // The node itself may start above or extend below what's currently
        // visible -- clip to the visible range, not the node's own extent.
        const firstLine = view.state.doc.lineAt(Math.max(node.from, from)).number;
        const lastLine = view.state.doc.lineAt(Math.min(node.to, to)).number;
        for (let n = firstLine; n <= lastLine; n++) {
          const line = view.state.doc.line(n);
          if (!seen.has(line.from)) {
            seen.add(line.from);
            linePositions.push(line.from);
          }
        }
      },
    });
  }

  // Multiple visible ranges (e.g. either side of a collapsed fold) and
  // multiple Blockquote nodes within one range can each contribute positions
  // out of overall order; RangeSetBuilder.add requires them strictly
  // increasing, so this sorts once up front rather than trying to keep every
  // contributor emitting in order.
  linePositions.sort((a, b) => a - b);
  for (const pos of linePositions) builder.add(pos, pos, blockquoteLine);
  return builder.finish();
}

export const blockquoteLines = ViewPlugin.fromClass(
  class implements PluginValue {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = blockquoteDecorations(view);
    }

    update(update: ViewUpdate): void {
      // Recompute on edits (docChanged, which can add/remove/move
      // Blockquote nodes) and on viewport changes (viewportChanged, which
      // covers scrolling into previously-undecorated lines). A
      // selection-only update -- moving the cursor -- triggers neither, so
      // clicking around a long document never re-walks the tree.
      if (update.docChanged || update.viewportChanged) {
        this.decorations = blockquoteDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);
