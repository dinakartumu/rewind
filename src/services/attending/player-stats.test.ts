import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createDb, type Database } from '../../db/client.js';
import {
  attendedEvents,
  attendedEventPlayers,
  players,
} from '../../db/schema/attending.js';
import { setupTestDb } from '../../test-helpers.js';
import {
  aggregatePlayerStats,
  formatIp,
  parseIpToOuts,
  PlayerNotFoundError,
} from './player-stats.js';

describe('parseIpToOuts / formatIp', () => {
  it('parses baseball-style IP into outs', () => {
    expect(parseIpToOuts('0.0')).toBe(0);
    expect(parseIpToOuts('0.1')).toBe(1);
    expect(parseIpToOuts('0.2')).toBe(2);
    expect(parseIpToOuts('1.0')).toBe(3);
    expect(parseIpToOuts('6.2')).toBe(20);
    expect(parseIpToOuts('7.0')).toBe(21);
  });

  it('returns 0 on undefined / garbage', () => {
    expect(parseIpToOuts(undefined)).toBe(0);
    expect(parseIpToOuts('')).toBe(0);
    expect(parseIpToOuts('garbage')).toBe(0);
  });

  it('formats outs back to baseball-style IP', () => {
    expect(formatIp(0)).toBe('0.0');
    expect(formatIp(1)).toBe('0.1');
    expect(formatIp(2)).toBe('0.2');
    expect(formatIp(3)).toBe('1.0');
    expect(formatIp(20)).toBe('6.2');
    expect(formatIp(21)).toBe('7.0');
  });

  it('round-trips correctly across the third-out wraparound', () => {
    // 6.2 + 0.1 = 7.0 (20 outs + 1 = 21 outs = 7 innings)
    const sumOuts = parseIpToOuts('6.2') + parseIpToOuts('0.1');
    expect(formatIp(sumOuts)).toBe('7.0');
    // 5.1 + 1.2 = 7.0 (16 + 5 = 21 outs)
    expect(formatIp(parseIpToOuts('5.1') + parseIpToOuts('1.2'))).toBe('7.0');
    // 1.2 + 1.2 + 1.2 = 6.0 (5 + 5 + 5 = 15 outs)
    expect(
      formatIp(
        parseIpToOuts('1.2') + parseIpToOuts('1.2') + parseIpToOuts('1.2')
      )
    ).toBe('5.0'); // 15 outs / 3 = 5.0 innings
  });
});

