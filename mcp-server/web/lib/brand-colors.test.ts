import { describe, expect, it } from 'vitest';
import {
  INTEGRATIONS,
  integrationFromValue,
  resolveResultIntegration,
  seriesColor,
} from './brand-colors.js';

describe('integrationFromValue', () => {
  it('matches the spellings a source column actually holds', () => {
    expect(integrationFromValue('trakt')).toBe('trakt');
    expect(integrationFromValue('Plex')).toBe('plex');
    expect(integrationFromValue(' letterboxd ')).toBe('letterboxd');
    expect(integrationFromValue('last.fm')).toBe('lastfm');
    expect(integrationFromValue('swarm')).toBe('foursquare');
  });

  it('is null for anything that does not name a service', () => {
    // `manual` is a real watch_history source but not an integration.
    expect(integrationFromValue('manual')).toBeNull();
    expect(integrationFromValue('')).toBeNull();
    expect(integrationFromValue(42)).toBeNull();
    expect(integrationFromValue(null)).toBeNull();
  });
});

describe('resolveResultIntegration', () => {
  it('uses a source column when every row agrees', () => {
    const key = resolveResultIntegration(
      ['title', 'source'],
      [
        ['Midnight Cowboy', 'trakt'],
        ['Heat', 'trakt'],
      ],
      null
    );
    expect(key).toBe('trakt');
  });

  it('returns null when the source column mixes services', () => {
    const key = resolveResultIntegration(
      ['title', 'source'],
      [
        ['Midnight Cowboy', 'trakt'],
        ['Heat', 'plex'],
      ],
      null
    );
    expect(key).toBeNull();
  });

  it('a mixed source column overrides the server key', () => {
    // The rows describe themselves better than the tables do: a chart of Plex
    // vs Trakt watches must not be painted as if it were all one service.
    const key = resolveResultIntegration(
      ['title', 'source'],
      [
        ['a', 'trakt'],
        ['b', 'plex'],
      ],
      'trakt'
    );
    expect(key).toBeNull();
  });

  it('falls back to the server key when no source column is projected', () => {
    const key = resolveResultIntegration(
      ['year', 'plays'],
      [['2024', 18234]],
      'lastfm'
    );
    expect(key).toBe('lastfm');
  });

  it('ignores an unknown server key rather than inventing a colour', () => {
    expect(resolveResultIntegration(['a'], [[1]], 'myspace')).toBeNull();
    expect(resolveResultIntegration(['a'], [[1]], null)).toBeNull();
    expect(resolveResultIntegration(['a'], [[1]], undefined)).toBeNull();
  });

  it('ignores a source column of values it does not recognise', () => {
    const key = resolveResultIntegration(
      ['title', 'source'],
      [['x', 'manual']],
      'lastfm'
    );
    // All rows are 'unknown' — one distinct value, but not a service, so the
    // server key still decides.
    expect(key).toBe('lastfm');
  });
});

describe('seriesColor', () => {
  it('returns the palette step for the mode, not the brand colour', () => {
    expect(seriesColor('strava', false)).toBe('#eb6834');
    expect(seriesColor('strava', true)).toBe('#d95926');
    // The brand colour is reserved for chips.
    expect(seriesColor('strava', false)).not.toBe(INTEGRATIONS.strava.brand);
  });

  it('is null without an integration so the card keeps its neutral accent', () => {
    expect(seriesColor(null, false)).toBeNull();
  });
});

describe('the palette contract', () => {
  const LIGHT_STEPS = new Set([
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#4a3aa7',
    '#e34948',
  ]);
  const DARK_STEPS = new Set([
    '#3987e5',
    '#d95926',
    '#199e70',
    '#c98500',
    '#d55181',
    '#008300',
    '#9085e9',
    '#e66767',
  ]);

  it('draws every series colour from the documented categorical palette', () => {
    // Guards the rule that makes this safe: marks come from validated steps,
    // never from a brand hex. A new integration added with an eyeballed colour
    // fails here.
    for (const [key, style] of Object.entries(INTEGRATIONS)) {
      expect(LIGHT_STEPS.has(style.series), `${key} light`).toBe(true);
      expect(DARK_STEPS.has(style.seriesDark), `${key} dark`).toBe(true);
    }
  });

  it('gives every integration a label and a six-digit brand hex', () => {
    for (const [key, style] of Object.entries(INTEGRATIONS)) {
      expect(style.label, `${key} label`).toBeTruthy();
      expect(style.brand, `${key} brand`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
