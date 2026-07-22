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
        collectionId = await createCollection(baseUrl, token, LEAVING_SOON_NAME, [...desired]);
        setLeavingSoonCollectionId(collectionId);
        return `Leaving Soon: created with ${desired.size} item(s)`;
      }
      setLeavingSoonCollectionId(collectionId);
    }

    const have = new Set(current ?? []);
    const toAdd = [...desired].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !desired.has(id));
    if (toAdd.length) await addToCollection(baseUrl, token, collectionId, toAdd);
    if (toRemove.length) await removeFromCollection(baseUrl, token, collectionId, toRemove);
    return `Leaving Soon: +${toAdd.length}/-${toRemove.length} (${desired.size} total)`;
  } catch (e) {
    logEvent('warn', 'job:purge', `Leaving Soon collection sync failed: ${String(e)}`);
    return 'Leaving Soon: sync failed (see logs)';
  }
}
