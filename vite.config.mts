import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Renderer only. The Electron main/preload bundles are produced by `tsc` (see tsconfig.electron.json)
// because they must be CommonJS for `sandbox: true` preloads.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  build: {
    // Must live next to the tsc output: package.json main is out/main/index.js and the
    // main process serves the renderer from out/renderer through the app:// scheme.
    outDir: 'out/renderer',
    emptyOutDir: true,
    target: 'chrome128',
    assetsInlineLimit: 4096,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});