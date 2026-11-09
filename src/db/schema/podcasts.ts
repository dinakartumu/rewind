import {
  integer,
  sqliteTable,
  text,
  real,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

/**
 * Podcast domain -- imported from Castro `.castrobackup` snapshots plus
 * metadata scraped from castro.fm show pages.
 *
 * Castro stores only opaque UUIDs: episode UUIDs are not resolvable to titles
 * by any public endpoint. Episodes are therefore matched to real episodes by
 * show + duration + publish date, and every episode row carries a
 * `match_confidence`. Rows with confidence 'none' are still kept so that
 * listening history survives even where the title could not be recovered.
 *
 * Artwork is not stored here beyond the source URL -- show and episode covers
 * go through the shared `images` pipeline (domain 'listening', entity_type
 * 'podcast_show' / 'podcast_episode') so they get thumbhash and colours like
 * every other image in the API.
 */

export const podcastShows = sqliteTable(
  'podcast_shows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    // Castro's internal id; the join key back to the backup file.
    castroPublicId: text('castro_public_id').notNull(),
    castroShortCode: text('castro_short_code'),
    castroUrl: text('castro_url'),
    // Stable cross-service identity. Prefer this over the Castro UUID for any
    // future reconciliation -- Castro ids are meaningless outside Castro.
    itunesId: text('itunes_id'),
    feedUrl: text('feed_url'),
    website: text('website'),
    title: text('title'),
    author: text('author'),
    description: text('description'),
    artworkUrl: text('artwork_url'),
    categories: text('categories'), // JSON array of strings

    // Per-show playback preferences captured from the backup.
    subscribed: integer('subscribed').notNull().default(0),
    playbackRate: integer('playback_rate'),
    trimSilence: integer('trim_silence').notNull().default(0),
    monoMix: integer('mono_mix').notNull().default(0),
    enhancedAudio: integer('enhanced_audio').notNull().default(0),
    episodeLimit: integer('episode_limit'),
    policy: integer('policy'),
    startEpisodesAt: integer('start_episodes_at'),
    endEpisodesAt: integer('end_episodes_at'),
    mostRecentEpisodeId: text('most_recent_episode_id'),

    // Denormalised rollups so list endpoints don't scan play sessions.
    episodeCount: integer('episode_count').notNull().default(0),
    episodesPlayed: integer('episodes_played').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    totalListenedSeconds: integer('total_listened_seconds')
      .notNull()
      .default(0),
    firstPlayedAt: text('first_played_at'),
    lastPlayedAt: text('last_played_at'),

    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_podcast_shows_user_castro').on(
      table.userId,
      table.castroPublicId
    ),
    index('idx_podcast_shows_user_id').on(table.userId),
    index('idx_podcast_shows_itunes').on(table.itunesId),
    index('idx_podcast_shows_subscribed').on(table.subscribed),
    index('idx_podcast_shows_listened').on(table.totalListenedSeconds),
  ]
);

export const podcastEpisodes = sqliteTable(
  'podcast_episodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    showId: integer('show_id').references(() => podcastShows.id),
    // The UUID from the backup. Unique and always present, even when the
    // episode could not be identified.
    castroEpisodeId: text('castro_episode_id').notNull(),
    castroShortCode: text('castro_short_code'),
    castroUrl: text('castro_url'),

    // Null when match_confidence = 'none'.
    title: text('title'),
    episodeNumber: integer('episode_number'),
    publishedAt: text('published_at'),
    durationSeconds: integer('duration_seconds'),
    audioUrl: text('audio_url'),
    artworkUrl: text('artwork_url'),

    // How the episode was identified. 'high' and 'medium' are duration-exact
    // matches; 'low' is a best guess and may name the wrong episode; 'none'
    // means no candidate survived. match_candidates keeps the runners-up as
    // JSON so a better matcher can refine later without re-deriving anything.
    matchConfidence: text('match_confidence').notNull().default('none'),
    matchDeltaSeconds: real('match_delta_seconds'),
    matchCandidates: text('match_candidates'),

    // Per-episode state from the backup.
    starred: integer('starred').notNull().default(0),
    unpublished: integer('unpublished').notNull().default(0),
    resumePositionSeconds: real('resume_position_seconds'),
    inLibraryState: text('in_library_state'), // 'inbox' | 'queue' | 'archived'

    // Rollups from play sessions.
    timesPlayed: integer('times_played').notNull().default(0),
    totalListenedSeconds: integer('total_listened_seconds')
      .notNull()
      .default(0),
    maxPlayedSeconds: real('max_played_seconds'),
    completed: integer('completed').notNull().default(0),
    firstPlayedAt: text('first_played_at'),
    lastPlayedAt: text('last_played_at'),

    language: text('language'),
    hasTranscript: integer('has_transcript').notNull().default(0),

    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_podcast_episodes_user_castro').on(
      table.userId,
      table.castroEpisodeId
    ),
    index('idx_podcast_episodes_show').on(table.showId),
    index('idx_podcast_episodes_user_id').on(table.userId),
    index('idx_podcast_episodes_confidence').on(table.matchConfidence),
    index('idx_podcast_episodes_starred').on(table.starred),
    index('idx_podcast_episodes_played').on(table.lastPlayedAt),
    index('idx_podcast_episodes_transcript').on(table.hasTranscript),
  ]
);

