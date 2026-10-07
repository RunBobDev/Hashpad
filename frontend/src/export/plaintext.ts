/**
 * Export as Plain Text (SPEC §7.3): markdown syntax gone, structure kept by
 * indentation.
 *
 * Walked from the *untypeset* render rather than the source, so it agrees with
 * the preview about what is a list, a table or a footnote -- and walked before
 * KaTeX and Mermaid have run, so math and diagrams are still their source, the
 * only plain-text form either has.
 *
 * The shape: headings and paragraphs as plain lines, a blank line between
 * blocks; lists two spaces deeper per level, with `-` or the item's number;
 * quotes, code, display math and diagrams four spaces in; tables padded into
 * columns; links as `text (address)`; images as `[image: alt]`.
 */
import { ShowExportDialog, WriteFile } from '../../wailsjs/go/app/App';
import { renderMarkdown } from '../preview/render';
import { MATH_DISPLAY_CLASS } from '../preview/rules/math';
import { DIAGRAM_CLASS } from '../preview/rules/mermaid';
import { activeSource, runExport } from './build';

/** One block's lines. Blocks are joined with a blank line between. */
type Block = string[];

/** Elements that start a block of their own; everything else is inline. */
const BLOCK = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'UL',
]);

export function markdownToPlainText(markdown: string): string {
  // An inert document, so a raw `<img src="https://…">` in the markdown is
  // never fetched just to be turned into `[image: …]`.
  const root = document.implementation.createHTMLDocument('').createElement('div');
  root.innerHTML = renderMarkdown(markdown, { documentDir: null });
  return toPlainText(root);
}

/** LF line endings, a final newline, and `''` for an empty document. */
export function toPlainText(root: ParentNode): string {
  const blocks = blocksOf(root);
  return blocks.length === 0 ? '' : `${joined(blocks).join('\n')}\n`;
}

function blocksOf(parent: ParentNode): Block[] {
  const blocks: Block[] = [];
  let inline = '';
  const flush = (): void => {
    const lines = inlineLines(inline);
    if (lines.length > 0) blocks.push(lines);
    inline = '';
  };
  for (const node of parent.childNodes) {
    if (node instanceof Element && BLOCK.has(node.tagName)) {
      flush();
      blocks.push(...blockOf(node).filter((block) => block.length > 0));
    } else {
      inline += inlineText(node);
    }
  }
  flush();
  return blocks;
}

function blockOf(element: Element): Block[] {
  if (element.classList.contains(DIAGRAM_CLASS) || element.classList.contains(MATH_DISPLAY_CLASS)) {
    return [indent(sourceLines(element.textContent ?? ''), 4)];
  }
  switch (element.tagName) {
    case 'PRE':
      return [indent(sourceLines(element.textContent ?? ''), 4)];
    case 'BLOCKQUOTE':
      return [indent(joined(blocksOf(element)), 4)];
    case 'UL':
    case 'OL':
      return [listLines(element)];
    case 'TABLE':
      return [tableLines(element)];
    case 'DL':
      return [definitionLines(element)];
    case 'HR':
      return [['---']];
    default:
      // A paragraph or heading is one block of inline text; a `<div>` or
      // `<section>` is a container of blocks. The same walk serves both.
      return blocksOf(element);
  }
}

/** Blocks as lines, with a blank line between each. */
function joined(blocks: Block[]): string[] {
  return blocks.flatMap((block, i) => (i === 0 ? block : ['', ...block]));
}

function indent(lines: string[], by: number): string[] {
  return lines.map((line) => (line === '' ? '' : ' '.repeat(by) + line));
}

/** Preformatted text: every line kept, the closing newline dropped. */
function sourceLines(text: string): string[] {
  return text.replace(/\n$/, '').split('\n');
}

/** Flowing text: runs of spaces collapsed, blank lines dropped. */
function inlineLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '');
}

function listLines(list: Element): Block {
  const ordered = list.tagName === 'OL';
  const start = Number.parseInt(list.getAttribute('start') ?? '1', 10);
  let number = Number.isNaN(start) ? 1 : start;
  const lines: string[] = [];
  for (const item of list.children) {
    if (item.tagName !== 'LI') continue;
    const marker = ordered ? `${String(number++)}. ` : '- ';
    // No blank lines inside an item: a nested list belongs to its item.
    const body = blocksOf(item).flat();
    if (body.length === 0) lines.push(marker.trimEnd());
    else lines.push(marker + body[0]!, ...indent(body.slice(1), 2));
  }
  return lines;
}

// Known limit: pads by string length, so a column of wide CJK characters or emoji
// will not line up; measure display width if anyone exports tables of those.
function tableLines(table: Element): Block {
  const rows = [...table.querySelectorAll('tr')].map((row) =>
    [...row.children].map((cell) => inlineLines(inlineText(cell)).join(' ')),
  );
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  }
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const lines = rows.map(line);
  if (table.querySelector('thead') !== null && lines.length > 0) {
    lines.splice(1, 0, line(widths.map((width) => '-'.repeat(Math.max(width, 1)))));
  }
  return lines;
}

/** Front matter, which the preview shows as a `<dl>`, back as `key: value`. */
function definitionLines(list: Element): Block {
  const lines: string[] = [];
  for (const child of list.children) {
    const text = inlineLines(inlineText(child)).join(' ');
    const last = lines.length - 1;
    if (child.tagName === 'DD' && last >= 0 && lines[last]!.endsWith(':')) {
      lines[last] += ` ${text}`;
    } else {
      lines.push(child.tagName === 'DT' ? `${text}:` : text);
    }
  }
  return lines;
}

function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data;
  if (!(node instanceof Element)) return '';
  // The footnote's way back to its reference: an arrow, meaningless on paper.
  if (node.classList.contains('footnote-backref')) return '';
  if (node.classList.contains('preview-image-placeholder')) {
    return image(node.getAttribute('data-alt'));
  }
  switch (node.tagName) {
    case 'BR':
      return '\n';
    case 'IMG':
      return image(node.getAttribute('alt'));
    case 'INPUT':
      // A task item's box. Its following text starts with a space already.
      if (node.getAttribute('type') !== 'checkbox') return '';
      return node.hasAttribute('checked') ? '[x]' : '[ ]';
    case 'A':
      return link(node);
    default:
      return [...node.childNodes].map(inlineText).join('');
  }
}

function image(alt: string | null): string {
  const text = (alt ?? '').trim();
  return text === '' ? '[image]' : `[image: ${text}]`;
}

/** `text (address)`, unless the address would only repeat the text. */
function link(anchor: Element): string {
  const text = [...anchor.childNodes].map(inlineText).join('');
  const href = anchor.getAttribute('href') ?? '';
  if (href === '' || href.startsWith('#') || href === text || href === `mailto:${text}`) {
    return text;
  }
  return `${text} (${href})`;
}

/** File > Export as Plain Text… */
export function exportActiveAsText(): Promise<void> {
  return runExport('export', async () => {
    const source = activeSource();
    if (source === null) return;
    const path = await ShowExportDialog(`${source.stem}.txt`, 'text');
    if (path === '') return;
    // WriteFile turns LF into the document's own line ending.
    await WriteFile(path, markdownToPlainText(source.text), 'utf-8', source.lineEnding);
  });
}
