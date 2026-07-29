/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
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
    // and tests stay fast (design §5.4).
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
