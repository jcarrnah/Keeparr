import type { MediaCardData, MediaItem } from './types';

/** Build the browser-facing poster URL (proxied; never exposes the Plex token). */
export function thumbUrl(thumb: string | null): string | null {
  if (!thumb) return null;
  return `/api/image?path=${encodeURIComponent(thumb)}&w=300&h=450`;
}

/** Parse the stored genres JSON (a string[] blob) defensively → string[]. */
export function parseGenres(genres: string | null | undefined): string[] {
  if (!genres) return [];
  try {
    const v = JSON.parse(genres);
    return Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

/** Map a stored media row (+ kept flags) into the UI card shape. */
export function toCard(
  item: MediaItem,
  kept: boolean,
  keptByMe?: boolean,
  skipped?: boolean,
  watched?: boolean
): MediaCardData {
  const genres = parseGenres(item.genres);
  return {
    ratingKey: item.rating_key,
    sectionId: item.section_id,
    libraryKind: item.library_kind,
    title: item.title,
    year: item.year,
    thumbUrl: thumbUrl(item.thumb),
    sizeBytes: item.size_bytes,
    kept,
    keptByMe: !!keptByMe,
    skipped: !!skipped,
    watched: !!watched,
    overview: item.overview ?? undefined,
    genres: genres.length ? genres : undefined,
    runtimeMinutes: item.runtime_minutes ?? undefined,
  };
}
