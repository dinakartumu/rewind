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

/**
 * One push from the events feed.
 *
 * IMPORTANT: PushEvent payloads no longer carry a `commits` array. GitHub
 * trimmed the payload down to `before`/`head`/`push_id`/`ref`/`repository_id`
 * (verified across the authenticated feed, the public feed, and the global
 * firehose). Commits are therefore resolved in a second step — see
 * getPushCommits — rather than read straight off the event.
 */
export interface GithubPushRow {
  /** owner/name, from the event's repo.name. */
  repo: string;
  /** Ref tip before the push; NULL_SHA when the push created the branch. */
  before: string;
  /** Ref tip after the push. */
  head: string;
  ref: string;
  /** event.public === false. */
  isPrivate: boolean;
  /** The event's created_at — a fallback timestamp only. */
  pushedAt: string;
}

/** One commit, resolved from the compare API or a repo's commit list. */
export interface GithubCommitRow {
  sha: string;
  /** owner/name. */
  repo: string;
  message: string;
  /** The commit's own author date — not the enclosing push's timestamp. */
  committedAt: string;
  isPrivate: boolean;
  /** author.login; null when the commit email maps to no GitHub account. */
  authorLogin: string | null;
}

/** One repo from the authenticated user's repo list. */
export interface GithubRepoRow {
  /** owner/name. */
  fullName: string;
  isPrivate: boolean;
}

/** Result of a getRecentPushes call, carrying the conditional-request state. */
export interface GithubRecentPushesResult {
  pushes: GithubPushRow[];
  /**
   * ETag for the next If-None-Match. On a 200 it's the fresh response ETag
   * (falling back to the passed-in etag when the header is absent, so a stored
   * etag is never clobbered with null). On a 304 the client echoes the etag it
   * was sent.
   */
  etag: string | null;
  /** True when the server returned 304 Not Modified (empty pushes). */
  notModified: boolean;
}

/** The all-zero SHA GitHub sends as `before` when a push creates a branch. */
export const NULL_SHA = '0000000000000000000000000000000000000000';

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
  errors?: { message?: string }[];
  data?: {
    // null when the login doesn't resolve (misconfigured GITHUB_USERNAME).
    user?: {
      contributionsCollection?: {
        contributionCalendar?: {
          weeks?: { contributionDays?: ContributionDayApi[] }[];
        };
      };
    } | null;
  };
}

interface EventApiItem {
  type?: string;
  public?: boolean;
  created_at?: string;
  repo?: { name?: string };
  payload?: {
    before?: string;
    head?: string;
    ref?: string;
  };
}

/** A commit object as returned by the compare, list-commits, and get-commit APIs. */
interface CommitApiItem {
  sha?: string;
  author?: { login?: string } | null;
  commit?: {
    message?: string;
    author?: { date?: string } | null;
    committer?: { date?: string } | null;
  };
}

interface CompareApiResponse {
  commits?: CommitApiItem[];
}

