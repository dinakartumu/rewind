/**
 * The API only implements semantic/hybrid ranking over the reading domain and
 * returns a 400 for any other domain. The `search` tool must not send that
 * combination: a film or record searched with `mode: hybrid` still has a
 * correct keyword answer, so the mode is downgraded and the domain honoured.
 *
 * Regression: asking "did I watch midnight cowboy?" produced
 * `domain: watching` + `mode: hybrid`, which failed with an opaque
 * "Rewind API error: 400 Bad Request" instead of finding the film.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

const EMPTY = {
  data: [],
  pagination: { page: 1, limit: 10, total: 0, total_pages: 0 },
};

/** Build a client plus the spy that captures the query params `search` sends. */
async function buildSpyingClient(response: unknown = EMPTY) {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  const get = vi
    .spyOn(rewindClient, 'get')
    .mockImplementation(async () => response as never);
  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rewind-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, get };
}

/** Params the tool passed to `RewindClient.get` for the /search call. */
function searchParams(get: ReturnType<typeof vi.spyOn>) {
  const call = get.mock.calls.find((c) => c[0] === '/search');
  expect(call, 'expected a /search request').toBeDefined();
  return call![1] as Record<string, string | number>;
}

describe('search tool -- reading-only ranking modes', () => {
  it('drops hybrid mode when the domain is not reading', async () => {
    const { client, get } = await buildSpyingClient();

    await client.callTool({
      name: 'search',
      arguments: {
        query: 'midnight cowboy',
        domain: 'watching',
        mode: 'hybrid',
      },
    });

    const params = searchParams(get);
    // The domain the caller asked for is preserved; only the mode gives way.
    expect(params.domain).toBe('watching');
    expect(params.mode).toBe('keyword');
    await client.close();
  });

  it('drops semantic mode when the domain is not reading', async () => {
    const { client, get } = await buildSpyingClient();

    await client.callTool({
      name: 'search',
      arguments: {
        query: 'blue train',
        domain: 'collecting',
        mode: 'semantic',
      },
    });

    const params = searchParams(get);
    expect(params.domain).toBe('collecting');
    expect(params.mode).toBe('keyword');
    await client.close();
  });

  it('keeps hybrid mode for the reading domain', async () => {
    const { client, get } = await buildSpyingClient();

    await client.callTool({
      name: 'search',
      arguments: {
        query: 'the ESPN piece about Ichiro',
        domain: 'reading',
        mode: 'hybrid',
      },
    });

    const params = searchParams(get);
    expect(params.domain).toBe('reading');
    expect(params.mode).toBe('hybrid');
    await client.close();
  });

  it('keeps hybrid mode when no domain is given', async () => {
    const { client, get } = await buildSpyingClient();

    await client.callTool({
      name: 'search',
      arguments: { query: 'tech layoffs', mode: 'hybrid' },
    });

    const params = searchParams(get);
    expect(params.domain).toBeUndefined();
    expect(params.mode).toBe('hybrid');
    await client.close();
  });

  it('tells the model the mode was downgraded', async () => {
    const { client } = await buildSpyingClient({
      data: [
        {
          domain: 'watching',
          entity_type: 'movie',
          entity_id: '1858',
          title: 'Midnight Cowboy',
          subtitle: '1969',
          image: null,
          url: null,
          instapaper_url: null,
          instapaper_app_url: null,
          author: null,
        },
      ],
      pagination: { page: 1, limit: 10, total: 1, total_pages: 1 },
    });

    const result = (await client.callTool({
      name: 'search',
      arguments: {
        query: 'midnight cowboy',
        domain: 'watching',
        mode: 'hybrid',
      },
    })) as { content: { type: string; text?: string }[]; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const body = result.content.find((b) => b.type === 'text')?.text ?? '';
    expect(body).toContain('Midnight Cowboy');
    expect(body).toContain('reading-domain only');
    // Not labelled as a hybrid result -- the ranking that actually ran was FTS.
    expect(body).not.toContain('[hybrid]');
    await client.close();
  });
});
