/**
 * FORK: mirror pending scheduled-deletion tags into a "Leaving Soon"
 * Jellyfin/Emby collection, so household members see doomed titles inside the
 * media server itself (and can rescue them by keeping in Keeparr). Jellyfin
 * and Emby only — on these backends media_items.rating_key IS the server item
 * id. Held/cancelled/deleted tags drop out of the collection on the next sync.
 */
import {
  addToCollection,
  createCollection,
  findCollectionByName,
  getCollectionItemIds,
  removeFromCollection,
} from './jellyfin';
import { logEvent, pendingDeletionKeys } from './queries';
import {
  getAdminToken,
  getLeavingSoonCollectionId,
  getLeavingSoonEnabled,
  getMediaServerType,
  getServerBaseUrl,
  getServerToken,
  setLeavingSoonCollectionId,
} from './settings';

export const LEAVING_SOON_NAME = 'Leaving Soon';

/**
 * Sync the collection to the current pending set. Returns a short summary for
 * the job message, or null when not applicable (non-JF backend / toggle off /
 * not configured). Never throws — a media-server hiccup must not fail the
 * purge job that runs it.
 */
export async function syncLeavingSoonCollection(): Promise<string | null> {
  const type = getMediaServerType();
  if (type === 'plex' || !getLeavingSoonEnabled()) return null;
  const baseUrl = getServerBaseUrl();
  const token = getAdminToken() || getServerToken();
  if (!baseUrl || !token) return null;

  try {
    const desired = new Set(pendingDeletionKeys());

    // Reuse the cached collection id; fall back to a name lookup; create last.
    let collectionId = getLeavingSoonCollectionId();
    let current: string[] | null = null;
    if (collectionId) {
      try {
        current = await getCollectionItemIds(baseUrl, token, collectionId);
      } catch {
        collectionId = null; // cached id is stale (collection deleted) — redo
      }
    }
    if (!collectionId) {
      collectionId = await findCollectionByName(baseUrl, token, LEAVING_SOON_NAME);
      if (collectionId) {
        current = await getCollectionItemIds(baseUrl, token, collectionId);
      } else {
        if (desired.size === 0) return 'Leaving Soon: nothing pending';
        // Create EMPTY, then fall through to the chunked diff below — seeding
        // hundreds of ids into the create URL blows the server's URL limit (414).
        collectionId = await createCollection(baseUrl, token, LEAVING_SOON_NAME);
        current = [];
      }
      setLeavingSoonCollectionId(collectionId);
    }

    const have = new Set(current ?? []);
    const toAdd = [...desired].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !desired.has(id));
    const failed: string[] = [];
    let lastError: string | null = null;
    for (const [ids, edit] of [
      [toAdd, addToCollection],
      [toRemove, removeFromCollection],
    ] as const) {
      if (ids.length === 0) continue;
      const r = await edit(baseUrl, token, collectionId, ids);
      failed.push(...r.failed);
      lastError = r.lastError ?? lastError;
    }
    if (failed.length) {
      // Partial success: the good ids landed; name the refused ones + why.
      logEvent(
        'warn',
        'job:purge',
        `Leaving Soon: server refused ${failed.length} item(s) (ids: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''}) — last error: ${lastError}`
      );
    }
    const failNote = failed.length ? `, ${failed.length} refused (see logs)` : '';
    return `Leaving Soon: +${toAdd.length - failed.filter((f) => toAdd.includes(f)).length}/-${toRemove.length - failed.filter((f) => toRemove.includes(f)).length} (${desired.size} total)${failNote}`;
  } catch (e) {
    logEvent('warn', 'job:purge', `Leaving Soon collection sync failed: ${String(e)}`);
    return 'Leaving Soon: sync failed (see logs)';
  }
}
