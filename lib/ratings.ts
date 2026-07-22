/**
 * FORK: the 'ratings' job — backfill + refresh IMDb/RT/Metacritic from OMDb.
 * Free OMDb keys allow ~1000 req/day, so each run caps at RATINGS_DAILY_CAP
 * and resumes naturally next run (never-fetched items sort first). Stale
 * entries (>90d) refresh after the backfill completes. A transport/auth error
 * aborts the run (don't burn quota into a dead key); per-title misses just
 * stamp the timestamp and move on.
 */
import { fetchOmdbRatings } from './omdb';
import { itemsNeedingRatings, logEvent, updateItemRatings } from './queries';
import { getOmdbKey } from './settings';
import type { JobResult } from './sync';

export const RATINGS_DAILY_CAP = 900;
const STALE_DAYS = 90;

export async function runRatings(): Promise<JobResult> {
  const key = getOmdbKey();
  if (!key) {
    return { result: 0, message: 'No OMDb API key configured — nothing to do.' };
  }
  const staleBefore = Math.floor(Date.now() / 1000) - STALE_DAYS * 86400;
  const batch = itemsNeedingRatings(RATINGS_DAILY_CAP, staleBefore);
  if (batch.length === 0) {
    return { result: 0, message: 'All ratings are fresh.' };
  }

  let updated = 0;
  let misses = 0;
  for (const item of batch) {
    // guid_imdb can be a CSV when Plex merged several ids — use the first.
    const imdbId = item.guid_imdb.split(',')[0].trim();
    let ratings;
    try {
      ratings = await fetchOmdbRatings(key, imdbId);
    } catch (e) {
      // Transport/auth failure: abort — remaining items resume next run.
      logEvent('warn', 'job:ratings', `OMDb fetch failed (${String(e)}) — stopping this run.`);
      return {
        result: updated,
        message: `Updated ${updated}, then OMDb failed: ${String(e)} (will resume next run).`,
      };
    }
    if (ratings) updated++;
    else misses++;
    // Stamp even on a miss so unknown titles aren't refetched every night.
    updateItemRatings(item.rating_key, ratings ?? { imdbRating: null, rtScore: null, metacritic: null });
  }

  const parts = [`Updated ${updated} title(s)`];
  if (misses) parts.push(`${misses} unknown to OMDb`);
  if (batch.length === RATINGS_DAILY_CAP) parts.push('daily cap reached — resuming tomorrow');
  return { result: updated, message: parts.join('; ') + '.' };
}
