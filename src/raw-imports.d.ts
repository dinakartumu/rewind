/**
 * Vite's `?raw` suffix imports a file's contents as a string. Used by
 * config-drift tests that must compare two files as text rather than through a
 * shared constant — see src/__tests__/cron-wiring.test.ts.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
