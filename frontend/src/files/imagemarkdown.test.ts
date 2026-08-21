// @vitest-environment jsdom
/**
 * What we insert has to be what the preview reads back.
 *
 * This is the seam the G.5b bug lived in, and it is a seam precisely because
 * two correct halves were not enough: `imageops.ts` produced a path that was
 * right, and `preview/rules/images.ts` resolved paths that were right, and
 * between them `![](assets/Screenshot 2026-08-21 120000.png)` was not an image
 * at all. **A bare space ends a CommonMark destination**, so markdown-it emitted
 * the whole thing as literal text -- which is what the owner saw. Parentheses do
 * the same by closing the destination early, and dropped files keep their own
 * names, so both are the ordinary case rather than an exotic one.
 *
 * So these tests run the real renderer over the real generated markdown, and
 * assert on the `path=` the asset handler would receive. Testing
 * `escapeDestination`'s output shape instead would have re-encoded the same
 * assumption that was wrong.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../preview/render';
import { escapeDestination, imageMarkdown } from './imageops';

/** The path Go's asset handler would be asked for, or null if no image rendered. */
function resolvedPath(relativePath: string): string | null {
  const html = renderMarkdown(imageMarkdown(relativePath), {
    documentDir: 'C:/notes',
  } as never);
  const match = /path=([^"&]*)/.exec(html);
  return match ? decodeURIComponent(match[1]!) : null;
}

describe('the inserted markdown, as the preview reads it', () => {
  /**
   * The names that broke it, and the ones that always worked. Every one of these
   * is something Windows produces on its own: the Snipping Tool's default name
   * has two spaces in it, and a second copy of anything gets ` (1)`.
   */
  it.each([
    ['assets/pic.png'],
    ['assets/Screenshot 2026-08-21 120000.png'],
    ['assets/my pic.png'],
    ['assets/pic (1).png'],
    // Parentheses without a space, so this case is not carried by the space
    // rule. CommonMark tolerates *balanced* parens in a bare destination and
    // breaks on an unbalanced one, and a filename gives no reason to expect
    // either -- `Untitled(1).png` and `shot(1.png` are both just names.
    ['assets/pic(1).png'],
    ['assets/shot(1.png'],
    ['assets/shot)2.png'],
    ['assets/caf\u00e9.png'],
    ['assets/pic#1.png'],
    ['assets/pic&x.png'],
    ["assets/it's.png"],
    ['assets/pic+1.png'],
    ['assets/pic,1.png'],
    ['assets/pic[1].png'],
    ['assets/a b (2) #3.png'],
    ['cover.png'],
    ['my images/a shot.png'],
  ])('%s survives the round trip', (relativePath) => {
    expect(resolvedPath(relativePath)).toBe(relativePath);
  });

  /**
   * The plain case stays plain. Angle brackets are correct everywhere, so it
   * would be easy to wrap unconditionally -- but this text goes into a document
   * the user reads and edits, and `![](<assets/pic.png>)` is not what anyone
   * would have typed.
   */
  it('leaves an ordinary path unwrapped', () => {
    expect(imageMarkdown('assets/pic.png')).toBe('![](assets/pic.png)');
  });

  it('wraps a path that would otherwise end early', () => {
    expect(imageMarkdown('assets/my pic.png')).toBe('![](<assets/my pic.png>)');
  });

  /**
   * A filename may legally contain an angle bracket on Linux, and the wrapper is
   * only a wrapper if the contents cannot close it early.
   */
  it('escapes angle brackets inside the wrapper', () => {
    expect(escapeDestination('assets/a <b> c.png')).toBe(
      '<assets/a ' + String.fromCharCode(92) + '<b' + String.fromCharCode(92) + '> c.png>',
    );
  });
});
