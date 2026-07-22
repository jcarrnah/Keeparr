/**
 * FORK: OMDb client (www.omdbapi.com) — IMDb rating + Rotten Tomatoes +
 * Metacritic by IMDb id, for the swipe cards. Free keys allow ~1000 req/day;
 * the 'ratings' job (lib/ratings.ts) respects that with a daily cap and a
 * natural resume cursor (never-fetched items first). The pure parser is split
 * out for unit tests, matching the lib/arr.ts normalize* pattern.
 */
import { fetchJson } from './http';

export interface OmdbRatings {
  imdbRating: number | null; // 0–10
  rtScore: number | null; // Rotten Tomatoes %
  metacritic: number | null; // 0–100
}

/** Raw OMDb payload (only the fields we read). */
export interface OmdbRaw {
  Response?: string; // "True" | "False"
  Error?: string;
  imdbRating?: string; // "8.5" | "N/A"
  Metascore?: string; // "77" | "N/A"
  Ratings?: { Source?: string; Value?: string }[];
}

/** Parse an OMDb title payload; null when OMDb didn't know the id. */
export function parseOmdbRatings(d: OmdbRaw): OmdbRatings | null {
  if (d.Response === 'False') return null;
  const num = (s: string | undefined): number | null => {
    const n = Number(s);
    return s && s !== 'N/A' && Number.isFinite(n) ? n : null;
  };
  const rt = (d.Ratings ?? []).find((r) => r.Source === 'Rotten Tomatoes')?.Value;
  return {
    imdbRating: num(d.imdbRating),
    rtScore: rt ? num(rt.replace('%', '')) : null,
    metacritic: num(d.Metascore),
  };
}

/**
 * Fetch ratings for one IMDb id ("tt…"). Null = OMDb doesn't know the title
 * (a durable miss — still worth stamping ratings_fetched_at). Throws on
 * transport/auth errors (a 401'd key must abort the whole run, not burn quota).
 */
export async function fetchOmdbRatings(
  apiKey: string,
  imdbId: string
): Promise<OmdbRatings | null> {
  const d = await fetchJson<OmdbRaw>(
    `https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&i=${encodeURIComponent(imdbId)}`,
    { label: 'OMDb' }
  );
  return parseOmdbRatings(d);
}

/** Verify a key (Settings Test button) against a known title. Never throws. */
export async function testOmdb(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetchOmdbRatings(apiKey, 'tt0111161'); // The Shawshank Redemption
    return r
      ? { ok: true, message: `Connected (IMDb ${r.imdbRating ?? '?'} for the test title).` }
      : { ok: false, message: 'OMDb answered but rejected the lookup.' };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
