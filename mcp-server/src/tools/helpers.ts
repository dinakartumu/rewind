import { z } from 'zod';
import type { RewindClient } from '../client.js';

// ─── Types ───────────────────────────────────────────────────────────

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; data: string; mimeType: string };
export type ResourceLinkBlock = {
  type: 'resource_link';
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
};

export type ContentBlock = TextBlock | ImageBlock | ResourceLinkBlock;

export type ToolResult<S = unknown> = {
  content: ContentBlock[];
  structuredContent?: S;
  isError?: boolean;
  /** Optional result-level metadata (e.g. `{ ui: { resourceUri } }`). */
  _meta?: Record<string, unknown>;
};

// ─── Content block builders ──────────────────────────────────────────

/** Build a text content block. */
export function text(value: string): TextBlock {
  return { type: 'text', text: value };
}

/**
 * Build a resource_link content block.
 * Returns null if the URI is missing/empty so callers can `.filter(Boolean)`.
 */
export function resourceLink(
  uri: string | null | undefined,
  name: string,
  opts?: { mimeType?: string; description?: string }
): ResourceLinkBlock | null {
  if (!uri) return null;
  const block: ResourceLinkBlock = { type: 'resource_link', uri, name };
  if (opts?.mimeType) block.mimeType = opts.mimeType;
  if (opts?.description) block.description = opts.description;
  return block;
}

/**
 * An image attachment as returned by Rewind entity responses.
 * Accepts both `cdn_url` (live API) and `url` (OpenAPI-schema-example field).
 */
export type ImageAttachment =
  | {
      cdn_url?: string | null;
      url?: string | null;
      thumbhash?: string | null;
      dominant_color?: string | null;
      accent_color?: string | null;
    }
  | null
  | undefined;

/**
 * Build an image content block from an entity's image attachment by fetching
 * the public CDN URL directly. Returns null on any failure or missing URL --
 * never throws. Image blocks are best-effort; we always want to return
 * text/data even if the image fetch breaks.
 *
 * Pass `targetPx` to request a smaller transform -- overrides the `width` and
 * `height` query params on the CDN URL. Useful for list tools that must stay
 * under the client's per-response size budget. Omit for full-size (typically
 * 300x300) detail-tool posters.
 */
export async function imageBlock(
  client: RewindClient,
  image: ImageAttachment,
  targetPx?: number
): Promise<ImageBlock | null> {
  if (!image) return null;
  let url = image.cdn_url ?? image.url ?? null;
  if (!url) return null;
  if (targetPx) url = resizeCdnUrl(url, targetPx);

  try {
    const { bytes, mimeType } = await client.getBinaryFromUrl(url);
    return {
      type: 'image',
      data: bytesToBase64(bytes),
      mimeType,
    };
  } catch {
    return null;
  }
}

/**
 * Rewrite a Rewind CDN URL to use the Cloudflare Images transform path
 * (`/cdn-cgi/image/<opts>/<asset>`) at the requested pixel size. Raw R2 URLs
 * are converted to transform URLs, and existing transform options are
 * replaced while the source asset path and image version are preserved.
 *
 * Input:  https://cdn.rewind.rest/cdn-cgi/image/width=240,height=360,fit=cover,format=auto,quality=85/watching/movies/707/original.jpg?v=1
 * Output: https://cdn.rewind.rest/cdn-cgi/image/width=150,height=150,fit=cover,format=auto,quality=85/watching/movies/707/original.jpg?v=1
 *
 * Returns the input unchanged if it is not a valid URL.
 *
 * Pass `opts` to override the transform (format/quality) — e.g. a hard-
 * downsampled WebP thumbnail for `embed_art`. Defaults to square cover crop
 * at format=auto, quality=85.
 */
