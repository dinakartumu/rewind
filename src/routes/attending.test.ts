import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { attendedEvents, players, venues } from '../db/schema/attending.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

describe('attending - Tier 1 filter additions', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({
      name: 'attending-tier1-test',
      scope: 'read',
    });
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.delete(attendedEvents);
    await db.delete(players);
    await db.delete(venues);
  });

  describe('GET /v1/attending/events?team=...', () => {
    async function seedThreeGames() {
      const db = drizzle(env.DB);
      const now = new Date().toISOString();
      // Mariners home vs Rangers
      await db.insert(attendedEvents).values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2025-04-19',
        title: 'Texas Rangers at Seattle Mariners',
        eventData: JSON.stringify({
          league: 'mlb',
          season: 2025,
          home_team: { id: 136, name: 'Seattle Mariners' },
          away_team: { id: 140, name: 'Texas Rangers' },
        }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      });
      // Mariners away at Yankees
      await db.insert(attendedEvents).values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2025-05-10',
        title: 'Seattle Mariners at New York Yankees',
        eventData: JSON.stringify({
          league: 'mlb',
          season: 2025,
          home_team: { id: 147, name: 'New York Yankees' },
          away_team: { id: 136, name: 'Seattle Mariners' },
        }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      });
      // Huskies game (no Mariners)
      await db.insert(attendedEvents).values({
        userId: 1,
        category: 'sports',
        eventType: 'ncaaf_game',
        eventDate: '2025-09-20',
        title: 'Oregon at Washington',
        eventData: JSON.stringify({
          league: 'ncaaf',
          season: 2025,
          home_team: { id: 264, name: 'Washington Huskies' },
          away_team: { id: 2483, name: 'Oregon Ducks' },
        }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    it('team substring matches both home and away appearances', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=mariners&limit=10',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ title: string }> };
      expect(body.data).toHaveLength(2);
      const titles = body.data.map((e) => e.title).sort();
      expect(titles).toEqual([
        'Seattle Mariners at New York Yankees',
        'Texas Rangers at Seattle Mariners',
      ]);
    });

    it('team substring is case-insensitive', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=MARINERS',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);
    });

    it('team substring matches across leagues', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=washington',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ title: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('Oregon at Washington');
    });

    it('team_id matches the integer id on either side', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team_id=136',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);
    });

    it('team filter combines with other filters', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=mariners&event_type=mlb_game&season=2025',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);
    });

    it('team filter returns empty when no match', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=dodgers',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(0);
    });
  });

  describe('GET /v1/attending/players?name=...', () => {
    async function seedThreePlayers() {
      const db = drizzle(env.DB);
      const now = new Date().toISOString();
      await db.insert(players).values([
        {
          userId: 1,
          league: 'mlb',
          fullName: 'Julio Rodríguez',
          firstName: 'Julio',
          lastName: 'Rodríguez',
          primaryPosition: 'CF',
          primaryTeamId: 136,
          createdAt: now,
          updatedAt: now,
        },
        {
          userId: 1,
          league: 'mlb',
          fullName: 'Will Smith',
          firstName: 'Will',
          lastName: 'Smith',
          primaryPosition: 'C',
          primaryTeamId: 119,
          createdAt: now,
          updatedAt: now,
        },
        {
          userId: 1,
          league: 'mlb',
          fullName: 'Will Smith',
          firstName: 'Will',
          lastName: 'Smith',
          primaryPosition: 'P',
          primaryTeamId: 137,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }

    it('name substring is case-insensitive', async () => {
      await seedThreePlayers();
      const res = await SELF.fetch(
        'https://test/v1/attending/players?name=JULIO',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ full_name: string; primary_position: string | null }>;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].full_name).toBe('Julio Rodríguez');
    });

    it('name substring returns multiple hits with disambiguating fields', async () => {
      await seedThreePlayers();
      const res = await SELF.fetch(
        'https://test/v1/attending/players?name=will smith',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          full_name: string;
          primary_position: string | null;
          primary_team_id: number | null;
        }>;
      };
      expect(body.data).toHaveLength(2);
      const positions = body.data.map((p) => p.primary_position).sort();
      expect(positions).toEqual(['C', 'P']);
    });

    it('combines with league filter', async () => {
      await seedThreePlayers();
      const res = await SELF.fetch(
        'https://test/v1/attending/players?name=julio&league=mlb',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(1);
    });
  });
});
