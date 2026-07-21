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

// Helper: pull `_meta.ui.resourceUri` and structuredContent.view off a result.
function uiResourceUriOf(result: unknown): string | undefined {
  const meta = (result as { _meta?: { ui?: { resourceUri?: string } } })._meta;
  return meta?.ui?.resourceUri;
}
function viewOf(result: unknown): string | undefined {
  return (result as { structuredContent?: { view?: string } }).structuredContent
    ?.view;
}

describe('query_rewind generic UI wiring', () => {
  it('advertises the query-result UI resourceUri in the tool listing', async () => {
    const { client } = await createTestClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'query_rewind')!;
    const meta = tool._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toBe('ui://rewind/query-result.html');
    await client.close();
  });

  it('registers the ui://rewind/query-result.html resource', async () => {
    const { client } = await createTestClient();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(
      'ui://rewind/query-result.html'
    );
    await client.close();
  });

  it('attaches _meta.ui.resourceUri on the query_rewind result', async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    expect(uiResourceUriOf(result)).toBe('ui://rewind/query-result.html');
    await client.close();
  });

  it("defaults view to 'auto' and echoes it into structuredContent", async () => {
    const { client } = await createTestClient();
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1' },
    });
    expect(viewOf(result)).toBe('auto');
    await client.close();
  });

  it('accepts an explicit view arg and echoes it back', async () => {
    const { client } = await createTestClient();
    for (const view of ['table', 'chart', 'map', 'grid'] as const) {
      const result = await client.callTool({
        name: 'query_rewind',
        arguments: { sql: 'SELECT 1', view },
      });
      expect(viewOf(result)).toBe(view);
    }
    await client.close();
  });

  it('rejects an invalid view value via the input schema', async () => {
    const { client } = await createTestClient();
    // The SDK validates inputs against the tool's inputSchema and surfaces a
    // validation failure as an error result (isError) rather than a throw.
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1', view: 'sunburst' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)
      .map((b) => b.text ?? '')
      .join(' ');
    expect(text).toMatch(/view/i);
    await client.close();
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

// Helper: pull the `art` / `art_truncated` fields out of structuredContent.
function artOf(result: unknown): Record<string, string> | undefined {
  return (result as { structuredContent?: { art?: Record<string, string> } })
    .structuredContent?.art;
}
function artTruncatedOf(result: unknown): boolean | undefined {
  return (result as { structuredContent?: { art_truncated?: boolean } })
    .structuredContent?.art_truncated;
}

describe('query_rewind embed_art', () => {
  it('omits the art field entirely when embed_art is false (default)', async () => {
    const url = `${CDN}/listening/albums/5/original.jpg?v=3`;
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
    expect(artOf(result)).toBeUndefined();
    expect(artTruncatedOf(result)).toBeUndefined();
    // Default inline image blocks are unchanged.
    expect(imageBlocksOf(result)).toHaveLength(1);
    await client.close();
  });

  it('returns a base64 WebP data URI map keyed by the original URL', async () => {
    const a = `${CDN}/listening/albums/1/original.jpg?v=1`;
    const b = `${CDN}/listening/albums/2/original.jpg?v=1`;
    const { client } = await createTestClient({
      columns: ['album', 'art'],
      rows: [
        ['One', a],
        ['Two', b],
      ],
      row_count: 2,
      truncated: false,
    });
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1', embed_art: true },
    });
    const art = artOf(result);
    expect(art).toBeDefined();
    // Keyed by the ORIGINAL url exactly as it appeared in the cell.
    expect(Object.keys(art!).sort()).toEqual([a, b].sort());
    for (const uri of Object.values(art!)) {
      // MIME follows the CDN response content-type (jpeg from the default mock).
      expect(/^data:image\/[a-z]+;base64,/.test(uri)).toBe(true);
    }
    expect(artTruncatedOf(result)).toBeFalsy();
    await client.close();
  });

  it('forces a width=64 webp transform on the fetched CDN URL', async () => {
    const orig = `${CDN}/cdn-cgi/image/width=300,height=300,fit=cover,format=auto,quality=85/listening/albums/5/original.jpg?v=3`;
    const seen: string[] = [];
    const { client } = await createTestClient(
      {
        columns: ['art'],
        rows: [[orig]],
        row_count: 1,
        truncated: false,
      },
      async (url: string) => {
        seen.push(url);
        return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/webp' };
      }
    );
    await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1', embed_art: true },
    });
    // The embed fetch (last) must force width=64 + webp + quality=70.
    const embedFetch = seen[seen.length - 1];
    expect(embedFetch).toContain('width=64');
    expect(embedFetch).toContain('format=webp');
    expect(embedFetch).toContain('quality=70');
    // Source asset path + version preserved.
    expect(embedFetch).toContain('listening/albums/5/original.jpg');
    expect(embedFetch).toContain('v=3');
    await client.close();
  });

  it('labels the data URI with the CDN response content-type, not a hardcoded webp', async () => {
    // The CDN can ignore format=webp and return JPEG; the data URI MIME must
    // match the actual bytes so strict decoders accept it.
    const orig = `${CDN}/listening/albums/9/original.jpg?v=1`;
    const { client } = await createTestClient(
      {
        columns: ['art'],
        rows: [[orig]],
        row_count: 1,
        truncated: false,
      },
      async () => ({
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        mimeType: 'image/jpeg',
      })
    );
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1', embed_art: true },
    });
    const art = artOf(result);
    expect(art![orig].startsWith('data:image/jpeg;base64,')).toBe(true);
    await client.close();
  });

  it('de-duplicates and caps embedded art at 16 distinct URLs', async () => {
    // 20 distinct URLs, each appearing twice → 40 cells.
    const rows: unknown[][] = [];
    for (let i = 0; i < 20; i++) {
      const u = `${CDN}/listening/albums/${i}/original.jpg?v=1`;
      rows.push([`Album ${i}`, u]);
      rows.push([`Album ${i} dup`, u]);
    }
    const { client } = await createTestClient({
      columns: ['album', 'art'],
      rows,
      row_count: rows.length,
      truncated: false,
    });
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1', embed_art: true },
    });
    const art = artOf(result)!;
    expect(Object.keys(art)).toHaveLength(16);
    await client.close();
  });

  it('stops and sets art_truncated when the byte ceiling is exceeded', async () => {
    // Each fetch returns 100KB of bytes → base64 ~137KB. One cover fits under
    // the ~256KB ceiling; a second would push the total past it and is dropped.
    const a = `${CDN}/listening/albums/1/original.jpg?v=1`;
    const b = `${CDN}/listening/albums/2/original.jpg?v=1`;
    const big = new Uint8Array(100 * 1024).fill(65);
    const { client } = await createTestClient(
      {
        columns: ['art'],
        rows: [[a], [b]],
        row_count: 2,
        truncated: false,
      },
      async () => ({ bytes: big, mimeType: 'image/webp' })
    );
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1', embed_art: true },
    });
    const art = artOf(result)!;
    // Only the first cover fit under the ceiling.
    expect(Object.keys(art)).toEqual([a]);
    expect(artTruncatedOf(result)).toBe(true);
    await client.close();
  });

  it('omits the key for a failed fetch but keeps the others (no throw)', async () => {
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
        return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/webp' };
      }
    );
    const result = await client.callTool({
      name: 'query_rewind',
      arguments: { sql: 'SELECT 1', embed_art: true },
    });
    const art = artOf(result)!;
    expect(Object.keys(art)).toEqual([ok]);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    await client.close();
  });
});
