/**
 * Output-schema conformance — places domain.
 *
 * For every places tool: run it end-to-end through the SDK against a
 * fixture and assert it resolves. The SDK's validateToolOutput throws if
 * `structuredContent` does not match the declared `outputSchema`, so a
 * resolved call IS the conformance proof. Also asserts each tool
 * advertises a clean JSON Schema (top-level object, no $ref, no
 * `additionalProperties: false`).
 *
 * Fixtures mirror live /v1/places/recent and /v1/places/stats captures.
 * Structure mirrors output-schema-reading.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

// --- Fixtures (minimal valid API responses, from live captures) -----------

const checkinFixture = {
  id: 7321,
  venue_id: '63d6509bb9b5134963db58c7',
  venue_name: 'Analog Coffee',
  venue_category: 'Coffee Shop',
  venue_icon: 'https://cdn.rewind.rest/places/icons/food-coffeeshop_64.png',
  venue_city: 'Seattle',
  venue_state: 'WA',
  venue_country: 'United States',
  lat: 47.6205,
  lng: -122.3212,
  checked_in_at: '2026-03-18T17:05:00.000Z',
  shout: 'Morning cortado',
};

const statsFixture = {
  total: 7321,
  unique_venues: 2982,
  this_year: 204,
  top_categories: [
    {
      category: 'Coffee Shop',
      count: 776,
      icon: 'https://cdn.rewind.rest/places/icons/food-coffeeshop_64.png',
    },
    {
      category: 'Bakery',
      count: 343,
      icon: 'https://cdn.rewind.rest/places/icons/food-bakery_64.png',
    },
  ],
  top_cities: [
    { city: 'Seattle', count: 1360 },
    { city: 'Portland', count: 785 },
  ],
  top_venues: [
    {
      venue_name: 'Analog Coffee',
      count: 96,
      icon: 'https://cdn.rewind.rest/places/icons/food-coffeeshop_64.png',
      city: 'Seattle',
    },
    {
      venue_name: 'Bait Shop',
      count: 71,
      icon: null,
      city: null,
    },
  ],
};

const ROUTES: Record<string, unknown> = {
  '/places/recent': {
    data: [checkinFixture],
    pagination: { page: 1, limit: 20, total: 7321, total_pages: 367 },
  },
  '/places/stats': statsFixture,
};

async function buildClient(): Promise<Client> {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  vi.spyOn(rewindClient, 'get').mockImplementation(
    async (path: string) => ROUTES[path] ?? {}
  );
  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'output-schema-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const CASES: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'get_recent_checkins', args: {} },
  { name: 'get_places_stats', args: {} },
];

describe('output-schema conformance — places', () => {
  for (const c of CASES) {
    it(`${c.name}: structuredContent conforms to outputSchema`, async () => {
      const client = await buildClient();
      // A schema mismatch makes the SDK's validateToolOutput throw and this
      // call reject -- resolving without error IS the conformance check.
      const res = await client.callTool({ name: c.name, arguments: c.args });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toBeDefined();
    });
  }

  it('null-heavy check-in rows still conform', async () => {
    const rewindClient = new RewindClient('https://api.test', 'rw_test');
    vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) => {
      if (path === '/places/recent')
        return {
          data: [
            {
              ...checkinFixture,
              venue_id: null,
              venue_category: null,
              venue_icon: null,
              venue_city: null,
              venue_state: null,
              venue_country: null,
              lat: null,
              lng: null,
              shout: null,
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, total_pages: 1 },
        };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'null-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    const res = await client.callTool({
      name: 'get_recent_checkins',
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
  });

  it('empty-state branches still conform', async () => {
    const rewindClient = new RewindClient('https://api.test', 'rw_test');
    vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) => {
      if (path === '/places/recent')
        return {
          data: [],
          pagination: { page: 1, limit: 20, total: 0, total_pages: 0 },
        };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    const res = await client.callTool({
      name: 'get_recent_checkins',
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
  });

  it('every places tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const places = tools.filter((t) => names.has(t.name));
    expect(places).toHaveLength(CASES.length);

    for (const t of places) {
      expect(t.outputSchema, t.name).toMatchObject({ type: 'object' });
      const json = JSON.stringify(t.outputSchema);
      // No $ref/$defs: older Claude Desktop builds failed to compile them.
      expect(json, `${t.name} $ref`).not.toContain('$ref');
      // .passthrough() keeps the advertised schema forward-compatible.
      expect(json, `${t.name} additionalProperties`).not.toContain(
        '"additionalProperties":false'
      );
    }
  });
});
