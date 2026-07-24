const BASE_URL = 'https://api.github.com';
const GRAPHQL_URL = 'https://api.github.com/graphql';
const USER_AGENT = 'rewind-sync';
const API_VERSION = '2022-11-28';

/**
 * Thrown when the GitHub API responds 403/429 with `x-ratelimit-remaining: 0`
 * — the primary rate limit is exhausted. The message includes the reset time
 * (epoch seconds from `x-ratelimit-reset`) when present so the sync log shows
 * when the window reopens. The hourly cron retries naturally, so callers throw
 * and let the run fail rather than block on the reset.
 */
export class GithubRateLimitError extends Error {
  constructor(message = 'GitHub rate limit exceeded') {
    super(message);
    this.name = 'GithubRateLimitError';
  }
}

/** One flattened commit from a PushEvent in the events feed. */
export interface GithubCommitRow {
  sha: string;
  /** owner/name, from the event's repo.name. */
  repo: string;
  message: string;
  /** The parent event's created_at (individual commits carry no timestamp). */
  committedAt: string;
  /** event.public === false. */
  isPrivate: boolean;
}

/** Result of a getRecentCommits call, carrying the conditional-request state. */
export interface GithubRecentCommitsResult {
  commits: GithubCommitRow[];
  /** ETag from the response header (for the next If-None-Match); null on 304. */
  etag: string | null;
  /** True when the server returned 304 Not Modified (empty commits). */
  notModified: boolean;
}

/** One mapped item from the Search issues/PRs API. */
export interface GithubItem {
  /** owner/name, extracted from repository_url. */
  repo: string;
  number: number;
  title: string;
  /** 'merged' when a PR's pull_request.merged_at is set, else item.state. */
  state: string;
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  /**
   * Always false at the client layer. The Search Issues/PRs API item exposes
   * only `repository_url` — despite the docs schema listing a `repository`
   * object, the live API item carries NO `repository.private` flag (verified
   * empirically). Per-item probing is deliberately avoided (rate cost). Any
   * visibility refinement, if ever needed, happens at the sync layer.
   */
  isPrivate: boolean;
  /** html_url. */
  url: string;
}

export interface GithubSearchResult {
  items: GithubItem[];
  totalCount: number;
}

interface ContributionDayApi {
  date: string;
  contributionCount: number;
}

interface ContributionsGraphQLResponse {
  data?: {
    user?: {
      contributionsCollection?: {
        contributionCalendar?: {
          weeks?: { contributionDays?: ContributionDayApi[] }[];
        };
      };
    };
  };
}

interface EventApiItem {
  type?: string;
  public?: boolean;
  created_at?: string;
  repo?: { name?: string };
  payload?: {
    commits?: { sha?: string; message?: string }[];
  };
}

interface SearchApiItem {
  repository_url?: string;
  number?: number;
  title?: string;
  state?: string;
  created_at?: string;
  closed_at?: string | null;
  html_url?: string;
  pull_request?: { merged_at?: string | null };
}

interface SearchApiResponse {
  total_count?: number;
  items?: SearchApiItem[];
}

const CONTRIBUTIONS_QUERY = `query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`;

export class GithubClient {
  private token: string;
  private username: string;

  constructor(token: string, username: string) {
    this.token = token;
    this.username = username;
  }

