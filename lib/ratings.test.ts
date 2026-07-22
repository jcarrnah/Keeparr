/** FORK: OMDb parsing + ratings-job tests (only the OMDb HTTP call mocked). */
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { __setTestDbToMemory, __closeDb, getDb } from './db';
import {
  getMediaItem,
  itemsNeedingRatings,
  updateItemRatings,
  upsertMediaBatch,
  type UpsertMediaInput,
} from './queries';
import { setOmdbKey } from './settings';
import { parseOmdbRatings, fetchOmdbRatings } from './omdb';
import { runRatings, RATINGS_DAILY_CAP } from './ratings';

vi.mock('./omdb', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./omdb')>();
  return { ...mod, fetchOmdbRatings: vi.fn() };
});
const mockFetch = vi.mocked(fetchOmdbRatings);

function media(ratingKey: string, overrides: Partial<UpsertMediaInput> = {}): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: null,
    sizeBytes: 1,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
    guidImdb: `tt${ratingKey}`,
    ...overrides,
  };
}

beforeEach(() => {
  __setTestDbToMemory();
  mockFetch.mockReset();
});

afterAll(() => {
  __closeDb();
});

describe('parseOmdbRatings (pure)', () => {
  it('parses a full payload', () => {
    expect(
      parseOmdbRatings({
        Response: 'True',
        imdbRating: '8.5',
        Metascore: '77',
        Ratings: [
          { Source: 'Internet Movie Database', Value: '8.5/10' },
          { Source: 'Rotten Tomatoes', Value: '94%' },
        ],
      })
    ).toEqual({ imdbRating: 8.5, rtScore: 94, metacritic: 77 });
  });

  it('treats N/A and missing fields as null', () => {
    expect(
      parseOmdbRatings({ Response: 'True', imdbRating: 'N/A', Metascore: 'N/A' })
    ).toEqual({ imdbRating: null, rtScore: null, metacritic: null });
  });

  it('null on an OMDb miss', () => {
    expect(parseOmdbRatings({ Response: 'False', Error: 'Movie not found!' })).toBeNull();
  });
});

describe('itemsNeedingRatings cursor', () => {
  it('never-fetched first, then stale; fresh and id-less items excluded', () => {
    upsertMediaBatch([
      media('new1'),
      media('noid', { guidImdb: null }),
      media('stale'),
      media('fresh'),
    ]);
    const nowSec = Math.floor(Date.now() / 1000);
    updateItemRatings('stale', { imdbRating: 5, rtScore: null, metacritic: null });
    updateItemRatings('fresh', { imdbRating: 9, rtScore: null, metacritic: null });
    // Make 'stale' look 100 days old (fresh keeps its just-now stamp).
    __setTestDbToMemoryPatchFetchedAt('stale', nowSec - 100 * 86400);

    const due = itemsNeedingRatings(10, nowSec - 90 * 86400);
    expect(due.map((r) => r.rating_key)).toEqual(['new1', 'stale']);
  });
});

/** Test-only helper: backdate a ratings_fetched_at stamp. */
function __setTestDbToMemoryPatchFetchedAt(ratingKey: string, ts: number) {
  getDb()
    .prepare('UPDATE media_items SET ratings_fetched_at = ? WHERE rating_key = ?')
    .run(ts, ratingKey);
}

describe('FORK: runRatings job', () => {
  it('is inert without a key', async () => {
    upsertMediaBatch([media('1')]);
    const res = await runRatings();
    expect(res.message).toMatch(/No OMDb API key/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('backfills, stamps misses, and reports', async () => {
    setOmdbKey('k');
    upsertMediaBatch([media('1'), media('2')]);
    mockFetch
      .mockResolvedValueOnce({ imdbRating: 8.1, rtScore: 92, metacritic: 80 })
      .mockResolvedValueOnce(null); // unknown to OMDb
    const res = await runRatings();
    expect(res.result).toBe(1);
    expect(res.message).toMatch(/1 unknown/);
    expect(getMediaItem('1')?.imdb_rating).toBe(8.1);
    expect(getMediaItem('1')?.rt_score).toBe(92);
    // Miss: nulls but stamped — not refetched next run.
    expect(getMediaItem('2')?.imdb_rating).toBeNull();
    const again = await runRatings();
    expect(again.message).toMatch(/fresh/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses the FIRST id of a CSV guid_imdb', async () => {
    setOmdbKey('k');
    upsertMediaBatch([media('1', { guidImdb: 'tt0001,tt0002' })]);
    mockFetch.mockResolvedValue({ imdbRating: 7, rtScore: null, metacritic: null });
    await runRatings();
    expect(mockFetch).toHaveBeenCalledWith('k', 'tt0001');
  });

  it('aborts on a transport error and resumes next run', async () => {
    setOmdbKey('k');
    upsertMediaBatch([media('1'), media('2')]);
    mockFetch
      .mockResolvedValueOnce({ imdbRating: 8, rtScore: null, metacritic: null })
      .mockRejectedValueOnce(new Error('OMDb → HTTP 401'));
    const res = await runRatings();
    expect(res.result).toBe(1);
    expect(res.message).toMatch(/will resume next run/);
    // '2' was NOT stamped — it's still due.
    const due = itemsNeedingRatings(10, 0);
    expect(due.map((r) => r.rating_key)).toEqual(['2']);
    expect(RATINGS_DAILY_CAP).toBeGreaterThan(0);
  });
});
