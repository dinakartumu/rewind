import { describe, it, expect } from 'vitest';
import {
  cleanArtistName,
  cleanAlbumName,
  artistMatches,
  albumMatches,
} from './utils.js';

describe('cleanAlbumName', () => {
  it('strips deluxe edition parenthetical', () => {
    expect(
      cleanAlbumName('Ill Communication (Deluxe Edition/Remastered)')
    ).toBe('Ill Communication');
  });

  it('strips remastered bracket suffix', () => {
    expect(cleanAlbumName('Hello Nasty [Deluxe Edition/Remastered]')).toBe(
      'Hello Nasty'
    );
  });

  it('strips EP/Single dash suffix', () => {
    expect(cleanAlbumName('Too Many Rappers - Single')).toBe(
      'Too Many Rappers'
    );
  });

  it('preserves normal album names', () => {
    expect(cleanAlbumName('Hot Sauce Committee Part Two')).toBe(
      'Hot Sauce Committee Part Two'
    );
  });

  it('strips anniversary edition', () => {
    expect(
      cleanAlbumName("Paul's Boutique (20th Anniversary Edition / Remastered)")
    ).toBe("Paul's Boutique");
  });

  it('rewrites ampersand to "and" in album titles', () => {
    expect(cleanAlbumName('Hall & Oates Greatest Hits')).toBe(
      'Hall and Oates Greatest Hits'
    );
  });
});

describe('cleanArtistName', () => {
  it('strips feat. suffix', () => {
    expect(cleanArtistName('Gorillaz feat. IDLES')).toBe('Gorillaz');
  });

  it('strips ft. suffix', () => {
    expect(cleanArtistName('Kendrick Lamar ft. SZA')).toBe('Kendrick Lamar');
  });

  it('strips featuring suffix', () => {
    expect(cleanArtistName('Drake featuring Future')).toBe('Drake');
  });

  it('preserves names without featured artists', () => {
    expect(cleanArtistName('The Black Keys')).toBe('The Black Keys');
  });

  it('rewrites ampersand to "and" for upstream search recall', () => {
    expect(cleanArtistName('Simon & Garfunkel')).toBe('Simon and Garfunkel');
    expect(cleanArtistName('Matt & Kim')).toBe('Matt and Kim');
  });
});

describe('artistMatches', () => {
  it('matches exact names', () => {
    expect(artistMatches('Gorillaz', 'Gorillaz')).toBe(true);
  });

  it('matches case-insensitive', () => {
    expect(artistMatches('the black keys', 'The Black Keys')).toBe(true);
  });

  it('matches when returned has extra words (feat)', () => {
    expect(artistMatches('Gorillaz', 'Gorillaz feat. IDLES')).toBe(true);
  });

  it('matches when requested has extra "The" prefix', () => {
    expect(artistMatches('The Black Keys', 'Black Keys')).toBe(true);
  });

  it('rejects completely different artists', () => {
    expect(artistMatches('Gorillaz', 'The Countdown Kids')).toBe(false);
  });

  it('rejects partial word matches', () => {
    expect(artistMatches('Zero 7', 'Imagine Dragons')).toBe(false);
  });

  it('strips feat before comparing', () => {
    expect(artistMatches('Gorillaz feat. Popcaan', 'Gorillaz')).toBe(true);
  });

  // Key regression: "The Animals" must NOT match "Glass Animals"
  it('rejects Glass Animals for The Animals', () => {
    expect(artistMatches('The Animals', 'Glass Animals')).toBe(false);
  });

  it('rejects Buddy for Buddy Holly', () => {
    expect(artistMatches('Buddy Holly', 'Buddy')).toBe(false);
  });

  // Ampersand vs "and" normalization: catalogs sometimes index "Matt & Kim"
  // and sometimes "Matt and Kim". Both forms should match each way.
  it('matches ampersand against spelled-out "and"', () => {
    expect(artistMatches('Matt & Kim', 'Matt and Kim')).toBe(true);
    expect(artistMatches('Matt and Kim', 'Matt & Kim')).toBe(true);
    expect(artistMatches('Simon & Garfunkel', 'Simon and Garfunkel')).toBe(
      true
    );
  });

  // Live regression: Apple Music credits the RRR single to "Kaala Bhairava"
  // while Last.fm stores "Kala Bhairava". Doubled-vowel transliteration
  // variants must match within a small edit-distance tolerance.
  it('matches doubled-vowel transliteration variants', () => {
    expect(artistMatches('Kala Bhairava', 'Kaala Bhairava')).toBe(true);
    expect(artistMatches('Kaala Bhairava', 'Kala Bhairava')).toBe(true);
  });

  it('matches transliteration variant inside a multi-artist credit', () => {
    expect(artistMatches('Kala Bhairava', 'Kaala Bhairava & M.M. Kreem')).toBe(
      true
    );
    expect(
      artistMatches('Kala Bhairava', 'Kaala Bhairava & M.M. Keeravani')
    ).toBe(true);
  });

  // Live regression: Deezer indexes "A.R.Rahman" (no spaces), Apple Music
  // indexes "A.R. Rahman" and "AR RAHMAN". Punctuation/spacing must not
  // shift token boundaries and break the match.
  it('matches dotted vs undotted initials', () => {
    expect(artistMatches('A.R. Rahman', 'A.R.Rahman')).toBe(true);
    expect(artistMatches('AR Rahman', 'A.R.Rahman')).toBe(true);
    expect(artistMatches('AR Rahman', 'A.R. Rahman')).toBe(true);
    expect(artistMatches('A.R. Rahman', 'AR RAHMAN')).toBe(true);
    expect(artistMatches('A R Rahman', 'A.R. Rahman')).toBe(true);
  });

  it('matches diacritic spellings against plain ASCII', () => {
    expect(artistMatches('Bjork', 'Björk')).toBe(true);
    expect(artistMatches('Björk', 'Bjork')).toBe(true);
    expect(artistMatches('Sigur Ros', 'Sigur Rós')).toBe(true);
  });

  it('rejects clearly wrong artists despite tolerance', () => {
    expect(artistMatches('Kala Bhairava', 'Various Artists')).toBe(false);
    expect(artistMatches('A.R. Rahman', 'A.R. Murugadoss')).toBe(false);
    expect(artistMatches('Kala Bhairava', 'Rahul Sipligunj')).toBe(false);
  });

  it('does not let tolerance break short-name safety', () => {
    // Short names must remain exact-only: no 1-edit fuzz on tiny strings
    expect(artistMatches('Blur', 'Blue')).toBe(false);
    expect(artistMatches('Zero 7', 'Zed 7')).toBe(false);
  });
});

