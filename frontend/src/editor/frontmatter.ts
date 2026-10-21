/**
 * YAML front matter as a block of its own in the editor's markdown (design
 * §4.38), decided by the reading view's rule (`frontMatterClose`).
 *
 * Without it `@lezer/markdown` reads front matter as a horizontal rule and a
 * Setext heading: live preview styled `title:`/`author:` as a heading and hid
 * the closing `---` as its underline (owner's report), and source mode drew the
 * lines as a heading too. A `FrontMatter` node has no style and no children, so
 * nothing inside it is decorated; live preview draws it as a card instead
 * (livepreview.ts).
 */
import type { Input } from '@lezer/common';
import type { BlockContext, MarkdownConfig } from '@lezer/markdown';
import { frontMatterClose } from '../preview/rules/frontmatter';

export const FrontMatterExtension: MarkdownConfig = {
  defineNodes: [{ name: 'FrontMatter', block: true }],
  parseBlock: [
    {
      name: 'FrontMatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || cx.parentType().name !== 'Document') return false;

        // Line 1 is in hand; the rest is read only once it looks like a fence.
        let rest: string[] | null = null;
        const close = frontMatterClose((index) =>
          index === 0 ? line.text : (rest ??= documentOf(cx).split('\n'))[index],
        );
        if (close === null) return false;

        for (let index = 0; index < close; index++) cx.nextLine();
        const end = cx.lineStart + line.text.length;
        cx.nextLine();
        cx.addElement(cx.elt('FrontMatter', 0, end));
        return true;
      },
    },
  ],
};

/**
 * The whole document, which the rule needs to find the closing fence -- a
 * block parser can otherwise see one line ahead. `input` is on every
 * BlockContext but missing from @lezer/markdown's types (checked 1.7.2); if a
 * release drops it, frontmatter.test.ts fails rather than this going quiet.
 *
 * shortcut: reads the whole document whenever line 1 is reparsed, which is
 * only while front matter is being edited; read line by line if a document of
 * megabytes ever makes typing in its front matter slow.
 */
function documentOf(cx: BlockContext): string {
  const { input } = cx as unknown as { input: Input };
  return input.read(0, input.length);
}