  /** Shared headers for every REST + GraphQL request. */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': API_VERSION,
    };
  }

  /** Throws GithubRateLimitError when a 403/429 carries remaining === '0'. */
  private throwIfRateLimited(response: Response): void {
    if (response.status !== 403 && response.status !== 429) return;
    if (response.headers.get('x-ratelimit-remaining') !== '0') return;
    const reset = response.headers.get('x-ratelimit-reset');
    const resetNote = reset
      ? ` — resets at ${new Date(Number(reset) * 1000).toISOString()}`
      : '';
    throw new GithubRateLimitError(
      `[ERROR] GitHub rate limit exceeded (${response.status})${resetNote}`
    );
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: this.headers(),
    });

    this.throwIfRateLimited(response);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] GitHub API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Daily contribution counts for a window (max 1 year per GraphQL query).
   * Uses contributionsCollection → contributionCalendar, which INCLUDES
   * private contributions when the token has read:user scope. Flattens
   * weeks[] → contributionDays[] into a flat [{ date, count }].
   *
   * from/to must be ISO DateTime strings; date-only inputs (YYYY-MM-DD) are
   * promoted to `<date>T00:00:00Z` since the GraphQL DateTime scalar rejects
   * bare dates.
   */
  async getContributionDays(
    from: string,
    to: string
  ): Promise<Array<{ date: string; count: number }>> {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: CONTRIBUTIONS_QUERY,
        variables: {
          login: this.username,
          from: toIsoDateTime(from),
          to: toIsoDateTime(to),
        },
      }),
    });

    this.throwIfRateLimited(response);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] GitHub GraphQL error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const json = (await response.json()) as ContributionsGraphQLResponse;
    const weeks =
      json.data?.user?.contributionsCollection?.contributionCalendar?.weeks ??
      [];
    const days: Array<{ date: string; count: number }> = [];
    for (const week of weeks) {
      for (const day of week.contributionDays ?? []) {
        days.push({ date: day.date, count: day.contributionCount });
      }
    }
    return days;
  }

  /**
   * One page of the user's recent events (30/page, ~300 back). PushEvents are
   * flattened to commit rows; all other event types are ignored.
   *
   * Conditional requests: pass the last-seen `etag` to send If-None-Match. A
   * 304 does NOT count against the rate limit — on 304 we return empty commits
   * and notModified: true. On a 200 the fresh ETag header is captured for the
   * next call.
   */
  async getRecentCommits(
    page = 1,
    etag?: string
  ): Promise<GithubRecentCommitsResult> {
    const headers = this.headers();
    if (etag) headers['If-None-Match'] = etag;

    const response = await fetch(
      `${BASE_URL}/users/${this.username}/events?per_page=30&page=${page}`,
      { headers }
    );

    this.throwIfRateLimited(response);

    if (response.status === 304) {
      return { commits: [], etag: etag ?? null, notModified: true };
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] GitHub API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const newEtag = response.headers.get('ETag');
    const events = (await response.json()) as EventApiItem[];
    const commits: GithubCommitRow[] = [];
    for (const event of events) {
      if (event.type !== 'PushEvent') continue;
      const repo = event.repo?.name ?? '';
      const committedAt = event.created_at ?? '';
      const isPrivate = event.public === false;
      for (const commit of event.payload?.commits ?? []) {
        if (!commit.sha) continue;
        commits.push({
          sha: commit.sha,
          repo,
          message: commit.message ?? '',
          committedAt,
          isPrivate,
        });
      }
    }

    return { commits, etag: newEtag, notModified: false };
  }

  /**
   * Additions/deletions for a single commit. Returns null on 404/409
   * (force-pushed, empty, or otherwise unreachable commits) rather than
   * throwing, so a missing detail never fails the whole sync.
   */
  async getCommitStats(
    repo: string,
    sha: string
  ): Promise<{ additions: number; deletions: number } | null> {
    const response = await fetch(`${BASE_URL}/repos/${repo}/commits/${sha}`, {
      headers: this.headers(),
    });

    this.throwIfRateLimited(response);

    if (response.status === 404 || response.status === 409) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] GitHub API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as {
      stats?: { additions?: number; deletions?: number };
    };
    return {
      additions: data.stats?.additions ?? 0,
      deletions: data.stats?.deletions ?? 0,
    };
  }

  /**
   * One page of authored PRs or issues via the Search API. Items map to
   * GithubItem; a PR's state becomes 'merged' when pull_request.merged_at is
   * set (the item's own `state` only distinguishes open/closed). The repo is
   * extracted from repository_url; see GithubItem.isPrivate for why visibility
   * defaults to false here.
   */
  async searchAuthored(
    type: 'pr' | 'issue',
    page = 1
  ): Promise<GithubSearchResult> {
    // Space-joined qualifiers; URLSearchParams encodes them as `+`-equivalent
    // %20/%3A which GitHub's search accepts.
    const q = `author:${this.username} type:${type}`;
    const params = new URLSearchParams({
      q,
      sort: 'created',
      order: 'desc',
      per_page: '100',
      page: String(page),
    });

    const data = await this.request<SearchApiResponse>(
      `/search/issues?${params.toString()}`
    );

    const items = (data.items ?? []).map((item): GithubItem => {
      const mergedAt = item.pull_request?.merged_at ?? null;
      return {
        repo: extractRepo(item.repository_url ?? ''),
        number: item.number ?? 0,
        title: item.title ?? '',
        state: mergedAt ? 'merged' : (item.state ?? ''),
        createdAt: item.created_at ?? '',
        closedAt: item.closed_at ?? null,
        mergedAt,
        isPrivate: false,
        url: item.html_url ?? '',
      };
    });

    return { items, totalCount: data.total_count ?? 0 };
  }
}

/** Promotes a date-only string to an ISO DateTime; passes ISO through. */
function toIsoDateTime(value: string): string {
  return value.includes('T') ? value : `${value}T00:00:00Z`;
}

/** owner/name from a repository_url like https://api.github.com/repos/owner/name. */
function extractRepo(repositoryUrl: string): string {
  return repositoryUrl.replace('https://api.github.com/repos/', '');
}
