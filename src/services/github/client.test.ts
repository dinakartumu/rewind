import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GithubClient, GithubRateLimitError } from './client.js';

/** Minimal GraphQL contributions calendar: 2 weeks, 2 days each. */
function contributionsResponse(): Record<string, unknown> {
  return {
    data: {
      user: {
        contributionsCollection: {
          contributionCalendar: {
            weeks: [
              {
                contributionDays: [
                  { date: '2026-07-20', contributionCount: 3 },
                  { date: '2026-07-21', contributionCount: 0 },
                ],
              },
              {
                contributionDays: [
                  { date: '2026-07-22', contributionCount: 5 },
                  { date: '2026-07-23', contributionCount: 1 },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** Events feed: one PushEvent (2 commits), one WatchEvent to ignore. */
function eventsResponse(): unknown[] {
  return [
    {
      type: 'PushEvent',
      public: false,
      created_at: '2026-07-23T09:00:00Z',
      repo: { name: 'pat/rewind' },
      payload: {
        commits: [
          { sha: 'aaa111', message: 'first commit\nbody' },
          { sha: 'bbb222', message: 'second commit' },
        ],
      },
    },
    {
      type: 'WatchEvent',
      public: true,
      created_at: '2026-07-23T08:00:00Z',
      repo: { name: 'someone/other' },
      payload: {},
    },
  ];
}

/** One search page with a merged PR and an open PR. */
function searchResponse(): Record<string, unknown> {
  return {
    total_count: 2,
    items: [
      {
        repository_url: 'https://api.github.com/repos/pat/rewind',
        number: 42,
        title: 'Add coding domain',
        state: 'closed',
        created_at: '2026-07-20T10:00:00Z',
        closed_at: '2026-07-22T12:00:00Z',
        html_url: 'https://github.com/pat/rewind/pull/42',
        pull_request: {
          merged_at: '2026-07-22T12:00:00Z',
          html_url: 'https://github.com/pat/rewind/pull/42',
        },
      },
      {
        repository_url: 'https://api.github.com/repos/pat/other',
        number: 7,
        title: 'Open PR',
        state: 'open',
        created_at: '2026-07-21T10:00:00Z',
        closed_at: null,
        html_url: 'https://github.com/pat/other/pull/7',
        pull_request: { merged_at: null },
      },
    ],
  };
}

describe('GithubClient', () => {
  let client: GithubClient;

  beforeEach(() => {
    client = new GithubClient('gh_test_token', 'patuser');
    vi.restoreAllMocks();
  });

  it('should construct with a token and username', () => {
    expect(client).toBeDefined();
  });

  it('should POST GraphQL with contributionsCollection and login/from/to variables', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(contributionsResponse())));

    await client.getContributionDays('2026-07-20', '2026-07-23');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    const init = options as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer gh_test_token');
    const body = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain('contributionsCollection');
    expect(body.query).toContain('contributionCalendar');
    expect(body.variables.login).toBe('patuser');
    // Date-only inputs are promoted to ISO DateTime for the GraphQL args.
    expect(body.variables.from).toBe('2026-07-20T00:00:00Z');
    expect(body.variables.to).toBe('2026-07-23T00:00:00Z');
  });

  it('should flatten weeks -> days into { date, count }', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(contributionsResponse()))
    );

    const days = await client.getContributionDays('2026-07-20', '2026-07-23');

    expect(days).toEqual([
      { date: '2026-07-20', count: 3 },
      { date: '2026-07-21', count: 0 },
      { date: '2026-07-22', count: 5 },
      { date: '2026-07-23', count: 1 },
    ]);
  });

  it('should pass through already-ISO from/to datetimes unchanged', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(contributionsResponse())));

    await client.getContributionDays(
      '2026-07-20T05:00:00Z',
      '2026-07-23T05:00:00Z'
    );

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables.from).toBe('2026-07-20T05:00:00Z');
    expect(body.variables.to).toBe('2026-07-23T05:00:00Z');
  });

  it('should request events with the right URL + REST headers', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(eventsResponse())));

    await client.getRecentCommits();

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('https://api.github.com/users/patuser/events');
    expect(url).toContain('per_page=30');
    expect(url).toContain('page=1');
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer gh_test_token');
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('rewind-sync');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('should flatten PushEvents to commits and ignore non-push events', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(eventsResponse()))
    );

    const { commits, notModified } = await client.getRecentCommits(2);

    expect(notModified).toBe(false);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: 'aaa111',
      repo: 'pat/rewind',
      message: 'first commit\nbody',
      committedAt: '2026-07-23T09:00:00Z',
      isPrivate: true,
    });
    expect(commits[1]).toEqual({
      sha: 'bbb222',
      repo: 'pat/rewind',
      message: 'second commit',
      committedAt: '2026-07-23T09:00:00Z',
      isPrivate: true,
    });
  });

  it('should send If-None-Match when an etag is provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(eventsResponse()), {
        headers: { ETag: '"newtag"' },
      })
    );

    await client.getRecentCommits(1, '"oldtag"');

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"oldtag"');
  });

  it('should capture the ETag from a 200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(eventsResponse()), {
        status: 200,
        headers: { ETag: '"freshtag"' },
      })
    );

    const result = await client.getRecentCommits(1);

    expect(result.etag).toBe('"freshtag"');
    expect(result.notModified).toBe(false);
    expect(result.commits).toHaveLength(2);
  });

  it('should return notModified with empty commits on a 304', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { ETag: '"oldtag"' },
      })
    );

    const result = await client.getRecentCommits(1, '"oldtag"');

    expect(result.notModified).toBe(true);
    expect(result.commits).toEqual([]);
    expect(result.etag).toBe('"oldtag"');
  });

  it('should map search items incl. merged-state derivation and repo extraction', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(searchResponse())));

    const { items, totalCount } = await client.searchAuthored('pr');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('https://api.github.com/search/issues');
    expect(url).toContain('author%3Apatuser');
    expect(url).toContain('type%3Apr');
    expect(url).toContain('sort=created');
    expect(url).toContain('order=desc');
    expect(url).toContain('per_page=100');

    expect(totalCount).toBe(2);
    expect(items[0]).toEqual({
      repo: 'pat/rewind',
      number: 42,
      title: 'Add coding domain',
      state: 'merged',
      createdAt: '2026-07-20T10:00:00Z',
      closedAt: '2026-07-22T12:00:00Z',
      mergedAt: '2026-07-22T12:00:00Z',
      isPrivate: false,
      url: 'https://github.com/pat/rewind/pull/42',
    });
    expect(items[1].state).toBe('open');
    expect(items[1].mergedAt).toBeNull();
    expect(items[1].repo).toBe('pat/other');
  });

  it('should derive issue state from item.state (no merged concept)', async () => {
    const page = {
      total_count: 1,
      items: [
        {
          repository_url: 'https://api.github.com/repos/pat/rewind',
          number: 99,
          title: 'A bug',
          state: 'closed',
          created_at: '2026-07-19T10:00:00Z',
          closed_at: '2026-07-20T10:00:00Z',
          html_url: 'https://github.com/pat/rewind/issues/99',
        },
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(page))
    );

    const { items } = await client.searchAuthored('issue');

    expect(items[0].state).toBe('closed');
    expect(items[0].mergedAt).toBeNull();
  });

  it('should throw GithubRateLimitError on 403 with x-ratelimit-remaining 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1784880626',
        },
      })
    );

    await expect(client.searchAuthored('pr')).rejects.toBeInstanceOf(
      GithubRateLimitError
    );
  });

  it('should throw GithubRateLimitError on 429 with x-ratelimit-remaining 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('rate limited', {
        status: 429,
        headers: { 'x-ratelimit-remaining': '0' },
      })
    );

    await expect(client.getRecentCommits()).rejects.toBeInstanceOf(
      GithubRateLimitError
    );
  });

  it('should throw a generic error with status on other non-ok responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('server error', {
        status: 500,
        statusText: 'Internal Server Error',
      })
    );

    await expect(client.getRecentCommits()).rejects.toThrow('500');
  });

  it('should return commit stats additions/deletions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ stats: { additions: 10, deletions: 3 } }))
    );

    const stats = await client.getCommitStats('pat/rewind', 'aaa111');

    expect(stats).toEqual({ additions: 10, deletions: 3 });
  });

  it('should return null from getCommitStats on a 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 })
    );

    const stats = await client.getCommitStats('pat/rewind', 'deadbeef');

    expect(stats).toBeNull();
  });

  it('should return null from getCommitStats on a 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Conflict', { status: 409 })
    );

    const stats = await client.getCommitStats('pat/rewind', 'deadbeef');

    expect(stats).toBeNull();
  });
});
