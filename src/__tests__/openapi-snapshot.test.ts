import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setupTestDb } from '../test-helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// openapi.snapshot.json is the committed spec: linted by spectral, written
// by `npm run spec:update`, and checked in CI, so a route or schema change
// that skips the update fails here.
//
// The docs site consumes its own copy of this spec. That copy lives in the
// rewind-docs repo and is synced by the publish-docs CI job, not written
// from here.
describe('OpenAPI spec snapshot', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  it('matches the committed snapshot', async () => {
    const res = await SELF.fetch('http://localhost/v1/openapi.json');
    const spec = (await res.json()) as any;
    const json = JSON.stringify(spec, null, 2) + '\n';

    await expect(json).toMatchFileSnapshot('../../openapi.snapshot.json');
  });
});
