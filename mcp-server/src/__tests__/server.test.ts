import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

/**
 * Creates a connected MCP client + server pair using in-memory transport.
 * The RewindClient is mocked so no real API calls are made.
 *
 * After the SQL-first migration the tool surface is the SQL primitives
 * (query_rewind, get_schema), the rich/widget tools, the search tools, and
 * get_health. The thin single-query wrappers were retired — query_rewind
 * covers them.
 */
async function createTestClient() {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');

  // Mock the HTTP client -- kept tools go through client.get()
  vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) => {
    return getMockResponse(path);
  });

  // Mock the SQL-first client methods.
  vi.spyOn(rewindClient, 'query').mockResolvedValue({
    columns: ['name', 'plays'],
    rows: [['Beastie Boys', 45]],
    row_count: 1,
    truncated: false,
  });
  vi.spyOn(rewindClient, 'getSchema').mockResolvedValue({
    notes: ['Single-user database: user_id is always 1.'],
    tables: [
      {
        name: 'lastfm_scrobbles',
        purpose: 'One row per Last.fm play.',
        columns: [{ name: 'id', type: 'integer' }],
      },
    ],
  });

  // Mock image fetches -- return a tiny fake JPEG payload so imageBlock()
  // produces a base64 image content block in tool responses.
  vi.spyOn(rewindClient, 'getBinaryFromUrl').mockResolvedValue({
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    mimeType: 'image/jpeg',
  });

  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({
    name: 'test-client',
    version: '1.0.0',
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, rewindClient };
}

