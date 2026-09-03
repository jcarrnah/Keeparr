import { describe, expect, it } from 'vitest';
import {
  MAX_EXCLUSION_PATTERNS,
  excludedSections,
  filterExcludedSections,
  isSectionExcluded,
  normalizeExclusionPatterns,
} from './section-filter';

/** A stand-in for StoredSection / BackendSection — the filter only reads `title`. */
const lib = (title: string) => ({ id: title, title });

/** The case this exists for: a Jellyfin recommendation plugin makes one library
 *  per user, and they keep coming as users are added. */
const REAL = ['Movies', '4K Movies', 'TV Shows', 'Anime'].map(lib);
const PLUGIN = [
  'Recommended for John',
  'Recommended for Sam',
  'Recommended for a.new.user',
].map(lib);

describe('isSectionExcluded (title glob matching)', () => {
  it('matches a wildcard pattern against the plugin libraries only', () => {
    for (const s of PLUGIN) expect(isSectionExcluded(s.title, ['*Recommend*'])).toBe(true);
    for (const s of REAL) expect(isSectionExcluded(s.title, ['*Recommend*'])).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(isSectionExcluded('RECOMMENDED FOR JOHN', ['*recommend*'])).toBe(true);
    expect(isSectionExcluded('recommended for john', ['*RECOMMEND*'])).toBe(true);
  });

  it('treats a pattern with no wildcard as an exact title match', () => {
    // Not a substring match — otherwise "Movies" would silently take out
    // "4K Movies" as well, and that is the whole library.
    expect(isSectionExcluded('Movies', ['Movies'])).toBe(true);
    expect(isSectionExcluded('4K Movies', ['Movies'])).toBe(false);
  });

  it('anchors the pattern at both ends', () => {
    expect(isSectionExcluded('Recommended for John', ['Recommended*'])).toBe(true);
    expect(isSectionExcluded('My Recommended List', ['Recommended*'])).toBe(false);
  });

  it('supports ? as exactly one character', () => {
    expect(isSectionExcluded('4K Movies', ['?K Movies'])).toBe(true);
    expect(isSectionExcluded('UHD Movies', ['?K Movies'])).toBe(false);
  });

  it('treats regex metacharacters in a pattern as literal text', () => {
    // A library really can be called "Movies (4K)" — the parens must not be a
    // capture group, and the dot must not be a wildcard.
    expect(isSectionExcluded('Movies (4K)', ['Movies (4K)'])).toBe(true);
    expect(isSectionExcluded('Movies 4K', ['Movies (4K)'])).toBe(false);
    expect(isSectionExcluded('a.b', ['a.b'])).toBe(true);
    expect(isSectionExcluded('axb', ['a.b'])).toBe(false);
    expect(isSectionExcluded('C:\\Media', ['C:\\Media'])).toBe(true);
    expect(isSectionExcluded('Movies+', ['Movies+'])).toBe(true);
    expect(isSectionExcluded('Moviess', ['Movies+'])).toBe(false);
  });

  it('ignores blank patterns rather than matching everything', () => {
    // An empty row left in the editor must not hide the entire server.
    expect(isSectionExcluded('Movies', ['', '   '])).toBe(false);
    expect(isSectionExcluded('', [''])).toBe(false);
  });

  it('trims surrounding whitespace on both the pattern and the title', () => {
    expect(isSectionExcluded('  Movies  ', [' Movies '])).toBe(true);
  });

  it('matches if ANY pattern matches', () => {
    expect(isSectionExcluded('Anime', ['*Recommend*', 'Anime'])).toBe(true);
  });
});

describe('filterExcludedSections / excludedSections', () => {
  const all = [...REAL, ...PLUGIN];

  it('keeps the real libraries and drops the plugin ones', () => {
    expect(filterExcludedSections(all, ['*Recommend*']).map((s) => s.title)).toEqual([
      'Movies',
      '4K Movies',
      'TV Shows',
      'Anime',
    ]);
  });

  it('is the exact complement of excludedSections', () => {
    const patterns = ['*Recommend*'];
    const kept = filterExcludedSections(all, patterns);
    const dropped = excludedSections(all, patterns);
    expect(kept.length + dropped.length).toBe(all.length);
    expect(dropped.map((s) => s.title)).toEqual(PLUGIN.map((s) => s.title));
  });

  it('returns every section untouched when no patterns are set (the default)', () => {
    expect(filterExcludedSections(all, [])).toBe(all); // same reference — fast path
    expect(excludedSections(all, [])).toEqual([]);
  });

  it('can exclude everything — callers have to guard against that themselves', () => {
    // syncLibrary aborts on this rather than tombstoning the whole library.
    expect(filterExcludedSections(all, ['*'])).toEqual([]);
  });
});

describe('normalizeExclusionPatterns (admin input)', () => {
  it('trims, drops blanks, and de-dupes case-insensitively', () => {
    expect(
      normalizeExclusionPatterns([' *Recommend* ', '', '   ', '*RECOMMEND*', 'Anime'])
    ).toEqual(['*Recommend*', 'Anime']);
  });

  it('coerces non-strings and ignores a non-array', () => {
    expect(normalizeExclusionPatterns([1, null, undefined, 'ok'])).toEqual(['1', 'ok']);
    expect(normalizeExclusionPatterns('*Recommend*')).toEqual([]);
    expect(normalizeExclusionPatterns(null)).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_EXCLUSION_PATTERNS + 10 }, (_, i) => `p${i}`);
    expect(normalizeExclusionPatterns(many)).toHaveLength(MAX_EXCLUSION_PATTERNS);
  });
});
