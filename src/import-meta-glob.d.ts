/**
 * Vite's `import.meta.glob`. Used by structural tests that assert a pattern
 * holds across every file in a directory — see src/lib/sync-run.test.ts, which
 * scans all sync services to prove none hand-rolls its failure bookkeeping.
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { query?: string; import?: string; eager?: boolean }
  ): Record<string, T>;
}