/** Mock responses for the API endpoints the kept tools call. */
function getMockResponse(path: string): unknown {
  // Listening
  if (path === '/listening/now-playing') {
    return {
      is_playing: true,
      track: {
        name: 'Sabotage',
        artist: {
          id: 10,
          name: 'Beastie Boys',
          apple_music_url: 'https://music.apple.com/us/artist/beastie-boys/12',
        },
        album: {
          id: 20,
          name: 'Ill Communication',
          image: {
            cdn_url: 'https://cdn.rewind.rest/listening/albums/20/original.jpg',
            thumbhash: 'x',
            dominant_color: '#111',
            accent_color: '#222',
          },
        },
        url: 'https://www.last.fm/music/Beastie+Boys/_/Sabotage',
        apple_music_url: 'https://music.apple.com/us/album/sabotage/30',
        preview_url: null,
      },
      scrobbled_at: new Date().toISOString(),
    };
  }
  if (path.startsWith('/listening/top/')) {
    return {
      period: '1month',
      data: [
        {
          rank: 1,
          id: 10,
          name: 'Beastie Boys',
          detail: 'Artist',
          playcount: 45,
          image: {
            cdn_url:
              'https://cdn.rewind.rest/listening/artists/10/original.jpg',
            thumbhash: 'x',
            dominant_color: '#111',
            accent_color: '#222',
          },
          url: 'https://www.last.fm/music/Beastie+Boys',
          apple_music_url: 'https://music.apple.com/us/artist/beastie-boys/12',
          preview_url: null,
        },
      ],
    };
  }
  if (path.match(/\/listening\/artists\/\d+/)) {
    return {
      id: 10,
      name: 'Beastie Boys',
      mbid: null,
      url: 'https://www.last.fm/music/Beastie+Boys',
      apple_music_url: 'https://music.apple.com/us/artist/beastie-boys/12',
      playcount: 500,
      scrobble_count: 500,
      first_scrobbled_at: '2008-01-01T12:00:00.000Z',
      last_played_at: '2026-04-01T12:00:00.000Z',
      all_time_rank: 7,
      distinct_tracks: 42,
      distinct_albums: 6,
      genre: 'Hip Hop',
      tags: [{ name: 'Hip Hop', count: 100 }],
      bio_summary: 'Brooklyn rap trio active 1981–2012.',
      bio_content: 'The Beastie Boys were an American rap rock group...',
      bio_synced_at: '2026-04-01T12:00:00.000Z',
      image: {
        cdn_url: 'https://cdn.rewind.rest/listening/artists/10/original.jpg',
        thumbhash: 'x',
        dominant_color: '#111',
        accent_color: '#222',
      },
      sparkline: {
        granularity: 'year',
        points: [{ at: '2024-01-01T00:00:00.000Z', count: 50 }],
      },
      top_albums: [
        {
          id: 20,
          name: "Paul's Boutique",
          playcount: 100,
          apple_music_url: null,
          image: null,
        },
      ],
      top_tracks: [
        {
          id: 30,
          name: 'Sabotage',
          album_id: 20,
          album_name: "Paul's Boutique",
          scrobble_count: 50,
          apple_music_url: null,
          preview_url: null,
          image: null,
        },
      ],
      similar_artists: [
        {
          id: 11,
          name: 'A Tribe Called Quest',
          your_scrobble_count: 220,
          similarity_score: 0.82,
          image: null,
        },
      ],
    };
  }

  // Watching
  if (path === '/watching/recent') {
    return {
      data: [
        {
          movie: {
            id: 1,
            title: 'The Royal Tenenbaums',
            year: 2001,
            director: 'Wes Anderson',
            tmdb_id: 9428,
            image: {
              url: 'https://cdn.rewind.rest/watching/movies/1/original.jpg',
              thumbhash: 'xhash',
              dominant_color: '#222',
              accent_color: '#c83',
            },
          },
          watched_at: new Date().toISOString(),
          user_rating: 9,
          rewatch: false,
          source: 'plex',
          review: null,
          review_url:
            'https://letterboxd.com/patdugan/film/the-royal-tenenbaums/',
        },
      ],
    };
  }

  // Reading
  if (path === '/reading/recent') {
    return {
      data: [
        {
          id: 1,
          title: 'How to Build an MCP Server',
          author: 'Anthropic',
          url: 'https://www.anthropic.com/blog/how-to-build-an-mcp-server',
          domain: 'anthropic.com',
          estimated_read_min: 12,
          status: 'archived',
          progress: 1,
          image: {
            cdn_url: 'https://cdn.rewind.rest/reading/articles/1/original.jpg',
            thumbhash: 'x',
            dominant_color: '#111',
            accent_color: '#222',
          },
          saved_at: new Date().toISOString(),
        },
      ],
    };
  }
  if (path.match(/\/reading\/articles\/\d+/)) {
    return {
      id: 1,
      title: 'How to Build an MCP Server',
      author: 'Anthropic',
      url: 'https://www.anthropic.com/blog/how-to-build-an-mcp-server',
      instapaper_url: 'https://www.instapaper.com/read/1',
      instapaper_app_url: null,
      domain: 'anthropic.com',
      description: 'A guide.',
      content: 'The full article body text about building MCP servers.',
      excerpt: 'An excerpt.',
      word_count: 1200,
      estimated_read_min: 12,
      status: 'archived',
      progress: 1,
      image: null,
      highlights: [],
      saved_at: new Date().toISOString(),
    };
  }

  // Search
  if (path === '/search') {
    return {
      data: [
        {
          domain: 'listening',
          entity_type: 'artist',
          entity_id: '10',
          title: 'Beastie Boys',
          subtitle: null,
        },
        {
          domain: 'watching',
          entity_type: 'movie',
          entity_id: '1',
          title: 'The Royal Tenenbaums',
          subtitle: '2001',
        },
      ],
      pagination: { total: 2 },
    };
  }

  // Health
  if (path === '/health') {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
  if (path === '/health/sync') {
    return {
      domains: {
        listening: {
          status: 'healthy',
          last_sync: new Date().toISOString(),
          items_synced: 100,
        },
      },
    };
  }

  throw new Error(`Unmocked endpoint: ${path}`);
}

// --- Tests ---

/** The exact set of tools the server registers after the SQL-first migration. */
const EXPECTED_TOOLS = [
  'query_rewind',
  'get_schema',
  'get_health',
  'get_now_playing',
  'get_top_artists',
  'get_top_albums',
  'get_top_tracks',
  'get_artist_details',
  'get_recent_watches',
  'get_recent_reads',
  'get_article',
  'search',
  'semantic_search',
  'get_attended_season',
  'get_attended_event',
  'get_attended_player',
];

/** Tools retired in the SQL-first migration — must NOT be registered. */
const RETIRED_TOOLS = [
  'get_recent_listens',
  'get_listening_stats',
  'get_listening_streaks',
  'get_album_details',
  'get_listening_genres',
  'get_running_stats',
  'get_recent_runs',
  'get_personal_records',
  'get_running_streaks',
  'get_activity_details',
  'get_activity_splits',
  'get_running_years',
  'get_movie_details',
  'get_watching_stats',
  'browse_movies',
  'get_watching_genres',
  'get_watching_decades',
  'get_watching_directors',
  'get_vinyl_collection',
  'get_collecting_stats',
  'get_physical_media',
  'get_physical_media_stats',
  'get_reading_highlights',
  'get_random_highlight',
  'get_reading_stats',
  'find_similar_articles',
  'get_recent_checkins',
  'get_places_stats',
  'get_feed',
  'get_on_this_day',
  'get_attended_events',
  'get_attended_players',
  'get_attended_player_stats',
  'get_attending_stats',
  'get_attending_year_in_review',
];

describe('MCP Server', () => {
  let client: Client;

  beforeAll(async () => {
    const ctx = await createTestClient();
    client = ctx.client;
  });

  afterAll(async () => {
    await client.close();
  });

  describe('initialization', () => {
    it('registers exactly the SQL-first tool set', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // Exact set so adding/removing a tool fails the test and forces an
      // accompanying docs update. Roughly 12-15 tools; SQL primitives cover
      // the retired thin wrappers.
      expect(names.length).toBe(EXPECTED_TOOLS.length);
      for (const name of EXPECTED_TOOLS) expect(names).toContain(name);
      for (const name of RETIRED_TOOLS) expect(names).not.toContain(name);
    });

    it('all tools have readOnlyHint annotation', async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).toBe(false);
      }
    });

    it('lists resources including the schema resource', async () => {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('rewind://sync/status');
      expect(uris).toContain('rewind://schema');
    });

    it('lists prompts', async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts.length).toBe(7);
      const names = prompts.map((p) => p.name);
      expect(names).toContain('weekly-summary');
      expect(names).toContain('year-in-review');
      expect(names).toContain('find-article');
    });

    it('exposes server instructions', () => {
      const instructions = client.getInstructions();
      expect(instructions).toBeTruthy();
      expect(instructions).toContain('Rewind');
      expect(instructions).toContain('get_schema');
      expect(instructions).toContain('query_rewind');
      // Keep under 2KB (Claude Code truncates above that)
      expect(instructions!.length).toBeLessThan(2048);
    });
  });

  describe('SQL-first primitives', () => {
    it('query_rewind renders a markdown table and structuredContent', async () => {
      const result = await client.callTool({
        name: 'query_rewind',
        arguments: { sql: 'SELECT name, plays FROM x' },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('Beastie Boys');
      expect(text).toContain('| name | plays |');
      const sc = (result as { structuredContent?: { columns: string[] } })
        .structuredContent;
      expect(sc?.columns).toEqual(['name', 'plays']);
    });

    it('get_schema renders tables and structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_schema',
        arguments: {},
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('lastfm_scrobbles');
      const sc = (
        result as { structuredContent?: { tables: Array<{ name: string }> } }
      ).structuredContent;
      expect(sc?.tables[0].name).toBe('lastfm_scrobbles');
    });
  });

  describe('kept widget + search tools', () => {
    type RichContent = Array<{
      type: string;
      text?: string;
      uri?: string;
      name?: string;
    }>;

    it('get_now_playing includes track, album cover, and Apple Music links', async () => {
      const result = await client.callTool({
        name: 'get_now_playing',
        arguments: {},
      });
      const content = result.content as RichContent;
      expect(content[0].text).toContain('Sabotage');
      expect(content[0].text).toContain('Beastie Boys');
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      const links = content.filter((b) => b.type === 'resource_link');
      expect(links.some((b) => b.name?.includes('Apple Music'))).toBe(true);
    });

    it('get_top_artists mirrors the API shape in structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_top_artists',
        arguments: {},
      });
      const sc = (
        result as {
          structuredContent?: { period: string; data: Array<{ id: number }> };
        }
      ).structuredContent;
      expect(sc?.period).toBe('1month');
      expect(sc?.data[0].id).toBe(10);
    });

    it('get_artist_details returns artist image and Apple Music link', async () => {
      const result = await client.callTool({
        name: 'get_artist_details',
        arguments: { id: 10 },
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      expect(
        content.find(
          (b) => b.type === 'resource_link' && b.name?.includes('Apple Music')
        )
      ).toBeDefined();
    });

    it('get_recent_watches emits posters and Letterboxd links', async () => {
      const result = await client.callTool({
        name: 'get_recent_watches',
        arguments: {},
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('letterboxd.com');
    });

    it('get_recent_reads emits article URL resource_links', async () => {
      const result = await client.callTool({
        name: 'get_recent_reads',
        arguments: {},
      });
      const content = result.content as RichContent;
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('anthropic.com');
    });

    it('get_article returns full body and structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_article',
        arguments: { id: 1 },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('How to Build an MCP Server');
      const sc = (result as { structuredContent?: { article: { id: number } } })
        .structuredContent;
      expect(sc?.article.id).toBe(1);
    });

    it('search emits rewind:// resource_links per match', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { query: 'beastie' },
      });
      const content = result.content as RichContent;
      const links = content.filter((b) => b.type === 'resource_link');
      expect(links.map((l) => l.uri)).toContain('rewind://artist/10');
      expect(links.map((l) => l.uri)).toContain('rewind://movie/1');
      const sc = (
        result as { structuredContent?: { items: Array<{ domain: string }> } }
      ).structuredContent;
      expect(sc?.items[0].domain).toBe('listening');
    });
  });

  describe('health', () => {
    it('get_health returns API status and per-domain sync info', async () => {
      const result = await client.callTool({
        name: 'get_health',
        arguments: {},
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('API Status: ok');
      const sc = (result as { structuredContent?: { api_status: string } })
        .structuredContent;
      expect(sc?.api_status).toBe('ok');
    });
  });

  describe('entity resource templates', () => {
    it('registers artist, movie, and article templates', async () => {
      const { resourceTemplates } = await client.listResourceTemplates();
      const uris = resourceTemplates.map((t) => t.uriTemplate);
      expect(uris).toContain('rewind://artist/{id}');
      expect(uris).toContain('rewind://movie/{id}');
      expect(uris).toContain('rewind://article/{id}');
    });

    it('reads an article entity via rewind://article/{id}', async () => {
      const result = await client.readResource({ uri: 'rewind://article/1' });
      const content = result.contents[0] as { mimeType?: string; text: string };
      expect(content.mimeType).toBe('application/json');
      const data = JSON.parse(content.text) as { title: string };
      expect(data.title).toBe('How to Build an MCP Server');
    });
  });
});
