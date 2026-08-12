// markdown-it-mark and markdown-it-footnote ship no types of their own (no
// "types" field in package.json, no .d.ts in dist); each is a markdown-it
// plugin, so `MarkdownIt.PluginSimple` is the correct shape.
declare module 'markdown-it-mark' {
  const plugin: import('markdown-it').PluginSimple;
  export default plugin;
}

declare module 'markdown-it-footnote' {
  const plugin: import('markdown-it').PluginSimple;
  export default plugin;
}