describe('albumMatches', () => {
  it('matches exact names', () => {
    expect(albumMatches('Blue', 'Blue')).toBe(true);
  });

  it('matches deluxe variants', () => {
    expect(albumMatches('GUTS', 'GUTS (Deluxe)')).toBe(true);
  });

  it('matches when returned is superset with extra words', () => {
    expect(albumMatches('The Mountain', 'The Mountain (Deluxe Edition)')).toBe(
      true
    );
  });

  it('rejects completely different albums', () => {
    expect(albumMatches('The Mountain', '30 Toddler Songs, Vol. 2')).toBe(
      false
    );
  });

  it('rejects wrong album same word', () => {
    expect(albumMatches('The Misfits', 'Famous Monsters')).toBe(false);
  });

  // Key regression: "Gold" must NOT match "20 Golden Greats"
  it('rejects Gold matching Golden Greats', () => {
    expect(albumMatches('Gold', '20 Golden Greats')).toBe(false);
  });

  it('rejects Gold matching Hollyhood', () => {
    expect(albumMatches('Gold', 'Hollyhood (feat. Kent Jamz)')).toBe(false);
  });

  // Soundtrack edge case
  it('matches exact soundtrack title', () => {
    expect(
      albumMatches(
        'Garden State: Music from the Motion Picture',
        'Garden State (Music from the Motion Picture)'
      )
    ).toBe(true);
  });

  // Artist-name-as-prefix: Last.fm sometimes stores "Artist Album" while sources return "Album"
  it('matches when requested has artist name prefix', () => {
    expect(
      albumMatches(
        'Beastie Boys Anthology: The Sounds of Science',
        'Anthology: The Sounds Of Science',
        'Beastie Boys'
      )
    ).toBe(true);
  });

  it('does not false-match with artist prefix on different album', () => {
    expect(
      albumMatches(
        'Beastie Boys Anthology: The Sounds of Science',
        'Licensed to Ill',
        'Beastie Boys'
      )
    ).toBe(false);
  });

  // Apostrophe normalization: straight vs curly quotes
  it('matches apostrophe variants', () => {
    expect(albumMatches("Paul's Boutique", 'Paul\u2019s Boutique')).toBe(true);
  });

  // Number word and part/pt normalization
  it('matches "Part Two" with "Pt. 2"', () => {
    expect(
      albumMatches(
        'Hot Sauce Committee Part Two',
        'Hot Sauce Committee (Pt. 2)'
      )
    ).toBe(true);
  });

  it('matches "Vol. 1" with "Volume One"', () => {
    expect(
      albumMatches('Greatest Hits Vol. 1', 'Greatest Hits Volume One')
    ).toBe(true);
  });

  // Live regression: Apple Music returns 'Komuram Bheemudo (From "RRR") -
  // Single' for the stored album 'Komuram Bheemudo (From "RRR")'.
  it('matches when returned adds "- Single" after a From clause', () => {
    expect(
      albumMatches(
        'Komuram Bheemudo (From "RRR")',
        'Komuram Bheemudo (From "RRR") - Single'
      )
    ).toBe(true);
  });

  // Apple's third candidate spells it "Bheemudho" — transliteration variant
  // plus suffix must still match after suffix stripping on both sides.
  it('matches transliteration variant with suffix differences', () => {
    expect(
      albumMatches(
        'Komuram Bheemudo (From "RRR")',
        'Komuram Bheemudho (From "RRR") - Single'
      )
    ).toBe(true);
  });

  it('matches soundtrack suffix stripped from both sides', () => {
    expect(
      albumMatches(
        'RRR (Original Motion Picture Soundtrack)',
        'RRR (Telugu) (Original Motion Picture Soundtrack)'
      )
    ).toBe(true);
  });

  // "(From X)" carries meaning: two songs sharing a title but lifted from
  // different films must NOT match once suffixes are stripped.
  it('rejects matching titles with conflicting From clauses', () => {
    expect(
      albumMatches(
        'Jai Ho (From "Slumdog Millionaire")',
        'Jai Ho (From "Some Other Film") - Single'
      )
    ).toBe(false);
  });

  it('still rejects unrelated albums despite tolerance', () => {
    expect(albumMatches('Komuram Bheemudo', 'Naatu Naatu - Single')).toBe(
      false
    );
    expect(albumMatches('Gold', '20 Golden Greats')).toBe(false);
    expect(albumMatches('Blue', 'Blur')).toBe(false);
  });
});
