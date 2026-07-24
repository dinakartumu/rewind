const BASE_URL = 'https://www.rescuetime.com/anapi';

/**
 * One activity bucket mapped from the RescueTime Analytic Data API
 * (perspective=interval, interval=minute).
 *
 * TIMEZONE: RescueTime returns the Date column in the account's local time
 * with NO offset suffix (e.g. "2026-07-23T09:00:00"). We deliberately do NOT
 * convert: we store the value as-is with '.000Z' appended so it is a valid ISO
 * string, while the wall-clock digits stay account-local. The account timezone
 * is the frame the user thinks in ("I was coding at 9am"), and the API offers
 * no timezone override to normalize against, so any conversion would misrepresent
 * the data. This is documented in schema-doc as "RescueTime-local time stored
 * as ISO".
 */
export interface RescuetimeActivity {
  /** Account-local wall-clock time with '.000Z' appended; see note above. */
  timestamp: string;
  durationSeconds: number;
  activity: string;
  category: string | null;
  /** RescueTime productivity score: -2 (very distracting) .. +2 (very productive). */
  productivity: number;
}

/** One day's productivity pulse mapped from the daily_summary_feed API. */
export interface RescuetimeDailySummary {
  /** YYYY-MM-DD */
  date: string;
  /** 0-100 RescueTime pulse. */
  productivityPulse: number;
}

/**
 * Analytic Data API response. Rows are POSITIONAL arrays; their column order
 * is described by row_headers but is fixed and documented by the API:
 *   [0] Date (account-local, no offset)
 *   [1] Time Spent (seconds)
 *   [2] Number of People
 *   [3] Activity
 *   [4] Category
 *   [5] Productivity (-2..+2)
 * We read by fixed index rather than by row_headers lookup — the order is a
 * stable contract of the API for perspective=interval, restrict_kind=activity.
 */
interface AnalyticDataResponse {
  row_headers?: string[];
  rows?: unknown[][];
}

interface DailySummaryFeedItem {
  date: string;
  productivity_pulse: number;
}

// Positional column indices for perspective=interval activity rows.
const COL_DATE = 0;
const COL_SECONDS = 1;
const COL_ACTIVITY = 3;
const COL_CATEGORY = 4;
const COL_PRODUCTIVITY = 5;

export class RescuetimeClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${BASE_URL}${path}`;
    // RescueTime auth is the key as a query param; no headers required. No 429
    // retry loop: on any non-200 we throw and let the hourly cron retry.
    // SECURITY: the URL must NEVER appear in a thrown error or log — the API
    // key is a query param, so leaking the URL would leak the credential.
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] RescueTime API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Activities for a single day via the Analytic Data API.
   * @param date YYYY-MM-DD (used for both restrict_begin and restrict_end)
   */
  async getActivities(date: string): Promise<RescuetimeActivity[]> {
    const params = new URLSearchParams({
      key: this.apiKey,
      format: 'json',
      perspective: 'interval',
      restrict_kind: 'activity',
      interval: 'minute',
      restrict_begin: date,
      restrict_end: date,
    });
    const data = await this.request<AnalyticDataResponse>(
      `/data?${params.toString()}`
    );
    // Validate the column layout before reading rows by fixed index. If
    // row_headers is present and not the expected 6 columns, the API contract
    // changed and index-based mapping would silently produce garbage.
    if (data.row_headers && data.row_headers.length !== 6) {
      throw new Error(
        `[ERROR] RescueTime API returned unexpected columns: ${data.row_headers.join(', ')}`
      );
    }
    return (data.rows ?? []).map((row) => ({
      // Account-local wall-clock time; append '.000Z' without converting.
      timestamp: `${String(row[COL_DATE])}.000Z`,
      durationSeconds: Number(row[COL_SECONDS]),
      activity: String(row[COL_ACTIVITY]),
      category: row[COL_CATEGORY] == null ? null : String(row[COL_CATEGORY]),
      productivity: Number(row[COL_PRODUCTIVITY]),
    }));
  }

  /**
   * Daily productivity pulse feed (recent ~2 weeks only). Maps each entry to
   * { date, productivityPulse }.
   */
  async getDailySummaries(): Promise<RescuetimeDailySummary[]> {
    const params = new URLSearchParams({ key: this.apiKey });
    const data = await this.request<DailySummaryFeedItem[]>(
      `/daily_summary_feed?${params.toString()}`
    );
    return (data ?? []).map((item) => ({
      date: item.date,
      productivityPulse: item.productivity_pulse,
    }));
  }
}
