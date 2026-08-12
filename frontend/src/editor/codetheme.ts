/**
 * The palette for code *inside* fenced blocks — the job CodeMirror's
 * `defaultHighlightStyle` used to do here.
 *
 * Deliberately **unscoped**, unlike `markdownHighlightStyle`. That style
 * carries `scope: markdownLanguage` so its generic-tag rules cannot repaint
 * embedded code; this one exists precisely to reach inside those mounted
 * grammars, so a scope would disable it entirely.
 *
 * The tag list mirrors the shape of `defaultHighlightStyle` rather than
 * inventing one: those are the tags the Lezer grammars actually emit, and a
 * tag with no rule falls back to the editor's foreground, which is a
 * legitimate answer for anything not listed.
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
  { tag: tags.invalid, color: 'var(--syn-code-invalid)' },
]);
