import {
  extractGuids,
  getAllLeaves,
  getRecentlyAdded,
  getSectionItems,
  getSections,
  sumLeafSizes,
  sumPartSizes,
  type PlexMetadata,
} from '../plex';
import { getPlexBaseUrl, getServerToken } from '../settings';
import type { LibraryKind } from '../types';
import type { BackendItem, BackendSection, MediaBackend } from './types';

function creds(): { baseUrl: string; token: string } {
  const baseUrl = getPlexBaseUrl();
  const token = getServerToken();
  if (!baseUrl || !token) throw new Error('Plex server not configured');
  return { baseUrl, token };
}

function mapItem(m: PlexMetadata, sizeBytes: number): BackendItem {
  const { tmdb, tvdb, imdb } = extractGuids(m);
  return {
    ratingKey: String(m.ratingKey),
    title: m.title,
    year: m.year ?? null,
    thumb: m.thumb ?? null,
    addedAt: m.addedAt ?? null,
    guidTmdb: tmdb,
    guidTvdb: tvdb,
    guidImdb: imdb,
    sizeBytes,
    overview: m.summary ?? null,
    genres: (m.Genre ?? []).map((g) => g.tag).filter((t): t is string => !!t),
    runtimeMinutes: m.duration ? Math.round(m.duration / 60000) : null,
  };
}

/** Plex backend: thin adapter over lib/plex.ts so Plex behavior is unchanged. */
export const plexBackend: MediaBackend = {
  async listSections(): Promise<BackendSection[]> {
    const { baseUrl, token } = creds();
    const secs = await getSections(baseUrl, token);
    return secs
      .filter((s) => s.type === 'movie' || s.type === 'show')
      .map((s) => ({
        id: s.key,
        title: s.title,
        kind: (s.type === 'movie' ? 'movie' : 'show') as LibraryKind,
        paths: (s.Location ?? []).map((l) => l.path),
      }));
  },
  async listSectionItems(sectionId, kind) {
    const { baseUrl, token } = creds();
    const items = await getSectionItems(baseUrl, token, sectionId, kind === 'movie' ? 1 : 2);
    return items.map((m) => mapItem(m, kind === 'movie' ? sumPartSizes(m) : 0));
  },
  async recentItems(sectionId, kind, limit) {
    const { baseUrl, token } = creds();
    const items = await getRecentlyAdded(baseUrl, token, sectionId, kind === 'movie' ? 1 : 2, limit);
    return items.map((m) => mapItem(m, kind === 'movie' ? sumPartSizes(m) : 0));
  },
  async showSize(ratingKey) {
    const { baseUrl, token } = creds();
    return sumLeafSizes(await getAllLeaves(baseUrl, token, ratingKey));
  },
  // Plex watch history comes from Tautulli (separate connector), not Plex itself.
  async getWatchData() {
    return null;
  },
};
