import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { syncRuns } from '../db/schema/system.js';

/**
 * Mark a sync run failed, never throwing.
 *
 * Every sync service needs this in its catch block, and the naive version —
 * `await db.update(syncRuns).set({ status: 'failed' })` inline — reintroduces a
 * subtle bug each time it is written out by hand. That update is a D1 round
 * trip, so whatever killed the sync (an exhausted subrequest budget, a killed
 * isolate, a D1 blip) is very likely to kill the bookkeeping too. When it does,
 * the secondary error escapes the catch and replaces the real cause, and the
 * row is stranded at `status: 'running'` forever — which `/v1/health/sync`
 * reports as in-progress, indistinguishable from healthy.
 *
 * That is not hypothetical: it is how the Trakt watch-history sync stayed
 * broken for eleven hours on 2026-07-26 without surfacing anywhere.
 *
 * So: log the secondary failure and move on, leaving the caller free to rethrow
 * the error that actually matters. A run stranded at `running` past a Worker's
 * lifetime is separately reported as `stale` by `GET /v1/health/sync`, which is
 * the backstop for a hard-killed isolate where no application code runs at all.
 *
 * See issue #19.
 */
export async function markRunFailed(
  db: Database,
  runId: number,
  errorMsg: string,
  extra: { itemsSynced?: number } = {}
): Promise<void> {
  try {
    await db
      .update(syncRuns)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMsg,
        ...(extra.itemsSynced !== undefined
          ? { itemsSynced: extra.itemsSynced }
          : {}),
      })
      .where(eq(syncRuns.id, runId));
  } catch (bookkeepingError) {
    const message =
      bookkeepingError instanceof Error
        ? bookkeepingError.message
        : String(bookkeepingError);
    console.log(
      `[ERROR] Could not mark sync run ${runId} failed: ${message} (original error: ${errorMsg})`
    );
  }
}
