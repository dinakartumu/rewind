import { describe, it, expect } from 'vitest';
import { resolveIntegration } from './integrations.js';
import { validateReadOnlySql } from './sql-guard.js';

/** The guard is the only supported way to get a table list; go through it. */
function integrationFor(sql: string): string | null {
  const gate = validateReadOnlySql(sql);
  if (!gate.ok) throw new Error(`guard rejected: ${gate.error}`);
  return resolveIntegration(gate.tables);
}

describe('resolveIntegration', () => {
  it('names the service behind a single-table query', () => {
    expect(
      integrationFor(
        "SELECT strftime('%Y', scrobbled_at) AS year, count(*) FROM lastfm_scrobbles GROUP BY year"
      )
    ).toBe('lastfm');
    expect(integrationFor('SELECT name, distance FROM strava_activities')).toBe(
      'strava'
    );
    expect(integrationFor('SELECT title FROM reading_items')).toBe(
      'instapaper'
    );
    expect(integrationFor('SELECT venue_name FROM checkins')).toBe(
      'foursquare'
    );
  });

  it('stays with the service when joining a shared table', () => {
    // images/activity_feed carry no integration of their own, so joining one
    // must not dilute the answer — this is the common artwork join.
    expect(
      integrationFor(
        "SELECT a.name, i.r2_key FROM lastfm_albums a JOIN images i ON i.entity_type='albums' AND i.entity_id = CAST(a.id AS TEXT)"
      )
    ).toBe('lastfm');
  });

  it('joins across services resolve to null rather than picking a winner', () => {
    expect(
      integrationFor(
        'SELECT r.name, c.venue_name FROM strava_activities r JOIN checkins c ON date(r.started_at) = date(c.checked_in_at)'
      )
    ).toBeNull();
  });

  it('returns null for a query with no integration-owned table', () => {
    expect(integrationFor('SELECT count(*) FROM images')).toBeNull();
  });

  it('leaves watching neutral so TMDB does not get credit for a watch', () => {
    // movies/shows are TMDB-enriched catalogues, not a log of user activity;
    // the renderer tints these from watch_history.source instead.
    expect(
      integrationFor(
        'SELECT m.title, w.watched_at FROM watch_history w JOIN movies m ON w.movie_id = m.id'
      )
    ).toBeNull();
  });

  it('ignores a CTE name that shadows nothing real', () => {
    expect(
      integrationFor(
        'WITH recent AS (SELECT * FROM lastfm_scrobbles) SELECT count(*) FROM recent'
      )
    ).toBe('lastfm');
  });
});

describe('sql guard table extraction', () => {
  it('reports the base tables it already parsed for the allow-list', () => {
    const gate = validateReadOnlySql(
      'SELECT * FROM lastfm_tracks t JOIN lastfm_artists a ON a.id = t.artist_id'
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect([...gate.tables].sort()).toEqual([
      'lastfm_artists',
      'lastfm_tracks',
    ]);
  });

  it('excludes CTE names from the table list', () => {
    const gate = validateReadOnlySql(
      'WITH runs AS (SELECT * FROM strava_activities) SELECT * FROM runs'
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.tables).toEqual(['strava_activities']);
  });
});
