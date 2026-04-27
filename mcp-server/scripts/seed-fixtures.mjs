#!/usr/bin/env node
/**
 * Pull real Rewind data into JSON snapshots used by the design workbench.
 *
 * Reads REWIND_ADMIN_KEY from .dev.vars at the repo root, calls the production
 * api.rewind.rest endpoints, and writes one JSON file per component into
 * mcp-server/web/fixtures/. The .fixtures.ts files import these for the
 * "real" variant; hand-curated edge cases live alongside.
 *
 * Re-run any time you want fresh snapshots:
 *   npm run fixtures:seed
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = resolve(here, '..');
const repoRoot = resolve(mcpServerRoot, '..');
const outDir = join(mcpServerRoot, 'web', 'fixtures');

const envText = readFileSync(join(repoRoot, '.dev.vars'), 'utf8');
const keyMatch = envText.match(/^REWIND_ADMIN_KEY=(.+)$/m);
if (!keyMatch) {
  console.error('REWIND_ADMIN_KEY not found in .dev.vars');
  process.exit(1);
}
const KEY = keyMatch[1].trim();

const API = 'https://api.rewind.rest/v1';

async function get(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function write(name, payload) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  const size = JSON.stringify(payload).length;
  console.log(`  ${name}.json → ${size.toLocaleString()} chars`);
}

async function seedRecentWatches() {
  console.log('recent-watches');
  const r = await get('/watching/recent?limit=8');
  // API returns { data: Watch[] }; MCP tool reshapes to { items: Watch[] }.
  write('recent-watches', { items: r.data });
}

async function seedRecentReads() {
  console.log('recent-reads');
  const r = await get('/reading/recent?limit=8');
  write('recent-reads', { items: r.data });
}

async function seedTopAlbums() {
  console.log('top-albums');
  const r = await get('/listening/top/albums?period=1month&limit=10');
  write('top-albums', { period: r.period, data: r.data });
}

async function seedTopArtists() {
  console.log('top-artists');
  const r = await get(
    '/listening/top/artists?period=1month&limit=10&include_sparklines=true'
  );
  write('top-artists', { period: r.period, data: r.data });
}

async function seedAttendedSeason() {
  console.log('attended-season');
  // Try the most recent likely-completed season first; fall back as needed.
  for (const year of [2025, 2024, 2023]) {
    try {
      const r = await get(`/attending/seasons/mlb/${year}`);
      if (r.data && r.data.length > 0) {
        write('attended-season', r);
        return r;
      }
    } catch {
      // try previous year
    }
  }
  console.warn('  (no MLB seasons with attended games found)');
  return null;
}

async function seedAttendedEvent(season) {
  console.log('attended-event');
  // Pick a notable event from the season — prefer the most recent attended one.
  const candidates = season?.data?.filter((g) => g.attended) ?? [];
  if (!candidates.length) {
    console.warn('  (no attended events to snapshot)');
    return;
  }
  // Most recent attended game.
  const pick = candidates[candidates.length - 1];
  const detail = await get(`/attending/events/${pick.id}`);
  write('attended-event', detail);
}

// ─── Single-entity card fixtures ────────────────────────────────────
// These reshape the flat backend response into the nested structuredContent
// shape the cards consume. The reshape mirrors the MCP tool layer so the
// workbench renders exactly what Claude Desktop / iOS sees in production.

async function seedArticle() {
  console.log('article');
  // Pick a recent saved article that has both an og:image and a real
  // title (skip "Untitled" — happens when Instapaper / extraction missed
  // the title; the card renders empty heading).
  const recent = await get('/reading/recent?limit=30');
  const withImage = recent.data?.find(
    (a) =>
      a.image &&
      (a.image.cdn_url || a.image.url) &&
      a.title &&
      a.title.trim() &&
      a.title.toLowerCase() !== 'untitled'
  );
  if (!withImage) {
    console.warn('  (no recent reads with both image and real title)');
    return;
  }
  const a = await get(`/reading/articles/${withImage.id}`);
  write('article', {
    article: {
      id: a.id,
      title: a.title,
      author: a.author,
      url: a.url,
      instapaper_url: a.instapaper_url,
      instapaper_app_url: a.instapaper_app_url,
      domain: a.domain,
      description: a.description,
      word_count: a.word_count,
      estimated_read_min: a.estimated_read_min,
      status: a.status,
      progress: a.progress,
      saved_at: a.saved_at,
      image: a.image,
    },
    highlights: (a.highlights ?? []).slice(0, 5).map((h) => ({
      id: h.id,
      text: h.text,
      note: h.note,
      created_at: h.created_at,
    })),
    highlight_count: a.highlights?.length ?? 0,
  });
}

async function seedArtist() {
  console.log('artist');
  // Resolve Olivia Rodrigo (Phase 2's example-query target — chosen for the
  // bio + similar-artists demos). The /listening/artists endpoint uses
  // `search` (not `name`); fall back to the top-1 artist if the lookup
  // ever returns empty.
  const search = await get('/listening/artists?search=olivia+rodrigo&limit=1');
  let id = search.data?.[0]?.id;
  if (!id) {
    const top = await get('/listening/top/artists?period=overall&limit=1');
    id = top.data?.[0]?.id;
  }
  if (!id) {
    console.warn('  (no artist to snapshot)');
    return;
  }
  const a = await get(`/listening/artists/${id}`);
  write('artist', {
    artist: {
      id: a.id,
      name: a.name,
      mbid: a.mbid,
      url: a.url,
      apple_music_url: a.apple_music_url,
      apple_music_id: null,
      genre: a.genre,
      tags: (a.tags ?? []).map((t) => t.name).slice(0, 5),
      bio_summary: a.bio_summary,
      bio_content: a.bio_content,
      image: a.image,
    },
    listening_stats: {
      total_scrobbles: a.scrobble_count ?? 0,
      first_scrobble_at: a.first_scrobbled_at ?? null,
      last_played_at: a.last_played_at ?? null,
      all_time_rank: a.all_time_rank ?? null,
      distinct_tracks: a.distinct_tracks ?? 0,
      distinct_albums: a.distinct_albums ?? 0,
    },
    sparkline: a.sparkline ?? null,
    top_tracks: (a.top_tracks ?? []).slice(0, 10).map((t, i) => ({
      rank: i + 1,
      id: t.id,
      name: t.name,
      album_id: t.album_id,
      album_name: t.album_name,
      scrobble_count: t.scrobble_count,
      apple_music_url: t.apple_music_url,
      preview_url: t.preview_url,
      image: t.image,
    })),
    top_albums: (a.top_albums ?? []).slice(0, 5).map((al, i) => ({
      rank: i + 1,
      id: al.id,
      name: al.name,
      playcount: al.playcount,
      apple_music_url: al.apple_music_url,
      image: al.image,
    })),
    similar_artists: (a.similar_artists ?? []).slice(0, 5),
  });
  return id;
}

async function seedTopTracks(artistId) {
  console.log('top-tracks');
  // Prefer artist-filtered tracks (matches the artist card's narrative); fall
  // back to unfiltered top tracks so the grid + list cards always have data
  // to render even when the seeded artist hasn't been scrobbled at track
  // granularity (older Last.fm imports often miss track-level history).
  if (artistId) {
    const r = await get(
      `/listening/top/tracks?artist_id=${artistId}&period=overall&limit=20`
    );
    if (r.data?.length) {
      write('top-tracks', {
        period: r.period,
        artist_id: r.artist_id ?? artistId,
        data: r.data,
      });
      return;
    }
    console.warn(
      `  (artist_id=${artistId} has no track-level scrobbles, falling back to unfiltered)`
    );
  }
  const r = await get('/listening/top/tracks?period=1month&limit=12');
  write('top-tracks', {
    period: r.period,
    artist_id: r.artist_id ?? null,
    data: r.data,
  });
}

function deriveNotableReasons(a) {
  const reasons = [];
  if (a.batting_line) {
    const b = a.batting_line;
    if ((b.hr ?? 0) > 0) reasons.push(`${b.hr} HR`);
    if ((b.h ?? 0) >= 3) reasons.push('multi-hit');
    if ((b.rbi ?? 0) >= 4) reasons.push(`${b.rbi} RBI`);
    if ((b.sb ?? 0) >= 2) reasons.push(`${b.sb} SB`);
  }
  if (a.pitching_line) {
    const p = a.pitching_line;
    const ipNum = parseFloat(p.ip ?? '0');
    if (ipNum >= 9) reasons.push('complete game');
    if ((p.k ?? 0) >= 10) reasons.push(`${p.k} K`);
  }
  if (a.decision === 'W') reasons.push('win');
  if (a.decision === 'SV') reasons.push('save');
  return reasons;
}

async function seedAttendedPlayer() {
  console.log('attended-player');
  // Cal Raleigh — Phase 3's example query target. Fall back to any MLB
  // player with attended appearances if the lookup fails.
  let id = null;
  try {
    const search = await get('/attending/players?name=cal+raleigh&limit=1');
    id = search.data?.[0]?.id ?? null;
  } catch {
    // try the generic players list
  }
  if (!id) {
    const list = await get('/attending/players?league=mlb&limit=1');
    id = list.data?.[0]?.id ?? null;
  }
  if (!id) {
    console.warn('  (no attended MLB player to snapshot)');
    return;
  }
  const p = await get(`/attending/players/${id}`);
  const appearances = (p.appearances ?? []).map((a) => ({
    event_id: a.event_id,
    event_date: a.event_date,
    title: a.title,
    is_home: a.is_home,
    batting_line: a.batting_line,
    pitching_line: a.pitching_line,
    decision: a.decision,
    notable: a.notable,
    notable_reasons: deriveNotableReasons(a),
  }));
  write('attended-player', {
    player: {
      id: p.id,
      mlb_stats_id: p.mlb_stats_id,
      full_name: p.full_name,
      primary_position: p.primary_position,
      primary_number: p.primary_number,
      bats: p.bats,
      throws: p.throws,
      debut_date: p.debut_date,
      birth_country: p.birth_country,
      photo_silo: p.photo_silo,
      photo_full: p.photo_full,
      league: p.league,
      team: p.team,
    },
    supported: p.supported,
    season_stats: p.season_stats,
    attended_summary: p.attended_summary,
    attended_appearances: appearances.slice(0, 10),
    attended_appearance_count: p.appearance_count ?? appearances.length,
  });
}

async function main() {
  console.log(`Seeding fixtures from ${API} into ${outDir}\n`);
  await seedRecentWatches();
  await seedRecentReads();
  await seedTopAlbums();
  await seedTopArtists();
  const season = await seedAttendedSeason();
  if (season) await seedAttendedEvent(season);
  await seedArticle();
  const artistId = await seedArtist();
  await seedTopTracks(artistId);
  await seedAttendedPlayer();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
