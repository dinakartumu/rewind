import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Two projects so node tests stay in the default node environment while the
// web component render tests get a real DOM (happy-dom) plus the React/JSX
// transform. Splitting by project keeps the existing 119 node tests untouched
// and confines the DOM env + react plugin to the web render suite.
export default defineConfig({
  test: {
    projects: [
      {
        // Node suite: existing MCP tests + the pure detector unit tests.
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'web/**/*.test.ts'],
        },
      },
      {
        // Web render suite: mounts React components in a headless DOM.
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['web/**/*.test.tsx'],
        },
      },
    ],
  },
});
