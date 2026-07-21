/**
 * Shared utilities for image source clients.
 */

/**
 * Substitute `&` with `and` for friendlier upstream search behavior.
 * Apple Music / iTunes / Deezer free-text search occasionally tokenizes `&`
 * oddly, and most catalogs index "Matt & Kim" alongside the spelled-out form.
 */
function substituteAmpersand(name: string): string {
  return name.replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ');
}

/**
 * Strip featured artist suffixes from artist names for cleaner search results.
 * Last.fm creates separate entries like "Kendrick Lamar feat. DODY6" or
 * "Gorillaz feat. IDLES" which fail to match on iTunes/Apple Music.
 *
 * Also rewrites `&` to `and` so artists like "Matt & Kim" or "Simon &
 * Garfunkel" match the spelled-out form returned by upstream catalogs.
 */
export function cleanArtistName(name: string): string {
  const stripped = name.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim();
  return substituteAmpersand(stripped);
}

/**
 * Clean an album name for search queries.
 * Strips parenthetical/bracketed suffixes (deluxe, remastered, bonus, EP, single)
 * and version suffixes that confuse search APIs without affecting matching accuracy.
 * Also rewrites `&` to `and` for the same reason as cleanArtistName.
 */
export function cleanAlbumName(name: string): string {
  const stripped = name
    .replace(
      /\s*[([][^)\]]*(?:deluxe|remaster|bonus|expanded|anniversary|edition|version|ep|single)[^)\]]*[)\]]/gi,
      ''
    )
    .replace(/\s*-\s*(?:EP|Single)$/i, '')
    .trim();
  return substituteAmpersand(stripped);
}

/** Map of number words to digits for title normalization. */
const NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

/**
 * Normalize a name for comparison.
 * Folds diacritics, strips punctuation, collapses whitespace, lowercases,
 * and standardizes number words and common abbreviations (pt/part,
 * vol/volume).
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(?:part|pt)\b/g, 'pt')
    .replace(/\b(?:volume|vol)\b/g, 'vol')
    .replace(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
      (m) => NUMBER_WORDS[m] ?? m
    );
}

/** Minimum squashed length before fuzzy matching applies; shorter names must match exactly. */
const FUZZY_MIN_LENGTH = 5;
/** Maximum normalized edit distance (relative to the longer string) tolerated as a match. */
const FUZZY_TOLERANCE = 0.2;

/**
 * Levenshtein edit distance between two strings (single-row DP).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Tolerant equality on squashed (whitespace-free) normalized strings.
 * Allows small edit-distance differences to absorb transliteration
 * doubles ("Kala" vs "Kaala", "Bheemudo" vs "Bheemudho") while keeping
 * short names exact-only so "Blur" never matches "Blue".
 */
function fuzzyEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < FUZZY_MIN_LENGTH) return false;
  const tolerance = Math.floor(maxLen * FUZZY_TOLERANCE);
  if (tolerance === 0) return false;
  if (Math.abs(a.length - b.length) > tolerance) return false;
  return levenshtein(a, b) <= tolerance;
}

/**
 * Check whether the returned name begins with the requested name, comparing
 * squashed (whitespace-free) forms with edit-distance tolerance. The prefix
 * boundary must fall on a word edge of the returned name, so "Glass Animals"
 * still cannot match "Animals". Squashing fixes token-boundary shifts from
 * punctuation variants: "A.R.Rahman", "A.R. Rahman", and "AR Rahman" all
 * squash to "arrahman".
 */
function fuzzyPrefixMatch(requested: string, returned: string): boolean {
  const target = requested.replace(/ /g, '');
  if (!target) return false;
  let joined = '';
  for (const token of returned.split(' ')) {
    joined += token;
    if (fuzzyEquals(joined, target)) return true;
    if (joined.length > target.length * (1 + FUZZY_TOLERANCE)) break;
  }
  return false;
}

/**
 * Strip "the" prefix for comparison purposes.
 */
function stripThe(s: string): string {
  return s.replace(/^the\s+/, '');
}

/**
 * Check if a returned artist name is a reasonable match for the requested one.
 * The returned name must start with the requested name (after normalization
 * and "the" stripping). This allows "The Animals Retrospective" to match
 * "The Animals" but rejects "Glass Animals" because it doesn't start with
 * "Animals". Also rejects "Buddy" for "Buddy Holly" because "Buddy" doesn't
 * start with "Buddy Holly".
 */
