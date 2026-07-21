import { describe, it, expect } from 'vitest';
import {
  SIZE_PRESETS,
  VALID_SIZES,
  buildCdnUrl,
  buildR2Key,
} from './presets.js';

describe('presets', () => {
  it('defines all expected size presets', () => {
    expect(VALID_SIZES).toContain('thumbnail');
    expect(VALID_SIZES).toContain('small');
    expect(VALID_SIZES).toContain('medium');
    expect(VALID_SIZES).toContain('large');
    expect(VALID_SIZES).toContain('poster');
    expect(VALID_SIZES).toContain('poster-lg');
    expect(VALID_SIZES).toContain('backdrop');
    expect(VALID_SIZES).toContain('original');
  });

  it('thumbnail preset has correct dimensions', () => {
    expect(SIZE_PRESETS.thumbnail).toEqual({
      width: 64,
      height: 64,
      fit: 'cover',
    });
  });

  it('original preset has no fixed dimensions', () => {
    expect(SIZE_PRESETS.original).toEqual({
      width: null,
      height: null,
      fit: 'scale-down',
    });
  });

  it('defines a 2:3 small poster preset', () => {
    expect(SIZE_PRESETS['poster-sm']).toEqual({
      width: 240,
      height: 360,
      fit: 'cover',
    });
  });
});

describe('buildCdnUrl', () => {
  it('builds a Cloudflare transform URL for sized images', () => {
    expect(
      buildCdnUrl('watching/movies/456/original.jpg', 'poster-sm', 3)
    ).toBe(
      'https://cdn.dinakartumu.com/cdn-cgi/image/width=240,height=360,fit=cover,format=auto,quality=85/watching/movies/456/original.jpg?v=3'
    );
  });

  it('serves original images without a transform segment', () => {
    expect(
      buildCdnUrl('listening/albums/abc/original.jpg', 'original', 2)
    ).toBe('https://cdn.dinakartumu.com/listening/albums/abc/original.jpg?v=2');
  });

  it('falls back to the original URL for an unknown preset', () => {
    expect(buildCdnUrl('test/key.jpg', 'missing', 4)).toBe(
      'https://cdn.dinakartumu.com/test/key.jpg?v=4'
    );
  });

  it('encodes each R2 key segment in transformed URLs', () => {
    expect(
      buildCdnUrl(
        'watching/movies/tmdb:15 #1/poster?final&crop=.jpg',
        'poster-sm',
        5
      )
    ).toBe(
      'https://cdn.dinakartumu.com/cdn-cgi/image/width=240,height=360,fit=cover,format=auto,quality=85/watching/movies/tmdb%3A15%20%231/poster%3Ffinal%26crop%3D.jpg?v=5'
    );
  });

  it('encodes each R2 key segment in original URLs', () => {
    expect(
      buildCdnUrl('listening/albums/a+b=c/original #1.jpg', 'original', 6)
    ).toBe(
      'https://cdn.dinakartumu.com/listening/albums/a%2Bb%3Dc/original%20%231.jpg?v=6'
    );
  });
});

describe('buildR2Key', () => {
  it('builds correct key with default extension', () => {
    expect(buildR2Key('listening', 'albums', 'abc123')).toBe(
      'listening/albums/abc123/original.jpg'
    );
  });

  it('builds correct key with custom extension', () => {
    expect(buildR2Key('watching', 'movies', 'tmdb-27205', 'png')).toBe(
      'watching/movies/tmdb-27205/original.png'
    );
  });
});
