import { eq, sql, like } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { checkins } from '../../db/schema/places.js';
import type { Env } from '../../types/env.js';
import { CDN_BASE_URL } from '../images/presets.js';

/**
 * Foursquare category glyphs live at
 * `https://ss3.4sqi.net/img/categories_v2/{group}/{name}_64.png`. That host
 * is blocked/unreliable from the browser (only same-origin CDN images render
 * on the site), so we mirror each glyph into our own R2 bucket under
 * `places/icons/{group}-{name}_64.png` and serve it from cdn.dinakartumu.com.
 * The Foursquare sync stores the raw 4sqi URL at insert; this module rewrites
 * it to the CDN URL, uploading the PNG to R2 on first sight.
 */

const ICON_HOST = 'ss3.4sqi.net';
const ICON_PATH_RE = /\/img\/categories_v2\/([^/]+)\/(.+?)_64\.png$/;

export interface ParsedIcon {
  group: string;
  name: string;
  /** R2 object key, e.g. `places/icons/food-default_64.png`. */
  r2Key: string;
  /** Public CDN URL for the mirrored glyph. */
  cdnUrl: string;
}

/**
 * Parse a raw Foursquare category-icon URL into its group/name parts plus the
 * derived R2 key and CDN URL. Returns null for anything that isn't a 4sqi
 * categories_v2 glyph (already-CDN URLs, nulls, unexpected shapes).
 */
export function parseFoursquareIcon(url: string | null): ParsedIcon | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== ICON_HOST) return null;
  const m = parsed.pathname.match(ICON_PATH_RE);
  if (!m) return null;
  const [, group, name] = m;
  const slug = `${group}-${name}_64.png`;
  return {
    group,
    name,
    r2Key: `places/icons/${slug}`,
    cdnUrl: `${CDN_BASE_URL}/places/icons/${slug}`,
  };
}

/**
 * Ensure a single raw 4sqi glyph is mirrored into R2 and return the CDN URL
 * to store in its place. If the URL isn't a 4sqi glyph it's returned
 * unchanged. On any fetch/upload failure the raw URL is returned so the icon
 * reference is never lost — the next sync retries the mirror.
 */
export async function mirrorCategoryIcon(
  env: Env,
  rawUrl: string | null
): Promise<string | null> {
  const icon = parseFoursquareIcon(rawUrl);
  if (!icon) return rawUrl;

  try {
    const existing = await env.IMAGES.head(icon.r2Key);
    if (!existing) {
      const res = await fetch(rawUrl as string);
      if (!res.ok) return rawUrl;
      const body = await res.arrayBuffer();
      await env.IMAGES.put(icon.r2Key, body, {
        httpMetadata: {
          contentType: res.headers.get('content-type') ?? 'image/png',
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
    }
    return icon.cdnUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * Reconcile every stored check-in still pointing at a raw 4sqi glyph: mirror
 * each distinct icon into R2 and rewrite the rows to the CDN URL. Runs each
 * Foursquare sync — a cheap no-op query once everything is mirrored — so it
 * both fixes newly-inserted rows and self-heals any left behind by earlier
 * syncs. Bounded by the small number of distinct categories.
 */
export async function reconcileCheckinIcons(
  env: Env,
  db: Database,
  userId: number = 1
): Promise<{ mirrored: number }> {
  const rawRows = await db
    .selectDistinct({ icon: checkins.venueIcon })
    .from(checkins)
    .where(
      sql`${checkins.userId} = ${userId} AND ${like(
        checkins.venueIcon,
        `https://${ICON_HOST}/%`
      )}`
    );

  let mirrored = 0;
  for (const { icon } of rawRows) {
    const cdnUrl = await mirrorCategoryIcon(env, icon);
    if (cdnUrl && cdnUrl !== icon) {
      await db
        .update(checkins)
        .set({ venueIcon: cdnUrl })
        .where(eq(checkins.venueIcon, icon as string));
      mirrored++;
    }
  }
  return { mirrored };
}
