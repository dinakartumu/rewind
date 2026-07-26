import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { setupTestDb } from '../test-helpers.js';

describe('webhook routes', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  // The Plex webhook needs no auth, so an instance that does not run Plex is
  // left accepting and processing events for an integration it has no server
  // for. Refuse up front rather than half-processing them. See issue #17.
  describe('POST /v1/webhooks/plex', () => {
    it('reports not-configured when PLEX_URL and PLEX_TOKEN are unset', async () => {
      const body = new FormData();
      body.append(
        'payload',
        JSON.stringify({ event: 'media.scrobble', Metadata: { type: 'movie' } })
      );

      const res = await SELF.fetch('http://localhost/v1/webhooks/plex', {
        method: 'POST',
        body,
      });

      expect(res.status).toBe(503);
      const json = (await res.json()) as any;
      expect(json.error).toMatch(/not configured/i);
    });
  });
});
