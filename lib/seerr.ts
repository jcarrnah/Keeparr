/**
 * Overseerr / Seerr API client (base /api/v1, auth header X-Api-Key).
 * We use it read-only: test the connection and find which items a given user has
 * requested. On Plex we join via `media.ratingKey`; on Jellyfin/Emby (where that
 * key isn't our item id) we match by tmdb/tvdb id → `media_items.guid_*`.
 */
import { fetchJson } from './http';
import { getMediaServerType } from './settings';
import { ratingKeysByGuid } from './queries';

interface SeerrUser {
  id: number;
  email?: string | null;
  plexUsername?: string | null;
  username?: string | null;
  jellyfinUsername?: string | null;
}

interface SeerrRequest {
  media?: {
    ratingKey?: string | number | null;
    tmdbId?: number | null;
    tvdbId?: number | null;
    mediaType?: string | null;
  };
}

async function seerrGet<T>(
  base: string,
  apiKey: string,
  path: string
): Promise<T> {
  const url = base.replace(/\/$/, '') + '/api/v1' + path;
  // fetchJson rejects non-JSON (e.g. an HTML login/error page from a wrong URL)
  // with a clear message instead of a cryptic "Unexpected token '<'".
  return fetchJson<T>(url, {
    headers: { 'X-Api-Key': apiKey },
    label: `Seerr ${path}`,
  });
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50; // safety cap (10k rows) against a server that never ends

/**
 * Page through a Seerr list endpoint (`take`/`skip`, `{pageInfo, results}`
 * envelope) until exhausted. A single `take=200` silently drops everything past
 * the first page (users beyond 200, a heavy requester's older requests).
 */
async function seerrGetPaged<T>(
  base: string,
  apiKey: string,
  path: string
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await seerrGet<{
      pageInfo?: { pages?: number; page?: number };
      results?: T[];
    }>(base, apiKey, `${path}?take=${PAGE_SIZE}&skip=${page * PAGE_SIZE}`);
    const batch = data.results ?? [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    const info = data.pageInfo;
    if (info?.pages != null && info?.page != null && info.page >= info.pages) break;
  }
  return out;
}

export async function testSeerr(
  base: string,
  apiKey: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const status = await seerrGet<{ version?: string }>(base, apiKey, '/status');
    return {
      ok: true,
      message: status?.version ? `Connected (v${status.version})` : 'Connected',
    };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

/** Find the Seerr user id matching a Plex account by email or plex username. */
async function findSeerrUserId(
  base: string,
  apiKey: string,
  match: { email: string | null; username: string | null }
): Promise<number | null> {
  const users = await seerrGetPaged<SeerrUser>(base, apiKey, '/user');
  const lcEmail = match.email?.toLowerCase();
  const lcUser = match.username?.toLowerCase();
  const found = users.find(
    (u) =>
      (lcEmail && u.email?.toLowerCase() === lcEmail) ||
      (lcUser && u.plexUsername?.toLowerCase() === lcUser) ||
      (lcUser && u.jellyfinUsername?.toLowerCase() === lcUser) ||
      (lcUser && u.username?.toLowerCase() === lcUser)
  );
  return found?.id ?? null;
}

/**
 * Set of our rating keys the given user has requested via Seerr. Empty if the
 * user can't be matched or has no requests. Best-effort (never throws into the
 * caller's render path — caller should try/catch). On Plex this is `media.ratingKey`
 * directly; on Jellyfin/Emby it resolves the request's tmdb/tvdb id to the matching
 * media item (`media_items.guid_tmdb/guid_tvdb`), so it works without Plex ids.
 */
export async function requestedRatingKeysForUser(
  base: string,
  apiKey: string,
  match: { email: string | null; username: string | null }
): Promise<Set<string>> {
  const userId = await findSeerrUserId(base, apiKey, match);
  if (userId == null) return new Set();
  const requests = await seerrGetPaged<SeerrRequest>(
    base,
    apiKey,
    `/user/${userId}/requests`
  );
  const keys = new Set<string>();

  if (getMediaServerType() === 'plex') {
    for (const r of requests) {
      const rk = r.media?.ratingKey;
      if (rk != null && String(rk).length > 0) keys.add(String(rk));
    }
    return keys;
  }

  // Jellyfin/Emby: match by external id → our media item.
  const tmdb = ratingKeysByGuid('tmdb');
  const tvdb = ratingKeysByGuid('tvdb');
  for (const r of requests) {
    const m = r.media;
    if (!m) continue;
    const isTv = m.mediaType === 'tv';
    const rk = isTv
      ? m.tvdbId != null
        ? tvdb.get(String(m.tvdbId))
        : undefined
      : m.tmdbId != null
        ? tmdb.get(String(m.tmdbId))
        : undefined;
    if (rk) keys.add(rk);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// FORK: request cleanup after a purge. Deleting a title from Sonarr/Radarr does
// NOT remove its Seerr request — the request stays "available", and a re-request
// (or an auto-sync) can put the title straight back, re-downloading what we just
// deleted. Closing that loop is the difference between a deletion and a
// temporary one. Kept at the end of the file so upstream edits above never
// collide (see FORK_SYNC.md).
// ---------------------------------------------------------------------------

/** One Seerr request, with the id needed to delete it. */
interface SeerrRequestWithId extends SeerrRequest {
  id: number;
}

/**
 * Every request on the server, indexed by the external id it points at:
 * `"tmdb:603"` / `"tvdb:81967"` → request id. Built once per purge run so a
 * multi-item purge makes one paged fetch rather than one lookup per title.
 */
export async function seerrRequestIdsByExternalId(
  base: string,
  apiKey: string
): Promise<Map<string, number>> {
  const requests = await seerrGetPaged<SeerrRequestWithId>(base, apiKey, '/request');
  const map = new Map<string, number>();
  for (const r of requests) {
    if (r.id == null || !r.media) continue;
    // A title can carry both ids; index under each so either resolves.
    if (r.media.tmdbId != null) map.set(`tmdb:${r.media.tmdbId}`, r.id);
    if (r.media.tvdbId != null) map.set(`tvdb:${r.media.tvdbId}`, r.id);
  }
  return map;
}

/**
 * Delete one request. Seerr answers 204 with no body, so `allowEmpty` is
 * required. A request that is already gone (404) is a success for our purposes
 * and is swallowed; anything else propagates for the caller to log.
 */
export async function deleteSeerrRequest(
  base: string,
  apiKey: string,
  requestId: number
): Promise<void> {
  const url = base.replace(/\/$/, '') + '/api/v1/request/' + requestId;
  try {
    await fetchJson(url, {
      method: 'DELETE',
      headers: { 'X-Api-Key': apiKey },
      label: `Seerr DELETE /request/${requestId}`,
      allowEmpty: true,
    });
  } catch (e) {
    if (String(e).includes('HTTP 404')) return; // already gone
    throw e;
  }
}
