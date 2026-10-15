/**
 * GFM column alignment that survives the sanitiser.
 *
 * markdown-it writes a column's alignment as `style="text-align:…"` on each
 * cell, and render.ts's sanitiser forbids `style` -- so every column read left,
 * in every view and export. As `data-align` it survives (data attributes are
 * allowed), and preview.css applies it. Only markdown-it's own table cells are
 * touched: a `style` written in raw HTML is still removed.
 */
import type { MarkdownIt } from 'markdown-it';

export function tableAlignPlugin(md: MarkdownIt): void {
  md.core.ruler.push('table_align', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'th_open' && token.type !== 'td_open') continue;
      const align = /^text-align:(left|center|right)$/.exec(
        String(token.attrGet('style') ?? ''),
      )?.[1];
      if (!align) continue;
      token.attrs = token.attrs!.filter(([name]) => name !== 'style');
      token.attrSet('data-align', align);
    }
  });
}
