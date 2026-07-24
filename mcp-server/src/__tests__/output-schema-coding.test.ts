/**
 * Output-schema conformance + rendering — coding domain.
 *
 * For every coding tool: run it end-to-end through the SDK against a
 * fixture and assert it resolves. The SDK's validateToolOutput throws if
 * `structuredContent` does not match the declared `outputSchema`, so a
 * resolved call IS the conformance proof. Also asserts each tool
 * advertises a clean JSON Schema (top-level object, no $ref, no
 * `additionalProperties: false`), and that get_recent_coding_activity
 * renders GitHub items as markdown links to their URLs in the text block.
 *
 * Structure mirrors output-schema-reading.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

// --- Fixtures (minimal valid API responses) -------------------------------

const statsFixture = {
  coding_seconds: 486000,
  coding_days: 142,
  commits: 1203,
  prs: 87,
  issues: 41,
  screen_time: {
    total_seconds: 720000,
    very_productive_seconds: 410000,
    productive_seconds: 150000,
    neutral_seconds: 80000,
    distracting_seconds: 60000,
    very_distracting_seconds: 20000,
  },
};

const recentFixture = {
  data: [
    {
      type: 'pr',
      repo: 'pdugan20/rewind',
      title: 'Add coding domain routes',
      occurred_at: '2026-07-24T15:02:00.000Z',
      state: 'merged',
      url: 'https://github.com/pdugan20/rewind/pull/42',
    },
    {
      type: 'commit',
      repo: 'pdugan20/rewind',
      title: 'feat(coding): routes',
      occurred_at: '2026-07-24T14:40:00.000Z',
      state: null,
      url: 'https://github.com/pdugan20/rewind/commit/abc123',
    },
    {
      type: 'issue',
      repo: 'pdugan20/rewind',
      title: 'Backfill fails on gap years',
      occurred_at: '2026-07-23T09:00:00.000Z',
      state: 'open',
      url: 'https://github.com/pdugan20/rewind/issues/7',
    },
  ],
  pagination: { page: 1, limit: 20, total: 3, total_pages: 1 },
  today: { coding_seconds: 5400, productivity_pulse: 72 },
};

const languagesFixture = {
  data: [
    { language: 'TypeScript', total_seconds: 360000, percent: 74.1 },
    { language: 'Python', total_seconds: 90000, percent: 18.5 },
  ],
};

const ROUTES: Record<string, unknown> = {
  '/coding/stats': statsFixture,
  '/coding/recent': recentFixture,
  '/coding/languages': languagesFixture,
};

function resolveRoute(path: string): unknown {
  return ROUTES[path] ?? {};
}

async function buildClient(): Promise<Client> {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) =>
    resolveRoute(path)
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
  { name: 'get_coding_stats', args: {} },
  { name: 'get_recent_coding_activity', args: {} },
  { name: 'get_coding_languages', args: {} },
];

describe('output-schema conformance — coding', () => {
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

  it('get_recent_coding_activity renders GitHub items as markdown links', async () => {
    const client = await buildClient();
    const res = (await client.callTool({
      name: 'get_recent_coding_activity',
      arguments: {},
    })) as { content: Array<{ type: string; text?: string }> };
    const textBlock = res.content.find((b) => b.type === 'text');
    expect(textBlock?.text).toBeDefined();
    const body = textBlock!.text as string;
    // Each item title is a clickable markdown link to its GitHub URL.
    expect(body).toContain(
      '[Add coding domain routes](https://github.com/pdugan20/rewind/pull/42)'
    );
    expect(body).toContain(
      '[feat(coding): routes](https://github.com/pdugan20/rewind/commit/abc123)'
    );
    expect(body).toContain(
      '[Backfill fails on gap years](https://github.com/pdugan20/rewind/issues/7)'
    );
  });

  it('get_recent_coding_activity carries raw rows in structuredContent', async () => {
    const client = await buildClient();
    const res = (await client.callTool({
      name: 'get_recent_coding_activity',
      arguments: {},
    })) as { structuredContent?: { items?: unknown[]; today?: unknown } };
    expect(res.structuredContent?.items).toHaveLength(3);
    expect(res.structuredContent?.today).toEqual({
      coding_seconds: 5400,
      productivity_pulse: 72,
    });
  });

  it('empty-state branches still conform', async () => {
    const rewindClient = new RewindClient('https://api.test', 'rw_test');
    vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) => {
      if (path === '/coding/recent')
        return {
          data: [],
          pagination: { page: 1, limit: 20, total: 0, total_pages: 0 },
          today: { coding_seconds: 0, productivity_pulse: null },
        };
      if (path === '/coding/languages') return { data: [] };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    for (const [name, args] of [
      ['get_recent_coding_activity', {}],
      ['get_coding_languages', {}],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
  });

  it('every coding tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const coding = tools.filter((t) => names.has(t.name));
    expect(coding).toHaveLength(CASES.length);

    for (const t of coding) {
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
