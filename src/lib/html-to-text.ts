/**
 * Convert an HTML fragment to plain text.
 *
 * Strips script/style/noscript blocks (with their contents) and HTML
 * comments, inserts whitespace between block-level elements so words
 * don't merge, decodes the common HTML entities, collapses whitespace,
 * and optionally truncates at a word boundary.
 *
 * No runtime deps. Used for deriving `reading_items.body_excerpt` from
 * the raw Instapaper-processed article HTML stored in `content`.
 */

const STRIP_BLOCKS_RE = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const BLOCK_TAG_RE =
  /<\/?(p|div|br|li|ul|ol|h[1-6]|section|article|header|footer|nav|aside|blockquote|pre|tr|td|th|tbody|thead|table|hr|figure|figcaption)\b[^>]*>/gi;
const ANY_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

function decodeEntities(s: string): string {
  let out = s.replace(
    /&(nbsp|amp|lt|gt|quot|apos|#39|mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo);/g,
    (m) => ENTITIES[m] ?? m
  );
  // Numeric entities (decimal and hex).
  out = out.replace(/&#(\d+);/g, (_, code) =>
    String.fromCodePoint(parseInt(code, 10))
  );
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
    String.fromCodePoint(parseInt(code, 16))
  );
  return out;
}

export function htmlToText(
  html: string | null | undefined,
  opts?: { maxChars?: number }
): string {
  if (!html) return '';

  // 1. Drop script/style/noscript (element + contents) and comments.
  let out = html.replace(STRIP_BLOCKS_RE, ' ').replace(COMMENT_RE, ' ');
  // 2. Replace block-level tags with a space so "Hello</p><p>World" -> "Hello World".
  out = out.replace(BLOCK_TAG_RE, ' ');
  // 3. Strip all remaining tags (inline: <em>, <strong>, <a>, <span>, ...).
  out = out.replace(ANY_TAG_RE, '');
  // 4. Decode entities.
  out = decodeEntities(out);
  // 5. Collapse whitespace and trim.
  out = out.replace(WHITESPACE_RE, ' ').trim();

  const maxChars = opts?.maxChars;
  if (maxChars && out.length > maxChars) {
    const slice = out.slice(0, maxChars);
    if (out[maxChars] === ' ') {
      // Cut lands exactly on a word boundary — keep the full slice.
      out = slice;
    } else {
      const lastSpace = slice.lastIndexOf(' ');
      out = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
    }
  }

  return out;
}
