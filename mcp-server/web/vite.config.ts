import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Vite config for building MCP Apps UI bundles.
 *
 * Each `ui://` resource gets its own HTML entry file in this directory.
 * Select which one to build by setting INPUT:
 *
 *   INPUT=hello.html          npm run build:web  (Phase 1)
 *   INPUT=recent-watches.html npm run build:web  (Phase 2)
 *
 * vite-plugin-singlefile inlines all JS/CSS into one HTML file that the
 * Cloudflare Worker serves via the ASSETS binding at request time.
 */
const webRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  const input = process.env.INPUT ?? 'recent-watches.html';
  return {
    root: webRoot,
    plugins: [react(), viteSingleFile()],
    build: {
      outDir: resolve(webRoot, 'dist'),
      emptyOutDir: false, // preserve other built entries when building one at a time
      rollupOptions: {
        input: resolve(webRoot, input),
      },
    },
  };
});
