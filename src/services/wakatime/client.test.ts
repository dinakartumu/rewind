import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WakatimeClient, WakatimeHistoryLimitError } from './client.js';

function durationsResponse(data: unknown[]): Record<string, unknown> {
  return { data };
}

function summariesResponse(data: unknown[]): Record<string, unknown> {
  return { data };
}

describe('WakatimeClient', () => {
  let client: WakatimeClient;

  beforeEach(() => {
    client = new WakatimeClient('waka_test_key');
    vi.restoreAllMocks();
  });

  it('should construct with an API key', () => {
    expect(client).toBeDefined();
  });

  it('should request durations with Basic auth, correct URL, and map items', async () => {
    // slice_by=entity: each item carries a file `entity` and `project`;
    // WakaTime does not include a per-item `language` in the entity slice,
    // so language is null on duration rows (captured via getSummary instead).
    const item = {
      time: 1721725200.5, // 2024-07-23T09:00:00.500Z
      duration: 280.25,
      project: 'rewind',
      entity: '/Users/pat/dev/rewind/src/index.ts',
    };

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(durationsResponse([item])))
      );

    const rows = await client.getDurations('2026-07-23');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain(
      'https://wakatime.com/api/v1/users/current/durations'
    );
    expect(url).toContain('date=2026-07-23');
    expect(url).toContain('slice_by=entity');

    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${btoa('waka_test_key')}`);

    expect(rows).toHaveLength(1);
    expect(rows[0].startTime).toBe('2024-07-23T09:00:00.500Z');
    expect(rows[0].durationSeconds).toBe(280.25);
    expect(rows[0].project).toBe('rewind');
    expect(rows[0].entity).toBe('/Users/pat/dev/rewind/src/index.ts');
    expect(rows[0].language).toBeNull();
  });

  it('should return an empty array when durations data is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(durationsResponse([])))
    );

    const rows = await client.getDurations('2024-07-23');

    expect(rows).toEqual([]);
  });

  it('should map summary to totals with top language and top project', async () => {
    const day = {
      grand_total: { total_seconds: 5000 },
      languages: [
        { name: 'TypeScript', total_seconds: 3000 },
        { name: 'CSS', total_seconds: 500 },
      ],
      projects: [
        { name: 'rewind', total_seconds: 4000 },
        { name: 'other', total_seconds: 1000 },
      ],
      range: { date: '2026-07-23' },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(summariesResponse([day])))
    );

    const summary = await client.getSummary('2026-07-23');

    expect(summary.date).toBe('2026-07-23');
    expect(summary.totalSeconds).toBe(5000);
    expect(summary.topLanguage).toBe('TypeScript');
    expect(summary.topProject).toBe('rewind');
  });

  it('should return null tops when language/project arrays are empty', async () => {
    const day = {
      grand_total: { total_seconds: 0 },
      languages: [],
      projects: [],
      range: { date: '2026-07-23' },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(summariesResponse([day])))
    );

    const summary = await client.getSummary('2026-07-23');

    expect(summary.totalSeconds).toBe(0);
    expect(summary.topLanguage).toBeNull();
    expect(summary.topProject).toBeNull();
  });

  it('should return zeroed totals with null tops when summary data is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(summariesResponse([])))
    );

    const summary = await client.getSummary('2024-07-23');

    expect(summary).toEqual({
      date: '2024-07-23',
      totalSeconds: 0,
      topLanguage: null,
      topProject: null,
    });
  });

  it('should throw WakatimeHistoryLimitError on a 402 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Payment Required', {
        status: 402,
        statusText: 'Payment Required',
      })
    );

    await expect(client.getDurations('2020-01-01')).rejects.toBeInstanceOf(
      WakatimeHistoryLimitError
    );
  });

  it('should throw a generic error containing the status on a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      })
    );

    await expect(client.getDurations('2026-07-23')).rejects.toThrow('500');
  });
});
