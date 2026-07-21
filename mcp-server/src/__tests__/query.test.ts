import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

/**
 * Tests for the SQL-first primitive tools (query_rewind, get_schema) and the
 * rewind://schema resource. The RewindClient query/getSchema/get methods are
 * mocked so no real API calls are made.
 */

const MOCK_QUERY_RESULT = {
  columns: ['year', 'plays'],
  rows: [
    ['2024', 18234],
    ['2025', 21012],
  ],
  row_count: 2,
  truncated: false,
};

const MOCK_SCHEMA = {
  notes: ['Single-user database: every table has user_id and it is always 1.'],
  tables: [
    {
      name: 'lastfm_scrobbles',
      purpose: 'One row per Last.fm play.',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'scrobbled_at', type: 'text', note: 'ISO 8601 UTC.' },
      ],
      joins: ['lastfm_scrobbles.track_id → lastfm_tracks.id'],
    },
  ],
};

async function createTestClient() {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');

  vi.spyOn(rewindClient, 'query').mockResolvedValue(MOCK_QUERY_RESULT);
  vi.spyOn(rewindClient, 'getSchema').mockResolvedValue(MOCK_SCHEMA);
  // resources.ts still registers the sync-status resource which calls get();
  // return a benign shape for any get() so unrelated registration is happy.
  vi.spyOn(rewindClient, 'get').mockResolvedValue({ domains: {} });

  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'query-test', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client };
}

describe('SQL-first tools', () => {
  let client: Client;

  beforeAll(async () => {
    ({ client } = await createTestClient());
  });

  afterAll(async () => {
    await client.close();
  });

  it('registers query_rewind and get_schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('query_rewind');
    expect(names).toContain('get_schema');
  });

  it('query_rewind returns a markdown table plus structuredContent', async () => {
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe('text');
    // Small result renders as a markdown table with the column headers.
    expect(content[0].text).toContain('| year | plays |');
    expect(content[0].text).toContain('18234');
    expect(result.isError).toBeFalsy();

    const sc = (
      result as {
        structuredContent?: { columns: string[]; row_count: number };
      }
    ).structuredContent;
    expect(sc?.columns).toEqual(['year', 'plays']);
    expect(sc?.row_count).toBe(2);
  });

  it('get_schema returns readable markdown plus structuredContent', async () => {
    const result = await client.callTool({
      name: 'get_schema',
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('lastfm_scrobbles');
    expect(content[0].text).toContain('scrobbled_at');

    const sc = (
      result as { structuredContent?: { tables: Array<{ name: string }> } }
    ).structuredContent;
    expect(sc?.tables[0].name).toBe('lastfm_scrobbles');
  });

  it('exposes the rewind://schema resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('rewind://schema');

    const read = await client.readResource({ uri: 'rewind://schema' });
    const content = read.contents[0] as { mimeType?: string; text: string };
    expect(content.mimeType).toBe('application/json');
    const data = JSON.parse(content.text) as {
      tables: Array<{ name: string }>;
    };
    expect(data.tables[0].name).toBe('lastfm_scrobbles');
  });
});