interface RepoApiItem {
  full_name?: string;
  private?: boolean;
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

const CREATED_AT_QUERY = `query ($login: String!) {
  user(login: $login) {
    createdAt
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
   * Shared GraphQL POST: sends the query + variables, handles rate limiting and
   * transport errors, and surfaces query-level errors (GraphQL returns 200 even
   * for those — the `errors` array is the only signal) and a null user (login
   * didn't resolve → bad GITHUB_USERNAME) as thrown errors.
   */
  private async graphql<
    T extends { errors?: { message?: string }[]; data?: { user?: unknown } },
  >(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    this.throwIfRateLimited(response);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] GitHub GraphQL error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const json = (await response.json()) as T;

    if (json.errors?.length) {
      throw new Error(
        `[ERROR] GitHub GraphQL error: ${json.errors[0].message}`
      );
    }
    if (json.data?.user === null) {
      throw new Error('[ERROR] GitHub GraphQL: user not found');
    }

    return json;
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
    const json = await this.graphql<ContributionsGraphQLResponse>(
      CONTRIBUTIONS_QUERY,
      {
        login: this.username,
        from: toIsoDateTime(from),
        to: toIsoDateTime(to),
      }
    );

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
   * The account's creation timestamp (ISO 8601) via GraphQL `user.createdAt`.
   * Used as the contributions-backfill floor: the walk continues down to the
   * creation year unconditionally, so an intermediate gap year (all-zero
   * contributions) no longer ends the phase and drop older history.
   */
  async getUserCreatedAt(): Promise<string> {
    const json = await this.graphql<{
      errors?: { message?: string }[];
      data?: { user?: { createdAt?: string } | null };
    }>(CREATED_AT_QUERY, { login: this.username });

    const createdAt = json.data?.user?.createdAt;
    if (!createdAt) {
      throw new Error('[ERROR] GitHub GraphQL: createdAt missing');
    }
    return createdAt;
  }

  /**
   * One page of the user's recent events (30/page, ~300 back). PushEvents are
   * mapped to push descriptors; all other event types are ignored. Resolving a
   * push to its commits is a separate call — see getPushCommits.
   *
   * Conditional requests: pass the last-seen `etag` to send If-None-Match. A
   * 304 does NOT count against the rate limit — on 304 we return empty pushes
   * and notModified: true. On a 200 the fresh ETag header is captured for the
   * next call.
   */
  async getRecentPushes(
    page = 1,
    etag?: string
  ): Promise<GithubRecentPushesResult> {
    const headers = this.headers();
    if (etag) headers['If-None-Match'] = etag;

    const response = await fetch(
      `${BASE_URL}/users/${this.username}/events?per_page=30&page=${page}`,
      { headers }
    );

    this.throwIfRateLimited(response);

    if (response.status === 304) {
      return { pushes: [], etag: etag ?? null, notModified: true };
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] GitHub API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    // Fall back to the passed-in etag when the 200 omits an ETag header, so we
    // never overwrite a stored etag with null.
    const newEtag = response.headers.get('ETag') ?? etag ?? null;
    const events = (await response.json()) as EventApiItem[];
    const pushes: GithubPushRow[] = [];
    for (const event of events) {
      if (event.type !== 'PushEvent') continue;
      const repo = event.repo?.name;
      const head = event.payload?.head;
      // Without a repo and a head SHA there is nothing to resolve against.
      if (!repo || !head) continue;
      pushes.push({
        repo,
        before: event.payload?.before ?? NULL_SHA,
        head,
        ref: event.payload?.ref ?? '',
        isPrivate: event.public === false,
        pushedAt: event.created_at ?? '',
      });
    }

    return { pushes, etag: newEtag, notModified: false };
  }

  /** Maps a raw commit object onto a GithubCommitRow. */
  private mapCommit(
    item: CommitApiItem,
    repo: string,
    isPrivate: boolean,
    fallbackDate: string
  ): GithubCommitRow | null {
    if (!item.sha) return null;
    return {
      sha: item.sha,
      repo,
      message: item.commit?.message ?? '',
      committedAt:
        item.commit?.author?.date ??
        item.commit?.committer?.date ??
        fallbackDate,
      isPrivate,
      authorLogin: item.author?.login ?? null,
    };
  }

  /**
   * The commits introduced by one push, via the compare API
   * (`before...head`). This is the only way to recover commit SHAs and
   * messages now that PushEvent payloads omit them.
   *
   * Two cases yield no comparison and fall back to fetching `head` alone: a
   * push that CREATED the branch (`before` is the null SHA, nothing to compare
   * against) and a `before` that no longer resolves (force-pushed and
   * garbage-collected, 404/409). Both undercount a multi-commit push — head is
   * the one commit we can still name — and the commits backfill sweeps up
   * whatever the incremental pass misses.
   *
   * Returns [] rather than throwing when even `head` is unreachable, so one bad
   * push never fails the whole sync.
   */
  async getPushCommits(push: GithubPushRow): Promise<GithubCommitRow[]> {
    if (push.before && push.before !== NULL_SHA) {
      const response = await fetch(
        `${BASE_URL}/repos/${push.repo}/compare/${push.before}...${push.head}`,
        { headers: this.headers() }
      );
      this.throwIfRateLimited(response);

      if (response.ok) {
        const data = (await response.json()) as CompareApiResponse;
        return (data.commits ?? [])
          .map((c) =>
            this.mapCommit(c, push.repo, push.isPrivate, push.pushedAt)
          )
          .filter((c): c is GithubCommitRow => c !== null);
      }

      // 404/409: unreachable base (force-push, GC, empty repo). Fall through
      // to the head-only path. Anything else is a real failure.
      if (response.status !== 404 && response.status !== 409) {
        const errorText = await response.text();
        throw new Error(
          `[ERROR] GitHub API error: ${response.status} ${response.statusText} - ${errorText}`
        );
      }
    }

    const response = await fetch(
      `${BASE_URL}/repos/${push.repo}/commits/${push.head}`,
      { headers: this.headers() }
    );
    this.throwIfRateLimited(response);

    if (response.status === 404 || response.status === 409) return [];
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] GitHub API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as CommitApiItem;
    const mapped = this.mapCommit(
      data,
      push.repo,
      push.isPrivate,
      push.pushedAt
    );
    return mapped ? [mapped] : [];
  }

  /**
   * One page of repos the user owns or can read (100/page), sorted by
   * full_name ascending. The sort matters: it is stable across the lifetime of
   * a backfill, whereas `pushed` reshuffles pages as repos receive commits
   * mid-walk and would silently skip repos.
   */
  async listRepos(page = 1): Promise<GithubRepoRow[]> {
    const params = new URLSearchParams({
      affiliation: 'owner,collaborator,organization_member',
      sort: 'full_name',
      direction: 'asc',
      per_page: '100',
      page: String(page),
    });
    const data = await this.request<RepoApiItem[]>(
      `/user/repos?${params.toString()}`
    );
    return data
      .filter((r): r is RepoApiItem & { full_name: string } =>
        Boolean(r.full_name)
      )
      .map((r) => ({ fullName: r.full_name, isPrivate: r.private === true }));
  }

  /**
   * One page of a repo's commits authored by the user (100/page), newest
   * first. `author` filters server-side by login or commit email, which is why
   * the backfill does not need the incremental path's author screening.
   *
   * Returns [] on 404 (repo gone / no access) and 409 (empty repo) so one bad
   * repo never halts the walk.
   */
  async listRepoCommits(
    repo: GithubRepoRow,
    page = 1
  ): Promise<GithubCommitRow[]> {
    const params = new URLSearchParams({
      author: this.username,
      per_page: '100',
      page: String(page),
    });
    const response = await fetch(
      `${BASE_URL}/repos/${repo.fullName}/commits?${params.toString()}`,
      { headers: this.headers() }
    );
    this.throwIfRateLimited(response);

    if (response.status === 404 || response.status === 409) return [];
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] GitHub API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as CommitApiItem[];
    return data
      .map((c) => this.mapCommit(c, repo.fullName, repo.isPrivate, ''))
      .filter((c): c is GithubCommitRow => c !== null && c.committedAt !== '');
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
    // Space-joined qualifiers; URLSearchParams encodes spaces as `+` and the
    // `:` as %3A, which GitHub's search accepts.
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

const REPO_URL_PREFIX = 'https://api.github.com/repos/';

/** owner/name from a repository_url like https://api.github.com/repos/owner/name. */
function extractRepo(repositoryUrl: string): string {
  // Fail loudly on an unexpected shape rather than silently returning the raw
  // URL as a bogus repo slug.
  if (!repositoryUrl.startsWith(REPO_URL_PREFIX)) {
    throw new Error(
      `[ERROR] GitHub: unexpected repository_url: ${repositoryUrl}`
    );
  }
  return repositoryUrl.slice(REPO_URL_PREFIX.length);
}
