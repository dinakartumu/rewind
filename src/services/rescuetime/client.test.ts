import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RescuetimeClient } from './client.js';

/**
 * The Analytic Data API returns positional row arrays whose column order is
 * described by row_headers. We include row_headers in the fixture to document
 * the mapping, but the client reads by fixed positional index (see client.ts
 * for the documented assumption).
 */
function dataResponse(rows: unknown[][]): Record<string, unknown> {
  return {
    row_headers: [
      'Date',
      'Time Spent (seconds)',
      'Number of People',
      'Activity',
      'Category',
      'Productivity',
    ],
    rows,
  };
}

describe('RescuetimeClient', () => {
  let client: RescuetimeClient;

  beforeEach(() => {
    client = new RescuetimeClient('rescue_test_key');
    vi.restoreAllMocks();
  });

  it('should request activities with all query params and map positional rows', async () => {
    const row = ['2026-07-23T09:00:00', 280, 1, 'VS Code', 'Editing & IDEs', 2];

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(dataResponse([row]))));

    const activities = await client.getActivities('2026-07-23');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    const urlStr = String(url);
    expect(urlStr).toContain('https://www.rescuetime.com/anapi/data');
    expect(urlStr).toContain('key=rescue_test_key');
    expect(urlStr).toContain('format=json');
    expect(urlStr).toContain('perspective=interval');
    expect(urlStr).toContain('restrict_kind=activity');
    expect(urlStr).toContain('interval=minute');
    expect(urlStr).toContain('restrict_begin=2026-07-23');
    expect(urlStr).toContain('restrict_end=2026-07-23');

    expect(activities).toHaveLength(1);
    // RescueTime returns account-local time with no offset; stored as-is with
    // '.000Z' appended (no timezone conversion — the account timezone is what
    // the user thinks in).
    expect(activities[0].timestamp).toBe('2026-07-23T09:00:00.000Z');
    expect(activities[0].durationSeconds).toBe(280);
    expect(activities[0].activity).toBe('VS Code');
    expect(activities[0].category).toBe('Editing & IDEs');
    expect(activities[0].productivity).toBe(2);
  });

  it('should return an empty array when rows is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(dataResponse([])))
    );

    const activities = await client.getActivities('2026-07-23');

    expect(activities).toEqual([]);
  });

  it('should return an empty array when rows is absent entirely', async () => {
    // A well-formed response with row_headers but no rows key at all.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          row_headers: [
            'Date',
            'Time Spent (seconds)',
            'Number of People',
            'Activity',
            'Category',
            'Productivity',
          ],
        })
      )
    );

    const activities = await client.getActivities('2026-07-23');

    expect(activities).toEqual([]);
  });

  it('should map a null category cell to null', async () => {
    const row = ['2026-07-23T09:00:00', 280, 1, 'VS Code', null, 2];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(dataResponse([row])))
    );

    const activities = await client.getActivities('2026-07-23');

    expect(activities).toHaveLength(1);
    expect(activities[0].category).toBeNull();
  });

  it('should throw when row_headers has an unexpected column count', async () => {
    // A five-column response — the API contract changed; mapping by fixed
    // index would silently produce garbage, so the client must reject it.
    const fiveColumnResponse = {
      row_headers: [
        'Date',
        'Time Spent (seconds)',
        'Activity',
        'Category',
        'Productivity',
      ],
      rows: [['2026-07-23T09:00:00', 280, 'VS Code', 'Editing & IDEs', 2]],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(fiveColumnResponse))
    );

    await expect(client.getActivities('2026-07-23')).rejects.toThrow(
      'unexpected columns'
    );
  });

  it('should map daily summary feed to { date, productivityPulse }', async () => {
    const feed = [
      { date: '2026-07-23', productivity_pulse: 71, other_field: 'ignored' },
      { date: '2026-07-22', productivity_pulse: 64 },
    ];

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(feed)));

    const summaries = await client.getDailySummaries();

    const [url] = fetchSpy.mock.calls[0];
    const urlStr = String(url);
    expect(urlStr).toContain(
      'https://www.rescuetime.com/anapi/daily_summary_feed'
    );
    expect(urlStr).toContain('key=rescue_test_key');

    expect(summaries).toEqual([
      { date: '2026-07-23', productivityPulse: 71 },
      { date: '2026-07-22', productivityPulse: 64 },
    ]);
  });

  it('should throw an error containing the status and response body on a non-200 response', async () => {
    // Fresh Response per call — a Response body can only be read once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        })
    );

    await expect(client.getActivities('2026-07-23')).rejects.toThrow('500');
    await expect(client.getActivities('2026-07-23')).rejects.toThrow(
      'Server Error'
    );
  });
});
