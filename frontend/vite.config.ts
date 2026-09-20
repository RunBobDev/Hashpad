/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * The version the About dialog shows, read from `wails.json` at build time.
 *
 * **One source of truth, and it is the file the build already treats as one.**
 * `info.productVersion` is what stamps the Windows version resource on the
 * exe, so reading it here means the dialog and the file's Properties tab
 * cannot disagree -- where a constant in a `.ts` file would be a second place
 * to remember on every release, and would be wrong the first time somebody
 * forgot.
 *
 * Not a Go binding for the same reason it is not a constant: this is a build
 * artifact, known at build time, and an IPC round trip to learn it would be
 * machinery for a string that never changes while the app is running.
 */
const productVersion: string = (
  JSON.parse(readFileSync(new URL('../wails.json', import.meta.url), 'utf8')) as {
    info: { productVersion: string };
  }
).info.productVersion;

/**
 * KaTeX ships each of its twenty faces three times -- woff2, woff and ttf -- and
 * Vite emits every file the bundled CSS references. **Measured: 256 kB of woff2
 * against 817 kB of woff and ttf that WebView2 will never request**, because
 * Chromium has read woff2 since version 36 and picks the first `src` it
 * understands. WebKitGTK, for the Linux build, has since 2015.
 *
 * So the other two formats are pure binary size, and the binary has a 25 MB
 * budget (SPEC §2.3) that Mermaid is about to want a large share of. Dropping
 * the fallbacks from the `src` list is what stops Vite emitting them; nothing
 * else in the stylesheet changes, and the first entry -- the one that is
 * actually used -- is untouched.
 */
function katexWoff2Only() {
  return {
    name: 'hashpad-katex-woff2-only',
    // **`pre`, or this does nothing.** Vite's own `vite:css` plugin resolves
    // `url()` references and registers the assets to emit; a transform running
    // after it is editing a string whose side effects have already happened.
    // Measured: without this the woff and ttf files were still emitted.
    enforce: 'pre' as const,
    transform(code: string, id: string): string | null {
      // The id arrives with Vite's own query suffix attached (`?used`, and
      // others), so it is stripped before matching rather than matched around.
      const path = id.split('?')[0]!.replace(/\\/g, '/');
      if (!path.endsWith('katex/dist/katex.min.css')) return null;
      return code.replace(/,url\([^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '');
    },
  };
}

export default defineConfig({
  plugins: [katexWoff2Only()],
  define: {
    __APP_VERSION__: JSON.stringify(productVersion),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Vite's default modulePreload injects a polyfill that calls fetch() to
    // detect <link rel="modulepreload"> support. It never actually fires here
    // (single bundle, no cross-chunk preloading), but its mere presence in the
    // shipped JS is the one thing that stops "grep the bundle for a network
    // call" from being a clean, provable check — and zero-network-provable is
    // the whole point (design §2.4). Disabling it removes the call entirely
    // rather than relying on "it's inert" as the argument.
    modulePreload: { polyfill: false },
    // WebView2 is evergreen Chromium, but WebKitGTK on Linux trails it. es2022
    // is the newest target both support, so the Linux port needs no build change.
    target: 'es2022',
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      // Single core bundle (design §2.4): assets come from Go's embedded handler,
      // so there is no HTTP waterfall to amortise and per-chunk overhead is pure
      // cost. Lazy import() is reserved for the preview module (F), language
      // modes (D), and Phase 2's KaTeX/Mermaid.
      output: { manualChunks: undefined },
    },
  },
  test: {
    // Commands and the store are pure functions by design, so no DOM is needed
    // and tests stay fast (design §5.4). Most tests are like this — DOM tests
    // are the exception, so they opt in per file with a
    // `// @vitest-environment jsdom` docblock on line 1 instead of flipping
    // this default. Do NOT change this to 'jsdom' to make DOM tests "just
    // work": that switches every test in the suite onto jsdom's slower setup,
    // including the pure ones that never needed it.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Polyfills the two `Range` methods jsdom omits and CodeMirror's measure
    // phase calls. Inert under the `node` environment above -- see the file.
    setupFiles: ['./src/test-setup.ts'],
  },
});
