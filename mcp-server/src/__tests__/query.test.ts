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

async function createTestClient(
  queryResult: unknown = MOCK_QUERY_RESULT,
  binary?: (url: string) => Promise<{ bytes: Uint8Array; mimeType: string }>
) {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');

  vi.spyOn(rewindClient, 'query').mockResolvedValue(queryResult as never);
  vi.spyOn(rewindClient, 'getSchema').mockResolvedValue(MOCK_SCHEMA);
  // resources.ts still registers the sync-status resource which calls get();
  // return a benign shape for any get() so unrelated registration is happy.
  vi.spyOn(rewindClient, 'get').mockResolvedValue({ domains: {} });
  // Default: every CDN fetch succeeds with a tiny fake image. Tests that need
  // failure/partial behavior pass their own `binary` implementation.
  vi.spyOn(rewindClient, 'getBinaryFromUrl').mockImplementation(
    binary ??
      ((async (url: string) => ({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/jpeg',
        // url is intentionally unused in the default happy path.
        _url: url,
      })) as never)
  );

  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'query-test', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, rewindClient };
}

const CDN = 'https://cdn.dinakartumu.com';

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

// Helper: count image content blocks and pull the text block from a tool result.
type Block = { type: string; text?: string };
function blocksOf(result: unknown): Block[] {
  return (result as { content: Block[] }).content;
}
function imageBlocksOf(result: unknown): Block[] {
  return blocksOf(result).filter((b) => b.type === 'image');
}

describe('query_rewind inline artwork', () => {
  it('renders cdn.dinakartumu.com URLs in results as image blocks', async () => {
    const url = `${CDN}/cdn-cgi/image/width=120,height=120/listening/albums/5/original.jpg?v=3`;
    const { client } = await createTestClient({
      columns: ['album', 'art'],
      rows: [['Blonde', url]],
      row_count: 1,
      truncated: false,
    });
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    // Text/table preserved.
    expect(blocksOf(result)[0].type).toBe('text');
    expect(blocksOf(result)[0].text).toContain('| album | art |');
    // One image appended.
    expect(imageBlocksOf(result)).toHaveLength(1);
    await client.close();
  });

  it('caps at 8 images even with many image rows', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => [
      `Album ${i}`,
      `${CDN}/listening/albums/${i}/original.jpg?v=1`,
    ]);
    const { client } = await createTestClient({
      columns: ['album', 'art'],
      rows,
      row_count: 20,
      truncated: false,
    });
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    expect(imageBlocksOf(result)).toHaveLength(8);
    await client.close();
  });

  it('de-duplicates repeated image URLs, preserving first-seen order', async () => {
    const a = `${CDN}/listening/albums/1/original.jpg?v=1`;
    const b = `${CDN}/listening/albums/2/original.jpg?v=1`;
    const seen: string[] = [];
    const { client } = await createTestClient(
      {
        columns: ['art'],
        rows: [[a], [b], [a], [b]],
        row_count: 4,
        truncated: false,
      },
      async (url: string) => {
        seen.push(url);
        return { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' };
      }
    );
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    expect(imageBlocksOf(result)).toHaveLength(2);
    // Only two distinct fetches, a before b.
    const sources = seen.map((u) => (u.includes('/albums/1/') ? 'a' : 'b'));
    expect(sources).toEqual(['a', 'b']);
    await client.close();
  });

  it('composes a CDN URL from a bare r2_key value and renders it', async () => {
    const seen: string[] = [];
    const { client } = await createTestClient(
      {
        columns: ['title', 'image_key'],
        rows: [['Dune', 'watching/movies/707/original.jpg']],
        row_count: 1,
        truncated: false,
      },
      async (url: string) => {
        seen.push(url);
        return { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' };
      }
    );
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    expect(imageBlocksOf(result)).toHaveLength(1);
    expect(seen[0]).toContain(CDN);
    expect(seen[0]).toContain('watching/movies/707/original.jpg');
    await client.close();
  });

  it('emits no image blocks when no cell is an image', async () => {
    const { client } = await createTestClient({
      columns: ['year', 'plays'],
      rows: [['2024', 18234]],
      row_count: 1,
      truncated: false,
    });
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    expect(imageBlocksOf(result)).toHaveLength(0);
    await client.close();
  });

  it('silently omits images whose fetch fails', async () => {
    const ok = `${CDN}/listening/albums/1/original.jpg?v=1`;
    const bad = `${CDN}/listening/albums/2/original.jpg?v=1`;
    const { client } = await createTestClient(
      {
        columns: ['art'],
        rows: [[ok], [bad]],
        row_count: 2,
        truncated: false,
      },
      async (url: string) => {
        if (url.includes('/albums/2/')) throw new Error('boom');
        return { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' };
      }
    );
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    // Only the successful fetch survives; no error surfaced.
    expect(imageBlocksOf(result)).toHaveLength(1);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    await client.close();
  });
});
