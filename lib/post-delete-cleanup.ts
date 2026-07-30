/**
 * FORK: finish the job after a purge.
 *
 * Deleting via Sonarr/Radarr only removes the *arr record and the files. Two
 * other systems still believe the title exists, and each causes a real problem:
 *
 *  - **Jellyfin/Emby** keeps serving the now-empty entry until it rescans, so
 *    purged shows linger at 0.00 GB (they surface under Problems as zero-size
 *    items with no *arr match). One library refresh at the end of a run makes
 *    the server drop them itself.
 *  - **Seerr** keeps the request. It still reads as "available", and a
 *    re-request or auto-sync can put the title straight back — re-downloading
 *    exactly what was just deleted. This is the loop that makes a deletion
 *    temporary.
 *
 * Never throws: this runs at the tail of the purge job, and a media-server or
 * Seerr hiccup must not fail a run whose deletions already succeeded.
 */
import { refreshLibrary } from './jellyfin';
import { logEvent } from './queries';
import { deleteSeerrRequest, seerrRequestIdsByExternalId } from './seerr';
import {
  getAdminToken,
  getMediaServerType,
  getSeerrKey,
  getSeerrUrl,
  getServerBaseUrl,
  getServerToken,
} from './settings';

/** One purged title, with the external ids its Seerr request points at. */
export interface PurgedItem {
  ratingKey: string;
  title: string;
  guidTmdb: string | null;
  guidTvdb: string | null;
}

export interface CleanupResult {
  /** Seerr requests removed (so the title can't be silently re-added). */
  seerrCleared: number;
  /** Whether a media-server rescan was triggered. */
  serverRefreshed: boolean;
}

/** A media item can carry several ids of a kind as CSV — try each. */
function idKeys(item: PurgedItem): string[] {
  const out: string[] = [];
  for (const raw of (item.guidTmdb ?? '').split(',')) {
    const t = raw.trim();
    if (t) out.push(`tmdb:${t}`);
  }
  for (const raw of (item.guidTvdb ?? '').split(',')) {
    const t = raw.trim();
    if (t) out.push(`tvdb:${t}`);
  }
  return out;
}

/**
 * Clear Seerr requests for the purged titles and trigger one media-server
 * rescan. Call once per purge run, after the delete loop — never in dry-run.
 */
export async function cleanupAfterDeletions(
  items: PurgedItem[]
): Promise<CleanupResult> {
  const result: CleanupResult = { seerrCleared: 0, serverRefreshed: false };
  if (items.length === 0) return result;

  // --- Seerr: drop the requests that would let these come back -------------
  const seerrUrl = getSeerrUrl();
  const seerrKey = getSeerrKey();
  if (seerrUrl && seerrKey) {
    try {
      // One paged fetch for the whole run, not one lookup per title.
      const byExternalId = await seerrRequestIdsByExternalId(seerrUrl, seerrKey);
      const done = new Set<number>();
      for (const item of items) {
        for (const key of idKeys(item)) {
          const requestId = byExternalId.get(key);
          if (requestId == null || done.has(requestId)) continue;
          try {
            await deleteSeerrRequest(seerrUrl, seerrKey, requestId);
            done.add(requestId);
            result.seerrCleared++;
            logEvent(
              'info',
              'job:purge',
              `Cleared the Seerr request for "${item.title}" so it can't be silently re-added.`
            );
          } catch (e) {
            logEvent(
              'warn',
              'job:purge',
              `Deleted "${item.title}" but could NOT clear its Seerr request — ` +
                `it may be re-requested and re-downloaded: ${String(e)}`
            );
          }
          break; // one request per title
        }
      }
    } catch (e) {
      logEvent(
        'warn',
        'job:purge',
        `Could not read Seerr requests for post-delete cleanup: ${String(e)}`
      );
    }
  }

  // --- Media server: one rescan so empty entries disappear -----------------
  // Jellyfin/Emby only; Plex has no equivalent single-call refresh here, and
  // its own scheduled scan handles it.
  if (getMediaServerType() !== 'plex') {
    const baseUrl = getServerBaseUrl();
    const token = getAdminToken() || getServerToken();
    if (baseUrl && token) {
      try {
        await refreshLibrary(baseUrl, token);
        result.serverRefreshed = true;
        logEvent(
          'info',
          'job:purge',
          'Triggered a media-server library refresh so the deleted titles drop out.'
        );
      } catch (e) {
        logEvent(
          'warn',
          'job:purge',
          `Could not trigger a media-server refresh (deleted titles will linger ` +
            `as empty entries until its own scan): ${String(e)}`
        );
      }
    }
  }

  return result;
}
