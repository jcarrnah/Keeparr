/** Shared data-transfer types across the queries layer, API routes, and UI. */

export type LibraryKind = 'movie' | 'show';

/**
 * Watch-history slice for the home feed (the `watch=` query param) — lets votes
 * be gathered on a coherent list instead of one big mixed batch.
 * `never_played`/`stale_90`/`recent_30` are server-wide (anyone's history);
 * `my_unwatched` is this user's.
 */
export type FeedWatchMode =
  | 'never_played'
  | 'stale_90'
  | 'recent_30'
  | 'my_unwatched';

export const FEED_WATCH_MODES: FeedWatchMode[] = [
  'never_played',
  'stale_90',
  'recent_30',
  'my_unwatched',
];

/** A row from media_items as stored. */
export interface MediaItem {
  rating_key: string;
  section_id: string;
  library_kind: LibraryKind;
  title: string;
  year: number | null;
  thumb: string | null;
  size_bytes: number;
  added_at: number | null;
  guid_tmdb: string | null;
  guid_tvdb: string | null;
  last_synced: number;
  removed: number;
}

/** A media item enriched with per-request flags for the UI. */
export interface MediaCardData {
  ratingKey: string;
  sectionId: string;
  libraryKind: LibraryKind;
  title: string;
  year: number | null;
  /** Local proxy URL for the poster (never exposes the Plex token). */
  thumbUrl: string | null;
  sizeBytes: number;
  /** True when anyone keeps it (protected from reclaim). */
  kept: boolean;
  /** True when the current user keeps it (only their own keep is removable). */
  keptByMe?: boolean;
  /** True when the current user has marked this "don't care". */
  skipped?: boolean;
  /** True when the current user has watched it (any plays, from Tautulli). */
  watched?: boolean;
  // --- "OK to delete" (the original Seerr requester signing off) ---
  /** True when the current user requested this on Seerr (gates the control). */
  requestedByMe?: boolean;
  /** True when the current user marked this "OK to delete". */
  markedForDeleteByMe?: boolean;
  /** True when anyone marked it "OK to delete" — carries NO identity (Browse
   *  never reveals who, except via markedForDeleteByMe). */
  markedForDeleteAny?: boolean;
  // --- Sonarr/Radarr metadata (present only when the title is arr-matched) ---
  /** 'sonarr' | 'radarr'. */
  source?: string;
  instanceName?: string;
  monitored?: boolean;
  /** Raw arr status (continuing/ended/released…). */
  status?: string;
  /** Movie: actual file quality; series: quality profile name. */
  quality?: string;
  /** 'file' (movie, actual) | 'profile' (series, target). */
  qualityKind?: string;
  /** Resolved Sonarr/Radarr tag labels. */
  tags?: string[];
  /** arr-reported size on disk (for the Plex-vs-arr cross-check). */
  arrSizeBytes?: number;
  /** True when Plex size and arr size diverge materially (likely partial/broken). */
  sizeMismatch?: boolean;
}

export interface SessionUser {
  plexUserId: string;
  username: string | null;
  email: string | null;
  thumb: string | null;
  isAdmin: boolean;
  /** False = account is blocked from signing in. */
  enabled: boolean;
}

/** A user as the admin "Users" management screen sees them. */
export interface AdminUserRow {
  plexUserId: string;
  username: string | null;
  email: string | null;
  thumb: string | null;
  isAdmin: boolean;
  /** False = account is blocked from signing in. */
  enabled: boolean;
  /** True for the server Owner (plex_owner_id) — admin can never be revoked. */
  isOwner: boolean;
  lastLogin: number | null;
  createdAt: number;
}

export interface SyncStatus {
  lastRun: number | null;
  lastStatus: string | null;
  lastMessage: string | null;
  itemsSynced: number | null;
}

export type JobStatus = 'never' | 'running' | 'ok' | 'error';

/** One app-event log line (Settings → Logs). */
export interface LogRow {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

/** One historical job execution (for the admin activity log). */
export interface JobRun {
  id: number;
  jobId: string;
  startedAt: number;
  endedAt: number | null;
  status: string | null;
  message: string | null;
  durationMs: number | null;
  result: number | null;
}

/** Status of one scheduled refresh job. */
export interface JobState {
  jobId: string;
  lastRun: number | null;
  lastStatus: JobStatus;
  lastMessage: string | null;
  lastDurationMs: number | null;
  lastResult: number | null;
}

/** A Plex library as the UI sees it. */
export interface LibrarySection {
  sectionId: string;
  title: string;
  /** Plex's own section type (movie/show). */
  kind: LibraryKind;
  itemCount: number;
  /** Total bytes this library occupies on disk (summed media sizes). */
  sizeBytes: number;
}
