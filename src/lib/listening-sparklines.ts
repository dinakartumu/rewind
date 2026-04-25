import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { lastfmScrobbles, lastfmTracks } from '../db/schema/lastfm.js';

export type SparklineGranularity = 'day' | 'week';
export type SparklinePeriod = '1month' | '3month' | '6month' | '12month';

export const SPARKLINE_PERIODS: readonly SparklinePeriod[] = [
  '1month',
  '3month',
  '6month',
  '12month',
];

export function isSparklinePeriod(period: string): period is SparklinePeriod {
  return (SPARKLINE_PERIODS as readonly string[]).includes(period);
}

const PERIOD_CONFIG: Record<
  SparklinePeriod,
  { granularity: SparklineGranularity; bucketCount: number }
> = {
  '1month': { granularity: 'day', bucketCount: 28 },
  '3month': { granularity: 'week', bucketCount: 13 },
  '6month': { granularity: 'week', bucketCount: 26 },
  '12month': { granularity: 'week', bucketCount: 52 },
};

interface PeriodWindow {
  /** ISO 8601, inclusive lower bound on scrobbled_at. */
  from: string;
  /** ISO 8601, exclusive upper bound on scrobbled_at. */
  to: string;
  granularity: SparklineGranularity;
  bucketCount: number;
  /** Canonical bucket keys, oldest -> newest, length === bucketCount. */
  bucketKeys: string[];
}

/**
 * Convert a sparkline period to a UTC time window plus the canonical bucket
 * keys the SQL aggregate is expected to emit. JS bucket keys are generated
 * to match SQLite's strftime / weekday-0/-6-days output verbatim, so the
 * zero-fill step can index reliably.
 */
export function periodToWindow(
  period: SparklinePeriod,
  now: Date = new Date()
): PeriodWindow {
  const { granularity, bucketCount } = PERIOD_CONFIG[period];

  // Anchor to UTC midnight of "today" so all bucket math sits on day boundaries.
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );

  if (granularity === 'day') {
    const bucketKeys: string[] = [];
    for (let i = bucketCount - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      bucketKeys.push(toIsoDate(d));
    }
    const fromDate = new Date(today);
    fromDate.setUTCDate(fromDate.getUTCDate() - (bucketCount - 1));
    const toDate = new Date(today);
    toDate.setUTCDate(toDate.getUTCDate() + 1);
    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      granularity,
      bucketCount,
      bucketKeys,
    };
  }

  // Weekly: anchor each bucket on the Monday of that week, matching the
  // SQL `date(..., 'weekday 0', '-6 days')` expression.
  const dayOfWeek = today.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const currentMonday = new Date(today);
  currentMonday.setUTCDate(currentMonday.getUTCDate() - daysSinceMonday);

  const bucketKeys: string[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    const d = new Date(currentMonday);
    d.setUTCDate(d.getUTCDate() - i * 7);
    bucketKeys.push(toIsoDate(d));
  }
  const fromDate = new Date(currentMonday);
  fromDate.setUTCDate(fromDate.getUTCDate() - (bucketCount - 1) * 7);
  const toDate = new Date(currentMonday);
  toDate.setUTCDate(toDate.getUTCDate() + 7);
  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    granularity,
    bucketCount,
    bucketKeys,
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface SparklineSeries {
  granularity: SparklineGranularity;
  points: number[];
}

/**
 * For each artist in `artistIds`, return a zero-filled play-count series over
 * the period's window. Single SQL aggregate; missing buckets fill with 0.
 *
 * Joins through lastfm_tracks so we can scope by artist_id, and excludes
 * filtered tracks (`is_filtered = 0`) to match the convention used elsewhere.
 */
export async function buildSparklines(
  db: Database,
  artistIds: number[],
  period: SparklinePeriod,
  now: Date = new Date()
): Promise<Map<number, SparklineSeries>> {
  if (artistIds.length === 0) return new Map();

  const window = periodToWindow(period, now);
  const bucketSql =
    window.granularity === 'day'
      ? `strftime('%Y-%m-%d', ${lastfmScrobbles.scrobbledAt.name})`
      : `date(${lastfmScrobbles.scrobbledAt.name}, 'weekday 0', '-6 days')`;

  const rows = await db
    .select({
      artistId: lastfmTracks.artistId,
      bucket: sql<string>`${sql.raw(bucketSql)}`.as('bucket'),
      plays: sql<number>`count(*)`.as('plays'),
    })
    .from(lastfmScrobbles)
    .innerJoin(lastfmTracks, eq(lastfmScrobbles.trackId, lastfmTracks.id))
    .where(
      and(
        inArray(lastfmTracks.artistId, artistIds),
        gte(lastfmScrobbles.scrobbledAt, window.from),
        lt(lastfmScrobbles.scrobbledAt, window.to),
        eq(lastfmTracks.isFiltered, 0)
      )
    )
    .groupBy(lastfmTracks.artistId, sql.raw(bucketSql));

  const counts = new Map<number, Map<string, number>>();
  for (const row of rows) {
    let inner = counts.get(row.artistId);
    if (!inner) {
      inner = new Map();
      counts.set(row.artistId, inner);
    }
    inner.set(row.bucket, Number(row.plays));
  }

  const result = new Map<number, SparklineSeries>();
  for (const artistId of artistIds) {
    const inner = counts.get(artistId);
    const points = window.bucketKeys.map((key) => inner?.get(key) ?? 0);
    result.set(artistId, {
      granularity: window.granularity,
      points,
    });
  }
  return result;
}
