/**
 * GFM task list checkboxes. markdown-it does not render these natively, and
 * `markdown-it-task-lists` is effectively unmaintained (design §6.3), so this
 * is ~25 lines of our own.
 *
 * The checkbox is `disabled`: the preview is a rendering of the document, not
 * a second editor. Ticking it here would either do nothing (a lie) or edit the
 * source from the preview, which no other part of the pane does.
 */
// See sourceline.ts for why this imports `MarkdownIt`/`StateCore` as named
// types from the package root rather than a `markdown-it/lib/...` subpath.
import type { MarkdownIt, StateCore } from 'markdown-it';

const TASK = /^\[([ xX])\]\s+/;

export function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.push('hashpad_task_list', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.type !== 'list_item_open') continue;

      // list_item_open, paragraph_open, inline — the inline token is where the
      // literal `[ ] ` lives.
      const inline = tokens[i + 2];
      if (!inline || inline.type !== 'inline') continue;

      const match = TASK.exec(inline.content);
      if (!match) continue;

      const checked = match[1]!.toLowerCase() === 'x';
      inline.content = inline.content.slice(match[0].length);
      // The inline token has already been tokenised into children by this
      // point; the first text child carries the same prefix and must lose it
      // too, or the marker renders twice.
      const firstText = inline.children?.find((child) => child.type === 'text');
      if (firstText) firstText.content = firstText.content.replace(TASK, '');

      tokens[i]!.attrJoin('class', 'preview-task-item');
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
      inline.children?.unshift(box);
    }
  });
}
