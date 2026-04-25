-- Composite index supporting per-artist sparkline queries:
--   FROM lastfm_scrobbles s JOIN lastfm_tracks t ON s.track_id = t.id
--   WHERE t.artist_id IN (...) AND s.scrobbled_at >= :from
-- Without this, the (track_id-only) probe re-checks scrobbled_at per row.
-- Also accelerates the foreseeable artist-detail "plays over time" query.
CREATE INDEX IF NOT EXISTS idx_lastfm_scrobbles_track_scrobbled
  ON lastfm_scrobbles (track_id, scrobbled_at);