export function artistMatches(requested: string, returned: string): boolean {
  const req = stripThe(normalize(cleanArtistName(requested)));
  const ret = stripThe(normalize(cleanArtistName(returned)));
  if (!req || !ret) return false;
  if (req === ret) return true;
  // Returned must start with requested at a word boundary
  // Allows "The Animals Retrospective" for "The Animals" but not "Glass Animals"
  if (
    ret.startsWith(req) &&
    (ret.length === req.length || ret[req.length] === ' ')
  ) {
    return true;
  }
  // Tolerant prefix on squashed forms: absorbs punctuation-driven token
  // shifts ("A.R.Rahman" vs "AR Rahman") and transliteration doubles
  // ("Kaala Bhairava & M.M. Kreem" for "Kala Bhairava").
  return fuzzyPrefixMatch(req, ret);
}

/**
 * Check if two normalized names match at a word boundary (one starts with the other).
 */
function wordBoundaryMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (b.startsWith(a) && (b.length === a.length || b[a.length] === ' ')) {
    return true;
  }
  if (a.startsWith(b) && (a.length === b.length || a[b.length] === ' ')) {
    return true;
  }
  return false;
}

/**
 * Word-boundary match with edit-distance tolerance on squashed forms,
 * in both directions.
 */
function tolerantBoundaryMatch(a: string, b: string): boolean {
  if (wordBoundaryMatch(a, b)) return true;
  return fuzzyPrefixMatch(a, b) || fuzzyPrefixMatch(b, a);
}

/**
 * Extract the subject of a "(From X)" / "[From X]" clause, squashed and
 * normalized, or null when absent. The clause names the film a single was
 * lifted from, so two titles that only differ here are different releases.
 */
function extractFromClause(name: string): string | null {
  const match = name.match(/[([]\s*from\s+([^)\]]*)[)\]]/i);
  return match ? normalize(match[1]).replace(/ /g, '') : null;
}

/**
 * Strip release-type suffixes from an album title for comparison:
 * "- Single" / "- EP" dashes, "(From ...)" clauses, and parenthetical
 * qualifiers like "(Original Motion Picture Soundtrack)" or "(Deluxe
 * Edition)". Applied to BOTH sides of a comparison so
 * 'Komuram Bheemudo (From "RRR")' meets
 * 'Komuram Bheemudo (From "RRR") - Single' at the shared core.
 */
export function stripAlbumSuffixes(name: string): string {
  return name
    .replace(/[([]\s*from\s+[^)\]]*[)\]]/gi, ' ')
    .replace(
      /\s*[([][^)\]]*(?:deluxe|remaster|bonus|expanded|anniversary|edition|version|soundtrack|motion picture|\bep\b|\bsingle\b)[^)\]]*[)\]]/gi,
      ' '
    )
    .replace(
      /\s*-\s*(?:EP|Single|Original Motion Picture Soundtrack|Original Soundtrack|OST)\s*$/i,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a returned album/collection name is a reasonable match.
 * The returned name must start with the requested name (allowing
 * suffixes like "(Deluxe Edition)"), with a small edit-distance tolerance
 * for transliteration variants. "GUTS" matches "GUTS (Deluxe)" but "Gold"
 * does NOT match "Golden Greats".
 *
 * Falls back to comparing suffix-stripped cores from both sides, guarded
 * by "(From X)" agreement: when both titles carry a From clause the
 * clauses must match, since they identify the source film.
 *
 * When artistName is provided, also tries stripping the artist name prefix
 * from the requested album. Last.fm sometimes stores albums as
 * "Beastie Boys Anthology: The Sounds of Science" while sources return
 * "Anthology: The Sounds of Science".
 */
export function albumMatches(
  requested: string,
  returned: string,
  artistName?: string
): boolean {
  const req = stripThe(normalize(requested));
  const ret = stripThe(normalize(returned));
  if (!req || !ret) return false;
  if (tolerantBoundaryMatch(req, ret)) return true;

  // Compare suffix-stripped cores, but only when any From clauses agree:
  // "(From X)" carries meaning, so it is stripped from both sides only
  // after confirming both sides name the same source film.
  const reqFrom = extractFromClause(requested);
  const retFrom = extractFromClause(returned);
  const fromCompatible = !reqFrom || !retFrom || fuzzyEquals(reqFrom, retFrom);
  if (fromCompatible) {
    const reqCore = stripThe(normalize(stripAlbumSuffixes(requested)));
    const retCore = stripThe(normalize(stripAlbumSuffixes(returned)));
    if (
      reqCore &&
      retCore &&
      (reqCore !== req || retCore !== ret) &&
      tolerantBoundaryMatch(reqCore, retCore)
    ) {
      return true;
    }
  }

  // Try stripping artist name prefix from requested album
  if (artistName) {
    const normArtist = stripThe(normalize(cleanArtistName(artistName)));
    if (normArtist && req.startsWith(normArtist + ' ')) {
      const stripped = req.slice(normArtist.length + 1);
      if (stripped && tolerantBoundaryMatch(stripped, ret)) return true;
    }
  }

  return false;
}
