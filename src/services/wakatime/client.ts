const BASE_URL = 'https://wakatime.com/api/v1';

/**
 * Thrown on a 402 Payment Required from the WakaTime API, which signals a
 * request past the free-plan history window (~2 weeks). Backfill treats this
 * as the stop signal: there is no more accessible history to walk back into.
 */
export class WakatimeHistoryLimitError extends Error {
  constructor(
    message = 'WakaTime history limit reached (402 Payment Required)'
  ) {
    super(message);
    this.name = 'WakatimeHistoryLimitError';
  }
}

/**
 * One duration slice mapped from the WakaTime Durations API.
 *
 * The Durations API slices by a single primary key (`slice_by`). We request
 * `slice_by=entity` so each row is a contiguous stretch of activity in one
 * file — carrying both `entity` (file path) and `project`, which matches the
 * (start_time, project, entity) dedup key of the wakatime_durations table.
 * WakaTime does NOT include a per-item `language` in the entity slice, so
 * `language` is always null here; per-day language is captured separately via
 * `getSummary`'s top_language. (Verified against
 * https://wakatime.com/developers#durations — slice_by controls the primary
 * segmentation; only the sliced dimension plus project/time/duration are
 * reliably present per item.)
 */
export interface WakatimeDurationRow {
  /** ISO 8601 string derived from the item's `time` epoch float. */
  startTime: string;
  durationSeconds: number;
  project: string | null;
  /** Null on entity-sliced durations; see the interface note above. */
  language: string | null;
  /** File path (or domain) for the slice. */
  entity: string | null;
}

/** One per-language total mapped from the summary's `languages[]`. */
export interface WakatimeLanguageTotal {
  name: string;
  totalSeconds: number;
}

/** Per-day rollup mapped from the WakaTime Summaries API. */
export interface WakatimeSummary {
  /** YYYY-MM-DD */
  date: string;
  totalSeconds: number;
  /** Highest-total language for the day; null when the day has no data. */
  topLanguage: string | null;
  /** Highest-total project for the day; null when the day has no data. */
  topProject: string | null;
  /**
   * Full per-language breakdown for the day (materialized into
   * wakatime_daily_languages). Empty when the day has no data. Duration
   * rows never carry language (entity slice), so this is the sole source of
   * per-language time.
   */
  languages: WakatimeLanguageTotal[];
}

interface DurationsApiItem {
  time: number;
  duration: number;
  project?: string;
  language?: string;
  entity?: string;
}

interface SummaryApiNamedTotal {
  name: string;
  total_seconds: number;
}

interface SummaryApiDay {
  grand_total?: { total_seconds?: number };
  languages?: SummaryApiNamedTotal[];
  projects?: SummaryApiNamedTotal[];
  range?: { date?: string };
}

export class WakatimeClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        // WakaTime uses HTTP Basic auth with the API key as the username
        // (base64 of the raw key). No 429 retry loop: on 429 we throw and let
        // the hourly cron retry naturally.
        Authorization: `Basic ${btoa(this.apiKey)}`,
      },
    });

    if (response.status === 402) {
      throw new WakatimeHistoryLimitError();
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] WakaTime API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Durations for a single day, sliced by entity (see WakatimeDurationRow).
   *
   * We pass `timezone=UTC` (WakaTime's documented optional param, defaulting
   * to the account timezone otherwise) so the API's notion of "this day"
   * matches the UTC delete windows in sync.ts (dayBounds). Delete-window
   * agreement is load-bearing: on a non-UTC account, WakaTime would return the
   * day in account-local time while the sync deletes/reinserts in UTC, so the
   * boundary-hour slices (the local day's edges that fall in a neighboring UTC
   * day) would be silently dropped or double-counted.
   * @param date YYYY-MM-DD
   */
  async getDurations(date: string): Promise<WakatimeDurationRow[]> {
    const params = new URLSearchParams({
      date,
      slice_by: 'entity',
      timezone: 'UTC',
    });
    const data = await this.request<{ data: DurationsApiItem[] }>(
      `/users/current/durations?${params.toString()}`
    );
    return (data.data ?? []).map((item) => ({
      startTime: new Date(Math.round(item.time * 1000)).toISOString(),
      durationSeconds: item.duration,
      project: item.project ?? null,
      language: item.language ?? null,
      entity: item.entity ?? null,
    }));
  }

  /**
   * Summary rollup for a single day (start == end).
   *
   * We pass `timezone=UTC` (WakaTime's documented optional param, defaulting
   * to the account timezone otherwise) so the summary's day matches the UTC
   * delete windows in sync.ts (dayBounds) — the same delete-window agreement
   * getDurations relies on. Without it, a non-UTC account would total the
   * account-local day, disagreeing with the UTC-bounded duration rows and the
   * per-language rows rebuilt from this summary.
   * @param date YYYY-MM-DD
   */
  async getSummary(date: string): Promise<WakatimeSummary> {
    const params = new URLSearchParams({
      start: date,
      end: date,
      timezone: 'UTC',
    });
    const data = await this.request<{ data: SummaryApiDay[] }>(
      `/users/current/summaries?${params.toString()}`
    );
    const day = data.data?.[0];
    return {
      date: day?.range?.date ?? date,
      totalSeconds: day?.grand_total?.total_seconds ?? 0,
      topLanguage: topBySeconds(day?.languages),
      topProject: topBySeconds(day?.projects),
      languages: (day?.languages ?? []).map((l) => ({
        name: l.name,
        totalSeconds: l.total_seconds,
      })),
    };
  }

  /**
   * The earliest date WakaTime holds data for this account, from the All Time
   * Since Today endpoint's `data.range.start_date` (YYYY-MM-DD). Used as the
   * backfill floor: the walk terminates when the cursor passes below it, so a
   * multi-week vacation gap no longer looks like the end of history.
   *
   * Returns { startDate: null } when the field is absent (new/empty accounts),
   * signalling "no floor" — the backfill then falls back to stopping after an
   * empty chunk.
   */
  async getAllTimeSinceToday(): Promise<{ startDate: string | null }> {
    const data = await this.request<{
      data?: { range?: { start_date?: string } };
    }>('/users/current/all_time_since_today');
    return { startDate: data.data?.range?.start_date ?? null };
  }
}

/** Returns the name with the highest total_seconds, or null when empty. */
function topBySeconds(items?: SummaryApiNamedTotal[]): string | null {
  if (!items || items.length === 0) return null;
  return items.reduce((top, cur) =>
    cur.total_seconds > top.total_seconds ? cur : top
  ).name;
}
