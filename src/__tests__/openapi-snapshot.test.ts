import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setupTestDb } from '../test-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Two committed snapshots are kept in lockstep:
//   - openapi.snapshot.json          -- linted by spectral, source of truth
//   - docs-mintlify/openapi.json     -- consumed by the Mintlify API Reference
// Both are written when running `npm run spec:update` and both are checked
// in CI; if a route or schema changes and only one is updated, this test
// fails. Run `npm run spec:update` to refresh.
describe('OpenAPI spec snapshot', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  it('matches committed snapshots (root + Mintlify docs)', async () => {
    const res = await SELF.fetch('http://localhost/v1/openapi.json');
    const spec = (await res.json()) as any;
    const json = JSON.stringify(spec, null, 2) + '\n';

    await expect(json).toMatchFileSnapshot('../../openapi.snapshot.json');
    await expect(json).toMatchFileSnapshot('../../docs-mintlify/openapi.json');
  });
});