export const podcastPlaySessions = sqliteTable(
  'podcast_play_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    // Nullable: sessions for unidentifiable episodes still belong in history.
    episodeId: integer('episode_id').references(() => podcastEpisodes.id),
    showId: integer('show_id').references(() => podcastShows.id),
    castroEpisodeId: text('castro_episode_id'),
    castroPodcastId: text('castro_podcast_id'),

    beganAt: text('began_at').notNull(),
    finishedAt: text('finished_at'),
    playedFromSeconds: real('played_from_seconds'),
    playedToSeconds: real('played_to_seconds'),
    listenedSeconds: real('listened_seconds'),
    trimmed: integer('trimmed').notNull().default(0),

    backupId: integer('backup_id').references(() => podcastBackups.id),

    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    // Makes re-importing the same snapshot idempotent.
    uniqueIndex('idx_podcast_sessions_unique').on(
      table.userId,
      table.castroEpisodeId,
      table.beganAt
    ),
    index('idx_podcast_sessions_episode').on(table.episodeId),
    index('idx_podcast_sessions_show').on(table.showId),
    index('idx_podcast_sessions_began').on(table.beganAt),
    index('idx_podcast_sessions_user_id').on(table.userId),
  ]
);

/**
 * Transcript text lives here; per-segment timestamps and the pre-ad-removal
 * raw text live in R2, since they are large and rarely queried.
 *
 * `text` is the ad-stripped transcript. Ads are dynamically inserted and
 * differ per download, so they are not content -- but detection is imperfect,
 * hence ad_detection_method records how a given row was cleaned.
 */
export const podcastTranscripts = sqliteTable(
  'podcast_transcripts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    episodeId: integer('episode_id')
      .notNull()
      .references(() => podcastEpisodes.id),

    language: text('language'),
    engine: text('engine').notNull(),
    wordCount: integer('word_count').notNull().default(0),
    text: text('text').notNull(),

    adSecondsRemoved: real('ad_seconds_removed').notNull().default(0),
    adSpans: text('ad_spans'), // JSON array of [start, end] pairs
    adDetectionMethod: text('ad_detection_method'),

    segmentsR2Key: text('segments_r2_key'),
    rawTextR2Key: text('raw_text_r2_key'),

    transcribedAt: text('transcribed_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_podcast_transcripts_episode').on(table.episodeId),
    index('idx_podcast_transcripts_user_id').on(table.userId),
    index('idx_podcast_transcripts_engine').on(table.engine),
  ]
);

/**
 * Provenance for each imported snapshot. There are 500+ backup files spanning
 * several years; without this it is impossible to tell which one a row came
 * from or whether a file has already been ingested.
 */
export const podcastBackups = sqliteTable(
  'podcast_backups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    filename: text('filename').notNull(),
    exportedAt: text('exported_at').notNull(),
    deviceName: text('device_name'),
    deviceModel: text('device_model'),
    modelVersion: integer('model_version'),
    showCount: integer('show_count').notNull().default(0),
    episodeCount: integer('episode_count').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    importedAt: text('imported_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_podcast_backups_file').on(table.userId, table.filename),
    index('idx_podcast_backups_exported').on(table.exportedAt),
  ]
);