describe('aggregatePlayerStats', () => {
  let db: Database;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    db = createDb(env.DB);
    await db.delete(attendedEventPlayers);
    await db.delete(attendedEvents);
    await db.delete(players);
  });

  async function seedHitter() {
    const now = new Date().toISOString();
    const [player] = await db
      .insert(players)
      .values({
        userId: 1,
        league: 'mlb',
        fullName: 'Cal Raleigh',
        primaryPosition: 'C',
        primaryTeamId: 136,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [g1] = await db
      .insert(attendedEvents)
      .values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2025-04-01',
        title: 'g1',
        eventData: JSON.stringify({ season: 2025 }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [g2] = await db
      .insert(attendedEvents)
      .values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2024-08-01',
        title: 'g2',
        eventData: JSON.stringify({ season: 2024 }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await db.insert(attendedEventPlayers).values([
      {
        userId: 1,
        eventId: g1.id,
        playerId: player.id,
        teamId: 136,
        isHome: 1,
        battingLine: JSON.stringify({
          ab: 4,
          h: 2,
          hr: 1,
          rbi: 3,
          bb: 0,
          k: 1,
          pa: 4,
          total_bases: 5,
          doubles: 0,
          triples: 0,
          sb: 0,
          hbp: 0,
          r: 1,
        }),
        decision: null,
        notable: 1,
      },
      {
        userId: 1,
        eventId: g2.id,
        playerId: player.id,
        teamId: 136,
        isHome: 0,
        battingLine: JSON.stringify({
          ab: 3,
          h: 1,
          hr: 0,
          rbi: 0,
          bb: 1,
          k: 0,
          pa: 4,
          total_bases: 1,
          doubles: 0,
          triples: 0,
          sb: 0,
          hbp: 0,
          r: 0,
        }),
        decision: null,
        notable: 0,
      },
    ]);
    return { player, g1, g2 };
  }

  it('aggregates hitter career across all attended games (default scope)', async () => {
    const { player } = await seedHitter();
    const r = await aggregatePlayerStats(db, player.id);
    if (!('hitter' in r)) throw new Error('expected hitter');
    expect(r.scope).toBe('career');
    expect(r.season).toBeUndefined();
    expect(r.games).toBe(2);
    expect(r.games_with_box_score).toBe(2);
    expect(r.batting.pa).toBe(8);
    expect(r.batting.ab).toBe(7);
    expect(r.batting.h).toBe(3);
    expect(r.batting.hr).toBe(1);
    expect(r.batting.rbi).toBe(3);
    expect(r.batting.bb).toBe(1);
    expect(r.batting.total_bases).toBe(6);
    expect(r.batting.avg).toBe('.429'); // 3/7
    expect(r.batting.slg).toBe('.857'); // 6/7
  });

  it('aggregates hitter for one season when season is set', async () => {
    const { player } = await seedHitter();
    const r = await aggregatePlayerStats(db, player.id, 2025);
    if (!('hitter' in r)) throw new Error('expected hitter');
    expect(r.scope).toBe('season');
    expect(r.season).toBe(2025);
    expect(r.games).toBe(1);
    expect(r.batting.pa).toBe(4);
    expect(r.batting.h).toBe(2);
    expect(r.batting.hr).toBe(1);
  });

  it('aggregates pitcher career with IP outs-math, ERA, WHIP, decisions', async () => {
    const now = new Date().toISOString();
    const [player] = await db
      .insert(players)
      .values({
        userId: 1,
        league: 'mlb',
        fullName: 'George Kirby',
        primaryPosition: 'P',
        primaryTeamId: 136,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const events = await db
      .insert(attendedEvents)
      .values([
        {
          userId: 1,
          category: 'sports',
          eventType: 'mlb_game',
          eventDate: '2025-04-01',
          title: 'g1',
          eventData: JSON.stringify({ season: 2025 }),
          attended: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          userId: 1,
          category: 'sports',
          eventType: 'mlb_game',
          eventDate: '2025-04-08',
          title: 'g2',
          eventData: JSON.stringify({ season: 2025 }),
          attended: 1,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning();
    await db.insert(attendedEventPlayers).values([
      {
        userId: 1,
        eventId: events[0].id,
        playerId: player.id,
        teamId: 136,
        isHome: 1,
        pitchingLine: JSON.stringify({
          ip: '6.2',
          h: 5,
          r: 2,
          er: 2,
          bb: 1,
          k: 7,
          hr: 1,
          pitches: 100,
          strikes: 65,
          batters_faced: 28,
        }),
        decision: 'W',
        notable: 1,
      },
      {
        userId: 1,
        eventId: events[1].id,
        playerId: player.id,
        teamId: 136,
        isHome: 0,
        pitchingLine: JSON.stringify({
          ip: '0.1', // 1 out — total 21 outs across both
          h: 0,
          r: 0,
          er: 0,
          bb: 0,
          k: 1,
          hr: 0,
          pitches: 5,
          strikes: 4,
          batters_faced: 1,
        }),
        decision: null,
        notable: 0,
      },
    ]);
    const r = await aggregatePlayerStats(db, player.id);
    if (!('pitcher' in r)) throw new Error('expected pitcher');
    expect(r.pitching.bf).toBe(29);
    // 20 outs + 1 out = 21 outs = 7.0 innings
    expect(r.pitching.ip).toBe('7.0');
    expect(r.pitching.k).toBe(8);
    expect(r.pitching.er).toBe(2);
    // ERA = (2 * 27) / 21 = 2.57
    expect(r.pitching.era).toBe('2.57');
    // WHIP = (5 + 0 + 1 + 0) / 7.0 = 0.86
    expect(r.pitching.whip).toBe('0.86');
    expect(r.pitching.decisions.w).toBe(1);
    expect(r.pitching.decisions.l).toBe(0);
  });

  it('returns supported:false with appearance summaries for non-MLB players', async () => {
    const now = new Date().toISOString();
    const [player] = await db
      .insert(players)
      .values({
        userId: 1,
        league: 'ncaaf',
        fullName: 'Some Husky',
        primaryPosition: 'QB',
        primaryTeamId: 264,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [event] = await db
      .insert(attendedEvents)
      .values({
        userId: 1,
        category: 'sports',
        eventType: 'ncaaf_game',
        eventDate: '2025-09-20',
        title: 'Oregon at Washington',
        eventData: JSON.stringify({
          season: 2025,
          home_team: { id: 264, name: 'Washington Huskies' },
          away_team: { id: 2483, name: 'Oregon Ducks' },
          home_score: 14,
          away_score: 26,
          my_team_won: false,
        }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await db.insert(attendedEventPlayers).values({
      userId: 1,
      eventId: event.id,
      playerId: player.id,
      teamId: 264,
      isHome: 1,
      decision: null,
      notable: 0,
    });

    const r = await aggregatePlayerStats(db, player.id);
    expect(r.supported).toBe(false);
    if (r.supported !== false) throw new Error('expected unsupported');
    expect(r.league).toBe('ncaaf');
    expect(r.appearances).toHaveLength(1);
    expect(r.appearances[0].home_team).toBe('Washington Huskies');
    expect(r.appearances[0].away_team).toBe('Oregon Ducks');
    expect(r.appearances[0].final_score).toBe('14-26');
    expect(r.appearances[0].my_team_won).toBe(false);
  });

  it('throws PlayerNotFoundError for unknown player id', async () => {
    await expect(aggregatePlayerStats(db, 999_999)).rejects.toThrow(
      PlayerNotFoundError
    );
  });

  it('excludes attended=0 (no-show) games from aggregates', async () => {
    const now = new Date().toISOString();
    const [player] = await db
      .insert(players)
      .values({
        userId: 1,
        league: 'mlb',
        fullName: 'Bench Guy',
        primaryPosition: '1B',
        primaryTeamId: 136,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [showed] = await db
      .insert(attendedEvents)
      .values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2025-04-01',
        title: 'attended',
        eventData: JSON.stringify({ season: 2025 }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [skipped] = await db
      .insert(attendedEvents)
      .values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2025-05-01',
        title: 'no-show',
        eventData: JSON.stringify({ season: 2025 }),
        attended: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await db.insert(attendedEventPlayers).values([
      {
        userId: 1,
        eventId: showed.id,
        playerId: player.id,
        teamId: 136,
        isHome: 1,
        battingLine: JSON.stringify({
          ab: 3,
          h: 1,
          hr: 0,
          rbi: 0,
          bb: 0,
          k: 0,
          pa: 3,
          total_bases: 1,
          doubles: 0,
          triples: 0,
          sb: 0,
          hbp: 0,
          r: 0,
        }),
        decision: null,
        notable: 0,
      },
      {
        userId: 1,
        eventId: skipped.id,
        playerId: player.id,
        teamId: 136,
        isHome: 1,
        battingLine: JSON.stringify({
          ab: 4,
          h: 4,
          hr: 4,
          rbi: 4,
          bb: 0,
          k: 0,
          pa: 4,
          total_bases: 16,
          doubles: 0,
          triples: 0,
          sb: 0,
          hbp: 0,
          r: 4,
        }),
        decision: null,
        notable: 1,
      },
    ]);
    const r = await aggregatePlayerStats(db, player.id);
    if (!('hitter' in r)) throw new Error('expected hitter');
    // Only the attended game should count — no 4-HR game appearing.
    expect(r.games).toBe(1);
    expect(r.batting.h).toBe(1);
    expect(r.batting.hr).toBe(0);
  });
});
