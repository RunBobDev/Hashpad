/**
 * The palette for code *inside* fenced blocks — the job CodeMirror's
 * `defaultHighlightStyle` used to do here.
 *
 * Deliberately **unscoped**, unlike `markdownHighlightStyle`. That style
 * carries `scope: markdownLanguage` so its generic-tag rules cannot repaint
 * embedded code; this one exists precisely to reach inside those mounted
 * grammars, so a scope would disable it entirely.
 *
 * The tag list covers what `defaultHighlightStyle` covered, and the coverage
 * is checked rather than asserted: `codetheme.test.ts` renders a fence per
 * language and fails on a construct that used to be coloured and no longer is.
 * A tag with no rule inherits the editor's foreground, which is a legitimate
 * answer for a construct nobody needs to pick out — but it is only legitimate
 * when it is a decision, and the first draft of this file lost `diff` fences
 * entirely by omitting two tags.
 */
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--syn-code-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syn-code-string)' },
  { tag: [tags.number, tags.bool, tags.atom, tags.literal], color: 'var(--syn-code-literal)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syn-code-comment)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
    color: 'var(--syn-code-function)',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syn-code-type)' },
  {
    tag: [tags.variableName, tags.propertyName, tags.definition(tags.variableName)],
    color: 'var(--syn-code-variable)',
  },
  // A ```diff fence is the whole reason these two are here. `inserted` and
  // `deleted` descend from nothing this file otherwise claims, so without them
  // a diff block renders as undifferentiated prose -- added and removed lines
  // the same colour, which is worse than no highlighting at all because it
  // looks deliberate.
  { tag: tags.inserted, color: 'var(--syn-code-inserted)' },
  { tag: tags.deleted, color: 'var(--syn-code-deleted)' },
  // `meta` covers `<!DOCTYPE html>`, a `#!/bin/sh` shebang, a Python
  // decorator's `@`, and diff hunk headers -- structural annotations rather
  // than code, so they take the comment colour.
  //
  // `processingInstruction` descends from `meta`, and *markdown's* markers
  // carry it. This rule therefore contests every `#`, `>` and backtick in the
  // document with `markdownHighlightStyle`'s own -- which wins, because it is
  // registered first and so lands later in the stylesheet. That ordering is
  // load-bearing and `highlight.test.ts` pins it; if this rule ever starts
  // painting markdown markers, that test is where it will show.
  { tag: [tags.meta, tags.labelName], color: 'var(--syn-code-comment)' },
  { tag: tags.invalid, color: 'var(--syn-code-invalid)' },
]);
