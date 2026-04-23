import { describe, it, expect, vi } from 'vitest';
import {
  text,
  resourceLink,
  imageBlock,
  withRichResponse,
  withErrorHandling,
} from '../tools/helpers.js';
import { RewindClient } from '../client.js';

describe('helpers', () => {
  describe('text()', () => {
    it('wraps a string in a text content block', () => {
      expect(text('hello')).toEqual({ type: 'text', text: 'hello' });
    });

    it('accepts an empty string', () => {
      expect(text('')).toEqual({ type: 'text', text: '' });
    });
  });

  describe('resourceLink()', () => {
    it('builds a resource_link block for a valid URI', () => {
      const block = resourceLink(
        'https://letterboxd.com/u/film/',
        'Letterboxd review'
      );
      expect(block).toEqual({
        type: 'resource_link',
        uri: 'https://letterboxd.com/u/film/',
        name: 'Letterboxd review',
      });
    });

    it('includes optional mimeType and description', () => {
      const block = resourceLink('https://example.com', 'Example', {
        mimeType: 'text/html',
        description: 'An example site',
      });
      expect(block).toMatchObject({
        type: 'resource_link',
        uri: 'https://example.com',
        name: 'Example',
        mimeType: 'text/html',
        description: 'An example site',
      });
    });

    it('returns null when uri is null/undefined/empty', () => {
      expect(resourceLink(null, 'x')).toBeNull();
      expect(resourceLink(undefined, 'x')).toBeNull();
      expect(resourceLink('', 'x')).toBeNull();
    });
  });

  describe('imageBlock()', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic

    it('base64-encodes bytes fetched from image.cdn_url', async () => {
      const client = new RewindClient('https://api.test', 'rw_test');
      const spy = vi.spyOn(client, 'getBinaryFromUrl').mockResolvedValue({
        bytes,
        mimeType: 'image/jpeg',
      });

      const block = await imageBlock(client, {
        cdn_url: 'https://cdn.rewind.rest/watching/movies/1/original.jpg',
      });

      expect(block).not.toBeNull();
      expect(block?.type).toBe('image');
      expect(block?.mimeType).toBe('image/jpeg');
      expect(block?.data).toBe('/9j/4A==');
      expect(spy).toHaveBeenCalledWith(
        'https://cdn.rewind.rest/watching/movies/1/original.jpg'
      );
    });

    it('falls back to image.url when cdn_url is absent', async () => {
      const client = new RewindClient('https://api.test', 'rw_test');
      const spy = vi.spyOn(client, 'getBinaryFromUrl').mockResolvedValue({
        bytes,
        mimeType: 'image/jpeg',
      });

      await imageBlock(client, { url: 'https://cdn.example/x.jpg' });

      expect(spy).toHaveBeenCalledWith('https://cdn.example/x.jpg');
    });

    it('returns null when image is null or undefined', async () => {
      const client = new RewindClient('https://api.test', 'rw_test');
      expect(await imageBlock(client, null)).toBeNull();
      expect(await imageBlock(client, undefined)).toBeNull();
    });

    it('returns null when image has no cdn_url or url', async () => {
      const client = new RewindClient('https://api.test', 'rw_test');
      expect(await imageBlock(client, { thumbhash: 'x' })).toBeNull();
    });

    it('returns null on fetch failure instead of throwing', async () => {
      const client = new RewindClient('https://api.test', 'rw_test');
      vi.spyOn(client, 'getBinaryFromUrl').mockRejectedValue(
        new Error('network down')
      );

      const block = await imageBlock(client, {
        cdn_url: 'https://cdn.example/x.jpg',
      });

      expect(block).toBeNull();
    });
  });

  describe('withRichResponse()', () => {
    it('returns the handler result on success', async () => {
      const result = await withRichResponse(async () => ({
        content: [text('ok')],
        structuredContent: { value: 42 },
      }));
      expect(result).toEqual({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { value: 42 },
      });
    });

    it('catches exceptions and returns isError=true', async () => {
      const result = await withRichResponse(async () => {
        throw new Error('boom');
      });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Error: boom',
      });
    });

    it('handles non-Error throwables', async () => {
      const result = await withRichResponse(async () => {
        throw 'string error';
      });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(
        'Error: string error'
      );
    });
  });

  describe('withErrorHandling() (legacy text-only wrapper)', () => {
    it('still works for text-only tool handlers', async () => {
      const result = await withErrorHandling(async () => 'plain text');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'plain text' }],
      });
    });

    it('catches and reports errors', async () => {
      const result = await withErrorHandling(async () => {
        throw new Error('nope');
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error: nope');
    });
  });
});
