/**
 * Convert a Rewind-supplied `thumbhash` base64 string into a data: URL that
 * can go straight into an `<img src>` as a blur-up placeholder.
 *
 * Thumbhash is base64-encoded raw bytes. The `thumbhash` package's
 * `thumbHashToDataURL` wants a `Uint8Array`, so we decode the base64 first.
 *
 * Returns null on any failure -- callers should fall back to a solid color.
 */
import { thumbHashToDataURL } from 'thumbhash';

export function thumbhashToDataUrl(
  hash: string | null | undefined
): string | null {
  if (!hash) return null;
  try {
    const binary = atob(hash);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}
