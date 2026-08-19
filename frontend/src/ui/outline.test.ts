/**
 * The heading scanner, which needs no DOM -- so this file runs under Vitest's
 * default `node` environment. The sidebar that renders these lives beside it in
 * `outline.ts` and is tested separately.
 */
import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { outlineHeadings } from './outline';

const NL = String.fromCharCode(10);

function scan(...lines: string[]): ReturnType<typeof outlineHeadings> {
  return outlineHeadings(Text.of(lines.length === 0 ? [''] : lines));
}

/** Compact form for the common assertion: level, line and text. */
function shape(lines: string[]): string[] {
  return outlineHeadings(Text.of(lines)).map((h) => `${h.level}:${h.line}:${h.text}`);
}

describe('outlineHeadings', () => {
  it('finds every ATX level, in source order', () => {
    expect(shape(['# One', '', '### Three', '', '###### Six', '', '## Two'])).toEqual([
      '1:1:One',
      '3:3:Three',
      '6:5:Six',
      '2:7:Two',
    ]);
  });

  it('has nothing to say about an empty document', () => {
    expect(scan()).toEqual([]);
  });

  /**
   * CommonMark allows up to three spaces of indent; a fourth makes the line an
   * indented code block, where `#` is content. `headingLevelAt`'s regex already
   * draws that line -- this pins that the scanner respects it rather than
   * trimming first and losing the distinction.
   */
  it('respects the three-space indent limit', () => {
    expect(shape(['   # Indented'])).toEqual(['1:1:Indented']);
    expect(shape(['    # Code'])).toEqual([]);
  });

  /** `#hashtag` is not a heading -- CommonMark requires a space or end of line. */
  it('needs a space after the hashes', () => {
    expect(shape(['#hashtag', '# real'])).toEqual(['1:2:real']);
  });

  /** `##` alone is a valid empty heading; a blank sidebar row would look broken. */
  it('falls back to the marker for an empty heading', () => {
    expect(shape(['##'])).toEqual(['2:1:##']);
  });

  it('strips CommonMark’s optional closing hashes', () => {
    expect(shape(['## Title ##'])).toEqual(['2:1:Title']);
    // Not a closing run: no space before it, so it is part of the text.
    expect(shape(['## C#'])).toEqual(['2:1:C#']);
  });

  /**
   * The case that makes a line scan worth writing carefully: a shell script or
   * a Dockerfile in a fenced block is full of `# comments`, and every one of
   * them would otherwise become a sidebar entry.
   */
  it('ignores headings inside fenced code', () => {
    expect(
      shape(['# Real', '', '```sh', '# not a heading', '## nor this', '```', '', '## Also real']),
    ).toEqual(['1:1:Real', '2:8:Also real']);
  });

  it('handles tilde fences, and treats a different fence char as content', () => {
    expect(shape(['~~~', '# hidden', '```', '# still hidden', '~~~', '# Real'])).toEqual([
      '1:6:Real',
    ]);
  });

  /** An unclosed fence swallows the rest of the document, which is what a renderer does too. */
  it('treats an unclosed fence as running to the end', () => {
    expect(shape(['# Real', '```', '# never closed'])).toEqual(['1:1:Real']);
  });

  /**
   * `---` on line 1 opens YAML front matter, whose `title:` is metadata rather
   * than a heading -- `preview/rules/frontmatter.ts` treats it the same way.
   */
  it('skips front matter', () => {
    expect(shape(['---', 'title: My Notes', '# not a heading', '---', '# Real'])).toEqual([
      '1:5:Real',
    ]);
  });

  /** Only at the very top. Anywhere else `---` is a rule or a setext underline. */
  it('does not treat a later --- as front matter', () => {
    expect(shape(['# Real', '', '---', '', '## Also real'])).toEqual(['1:1:Real', '2:5:Also real']);
  });

  it('finds setext headings and reports the line of the text, not the underline', () => {
    expect(shape(['Title', '=====', '', 'Section', '-------'])).toEqual([
      '1:1:Title',
      '2:4:Section',
    ]);
  });

  /**
   * The three ways a run of `-` or `=` is *not* a setext underline. Getting
   * these wrong puts entries in the sidebar that no heading in the document
   * corresponds to, which is worse than missing one.
   */
  it('does not mistake a thematic break for a setext heading', () => {
    // Blank line above: a thematic break.
    expect(shape(['Some text', '', '---'])).toEqual([]);
    // Inside a fence: code.
    expect(shape(['```', 'text', '---', '```'])).toEqual([]);
    // Under an ATX heading: the heading is already counted, and the rule is not
    // a second one.
    expect(shape(['# Heading', '---'])).toEqual(['1:1:Heading']);
  });

  it('does not mistake a table separator for a setext heading', () => {
    expect(shape(['| a | b |', '| --- | --- |', '| 1 | 2 |'])).toEqual([]);
  });

  /**
   * A long document must be scanned whole. This is the case the syntax tree
   * could not be trusted for: CodeMirror parses incrementally and stops at a
   * work budget, so an outline built from `syntaxTree` would end partway down.
   */
  it('scans past any parser budget, to the end of a long document', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 4000; i++) lines.push(i % 100 === 0 ? `## Heading ${i}` : `body ${i}`);

    const headings = outlineHeadings(Text.of(lines));

    expect(headings).toHaveLength(40);
    expect(headings[39]).toEqual({ line: 4000, level: 2, text: 'Heading 4000' });
  });

  it('reads a document that arrives as one string the same way', () => {
    expect(outlineHeadings(Text.of(('# A' + NL + '## B').split(NL)))).toHaveLength(2);
  });
});
