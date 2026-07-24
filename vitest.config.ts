import {
  defineWorkersConfig,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, 'migrations');
  let migrations: unknown[] = [];

  try {
    migrations = await readD1Migrations(migrationsPath);
  } catch {
    // No migrations yet
  }

  return {
    test: {
      testTimeout: 15000,
      exclude: ['**/node_modules/**', '**/.claude/**', 'mcp-server/**'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            d1Databases: ['DB'],
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Keep the test worker env hermetic. `@cloudflare/vitest-pool-workers`
              // auto-loads `.dev.vars` alongside the wrangler config, so a developer
              // with real secrets locally would otherwise leak them into the test
              // worker — causing sync/backfill code to hit LIVE external APIs and
              // breaking tests that assert "not configured" behavior. Explicit
              // bindings here take precedence over `.dev.vars`, so we blank every
              // domain secret. CI has no `.dev.vars`, so these are already unset
              // there; this only neutralizes local secrets. Any test that needs a
              // key present constructs its own `env` object.
              LASTFM_API_KEY: '',
              STRAVA_CLIENT_ID: '',
              STRAVA_CLIENT_SECRET: '',
              STRAVA_WEBHOOK_VERIFY_TOKEN: '',
              PLEX_URL: '',
              PLEX_TOKEN: '',
              PLEX_WEBHOOK_SECRET: '',
              TMDB_API_KEY: '',
              DISCOGS_PERSONAL_TOKEN: '',
              DISCOGS_USERNAME: '',
              TRAKT_CLIENT_ID: '',
              TRAKT_CLIENT_SECRET: '',
              INSTAPAPER_CONSUMER_KEY: '',
              INSTAPAPER_CONSUMER_SECRET: '',
              INSTAPAPER_ACCESS_TOKEN: '',
              INSTAPAPER_ACCESS_TOKEN_SECRET: '',
              FOURSQUARE_ACCESS_TOKEN: '',
              WAKATIME_API_KEY: '',
              RESCUETIME_API_KEY: '',
              GITHUB_TOKEN: '',
              GITHUB_USERNAME: '',
              APPLE_MUSIC_DEVELOPER_TOKEN: '',
              FANART_TV_API_KEY: '',
            },
          },
        },
      },
    },
  };
});
