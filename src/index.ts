import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from './types/env.js';
import { cors } from './lib/cors.js';
import { requireAuth } from './lib/auth.js';
import { createDb } from './db/client.js';
import { openAPIConfig, securitySchemes } from './lib/openapi.js';
import system from './routes/system.js';
import listening from './routes/listening.js';
import running from './routes/running.js';
import watching from './routes/watching.js';
import webhooks from './routes/webhooks.js';
import imagesRoute from './routes/images.js';
import collecting from './routes/collecting.js';
import feed from './routes/feed.js';
import reading from './routes/reading.js';
import places from './routes/places.js';
import coding from './routes/coding.js';
import attending from './routes/attending.js';
import search from './routes/search.js';
import query from './routes/query.js';
import exportRoute from './routes/export.js';
import keys from './routes/keys.js';
import adminSync from './routes/admin-sync.js';
import adminReindex from './routes/admin-reindex.js';
import adminAttending from './routes/admin-attending.js';
import { LastfmClient } from './services/lastfm/client.js';
import { syncListening } from './services/lastfm/sync.js';
import { syncRunning } from './services/strava/sync.js';
import { syncCollecting } from './services/discogs/sync.js';
import { syncTraktCollection } from './services/trakt/sync.js';
import { syncTraktHistory } from './services/trakt/history-sync.js';
import { syncPlaces } from './services/foursquare/sync.js';
import { syncCoding } from './services/coding/sync.js';
import {
  processListeningImages,
  processWatchingImages,
  processCollectingImages,
  refreshArtistImageFromAppleMusicId,
} from './services/images/sync-images.js';
import { enrichBatch, enrichArtistsByName } from './services/itunes/enrich.js';
import { shouldRetry } from './lib/sync-retry.js';
import { shouldSkipWatchingImages } from './services/images/sync-images.js';

const app = new OpenAPIHono<{ Bindings: Env }>();

// Global middleware
app.use('*', async (c, next) => {
  const corsMiddleware = cors(c.env);
  return corsMiddleware(c, next);
});

// Auth for GET endpoints under /v1/ (read key required)
app.use('/v1/*', async (c, next) => {
  // Skip auth for webhook endpoints and health
  const path = c.req.path;
  if (
    path.startsWith('/v1/webhooks/') ||
    path === '/v1/health' ||
    path === '/v1/health/sync' ||
    path === '/v1/openapi.json'
  ) {
    return next();
  }

  // Admin endpoints require admin auth
  if (path.startsWith('/v1/admin/')) {
    const authMiddleware = requireAuth('admin');
    return authMiddleware(c, next);
  }

  // All other endpoints require read auth
  const authMiddleware = requireAuth('read');
  return authMiddleware(c, next);
});

// Root alias for the OpenAPI spec. The canonical path is /v1/openapi.json,
// but agents and SDK generators commonly probe /openapi.json at the API
// origin first — redirect there so discovery works without prior knowledge
// of the version prefix.
app.get('/openapi.json', (c) => c.redirect('/v1/openapi.json', 301));

// Route registration

const routes = app
  .basePath('/v1')
  .route('/', system)
  .route('/listening', listening)
  .route('/running', running)
  .route('/watching', watching)
  .route('/', webhooks)
  .route('/', imagesRoute)
  .route('/', collecting)
  .route('/reading', reading)
  .route('/places', places)
  .route('/coding', coding)
  .route('/attending', attending)
  .route('/feed', feed)
  .route('/search', search)
  .route('/', query)
  .route('/admin/export', exportRoute)
  .route('/admin/keys', keys)
  .route('/admin', adminReindex)
  .route('/', adminAttending)
  .route('/', adminSync);

// Register OpenAPI security scheme
routes.openAPIRegistry.registerComponent(
  'securitySchemes',
  'bearerAuth',
  securitySchemes.bearerAuth
);

// OpenAPI spec endpoint
routes.use('/openapi.json', async (c, next) => {
  await next();
  c.header('Cache-Control', 'public, max-age=300, s-maxage=300');
});
routes.doc31('/openapi.json', openAPIConfig);

