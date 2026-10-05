import { defineConfig } from 'vite';

/**
 * A sandboxed preload runs in Electron's restricted CommonJS environment, where `require`
 * only resolves a small allowlist and cannot follow relative paths out of its own
 * directory. So the preload has to be bundled into one self-contained file, with only
 * `electron` left external. This is that bundle.
 */
export default defineConfig({
  build: {
    outDir: 'out/preload',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    lib: {
      entry: 'src/preload/index.ts',
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      // `electron` must stay a real require: it is provided by the runtime.
      external: ['electron'],
      output: {
        // One CJS file is what Electron's sandbox expects.
        codeSplitting: false,
      },
    },
  },
});