export function resizeCdnUrl(
  url: string,
  targetPx: number,
  opts?: { format?: string; quality?: number }
): string {
  try {
    const u = new URL(url);
    const format = opts?.format ?? 'auto';
    const quality = opts?.quality ?? 85;
    const transform = `width=${targetPx},height=${targetPx},fit=cover,format=${format},quality=${quality}`;
    const transformPrefix = '/cdn-cgi/image/';
    let sourcePath = u.pathname;
    if (sourcePath.startsWith(transformPrefix)) {
      const optionsEnd = sourcePath.indexOf('/', transformPrefix.length);
      if (optionsEnd === -1) return url;
      sourcePath = sourcePath.slice(optionsEnd);
    }
    const version = u.searchParams.get('v');
    const versionSuffix = version ? `?v=${version}` : '';
    return `${u.origin}/cdn-cgi/image/${transform}${sourcePath}${versionSuffix}`;
  } catch {
    return url;
  }
}

/** Target pixel size for list-tool image blocks. Keeps responses under ~250KB. */
export const LIST_IMAGE_PX = 150;

/** Extract host (e.g. "nytimes.com") from a URL for inline labels. */
export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Convert bytes to base64. Uses globalThis.Buffer when available (Node / Workers),
 * falls back to a manual encoding that works in any JS runtime.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as {
    Buffer?: { from(b: Uint8Array): { toString(enc: 'base64'): string } };
  };
  if (g.Buffer) return g.Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─── Response wrappers ───────────────────────────────────────────────

/**
 * Wrap a tool handler that returns only text.
 * Returns { content, isError: true } on failure.
 */
export async function withErrorHandling(
  fn: () => Promise<string>
): Promise<{ content: TextBlock[]; isError?: boolean }> {
  try {
    const textValue = await fn();
    return { content: [text(textValue)] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [text(`Error: ${message}`)],
      isError: true,
    };
  }
}

/**
 * Wrap a tool handler that returns a rich response (text + images + resource_links + structuredContent).
 * Returns a well-formed error ToolResult on failure.
 *
 * Callers should construct content arrays via the builders above and filter nulls:
 *   return {
 *     content: [text(summary), ...blocks.filter(Boolean)],
 *     structuredContent: data,
 *   };
 */
export async function withRichResponse<S = unknown>(
  fn: () => Promise<ToolResult<S>>
): Promise<ToolResult<S>> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [text(`Error: ${message}`)],
      isError: true,
    };
  }
}

// ─── Existing utilities (unchanged) ──────────────────────────────────

/** Format a date string as "Jan 15, 2025" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Format a date string as relative time like "2h ago" */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

/** Format a number with commas */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString('en-US');
}

/**
 * Format a Letterboxd-style 0-5 star user rating. The Rewind API stores
 * these in the 0-5 half-star range (e.g. 4.5 = four and a half stars).
 * Renders as "4.5★" or "4★" -- never "4/10", which is a different scale.
 */
export function formatStars(r: number | null | undefined): string {
  if (r === null || r === undefined) return '';
  const display = r % 1 === 0 ? r.toFixed(0) : r.toFixed(1);
  return `${display}★`;
}

/** Common date filter params reused across tools. */
export const dateFilterParams = {
  date: z
    .string()
    .optional()
    .describe('Optional: filter to a specific date (YYYY-MM-DD)'),
  from: z
    .string()
    .optional()
    .describe('Optional: start of date range (ISO 8601)'),
  to: z.string().optional().describe('Optional: end of date range (ISO 8601)'),
};

/** Shared optional input for tools that return image content blocks. */
export const includeImagesParam = {
  include_images: z
    .boolean()
    .default(true)
    .describe(
      'Include artwork/poster image content blocks in the response. Default true. Set false to keep responses small.'
    ),
};

/**
 * Standard annotations for all Rewind tools. Read-only and closed-world:
 * every tool reads the user's own bounded archive via api.rewind.rest, never
 * an unbounded external space at call time.
 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true as const,
  destructiveHint: false as const,
  idempotentHint: true as const,
  openWorldHint: false as const,
};

export type { RewindClient };