// Cron handler
export default {
  fetch: app.fetch,
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    console.log(`[SYNC] Cron triggered: ${event.cron}`);
    const db = createDb(env.DB);

    switch (event.cron) {
      case '*/15 * * * *': {
        console.log('[SYNC] Last.fm scrobble sync');
        const client = new LastfmClient(
          env.LASTFM_API_KEY,
          env.LASTFM_USERNAME
        );
        ctx.waitUntil(
          syncListening(db, client, { type: 'scrobbles' })
            .then(() => processListeningImages(db, env))
            .catch((err) =>
              console.log(
                `[ERROR] Scrobble sync cron failed: ${err instanceof Error ? err.message : String(err)}`
              )
            )
        );
        break;
      }
      case '0 * * * *': {
        // Hourly high-frequency feeds. Strava activities, Trakt watch
        // history, Foursquare/Swarm check-ins, and coding activity
        // (WakaTime/RescueTime/GitHub) change often enough that daily /
        // 6-hourly freshness felt stale. Collection-style Trakt data
        // (owned media) stays on the weekly Sunday job.
        const runningRetry = await shouldRetry(db, 'running');
        if (runningRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed running sync (${runningRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Strava activities (hourly)');
        ctx.waitUntil(
          syncRunning(env, db).catch((e) =>
            console.log(`[ERROR] Strava cron sync failed: ${e}`)
          )
        );

        if (env.TRAKT_CLIENT_ID) {
          console.log('[SYNC] Trakt watch history sync (hourly)');
          ctx.waitUntil(
            (async () => {
              try {
                await syncTraktHistory(env);
                const skip = await shouldSkipWatchingImages(db);
                if (skip) {
                  console.log(
                    '[SYNC] Skipping watching image processing: Plex cron already ran it recently'
                  );
                } else {
                  await processWatchingImages(db, env);
                }
              } catch (error) {
                console.log(
                  `[ERROR] Trakt history sync failed: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            })()
          );
        }

        if (env.FOURSQUARE_ACCESS_TOKEN) {
          console.log('[SYNC] Foursquare check-in sync (hourly)');
          ctx.waitUntil(
            syncPlaces(env).catch((error) =>
              console.log(
                `[ERROR] Foursquare sync failed: ${error instanceof Error ? error.message : String(error)}`
              )
            )
          );
        }

        if (
          env.WAKATIME_API_KEY ||
          env.RESCUETIME_API_KEY ||
          env.GITHUB_TOKEN
        ) {
          console.log('[SYNC] Coding sync (hourly)');
          ctx.waitUntil(
            syncCoding(env).catch((error) =>
              console.log(
                `[ERROR] Coding sync failed: ${error instanceof Error ? error.message : String(error)}`
              )
            )
          );
        }
        break;
      }
      case '0 3 * * *': {
        const listeningRetry = await shouldRetry(db, 'listening');
        if (listeningRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed listening sync (${listeningRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Last.fm top lists + stats');
        const lastfmClient = new LastfmClient(
          env.LASTFM_API_KEY,
          env.LASTFM_USERNAME
        );
        ctx.waitUntil(
          (async () => {
            try {
              await syncListening(db, lastfmClient, { type: 'top_lists' });
              await syncListening(db, lastfmClient, { type: 'stats' });
              await processListeningImages(db, env);
            } catch (err) {
              console.log(
                `[ERROR] Last.fm daily sync failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }

            // Apple Music enrichment steps. Isolated from the sync above —
            // iTunes / Apple Music 403s or outages should not mark the
            // Last.fm sync as failed. Each step independently try/catched so
            // a failure in one doesn't poison the others.
            try {
              const trackResult = await enrichBatch(db, 200);
              const artistResult = await enrichArtistsByName(db, 100);
              const imageResult = await refreshArtistImageFromAppleMusicId(
                db,
                env,
                100
              );
              console.log(
                `[ENRICH] tracks ${trackResult.succeeded}/${trackResult.skipped}/${trackResult.failed}` +
                  ` artists ${artistResult.succeeded}/${artistResult.skipped}/${artistResult.failed}` +
                  ` images ${imageResult.succeeded}/${imageResult.skipped}/${imageResult.failed}` +
                  ` (succeeded/skipped/failed)`
              );
            } catch (err) {
              console.log(
                `[ERROR] Apple Music enrichment failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }

            // Last.fm similar-artists enrichment. Refreshes the user's
            // top-200 artists by playcount whose `similar_synced_at` is
            // missing or > 90d old. ~3.5 req/s sustained at the top end of
            // the batch (well under the 5 req/s rate limit baked into
            // LastfmClient). Surface for the artist card's
            // similar-artists footer.
            try {
              const { backfillSimilarArtistsForTop } =
                await import('./services/lastfm/enrichment.js');
              const simResult = await backfillSimilarArtistsForTop(
                db,
                lastfmClient,
                200
              );
              console.log(
                `[ENRICH] similar-artists ${simResult.refreshed}/${simResult.checked} (refreshed/checked)`
              );
            } catch (err) {
              console.log(
                `[ERROR] Last.fm similar-artists enrichment failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }

            // Album-attribution-repair integrity watchdog. Counts tracks
            // whose artist_id doesn't match their album's artist_id
            // (excluding albums attributed to the canonical Various
            // Artists row, where the mismatch is correct by design).
            // Post-Phase-3-apply this should be small and stable; growth
            // signals a sync regression. See
            // docs/projects/album-attribution-repair/.
            try {
              const { sql } = await import('drizzle-orm');
              const { lastfmAlbums, lastfmTracks } =
                await import('./db/schema/lastfm.js');
              const { getVariousArtistsId } =
                await import('./services/lastfm/constants.js');
              const vaId = await getVariousArtistsId(db);
              const [row] = await db
                .select({ n: sql<number>`count(*)` })
                .from(lastfmTracks)
                .innerJoin(
                  lastfmAlbums,
                  sql`${lastfmTracks.albumId} = ${lastfmAlbums.id}`
                )
                .where(
                  vaId === null
                    ? sql`${lastfmTracks.artistId} != ${lastfmAlbums.artistId}`
                    : sql`${lastfmTracks.artistId} != ${lastfmAlbums.artistId} AND ${lastfmAlbums.artistId} != ${vaId}`
                );
              const mismatch = Number(row?.n ?? 0);
              if (mismatch > 0) {
                console.log(
                  `[WARN] album-attribution integrity: ${mismatch} tracks where track.artist_id != album.artist_id`
                );
              } else {
                console.log('[INTEGRITY] album attribution clean');
              }
            } catch (err) {
              console.log(
                `[ERROR] integrity check failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          })()
        );
        break;
      }
      // The '30 3 * * *' Plex library scan lived here until issue #17. Its
      // trigger came out of wrangler.toml on 2026-07-26 because this instance
      // has no Plex server, leaving the branch unreachable. Plex syncs on
      // demand via POST /v1/admin/sync/watching?source=plex, which no-ops
      // until PLEX_URL/PLEX_TOKEN are set.
      case '45 3 * * SUN': {
        const collectingRetry = await shouldRetry(db, 'collecting');
        if (collectingRetry.shouldRetry) {
          console.log(
            `[SYNC] Retrying failed collecting sync (${collectingRetry.consecutiveFailures} consecutive failures)`
          );
        }
        console.log('[SYNC] Discogs + Trakt collections (Sunday)');
        ctx.waitUntil(
          (async () => {
            try {
              await syncCollecting(env);
              await processCollectingImages(db, env);
            } catch (err) {
              console.log(`[ERROR] Discogs cron sync failed: ${err}`);
            }
          })()
        );
        ctx.waitUntil(
          syncTraktCollection(env).catch((err) =>
            console.log(`[ERROR] Trakt cron sync failed: ${err}`)
          )
        );
        break;
      }
      // Triggers for Letterboxd/Instapaper ('0 */6 * * *'), attending
      // ('0 4 * * *'), and the Instapaper deletion reconciliation
      // ('0 5 * * SUN') came out of wrangler.toml on 2026-07-26 -- see the
      // note there for why none of them could do work on this instance.
      // Their handler blocks are removed too: an unreachable `case` is not
      // free, it is what let a genuinely-broken trigger hide among
      // intentionally-dead ones (issue #18). src/__tests__/cron-wiring.test.ts
      // now fails if the two sides drift again.
      default:
        console.log(`[SYNC] Unknown cron: ${event.cron}`);
    }
  },
};

// Export type for Hono RPC
export type AppType = typeof routes;
