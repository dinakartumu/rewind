import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb } from '../db/client.js';
import { stravaActivities } from '../db/schema/strava.js';
import { recomputeStats } from '../services/strava/sync.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';
import {
  formatDuration,
  formatPace,
  getWorkoutTypeLabel,
  calculateEddington,
} from '../services/strava/transforms.js';

describe('Running route helpers', () => {
  describe('formatActivityResponse helpers', () => {
    it('formats duration for display', () => {
      expect(formatDuration(2550)).toBe('42:30');
      expect(formatDuration(5400)).toBe('1:30:00');
    });

    it('formats pace for display', () => {
      expect(formatPace(8.167)).toBe('8:10/mi');
    });

    it('returns workout type label', () => {
      expect(getWorkoutTypeLabel(0)).toBe('default');
      expect(getWorkoutTypeLabel(1)).toBe('race');
    });
  });

  describe('Eddington endpoint logic', () => {
    it('computes Eddington from daily miles', () => {
      const dailyMilesMap = new Map<string, number>();
      // 10 days of 10+ miles
      for (let i = 0; i < 10; i++) {
        dailyMilesMap.set(`2024-01-${String(i + 1).padStart(2, '0')}`, 10);
      }
      // 5 days of 3 miles
      for (let i = 10; i < 15; i++) {
        dailyMilesMap.set(`2024-01-${String(i + 1).padStart(2, '0')}`, 3);
      }

      const eddington = calculateEddington([...dailyMilesMap.values()]);
      expect(eddington.number).toBe(10);
    });
  });

  describe('race distance filters', () => {
    it('defines correct distance ranges for races', () => {
      const distanceRanges: Record<string, [number, number]> = {
        '5k': [2.8, 3.5],
        '10k': [5.8, 6.8],
        half_marathon: [12.8, 13.5],
        marathon: [25.5, 27.0],
      };

      // 5K is ~3.1 miles
      expect(3.1).toBeGreaterThanOrEqual(distanceRanges['5k'][0]);
      expect(3.1).toBeLessThanOrEqual(distanceRanges['5k'][1]);

      // Half marathon is ~13.1 miles
      expect(13.1).toBeGreaterThanOrEqual(distanceRanges['half_marathon'][0]);
      expect(13.1).toBeLessThanOrEqual(distanceRanges['half_marathon'][1]);

      // Marathon is ~26.2 miles
      expect(26.2).toBeGreaterThanOrEqual(distanceRanges['marathon'][0]);
      expect(26.2).toBeLessThanOrEqual(distanceRanges['marathon'][1]);
    });
  });

  describe('pagination', () => {
    it('calculates correct total pages', () => {
      const total = 55;
      const limit = 20;
      expect(Math.ceil(total / limit)).toBe(3);
    });

    it('calculates correct offset', () => {
      const page = 3;
      const limit = 20;
      expect((page - 1) * limit).toBe(40);
    });
  });
});

describe('Running routes with mixed sport types', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({ scope: 'read', name: 'running-routes' });
  });

  async function seedMixedActivities() {
    const db = createDb(env.DB);
    await db.delete(stravaActivities);
    await db.insert(stravaActivities).values([
      {
        stravaId: 9001,
        name: 'Morning Run',
        sportType: 'Run',
        distanceMeters: 8046.7,
        distanceMiles: 5.0,
        movingTimeSeconds: 2400,
        elapsedTimeSeconds: 2500,
        totalElevationGainMeters: 30,
        totalElevationGainFeet: 98.4,
        startDate: '2024-06-15T14:00:00Z',
        startDateLocal: '2024-06-15T07:00:00',
        paceMinPerMile: 8.0,
        paceFormatted: '8:00/mi',
        startLat: 40.7128,
        startLng: -74.006,
        isRace: 0,
        isDeleted: 0,
      },
      {
        stravaId: 9002,
        name: 'Evening Ride',
        sportType: 'Ride',
        distanceMeters: 32186.9,
        distanceMiles: 20.0,
        movingTimeSeconds: 3600,
        elapsedTimeSeconds: 3700,
        totalElevationGainMeters: 150,
        totalElevationGainFeet: 492.1,
        startDate: '2024-06-16T02:00:00Z',
        startDateLocal: '2024-06-15T19:00:00',
        paceMinPerMile: 3.0,
        paceFormatted: '3:00/mi',
        isRace: 0,
        isDeleted: 0,
      },
    ]);
    await recomputeStats(db);
    return db;
  }

  it('GET /v1/running/recent exposes sport_type on activities', async () => {
    await seedMixedActivities();

    const res = await SELF.fetch('http://localhost/v1/running/recent', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ strava_id: number; sport_type: string }>;
    };

    const ride = body.data.find((a) => a.strava_id === 9002);
    expect(ride?.sport_type).toBe('Ride');
    const run = body.data.find((a) => a.strava_id === 9001);
    expect(run?.sport_type).toBe('Run');
  });

  it('GET /v1/running/recent exposes start_lat and start_lng on activities', async () => {
    await seedMixedActivities();

    const res = await SELF.fetch('http://localhost/v1/running/recent', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        strava_id: number;
        start_lat: number | null;
        start_lng: number | null;
      }>;
    };

    const run = body.data.find((a) => a.strava_id === 9001);
    expect(run?.start_lat).toBe(40.7128);
    expect(run?.start_lng).toBe(-74.006);
    // Activities without recorded coords serialize as explicit nulls.
    const ride = body.data.find((a) => a.strava_id === 9002);
    expect(ride?.start_lat).toBeNull();
    expect(ride?.start_lng).toBeNull();
  });

  it('GET /v1/running/activities exposes start_lat and start_lng on list items', async () => {
    await seedMixedActivities();

    const res = await SELF.fetch('http://localhost/v1/running/activities', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        strava_id: number;
        start_lat: number | null;
        start_lng: number | null;
      }>;
    };

    const run = body.data.find((a) => a.strava_id === 9001);
    expect(run?.start_lat).toBe(40.7128);
    expect(run?.start_lng).toBe(-74.006);
  });

  it('GET /v1/running/activities/:id exposes start_lat and start_lng', async () => {
    await seedMixedActivities();

    const res = await SELF.fetch(
      'http://localhost/v1/running/activities/9001',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      start_lat: number | null;
      start_lng: number | null;
    };

    expect(body.start_lat).toBe(40.7128);
    expect(body.start_lng).toBe(-74.006);
  });

  it('GET /v1/running/stats includes total_activities alongside run-scoped total_runs', async () => {
    await seedMixedActivities();

    const res = await SELF.fetch('http://localhost/v1/running/stats', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        total_runs: number;
        total_activities: number;
        total_distance_mi: number;
        avg_pace: string | null;
      };
    };

    expect(body.data.total_activities).toBe(2);
    expect(body.data.total_runs).toBe(1);
    // Distance totals include all sports; pace stays run-scoped
    expect(body.data.total_distance_mi).toBe(25.0);
    expect(body.data.avg_pace).toBe('8:00/mi');
  });
});
