import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Local design workbench for MCP UI components in ../web/.
 *
 * Imports the display components (PosterGrid, GameCard, etc.) directly with
 * fixture data — no MCP transport, no useApp(). This is the "HMR" render mode:
 * fast designer feedback at the cost of not exercising the entry-level
 * connect/error/loading states. A future iframe-mode toggle will load the
 * production-built dist/*.html bundles for byte-exact verification.
 */
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5174,
    open: true,
  },
  resolve: {
    alias: {
      // ../web/components/X.tsx files import from './X.js' for NodeNext
      // resolution in production builds. Vite's default resolver handles this
      // fine without extra config; alias intentionally minimal.
      '@web': resolve(root, '..', 'web'),
    },
  },
});
