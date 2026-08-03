import { getDb } from './db';
import { FEED_MOVIE_RESERVE_MIN, FEED_MOVIE_RESERVE_RATIO } from './config';
import { lastSegment, normalizeName, titleKey } from './paths';
import type {
  AdminUserRow,
  FeedWatchMode,
  JobRun,
  JobState,
  LibraryKind,
  LogRow,
  MediaItem,
  RuleCondition,
  SessionUser,
  SyncStatus,
  Verdict,
} from './types';
// FORK: the verdict scale lives in types.ts so SQL and UI share one source.
import { IMPLIED_VERDICTS, VERDICTS, VERDICT_POINTS, effectiveMinVoters } from './types';

export type { FeedWatchMode, RuleCondition, Verdict };

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Settings (key/value). Token values are encrypted by the caller before set.
// ---------------------------------------------------------------------------

export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function countAdmins(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1')
    .get() as { n: number };
  return row.n;
}

export function countUsers(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM users')
    .get() as { n: number };
  return row.n;
}

export interface UpsertUserInput {
  plexUserId: string;
  username: string | null;
  email: string | null;
  thumb: string | null;
  isAdmin: boolean;
  /** Initial enabled state on first insert (default true); preserved on update. */
  enabled?: boolean;
}

/**
 * Insert or update a user, recording the login time. Preserves is_admin once set
 * and never changes `enabled` on update (set it explicitly via setUserEnabled).
 */
export function upsertUser(input: UpsertUserInput): void {
  getDb()
    .prepare(
      `INSERT INTO users (plex_user_id, username, email, thumb, is_admin, enabled, created_at, last_login)
       VALUES (@plexUserId, @username, @email, @thumb, @isAdmin, @enabled, @ts, @ts)
       ON CONFLICT(plex_user_id) DO UPDATE SET
         username   = excluded.username,
         email      = excluded.email,
         thumb      = excluded.thumb,
         is_admin   = MAX(users.is_admin, excluded.is_admin),
         last_login = excluded.last_login`
    )
    .run({
      plexUserId: input.plexUserId,
      username: input.username,
      email: input.email,
      thumb: input.thumb,
      isAdmin: input.isAdmin ? 1 : 0,
      enabled: input.enabled === false ? 0 : 1,
      ts: now(),
    });
}

export function getUser(plexUserId: string): SessionUser | null {
  const row = getDb()
    .prepare(
      'SELECT plex_user_id, username, email, thumb, is_admin, enabled FROM users WHERE plex_user_id = ?'
    )
    .get(plexUserId) as
    | {
        plex_user_id: string;
        username: string | null;
        email: string | null;
        thumb: string | null;
        is_admin: number;
        enabled: number;
      }
    | undefined;
  if (!row) return null;
  return {
    plexUserId: row.plex_user_id,
    username: row.username,
    email: row.email,
    thumb: row.thumb,
    isAdmin: row.is_admin === 1,
    enabled: row.enabled === 1,
  };
}

/**
 * List every user who has logged in, admins first then most-recently-seen.
 * `isOwner` is not stored here — the caller annotates it via getOwnerId().
 */
export function listUsers(): Omit<AdminUserRow, 'isOwner'>[] {
  const rows = getDb()
    .prepare(
      `SELECT plex_user_id, username, email, thumb, is_admin, enabled, last_login, created_at
       FROM users
       ORDER BY is_admin DESC, last_login DESC`
    )
    .all() as {
    plex_user_id: string;
    username: string | null;
    email: string | null;
    thumb: string | null;
    is_admin: number;
    enabled: number;
    last_login: number | null;
    created_at: number;
  }[];
  return rows.map((r) => ({
    plexUserId: r.plex_user_id,
    username: r.username,
    email: r.email,
    thumb: r.thumb,
    isAdmin: r.is_admin === 1,
    enabled: r.enabled === 1,
    lastLogin: r.last_login,
    createdAt: r.created_at,
  }));
}

/**
 * Explicitly set or clear a user's admin flag. The deliberate counterpart to
 * upsertUser, whose MAX(is_admin, …) clause can only ever raise the flag.
 */
export function setUserAdmin(plexUserId: string, isAdmin: boolean): void {
  getDb()
    .prepare('UPDATE users SET is_admin = ? WHERE plex_user_id = ?')
    .run(isAdmin ? 1 : 0, plexUserId);
}

/** Enable or block a user from signing in. Blocking also invalidates any tokens
 *  they already hold (bump the epoch) so a captured session dies immediately. */
export function setUserEnabled(plexUserId: string, enabled: boolean): void {
  const db = getDb();
  if (enabled) {
    db.prepare('UPDATE users SET enabled = 1 WHERE plex_user_id = ?').run(plexUserId);
  } else {
    db.prepare(
      'UPDATE users SET enabled = 0, session_epoch = session_epoch + 1 WHERE plex_user_id = ?'
    ).run(plexUserId);
  }
}

/** The user's current session epoch (0 if unknown). Tokens carry the epoch at
 *  mint time; a mismatch means the token was invalidated (logout-all / disable). */
export function getUserEpoch(plexUserId: string): number {
  const row = getDb()
    .prepare('SELECT session_epoch FROM users WHERE plex_user_id = ?')
    .get(plexUserId) as { session_epoch: number } | undefined;
  return row?.session_epoch ?? 0;
}

/** Invalidate all of a user's outstanding session tokens (sign out everywhere). */
export function bumpSessionEpoch(plexUserId: string): void {
  getDb()
    .prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE plex_user_id = ?')
    .run(plexUserId);
}

// ---------------------------------------------------------------------------
// Media items (sync writes these)
// ---------------------------------------------------------------------------

export interface UpsertMediaInput {
  ratingKey: string;
  sectionId: string;
  libraryKind: LibraryKind;
  title: string;
  year: number | null;
  thumb: string | null;
  sizeBytes: number;
  addedAt: number | null;
  guidTmdb: string | null;
  guidTvdb: string | null;
  /** imdb id(s) ("tt…"), CSV when Plex lists several. Optional for back-compat. */
  guidImdb?: string | null;
  // FORK: card enrichment from the sync seam. Optional for back-compat (tests /
  // legacy callers) — omitted values store as null/[]/null.
  overview?: string | null;
  genres?: string[];
  runtimeMinutes?: number | null;
  /** On-disk folder name (server-side basename) — the disk-orphan scan's
   *  known-name key. Optional for back-compat. */
  dirName?: string | null;
  /** Movie file basename (covers loose files in the library root). */
  fileName?: string | null;
  /** FULL server-side path of the item's folder (Problems page Location cells). */
  dirPath?: string | null;
  /** Movie: distinct video files merged into the item (>1 = multi-part).
   *  Null/omitted for shows — COALESCE keeps any stored value. */
  fileCount?: number | null;
}

const upsertMediaStmt = () =>
  getDb().prepare(
    `INSERT INTO media_items
       (rating_key, section_id, library_kind, title, year, thumb, size_bytes,
        added_at, guid_tmdb, guid_tvdb, guid_imdb, overview, genres,
        runtime_minutes, dir_name, file_name, dir_path, file_count,
        last_synced, removed)
     VALUES
       (@ratingKey, @sectionId, @libraryKind, @title, @year, @thumb, @sizeBytes,
        @addedAt, @guidTmdb, @guidTvdb, @guidImdb, @overview, @genres,
        @runtimeMinutes, @dirName, @fileName, @dirPath, @fileCount,
        @ts, 0)
     ON CONFLICT(rating_key) DO UPDATE SET
       section_id   = excluded.section_id,
       library_kind = excluded.library_kind,
       title        = excluded.title,
       year         = excluded.year,
       thumb        = excluded.thumb,
       size_bytes   = excluded.size_bytes,
       added_at     = excluded.added_at,
       guid_tmdb    = excluded.guid_tmdb,
       guid_tvdb    = excluded.guid_tvdb,
       guid_imdb    = excluded.guid_imdb,
       overview        = excluded.overview,
       genres          = excluded.genres,
       runtime_minutes = excluded.runtime_minutes,
       dir_name     = COALESCE(excluded.dir_name, dir_name),
       file_name    = COALESCE(excluded.file_name, file_name),
       dir_path     = COALESCE(excluded.dir_path, dir_path),
       file_count   = COALESCE(excluded.file_count, file_count),
       last_synced  = excluded.last_synced,
       removed      = 0`
  );

/**
 * Upsert a batch of media items in a single transaction. Returns count.
 *
 * Pass a single `syncedAt` for the whole sync so every touched item shares one
 * last_synced value; then call tombstoneStale(syncedAt) afterwards to remove
 * anything not re-touched. Defaults to now() for ad-hoc writes.
 *
 * On-disk name/path columns update COALESCE-style: a NULL in the incoming row
 * keeps the stored value. Scans that don't recompute a show (known size →
 * showSize skipped, so no episode-derived path) must not wipe the backfill the
 * sizes job wrote — recentlyAdded runs every 5 minutes and was doing exactly
 * that on servers that omit Location from listings.
 */
export function upsertMediaBatch(
  items: UpsertMediaInput[],
  syncedAt: number = now()
): number {
  const db = getDb();
  const stmt = upsertMediaStmt();
  const run = db.transaction((rows: UpsertMediaInput[]) => {
    for (const r of rows) {
      stmt.run({
        ...r,
        guidImdb: r.guidImdb ?? null,
        overview: r.overview ?? null,
        // Genres bind as a JSON string (SQLite can't bind arrays).
        genres: r.genres && r.genres.length ? JSON.stringify(r.genres) : null,
        runtimeMinutes: r.runtimeMinutes ?? null,
        dirName: r.dirName ?? null,
        fileName: r.fileName ?? null,
        dirPath: r.dirPath ?? null,
        fileCount: r.fileCount ?? null,
        ts: syncedAt,
      });
    }
  });
  run(items);
  return items.length;
}

/**
 * Tombstone any non-removed item whose last_synced is older than `before`.
 * Called at the end of a full sync (with that sync's timestamp) so items
 * deleted in Plex disappear here. `excludeSectionIds` shields sections whose
 * scan returned no items (an empty-but-200 backend hiccup must not tombstone
 * a whole library). Returns the number of items tombstoned.
 */
export function tombstoneStale(
  before: number,
  excludeSectionIds: string[] = []
): number {
  const notIn = excludeSectionIds.length
    ? ` AND section_id NOT IN (${excludeSectionIds.map(() => '?').join(',')})`
    : '';
  const info = getDb()
    .prepare(
      `UPDATE media_items SET removed = 1 WHERE removed = 0 AND last_synced < ?${notIn}`
    )
    .run(before, ...excludeSectionIds);
  return info.changes;
}

export function getMediaItem(ratingKey: string): MediaItem | null {
  return (
    (getDb()
      .prepare('SELECT * FROM media_items WHERE rating_key = ?')
      .get(ratingKey) as MediaItem | undefined) ?? null
  );
}

/** Like getMediaItem but excludes tombstoned rows — the existence gate for
 *  mutations (keeping/skipping an item that's gone from the server is a 404). */
export function getActiveMediaItem(ratingKey: string): MediaItem | null {
  return (
    (getDb()
      .prepare('SELECT * FROM media_items WHERE rating_key = ? AND removed = 0')
      .get(ratingKey) as MediaItem | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------
// Keeps (per-user; an item is "protected" if ANYONE keeps it)
// ---------------------------------------------------------------------------

/** Whether anyone keeps this item (= protected from reclaim). */
export function isKept(ratingKey: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM keeps WHERE rating_key = ?')
    .get(ratingKey);
  return !!row;
}

/** Whether THIS user keeps this item. */
export function isKeptByUser(plexUserId: string, ratingKey: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM keeps WHERE plex_user_id = ? AND rating_key = ?')
    .get(plexUserId, ratingKey);
  return !!row;
}

/** Add this user's keep. No-op if they already keep it. True if newly kept. */
export function addKeep(plexUserId: string, ratingKey: string): boolean {
  const info = getDb()
    .prepare(
      `INSERT INTO keeps (plex_user_id, rating_key, kept_at) VALUES (?, ?, ?)
       ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
    )
    .run(plexUserId, ratingKey, now());
  return info.changes > 0;
}

/** Remove only THIS user's keep (never another user's). True if a row was removed. */
export function removeKeep(plexUserId: string, ratingKey: string): boolean {
  const info = getDb()
    .prepare('DELETE FROM keeps WHERE plex_user_id = ? AND rating_key = ?')
    .run(plexUserId, ratingKey);
  return info.changes > 0;
}

/**
 * Set this user's keep AND clear their "don't care" / "OK to delete" for the
 * item, atomically (the three states are mutually exclusive; separate
 * autocommit statements could be torn by a crash). True if newly kept.
 */
export function applyKeep(plexUserId: string, ratingKey: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO keeps (plex_user_id, rating_key, kept_at) VALUES (?, ?, ?)
         ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
      )
      .run(plexUserId, ratingKey, now());
    db.prepare('DELETE FROM user_skips WHERE plex_user_id = ? AND rating_key = ?').run(
      plexUserId,
      ratingKey
    );
    db.prepare('DELETE FROM user_deletes WHERE plex_user_id = ? AND rating_key = ?').run(
      plexUserId,
      ratingKey
    );
    // FORK: a keep pauses any pending scheduled deletion immediately (the purge
    // job re-checks keeps anyway, but the Browse badge should update right away).
    db.prepare(
      `UPDATE scheduled_deletions
       SET status = 'held', status_at = ?, status_detail = 'keep added'
       WHERE rating_key = ? AND status = 'pending'`
    ).run(now(), ratingKey);
    return info.changes > 0;
  })();
}

// ---------------------------------------------------------------------------
// Per-user skips ("don't care about the rest")
// ---------------------------------------------------------------------------

/**
 * Batch "don't care": skip every EXISTING, non-tombstoned key and clear this
 * user's keep / "OK to delete" marks for them, all in one transaction (same
 * exclusivity as the single-item routes — the old insert-only version let a
 * crafted batch leave an item both kept and skipped). Unknown/tombstoned keys
 * are silently dropped. Returns the number of newly skipped items.
 */
export function applySkipBatch(plexUserId: string, ratingKeys: string[]): number {
  if (ratingKeys.length === 0) return 0;
  const db = getDb();
  const ph = ratingKeys.map(() => '?').join(',');
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO user_skips (plex_user_id, rating_key, skipped_at)
         SELECT ?, rating_key, ? FROM media_items
         WHERE removed = 0 AND rating_key IN (${ph})
         ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
      )
      .run(plexUserId, now(), ...ratingKeys);
    db.prepare(
      `DELETE FROM keeps WHERE plex_user_id = ? AND rating_key IN (${ph})`
    ).run(plexUserId, ...ratingKeys);
    db.prepare(
      `DELETE FROM user_deletes WHERE plex_user_id = ? AND rating_key IN (${ph})`
    ).run(plexUserId, ...ratingKeys);
    return info.changes;
  })();
}

/** Mark a single item "don't care" for this user. True if newly inserted. */
export function addSkip(plexUserId: string, ratingKey: string): boolean {
  const info = getDb()
    .prepare(
      `INSERT INTO user_skips (plex_user_id, rating_key, skipped_at) VALUES (?, ?, ?)
       ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
    )
    .run(plexUserId, ratingKey, now());
  return info.changes > 0;
}

/** Clear a single "don't care" for this user. True if a row was removed. */
export function removeSkip(plexUserId: string, ratingKey: string): boolean {
  const info = getDb()
    .prepare(
      'DELETE FROM user_skips WHERE plex_user_id = ? AND rating_key = ?'
    )
    .run(plexUserId, ratingKey);
  return info.changes > 0;
}

/**
 * Set this user's "don't care" AND clear their keep / "OK to delete" for the
 * item, atomically. True if newly skipped.
 */
export function applySkip(plexUserId: string, ratingKey: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO user_skips (plex_user_id, rating_key, skipped_at) VALUES (?, ?, ?)
         ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
      )
      .run(plexUserId, ratingKey, now());
    db.prepare('DELETE FROM keeps WHERE plex_user_id = ? AND rating_key = ?').run(
      plexUserId,
      ratingKey
    );
    db.prepare('DELETE FROM user_deletes WHERE plex_user_id = ? AND rating_key = ?').run(
      plexUserId,
      ratingKey
    );
    return info.changes > 0;
  })();
}

/** Whether this user has marked an item "don't care". */
export function isSkipped(plexUserId: string, ratingKey: string): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 AS n FROM user_skips WHERE plex_user_id = ? AND rating_key = ?'
    )
    .get(plexUserId, ratingKey) as { n: number } | undefined;
  return !!row;
}

// ---------------------------------------------------------------------------
// Per-user "OK to delete" (the original Seerr requester signing off)
// ---------------------------------------------------------------------------

/** Whether this user requested this item on Seerr (the gate for OK-to-delete). */
export function isRequestedByUser(
  plexUserId: string,
  ratingKey: string
): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 FROM seerr_requests WHERE plex_user_id = ? AND rating_key = ?'
    )
    .get(plexUserId, ratingKey);
  return !!row;
}

/** Mark a single item "OK to delete" for this user. True if newly inserted. */
export function addDelete(plexUserId: string, ratingKey: string): boolean {
  const info = getDb()
    .prepare(
      `INSERT INTO user_deletes (plex_user_id, rating_key, marked_at) VALUES (?, ?, ?)
       ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
    )
    .run(plexUserId, ratingKey, now());
  return info.changes > 0;
}

/** Clear this user's "OK to delete" mark. True if a row was removed. */
export function removeDelete(plexUserId: string, ratingKey: string): boolean {
  const info = getDb()
    .prepare(
      'DELETE FROM user_deletes WHERE plex_user_id = ? AND rating_key = ?'
    )
    .run(plexUserId, ratingKey);
  return info.changes > 0;
}

/**
 * Set this user's "OK to delete" AND clear their keep / "don't care" for the
 * item, atomically. The isRequestedByUser gate belongs to the route, before
 * this runs. True if newly marked.
 */
export function applyDelete(plexUserId: string, ratingKey: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO user_deletes (plex_user_id, rating_key, marked_at) VALUES (?, ?, ?)
         ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
      )
      .run(plexUserId, ratingKey, now());
    db.prepare('DELETE FROM keeps WHERE plex_user_id = ? AND rating_key = ?').run(
      plexUserId,
      ratingKey
    );
    db.prepare('DELETE FROM user_skips WHERE plex_user_id = ? AND rating_key = ?').run(
      plexUserId,
      ratingKey
    );
    return info.changes > 0;
  })();
}

/** Whether this user has marked an item "OK to delete". */
export function isMarkedForDelete(
  plexUserId: string,
  ratingKey: string
): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 FROM user_deletes WHERE plex_user_id = ? AND rating_key = ?'
    )
    .get(plexUserId, ratingKey);
  return !!row;
}

// ---------------------------------------------------------------------------
// Feed (the home keep-loop)
// ---------------------------------------------------------------------------

export interface FeedOptions {
  /**
   * Limit the feed to a single Plex library (section id). Omitted → a mix across
   * all libraries, weighted toward large series with a few movies guaranteed.
   * Libraries are whatever Plex reports — nothing is hardcoded by category.
   */
  sectionId?: string;
  /** Override the reserved movie count for the mixed (all-libraries) feed. */
  reserveMovies?: number;
  /** Restrict the feed to a watch-history slice (omit = no watch filter). */
  watchMode?: FeedWatchMode;
}

/**
 * WHERE fragment for a FeedWatchMode (against `m`), mirroring the Browse watch
 * predicates. Mutates `params` with any cutoff it needs.
 */
function feedWatchClause(
  mode: FeedWatchMode,
  params: Record<string, unknown>
): string {
  const anyWatchSince =
    'EXISTS (SELECT 1 FROM watch_history w WHERE w.rating_key = m.rating_key AND w.last_watched >= @watchCutoff)';
  switch (mode) {
    case 'never_played':
      // Never watched by ANYONE on the server.
      return 'NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.rating_key = m.rating_key)';
    case 'stale_90':
      // No watch by anyone in the last 90 days (includes never-played).
      params.watchCutoff = now() - 90 * 86400;
      return `NOT ${anyWatchSince}`;
    case 'recent_30':
      // Watched by someone within the last 30 days.
      params.watchCutoff = now() - 30 * 86400;
      return anyWatchSince;
    case 'my_unwatched':
      // THIS user hasn't watched it (others may have).
      return 'NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.rating_key = m.rating_key AND w.plex_user_id = @uid)';
  }
}

/**
 * Base eligibility: present, not globally kept, and not already decided by this
 * user (skipped "don't care" or marked "OK to delete" — both mean they're done
 * with it, so it shouldn't roll back into their feed).
 */
const FEED_ELIGIBILITY = `m.removed = 0
  AND m.rating_key NOT IN (SELECT rating_key FROM keeps)
  AND m.rating_key NOT IN (
    SELECT rating_key FROM user_skips WHERE plex_user_id = @uid
  )
  AND m.rating_key NOT IN (
    SELECT rating_key FROM user_deletes WHERE plex_user_id = @uid
  )`;

/** A SQLite expression mapping random() (int64) to a (0,1) uniform. */
const RAND_UNIT =
  '((random() + 9223372036854775808.0) / 18446744073709551615.0)';

/**
 * Feed for the home keep-loop. With a `sectionId` it returns a size-weighted
 * batch from that one Plex library; otherwise a screen-fill mix across all
 * libraries, weighted toward large series but with a guaranteed few movies.
 * ("Largest overall" is served by the route via largestItems.)
 */
export function getFeed(
  plexUserId: string,
  limit: number,
  opts: FeedOptions = {}
): MediaItem[] {
  if (opts.sectionId) {
    return weightedPull(
      plexUserId,
      { sectionId: opts.sectionId, watchMode: opts.watchMode },
      limit,
      []
    );
  }
  return getFeedAll(plexUserId, limit, opts);
}

/**
 * Pull eligible items size-weighted (Efraimidis–Spirakis), restricted either to
 * a library_kind (used to guarantee some movies in the mix) or to one Plex
 * section. library_kind is Plex's own section type, not an invented category.
 */
function weightedPull(
  plexUserId: string,
  filter: {
    libraryKind?: LibraryKind;
    sectionId?: string;
    watchMode?: FeedWatchMode;
    /** FORK: drop items this user already swiped (the swipe deck). */
    excludeMyVerdicts?: boolean;
  },
  limit: number,
  excludeKeys: string[]
): MediaItem[] {
  if (limit <= 0) return [];
  const params: Record<string, unknown> = { uid: plexUserId, limit };
  const clauses: string[] = [];
  if (filter.libraryKind) {
    clauses.push('m.library_kind = @libraryKind');
    params.libraryKind = filter.libraryKind;
  }
  if (filter.sectionId) {
    clauses.push('m.section_id = @sectionId');
    params.sectionId = filter.sectionId;
  }
  if (filter.watchMode) {
    clauses.push(feedWatchClause(filter.watchMode, params));
  }
  if (filter.excludeMyVerdicts) {
    clauses.push(
      'm.rating_key NOT IN (SELECT rating_key FROM verdicts WHERE plex_user_id = @uid)'
    );
  }
  excludeKeys.forEach((k, i) => (params[`ex${i}`] = k));
  if (excludeKeys.length) {
    clauses.push(
      `m.rating_key NOT IN (${excludeKeys.map((_, i) => `@ex${i}`).join(', ')})`
    );
  }
  const extra = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare(
      `WITH elig AS (
         SELECT m.* FROM media_items m
         WHERE ${FEED_ELIGIBILITY} ${extra}
       ),
       stats AS (SELECT AVG(size_bytes) AS avg_size FROM elig)
       SELECT e.* FROM elig e, stats s
       ORDER BY pow(
         ${RAND_UNIT},
         1.0 / MAX(CAST(e.size_bytes AS REAL) / NULLIF(s.avg_size, 0), 0.01)
       ) DESC
       LIMIT @limit`
    )
    .all(params) as MediaItem[];
}

/** Mixed feed: a few movies guaranteed, the rest big-series-weighted shows. */
function getFeedAll(
  plexUserId: string,
  limit: number,
  opts: FeedOptions
): MediaItem[] {
  const reserveMovies =
    opts.reserveMovies ??
    Math.max(FEED_MOVIE_RESERVE_MIN, Math.ceil(limit * FEED_MOVIE_RESERVE_RATIO));

  const movies = weightedPull(
    plexUserId,
    { libraryKind: 'movie', watchMode: opts.watchMode },
    Math.min(reserveMovies, limit),
    []
  );
  const shows = weightedPull(
    plexUserId,
    { libraryKind: 'show', watchMode: opts.watchMode },
    limit - movies.length,
    []
  );

  let combined = [...movies, ...shows];
  if (combined.length < limit) {
    // Shows ran short — backfill with more movies we haven't used.
    const used = combined.map((m) => m.rating_key);
    combined = combined.concat(
      weightedPull(
        plexUserId,
        { libraryKind: 'movie', watchMode: opts.watchMode },
        limit - combined.length,
        used
      )
    );
  }

  // Shuffle so the reserved movies aren't always first. Fisher–Yates.
  for (let i = combined.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }
  return combined.slice(0, limit);
}

/** How many items remain for this user to triage (not kept, not skipped). */
export function countFeedRemaining(
  plexUserId: string,
  opts: { sectionId?: string; watchMode?: FeedWatchMode } = {}
): number {
  const params: Record<string, unknown> = { uid: plexUserId };
  let extraSql = '';
  if (opts.sectionId) {
    extraSql += ' AND m.section_id = @sectionId';
    params.sectionId = opts.sectionId;
  }
  if (opts.watchMode) {
    extraSql += ` AND ${feedWatchClause(opts.watchMode, params)}`;
  }
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM media_items m
       WHERE ${FEED_ELIGIBILITY}${extraSql}`
    )
    .get(params) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Library browse / search
// ---------------------------------------------------------------------------

export type LibrarySort =
  | 'size'
  | 'title'
  | 'added'
  | 'year'
  | 'library'
  | 'quality'
  | 'tags'
  | 'status'
  | 'watched'
  // FORK (3.2): the household's weighted verdict score (see VERDICT_POINTS).
  | 'score';
export type SortDir = 'asc' | 'desc';
export type KeptFilter = 'all' | 'kept' | 'unkept';
export type SkipFilter = 'all' | 'skipped' | 'unskipped';
export type DeleteFilter = 'all' | 'deletedByMe' | 'deletedAny';
/** Combinable Browse "Status" buckets (per-user decision states), OR'd together. */
export type StateBucket =
  | 'keptByMe'
  | 'keptOther'
  | 'dontcare'
  | 'okDeleteMine'
  | 'okDeleteAny'
  | 'undecided'
  // FORK: items with a live (pending/held) scheduled-deletion tag.
  | 'scheduledDeletion';
/** Per-user "have you watched it" filter (recency windows use last_watched). */
export type WatchFilter =
  | 'all'
  | 'watched'
  | 'unwatched'
  | 'unwatchedAny'
  | 'recent30'
  | 'recent60'
  | 'recent90'
  | 'stale90';

export interface LibraryQuery {
  plexUserId: string; // required for the per-user "don't care" flag + filter
  /** Restrict to these Plex libraries (section ids). Empty/omitted = all. */
  sectionIds?: string[];
  search?: string;
  sort?: LibrarySort;
  dir?: SortDir;
  /** Legacy convenience: same as keptFilter='unkept'. */
  hideKept?: boolean;
  keptFilter?: KeptFilter;
  /** Restrict to titles THIS user personally keeps (vs `keptFilter` = anyone). */
  keptByMeOnly?: boolean;
  skipFilter?: SkipFilter;
  /**
   * "OK to delete" filter. `deletedByMe` = items THIS user marked; `deletedAny`
   * = items anyone marked (the "released by someone" view). Default 'all'.
   */
  deleteFilter?: DeleteFilter;
  /** Combinable "Status" buckets, OR'd together (empty/omitted = no filter). The
   *  Browse Status multi-select drives this; supersedes kept/skip/delete filters. */
  stateBuckets?: StateBucket[];
  /** Filter by THIS user's watch history (default 'all'). */
  watchFilter?: WatchFilter;
  /** Sonarr/Radarr filters (match arr_items). Each restricts to arr-matched rows.
   *  All are multi-value "any of"; empty/omitted = no filter. */
  sources?: string[]; // 'sonarr' | 'radarr'
  instanceIds?: string[];
  tags?: string[];
  qualities?: string[];
  statuses?: string[];
  /** Subset of ['monitored','unmonitored']; both or neither = no filter. */
  monitored?: ArrMonitored[];
  /** Whether the title exists in any connected Sonarr/Radarr. */
  matchFilter?: 'all' | 'matched' | 'unmatched';
  /** Only arr-matched titles whose Plex vs arr sizes diverge materially. */
  sizeMismatch?: boolean;
  /**
   * Restrict to these rating keys (e.g. Seerr "requested by me"). `null`/omitted
   * = no restriction; an empty array = match nothing.
   */
  requestedKeys?: string[] | null;
  /**
   * FORK (3.2): only titles the household scores at least this high — the
   * "everyone wants this gone" shortlist, in the normal grid. An item nobody has
   * an opinion on scores 0, so any threshold above 0 implies "somebody voted".
   */
  minScore?: number;
  limit: number;
  offset: number;
}

const sortColumn: Record<LibrarySort, string> = {
  size: 'm.size_bytes',
  title: 'm.title COLLATE NOCASE',
  added: 'm.added_at',
  year: 'm.year',
  library: 'm.section_id', // groups same-library rows together
  quality: 'a.quality COLLATE NOCASE',
  tags: 'a.tags COLLATE NOCASE', // raw JSON; roughly groups by first tag
  status: 'a.status COLLATE NOCASE',
  watched: '(wh.rating_key IS NOT NULL)',
  // FORK (3.2): NULL for a title nobody voted on, so ORDER BY … NULLS LAST puts
  // the un-opinionated tail after the scored rows in BOTH directions.
  score: 'vs.score',
};

/** A media row joined with its kept status. */
export interface MediaWithKeep extends MediaItem {
  kept: number; // anyone keeps it (protected)
  kept_by_me: number; // this user keeps it
}

/** A library row: kept status + this user's "don't care" + "watched" state,
 *  plus Sonarr/Radarr metadata (null when the title isn't arr-matched). */
export interface LibraryRow extends MediaWithKeep {
  skipped: number;
  watched: number; // this user has watched it (any plays)
  requested_by_me: number; // this user requested it on Seerr (gates OK-to-delete)
  marked_for_delete_by_me: number; // this user marked it "OK to delete"
  marked_for_delete_any: number; // anyone marked it "OK to delete" (no identity)
  arr_source: string | null;
  arr_instance_name: string | null;
  arr_monitored: number | null;
  arr_status: string | null;
  arr_quality: string | null;
  arr_quality_kind: string | null;
  arr_tags: string | null; // JSON array string, or null
  arr_size_bytes: number | null;
  // FORK: live scheduled-deletion tag (null when not tagged / tag not live).
  scheduled_delete_after: number | null;
  scheduled_delete_status: string | null; // 'pending' | 'held'
  /** FORK: this user's swipe verdict (null = never swiped) — the card's cycle
   *  control needs the current position, not just the derived keep/skip flags. */
  my_verdict: Verdict | null;
  /** FORK (3.2): the household's weighted score and how many people fed it.
   *  Both null when nobody has an opinion (which is not the same as a score of
   *  0 — one shrug is an opinion). */
  verdict_score: number | null;
  verdict_voters: number | null;
}

/** Arr-matched titles whose Plex vs arr size differ by >10% AND >1 GB (the
 *  "size mismatch" definition — shared by the Browse filter and the Problems
 *  page so the two can't drift). Zero-size items are EXCLUDED: 0 bytes isn't a
 *  mismatch, it's "the server sees no files" — the Zero size category's
 *  diagnosis (which shows the *arr size as context). Expects media_items
 *  aliased `m`, arr_items `a`. */
const SIZE_MISMATCH_EXPR = `a.rating_key IS NOT NULL AND a.arr_size_bytes IS NOT NULL
       AND m.size_bytes > 0
       AND ABS(m.size_bytes - a.arr_size_bytes) > 1073741824
       AND ABS(m.size_bytes - a.arr_size_bytes) > 0.1 * m.size_bytes`;

export function queryLibrary(q: LibraryQuery): LibraryRow[] {
  const where: string[] = ['m.removed = 0'];
  const params: Record<string, unknown> = {
    uid: q.plexUserId,
    limit: q.limit,
    offset: q.offset,
  };
  if (q.sectionIds && q.sectionIds.length > 0) {
    const named = q.sectionIds.map((_, i) => `@sec${i}`);
    q.sectionIds.forEach((id, i) => (params[`sec${i}`] = id));
    where.push(`m.section_id IN (${named.join(', ')})`);
  }
  if (q.search && q.search.trim()) {
    where.push('m.title LIKE @search COLLATE NOCASE');
    params.search = `%${q.search.trim()}%`;
  }

  const keptExists =
    'EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key)';
  const keptFilter: KeptFilter = q.hideKept ? 'unkept' : q.keptFilter ?? 'all';
  if (keptFilter === 'kept') where.push(keptExists);
  else if (keptFilter === 'unkept') where.push(`NOT ${keptExists}`);
  // "Kept by you" — only titles this user personally keeps (subset of kept).
  if (q.keptByMeOnly) where.push('km.rating_key IS NOT NULL');

  const skipFilter: SkipFilter = q.skipFilter ?? 'all';
  if (skipFilter === 'skipped') where.push('s.rating_key IS NOT NULL');
  else if (skipFilter === 'unskipped') where.push('s.rating_key IS NULL');

  // "OK to delete" filter. By-me uses this user's mark (the LEFT JOIN); by-anyone
  // uses an EXISTS so it stays identity-free.
  const deletedAnyExists =
    'EXISTS (SELECT 1 FROM user_deletes d WHERE d.rating_key = m.rating_key)';
  const deleteFilter: DeleteFilter = q.deleteFilter ?? 'all';
  if (deleteFilter === 'deletedByMe') where.push('ud.rating_key IS NOT NULL');
  else if (deleteFilter === 'deletedAny') where.push(deletedAnyExists);
  // "Undecided" (unkept + unskipped) means this user hasn't decided anything, so
  // also exclude their own "OK to delete" marks.
  if (keptFilter === 'unkept' && skipFilter === 'unskipped') {
    where.push('ud.rating_key IS NULL');
  }

  // Combinable "Status" buckets (the Browse Status multi-select): OR the selected
  // per-user decision states. Empty/omitted = no filter (All).
  if (q.stateBuckets && q.stateBuckets.length) {
    const cond: Record<StateBucket, string> = {
      keptByMe: 'km.rating_key IS NOT NULL',
      keptOther: `(${keptExists}) AND km.rating_key IS NULL`,
      dontcare: 's.rating_key IS NOT NULL',
      okDeleteMine: 'ud.rating_key IS NOT NULL',
      okDeleteAny: deletedAnyExists,
      // FORK: a verdict counts as a decision too. The delete-side ones
      // (done_with_it / not_interested) write no keep, skip or "OK to delete"
      // row, so without this a title you just cycled to "Let it go" would sit
      // in the default Browse view forever and never drain. Deliberately NOT
      // mirrored in librarySummary(): its three buckets have to partition the
      // library's bytes exactly, and a delete-side verdict belongs to none of
      // them.
      undecided: `NOT (${keptExists}) AND s.rating_key IS NULL AND ud.rating_key IS NULL
                  AND vv.verdict IS NULL`,
      scheduledDeletion: 'sd.rating_key IS NOT NULL',
    };
    const parts = q.stateBuckets
      .filter((b) => cond[b])
      .map((b) => `(${cond[b]})`);
    if (parts.length) where.push(`(${parts.join(' OR ')})`);
  }

  // Watch filter (this user's history). Recency uses last_watched (epoch seconds).
  const watchFilter: WatchFilter = q.watchFilter ?? 'all';
  const sinceDays = (d: number) => now() - d * 86400;
  if (watchFilter === 'watched') where.push('wh.rating_key IS NOT NULL');
  else if (watchFilter === 'unwatched') where.push('wh.rating_key IS NULL');
  else if (watchFilter === 'unwatchedAny') {
    // Never watched by ANYONE on the server (not just this user).
    where.push(
      'NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.rating_key = m.rating_key)'
    );
  } else if (watchFilter === 'recent30' || watchFilter === 'recent60' || watchFilter === 'recent90') {
    const days = watchFilter === 'recent30' ? 30 : watchFilter === 'recent60' ? 60 : 90;
    params.watchCutoff = sinceDays(days);
    where.push('wh.last_watched >= @watchCutoff');
  } else if (watchFilter === 'stale90') {
    params.watchCutoff = sinceDays(90);
    where.push('(wh.rating_key IS NULL OR wh.last_watched < @watchCutoff)');
  }

  // Sonarr/Radarr filters (reference arr_items via the LEFT JOIN below). Each is
  // multi-value "any of" and implicitly restricts to arr-matched titles. A helper
  // emits `col IN (@p0,@p1,…)` with uniquely-named params.
  const inClause = (col: string, vals: string[], prefix: string) => {
    const named = vals.map((_, i) => `@${prefix}${i}`);
    vals.forEach((v, i) => (params[`${prefix}${i}`] = v));
    where.push(`${col} IN (${named.join(', ')})`);
  };
  if (q.sources && q.sources.length) inClause('a.source', q.sources, 'src');
  if (q.instanceIds && q.instanceIds.length) inClause('a.instance_id', q.instanceIds, 'inst');
  if (q.qualities && q.qualities.length) inClause('a.quality', q.qualities, 'ql');
  if (q.statuses && q.statuses.length) inClause('a.status', q.statuses, 'st');
  if (q.matchFilter === 'matched') where.push('a.rating_key IS NOT NULL');
  else if (q.matchFilter === 'unmatched') where.push('a.rating_key IS NULL');
  if (q.sizeMismatch) where.push(SIZE_MISMATCH_EXPR);
  if (q.tags && q.tags.length) {
    const named = q.tags.map((_, i) => `@tg${i}`);
    q.tags.forEach((t, i) => (params[`tg${i}`] = t));
    where.push(
      `EXISTS (SELECT 1 FROM json_each(COALESCE(a.tags, '[]')) WHERE value IN (${named.join(', ')}))`
    );
  }
  // Monitored: filter only when exactly one of the two is chosen.
  const mon = q.monitored ?? [];
  if (mon.length === 1) where.push(`a.monitored = ${mon[0] === 'monitored' ? 1 : 0}`);

  if (q.requestedKeys != null) {
    if (q.requestedKeys.length === 0) {
      where.push('1 = 0'); // requested-by-me with nothing requested → no rows
    } else {
      const named = q.requestedKeys.map((_, i) => `@req${i}`);
      q.requestedKeys.forEach((k, i) => (params[`req${i}`] = k));
      where.push(`m.rating_key IN (${named.join(', ')})`);
    }
  }

  // FORK (3.2): "score at least N". An unvoted title counts as 0 rather than
  // being dropped outright, so a threshold of 0 or below still shows the whole
  // library — the filter only starts excluding once it asks for real support.
  if (q.minScore != null && Number.isFinite(q.minScore)) {
    where.push('COALESCE(vs.score, 0) >= @minScore');
    params.minScore = q.minScore;
  }

  const col = sortColumn[q.sort ?? 'size'];
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  // NULLs last regardless of direction; stable title tiebreak.
  const order = `${col} ${dir} NULLS LAST, m.title COLLATE NOCASE ASC`;

  return getDb()
    .prepare(
      // FORK (3.2): the vote CTEs are defined with the consensus screen further
      // down this file — Browse reads the SAME vote set (explicit swipes plus
      // the keeps / "don't care" / "OK to delete" they stand in for), so a
      // title's score can't read differently on the two screens.
      `WITH ${VOTES_CTE}, ${ITEM_SCORES_CTE}
       SELECT m.*, ${keptExists} AS kept,
              (km.rating_key IS NOT NULL) AS kept_by_me,
              (s.rating_key IS NOT NULL) AS skipped,
              (wh.rating_key IS NOT NULL) AS watched,
              (sr.rating_key IS NOT NULL) AS requested_by_me,
              (ud.rating_key IS NOT NULL) AS marked_for_delete_by_me,
              ${deletedAnyExists} AS marked_for_delete_any,
              a.source AS arr_source, a.instance_name AS arr_instance_name,
              a.monitored AS arr_monitored, a.status AS arr_status,
              a.quality AS arr_quality, a.quality_kind AS arr_quality_kind,
              a.tags AS arr_tags, a.arr_size_bytes AS arr_size_bytes,
              sd.delete_after AS scheduled_delete_after,
              sd.status AS scheduled_delete_status,
              vv.verdict AS my_verdict,
              vs.score AS verdict_score, vs.voters AS verdict_voters
       FROM media_items m
       LEFT JOIN keeps km
         ON km.rating_key = m.rating_key AND km.plex_user_id = @uid
       LEFT JOIN verdicts vv
         ON vv.rating_key = m.rating_key AND vv.plex_user_id = @uid
       LEFT JOIN user_skips s
         ON s.rating_key = m.rating_key AND s.plex_user_id = @uid
       LEFT JOIN user_deletes ud
         ON ud.rating_key = m.rating_key AND ud.plex_user_id = @uid
       LEFT JOIN seerr_requests sr
         ON sr.rating_key = m.rating_key AND sr.plex_user_id = @uid
       LEFT JOIN watch_history wh
         ON wh.rating_key = m.rating_key AND wh.plex_user_id = @uid
       LEFT JOIN arr_items a ON a.rating_key = m.rating_key
       LEFT JOIN scheduled_deletions sd
         ON sd.rating_key = m.rating_key AND sd.status IN ('pending', 'held')
       LEFT JOIN item_scores vs ON vs.rating_key = m.rating_key
       WHERE ${where.join(' AND ')}
       ORDER BY ${order}
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as LibraryRow[];
}

// ---------------------------------------------------------------------------
// Search (typeahead + results page)
// ---------------------------------------------------------------------------

export interface SearchRow extends MediaItem {
  kept: number;
  kept_by_me: number;
  skipped: number;
  watched: number;
  requested_by_me: number;
  marked_for_delete_by_me: number;
  marked_for_delete_any: number;
  score: number;
  /** FORK: this user's swipe verdict (null = never swiped) — the cycle control. */
  my_verdict: Verdict | null;
}

/**
 * Relevance search over titles, approximating the "partial match, best first,
 * live as you type" feel of Plex/Seerr (local index, no spell-check). Tiered
 * scoring: exact > prefix > word-start > substring, plus a per-token bonus.
 * Every whitespace token must appear (AND), so "lego batman" excludes a plain
 * "Batman". Returns kept + this user's "don't care" state for the UI.
 */
export function searchMedia(params: {
  query: string;
  plexUserId: string;
  limit: number;
  offset: number;
}): SearchRow[] {
  const q = params.query.trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const sqlParams: Record<string, unknown> = {
    uid: params.plexUserId,
    limit: params.limit,
    offset: params.offset,
    qExact: q,
    qPrefix: `${q}%`,
    qWord: `% ${q}%`,
    qSub: `%${q}%`,
  };

  const tokenWhere: string[] = [];
  const tokenScore: string[] = [];
  tokens.forEach((t, i) => {
    sqlParams[`tok${i}`] = `%${t}%`;
    tokenWhere.push(`m.title LIKE @tok${i} COLLATE NOCASE`);
    tokenScore.push(
      `CASE WHEN m.title LIKE @tok${i} COLLATE NOCASE THEN 10 ELSE 0 END`
    );
  });

  const score = `(
      CASE WHEN m.title = @qExact COLLATE NOCASE THEN 1000 ELSE 0 END
    + CASE WHEN m.title LIKE @qPrefix COLLATE NOCASE THEN 200 ELSE 0 END
    + CASE WHEN (' ' || m.title) LIKE @qWord COLLATE NOCASE THEN 80 ELSE 0 END
    + CASE WHEN m.title LIKE @qSub COLLATE NOCASE THEN 30 ELSE 0 END
    + ${tokenScore.join(' + ')}
  )`;

  return getDb()
    .prepare(
      `SELECT m.*,
              EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key) AS kept,
              (km.rating_key IS NOT NULL) AS kept_by_me,
              (s.rating_key IS NOT NULL) AS skipped,
              (wh.rating_key IS NOT NULL) AS watched,
              (sr.rating_key IS NOT NULL) AS requested_by_me,
              (ud.rating_key IS NOT NULL) AS marked_for_delete_by_me,
              EXISTS (SELECT 1 FROM user_deletes d WHERE d.rating_key = m.rating_key) AS marked_for_delete_any,
              vv.verdict AS my_verdict,
              ${score} AS score
       FROM media_items m
       LEFT JOIN keeps km
         ON km.rating_key = m.rating_key AND km.plex_user_id = @uid
       LEFT JOIN verdicts vv
         ON vv.rating_key = m.rating_key AND vv.plex_user_id = @uid
       LEFT JOIN user_skips s
         ON s.rating_key = m.rating_key AND s.plex_user_id = @uid
       LEFT JOIN user_deletes ud
         ON ud.rating_key = m.rating_key AND ud.plex_user_id = @uid
       LEFT JOIN seerr_requests sr
         ON sr.rating_key = m.rating_key AND sr.plex_user_id = @uid
       LEFT JOIN watch_history wh
         ON wh.rating_key = m.rating_key AND wh.plex_user_id = @uid
       WHERE m.removed = 0 AND ${tokenWhere.join(' AND ')}
       ORDER BY score DESC, m.size_bytes DESC, m.title COLLATE NOCASE ASC
       LIMIT @limit OFFSET @offset`
    )
    .all(sqlParams) as SearchRow[];
}

// ---------------------------------------------------------------------------
// Big-picture stats
// ---------------------------------------------------------------------------

/** Largest items overall (kept or not), with kept flags for this user. */
export function largestItems(
  limit: number,
  offset: number,
  plexUserId: string
): MediaWithKeep[] {
  return getDb()
    .prepare(
      `SELECT m.*,
              EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key) AS kept,
              (km.rating_key IS NOT NULL) AS kept_by_me
       FROM media_items m
       LEFT JOIN keeps km
         ON km.rating_key = m.rating_key AND km.plex_user_id = @uid
       WHERE m.removed = 0
       ORDER BY m.size_bytes DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ uid: plexUserId, limit, offset }) as MediaWithKeep[];
}

/** Reclaimable items: NOT kept by anyone, largest first. */
export function reclaimableItems(limit: number, offset: number): MediaItem[] {
  return getDb()
    .prepare(
      `SELECT m.* FROM media_items m
       WHERE m.removed = 0
         AND m.rating_key NOT IN (SELECT rating_key FROM keeps)
       ORDER BY m.size_bytes DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as MediaItem[];
}

/**
 * Largest titles NOBODY on the server has ever watched, largest first. The
 * strongest reclaim signal (Big Picture "Never watched" drill-down). Carries
 * kept flags for this user so the table can show what's protected.
 */
export function neverWatchedItems(
  limit: number,
  offset: number,
  plexUserId: string
): MediaWithKeep[] {
  return getDb()
    .prepare(
      `SELECT m.*,
              EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key) AS kept,
              (km.rating_key IS NOT NULL) AS kept_by_me
       FROM media_items m
       LEFT JOIN keeps km
         ON km.rating_key = m.rating_key AND km.plex_user_id = @uid
       WHERE m.removed = 0
         AND NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.rating_key = m.rating_key)
       ORDER BY m.size_bytes DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ uid: plexUserId, limit, offset }) as MediaWithKeep[];
}

/** One marked-for-delete title with who released it (Big Picture drill-down). */
export interface MarkedForDeleteItem {
  ratingKey: string;
  title: string;
  year: number | null;
  sectionId: string;
  libraryKind: LibraryKind;
  sizeBytes: number;
  thumb: string | null;
  /** Still protected because someone keeps it (released but not reclaimable). */
  keptByAnyone: boolean;
  /** Everyone who marked it "OK to delete" (the one place identity is shown). */
  markedBy: { plexUserId: string; username: string | null }[];
}

/**
 * Items anyone marked "OK to delete", largest first, with the markers' names
 * (Big Picture attribution). One title can be released by several requesters,
 * so markers is an array; `keptByAnyone` flags titles still protected by a keep.
 */
export function markedForDeleteItems(): MarkedForDeleteItem[] {
  const rows = getDb()
    .prepare(
      `SELECT m.rating_key, m.title, m.year, m.section_id, m.library_kind,
              m.size_bytes, m.thumb,
              EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key) AS kept,
              ud.plex_user_id AS marker_id, u.username AS marker_name
       FROM user_deletes ud
       JOIN media_items m ON m.rating_key = ud.rating_key AND m.removed = 0
       LEFT JOIN users u ON u.plex_user_id = ud.plex_user_id
       ORDER BY m.size_bytes DESC, m.title COLLATE NOCASE ASC, ud.marked_at ASC`
    )
    .all() as {
    rating_key: string;
    title: string;
    year: number | null;
    section_id: string;
    library_kind: LibraryKind;
    size_bytes: number;
    thumb: string | null;
    kept: number;
    marker_id: string;
    marker_name: string | null;
  }[];
  // Group markers per item; Map preserves the size-DESC insertion order.
  const byItem = new Map<string, MarkedForDeleteItem>();
  for (const r of rows) {
    let item = byItem.get(r.rating_key);
    if (!item) {
      item = {
        ratingKey: r.rating_key,
        title: r.title,
        year: r.year,
        sectionId: r.section_id,
        libraryKind: r.library_kind,
        sizeBytes: r.size_bytes,
        thumb: r.thumb,
        keptByAnyone: !!r.kept,
        markedBy: [],
      };
      byItem.set(r.rating_key, item);
    }
    item.markedBy.push({ plexUserId: r.marker_id, username: r.marker_name });
  }
  return [...byItem.values()];
}

/** Distinct titles + summed bytes that anyone marked "OK to delete" (the KPI). */
export function markedForDeleteSummary(): { titles: number; bytes: number } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS titles, COALESCE(SUM(m.size_bytes), 0) AS bytes
       FROM media_items m
       WHERE m.removed = 0
         AND EXISTS (SELECT 1 FROM user_deletes d WHERE d.rating_key = m.rating_key)`
    )
    .get() as { titles: number; bytes: number };
  return { titles: row.titles, bytes: row.bytes };
}

/** Total bytes that could be freed (everything not kept). */
export function reclaimableTotalBytes(): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM media_items
       WHERE removed = 0 AND rating_key NOT IN (SELECT rating_key FROM keeps)`
    )
    .get() as { total: number };
  return row.total;
}

export interface LibraryStats {
  totalItems: number;
  totalBytes: number;
  keptItems: number;
  keptBytes: number;
  reclaimableBytes: number;
}

export function libraryStats(): LibraryStats {
  const db = getDb();
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS items, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM media_items WHERE removed = 0`
    )
    .get() as { items: number; bytes: number };
  const kept = db
    .prepare(
      `SELECT COUNT(*) AS items, COALESCE(SUM(m.size_bytes), 0) AS bytes
       FROM media_items m
       WHERE m.removed = 0
         AND EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key)`
    )
    .get() as { items: number; bytes: number };
  return {
    totalItems: totals.items,
    totalBytes: totals.bytes,
    keptItems: kept.items,
    keptBytes: kept.bytes,
    reclaimableBytes: totals.bytes - kept.bytes,
  };
}

/** Distinct sections present in the synced data, with counts. */
export function sectionsWithCounts(): {
  section_id: string;
  library_kind: LibraryKind;
  n: number;
}[] {
  return getDb()
    .prepare(
      `SELECT section_id, library_kind, COUNT(*) AS n
       FROM media_items WHERE removed = 0
       GROUP BY section_id, library_kind`
    )
    .all() as { section_id: string; library_kind: LibraryKind; n: number }[];
}

/** Per-section item count + total bytes (for the library sidebar + storage). */
export function sectionSizeSummary(): {
  section_id: string;
  library_kind: LibraryKind;
  n: number;
  bytes: number;
}[] {
  return getDb()
    .prepare(
      `SELECT section_id, library_kind, COUNT(*) AS n,
              COALESCE(SUM(size_bytes), 0) AS bytes
       FROM media_items WHERE removed = 0
       GROUP BY section_id, library_kind`
    )
    .all() as {
    section_id: string;
    library_kind: LibraryKind;
    n: number;
    bytes: number;
  }[];
}

/**
 * Per-library breakdown for a given user. Every non-removed title falls into
 * exactly one of three buckets so the byte/item counts partition the total:
 *   - kept     = protected (ANYONE keeps it; safe from reclaim)
 *   - dontcare = not protected AND this user marked "don't care"
 *   - undecided= not protected AND this user hasn't decided (their triage queue)
 * `kept_by_me_*` is a sub-count of `kept_*` (how much of the protected set is
 * the caller's own keep). Reclaimable = dontcare + undecided = bytes - kept.
 * `unwatched_*` is independent: items NOBODY on the server has ever watched.
 */
export interface LibrarySummaryRow {
  section_id: string;
  items: number;
  bytes: number;
  kept_items: number;
  kept_bytes: number;
  kept_by_me_items: number;
  kept_by_me_bytes: number;
  dontcare_items: number;
  dontcare_bytes: number;
  undecided_items: number;
  undecided_bytes: number;
  unwatched_items: number;
  unwatched_bytes: number;
  // Never-watched-by-anyone bytes, split by THIS user's keep bucket (so the
  // never-watched total can be drawn with the same kept/dontcare/undecided
  // breakdown as the composition bar). These four sum to `unwatched_bytes`.
  unwatched_kept_bytes: number; // protected (anyone keeps it) + never watched
  unwatched_kept_by_me_bytes: number; // this user keeps it + never watched
  unwatched_dontcare_bytes: number;
  unwatched_undecided_bytes: number;
}

export function librarySummary(plexUserId: string): LibrarySummaryRow[] {
  const protectedExpr =
    'EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key)';
  // "Never watched by anyone" — no watch_history row for this item, any user.
  const notWatchedExpr =
    'NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.rating_key = m.rating_key)';
  return getDb()
    .prepare(
      `SELECT m.section_id,
              COUNT(*) AS items,
              COALESCE(SUM(m.size_bytes), 0) AS bytes,
              COALESCE(SUM(CASE WHEN ${protectedExpr} THEN 1 ELSE 0 END), 0) AS kept_items,
              COALESCE(SUM(CASE WHEN ${protectedExpr} THEN m.size_bytes ELSE 0 END), 0) AS kept_bytes,
              COALESCE(SUM(CASE WHEN km.rating_key IS NOT NULL THEN 1 ELSE 0 END), 0) AS kept_by_me_items,
              COALESCE(SUM(CASE WHEN km.rating_key IS NOT NULL THEN m.size_bytes ELSE 0 END), 0) AS kept_by_me_bytes,
              COALESCE(SUM(CASE WHEN NOT ${protectedExpr} AND s.rating_key IS NOT NULL THEN 1 ELSE 0 END), 0) AS dontcare_items,
              COALESCE(SUM(CASE WHEN NOT ${protectedExpr} AND s.rating_key IS NOT NULL THEN m.size_bytes ELSE 0 END), 0) AS dontcare_bytes,
              COALESCE(SUM(CASE WHEN NOT ${protectedExpr} AND s.rating_key IS NULL THEN 1 ELSE 0 END), 0) AS undecided_items,
              COALESCE(SUM(CASE WHEN NOT ${protectedExpr} AND s.rating_key IS NULL THEN m.size_bytes ELSE 0 END), 0) AS undecided_bytes,
              COALESCE(SUM(CASE WHEN ${notWatchedExpr} THEN 1 ELSE 0 END), 0) AS unwatched_items,
              COALESCE(SUM(CASE WHEN ${notWatchedExpr} THEN m.size_bytes ELSE 0 END), 0) AS unwatched_bytes,
              COALESCE(SUM(CASE WHEN ${notWatchedExpr} AND ${protectedExpr} THEN m.size_bytes ELSE 0 END), 0) AS unwatched_kept_bytes,
              COALESCE(SUM(CASE WHEN ${notWatchedExpr} AND km.rating_key IS NOT NULL THEN m.size_bytes ELSE 0 END), 0) AS unwatched_kept_by_me_bytes,
              COALESCE(SUM(CASE WHEN ${notWatchedExpr} AND NOT ${protectedExpr} AND s.rating_key IS NOT NULL THEN m.size_bytes ELSE 0 END), 0) AS unwatched_dontcare_bytes,
              COALESCE(SUM(CASE WHEN ${notWatchedExpr} AND NOT ${protectedExpr} AND s.rating_key IS NULL THEN m.size_bytes ELSE 0 END), 0) AS unwatched_undecided_bytes
       FROM media_items m
       LEFT JOIN keeps km ON km.rating_key = m.rating_key AND km.plex_user_id = @uid
       LEFT JOIN user_skips s ON s.rating_key = m.rating_key AND s.plex_user_id = @uid
       WHERE m.removed = 0
       GROUP BY m.section_id`
    )
    .all({ uid: plexUserId }) as LibrarySummaryRow[];
}

/** Total used bytes per section id (used by the storage report). */
export function usedBytesBySection(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT section_id, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM media_items WHERE removed = 0
       GROUP BY section_id`
    )
    .all() as { section_id: string; bytes: number }[];
  return new Map(rows.map((r) => [r.section_id, r.bytes]));
}

// ---------------------------------------------------------------------------
// Watch history (Tautulli sync writes these)
// ---------------------------------------------------------------------------

export function upsertWatchBatch(
  rows: {
    plexUserId: string;
    ratingKey: string;
    plays: number;
    lastWatched: number | null;
  }[]
): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO watch_history (plex_user_id, rating_key, plays, last_watched)
     VALUES (@plexUserId, @ratingKey, @plays, @lastWatched)
     ON CONFLICT(plex_user_id, rating_key) DO UPDATE SET
       plays = excluded.plays,
       last_watched = excluded.last_watched`
  );
  const run = db.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(r);
  });
  run(rows);
  return rows.length;
}

/** Rating keys the given user has watched (for the "you watched" badge). */
export function watchedRatingKeys(plexUserId: string): Set<string> {
  const rows = getDb()
    .prepare('SELECT rating_key FROM watch_history WHERE plex_user_id = ?')
    .all(plexUserId) as { rating_key: string }[];
  return new Set(rows.map((r) => r.rating_key));
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

export function getSyncStatus(): SyncStatus {
  const row = getDb()
    .prepare('SELECT * FROM sync_state WHERE id = 1')
    .get() as {
    last_run: number | null;
    last_status: string | null;
    last_message: string | null;
    items_synced: number | null;
  };
  return {
    lastRun: row.last_run,
    lastStatus: row.last_status,
    lastMessage: row.last_message,
    itemsSynced: row.items_synced,
  };
}

export function setSyncStatus(s: Partial<SyncStatus>): void {
  const cur = getSyncStatus();
  const next = { ...cur, ...s };
  getDb()
    .prepare(
      `UPDATE sync_state SET
         last_run = @lastRun,
         last_status = @lastStatus,
         last_message = @lastMessage,
         items_synced = @itemsSynced
       WHERE id = 1`
    )
    .run(next);
}

// ---------------------------------------------------------------------------
// Per-job state (scheduled refresh jobs)
// ---------------------------------------------------------------------------

const DEFAULT_JOB_STATE: Omit<JobState, 'jobId'> = {
  lastRun: null,
  lastStatus: 'never',
  lastMessage: null,
  lastDurationMs: null,
  lastResult: null,
};

function rowToJobState(jobId: string, row: {
  last_run: number | null;
  last_status: string | null;
  last_message: string | null;
  last_duration_ms: number | null;
  last_result: number | null;
} | undefined): JobState {
  if (!row) return { jobId, ...DEFAULT_JOB_STATE };
  return {
    jobId,
    lastRun: row.last_run,
    lastStatus: (row.last_status as JobState['lastStatus']) ?? 'never',
    lastMessage: row.last_message,
    lastDurationMs: row.last_duration_ms,
    lastResult: row.last_result,
  };
}

export function getJobState(jobId: string): JobState {
  const row = getDb()
    .prepare('SELECT * FROM job_state WHERE job_id = ?')
    .get(jobId) as Parameters<typeof rowToJobState>[1];
  return rowToJobState(jobId, row);
}

export function getAllJobState(): JobState[] {
  const rows = getDb().prepare('SELECT * FROM job_state').all() as {
    job_id: string;
    last_run: number | null;
    last_status: string | null;
    last_message: string | null;
    last_duration_ms: number | null;
    last_result: number | null;
  }[];
  return rows.map((r) => rowToJobState(r.job_id, r));
}

export function setJobState(jobId: string, s: Partial<Omit<JobState, 'jobId'>>): void {
  const cur = getJobState(jobId);
  const next = { ...cur, ...s, jobId };
  getDb()
    .prepare(
      `INSERT INTO job_state
         (job_id, last_run, last_status, last_message, last_duration_ms, last_result)
       VALUES (@jobId, @lastRun, @lastStatus, @lastMessage, @lastDurationMs, @lastResult)
       ON CONFLICT(job_id) DO UPDATE SET
         last_run = excluded.last_run,
         last_status = excluded.last_status,
         last_message = excluded.last_message,
         last_duration_ms = excluded.last_duration_ms,
         last_result = excluded.last_result`
    )
    .run(next);
}

export function isJobRunning(jobId: string): boolean {
  return getJobState(jobId).lastStatus === 'running';
}

/**
 * Flip any job still marked 'running' to 'error' — called once at boot. A
 * process killed mid-job leaves its persisted 'running' row behind, which
 * would otherwise gate that job out of the scheduler AND manual runs forever.
 * last_run is untouched so the schedule re-fires the job normally.
 */
export function resetInterruptedJobs(): number {
  return getDb()
    .prepare(
      `UPDATE job_state SET last_status = 'error',
         last_message = 'Interrupted by server restart'
       WHERE last_status = 'running'`
    )
    .run().changes;
}

/** Append a finished run to the activity log, pruning to the most recent 100. */
export function recordJobRun(run: {
  jobId: string;
  startedAt: number;
  endedAt: number;
  status: string;
  message: string | null;
  durationMs: number;
  result: number | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO job_runs (job_id, started_at, ended_at, status, message, duration_ms, result)
     VALUES (@jobId, @startedAt, @endedAt, @status, @message, @durationMs, @result)`
  ).run(run);
  db.prepare(
    `DELETE FROM job_runs WHERE id NOT IN (
       SELECT id FROM job_runs ORDER BY started_at DESC LIMIT 100
     )`
  ).run();
}

// ---------------------------------------------------------------------------
// App event log
// ---------------------------------------------------------------------------

/** Append a log line, pruning to the most recent 1000. */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string
): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO logs (ts, level, source, message) VALUES (?, ?, ?, ?)'
  ).run(now(), level, source, message);
  db.prepare(
    `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY ts DESC LIMIT 1000)`
  ).run();
}

/** Recent log lines, newest first; optional level + keyword filters. */
export function recentLogs(
  opts: { level?: string; limit?: number; q?: string } = {}
): LogRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.level && opts.level !== 'all') {
    where.push('level = @level');
    params.level = opts.level;
  }
  // Keyword search across message + source (SQLite LIKE is already
  // case-insensitive for ASCII).
  if (opts.q && opts.q.trim()) {
    where.push('(message LIKE @q OR source LIKE @q)');
    params.q = `%${opts.q.trim()}%`;
  }
  // id DESC tiebreaks same-second entries (ts has second resolution).
  const sql = `SELECT * FROM logs${
    where.length ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY ts DESC, id DESC LIMIT @limit`;
  return getDb().prepare(sql).all(params) as LogRow[];
}

export function clearLogs(): void {
  getDb().prepare('DELETE FROM logs').run();
}

/** Clear cached Seerr requests for everyone (rebuilt by the requests job). */
export function clearSeerrRequests(): number {
  return getDb().prepare('DELETE FROM seerr_requests').run().changes;
}

/** Clear cached watch history (rebuilt by the Tautulli job). */
export function clearWatchHistory(): number {
  return getDb().prepare('DELETE FROM watch_history').run().changes;
}

/**
 * Wipe all media + user-decision + cache data for a fresh reseed (dev seed's
 * `--reset`; children before media_items for FK order). Settings, users, logs,
 * and job_state survive. One transaction — a partial wipe would be worse than
 * none.
 */
export function resetAllData(): void {
  const db = getDb();
  db.transaction(() => {
    for (const t of [
      'seerr_requests',
      'watch_history',
      'user_skips',
      'user_deletes',
      'keeps',
      'arr_items',
      'arr_unmatched',
      'job_runs',
      'media_items',
    ]) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
  })();
}

/** Most recent job runs across all jobs (for the admin activity log). */
export function recentJobRuns(limit: number): JobRun[] {
  const rows = getDb()
    .prepare(
      `SELECT id, job_id, started_at, ended_at, status, message, duration_ms, result
       FROM job_runs ORDER BY started_at DESC LIMIT ?`
    )
    .all(limit) as {
    id: number;
    job_id: string;
    started_at: number;
    ended_at: number | null;
    status: string | null;
    message: string | null;
    duration_ms: number | null;
    result: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    message: r.message,
    durationMs: r.duration_ms,
    result: r.result,
  }));
}

// ---------------------------------------------------------------------------
// Seerr request cache (refreshed by the 'requests' job)
// ---------------------------------------------------------------------------

/** Replace this user's cached Seerr request keys atomically. */
export function replaceSeerrRequests(
  plexUserId: string,
  ratingKeys: string[]
): void {
  const db = getDb();
  const del = db.prepare('DELETE FROM seerr_requests WHERE plex_user_id = ?');
  const ins = db.prepare(
    `INSERT INTO seerr_requests (plex_user_id, rating_key) VALUES (?, ?)
     ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
  );
  db.transaction(() => {
    del.run(plexUserId);
    for (const rk of ratingKeys) ins.run(plexUserId, rk);
  })();
}

/** Cached Seerr request rating keys for a user. */
export function seerrRequestKeys(plexUserId: string): string[] {
  const rows = getDb()
    .prepare('SELECT rating_key FROM seerr_requests WHERE plex_user_id = ?')
    .all(plexUserId) as { rating_key: string }[];
  return rows.map((r) => r.rating_key);
}

// ---------------------------------------------------------------------------
// Sonarr / Radarr cache (refreshed by the 'arr' job) — backs the Quality view
// ---------------------------------------------------------------------------

export interface ArrItemInput {
  ratingKey: string;
  source: 'sonarr' | 'radarr';
  instanceId: string;
  instanceName: string;
  arrId: number | null;
  monitored: boolean;
  status: string | null;
  quality: string | null;
  qualityKind: 'file' | 'profile';
  rootFolder: string | null;
  arrSizeBytes: number;
  tags: string[];
  /** Basename of the title's own *arr folder (disk-orphan known-name set).
   *  Optional for back-compat. */
  folderName?: string | null;
  /** FORK: the *arr's own URL slug ("open it in Sonarr/Radarr"). */
  titleSlug?: string | null;
}

/** Replace the arr_items cache atomically (small dataset; avoids stale).
 *  `preserveInstanceIds` keeps rows belonging to instances that failed this
 *  run (their fresh data is missing from `rows`, not gone from the arr). */
export function replaceArrItems(
  rows: ArrItemInput[],
  preserveInstanceIds: string[] = []
): number {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO arr_items
       (rating_key, source, instance_id, instance_name, arr_id, monitored, status,
        quality, quality_kind, root_folder, arr_size_bytes, tags, folder_name,
        title_slug, last_synced)
     VALUES (@rating_key, @source, @instance_id, @instance_name, @arr_id, @monitored,
        @status, @quality, @quality_kind, @root_folder, @arr_size_bytes, @tags,
        @folder_name, @title_slug, @ts)
     ON CONFLICT(rating_key) DO UPDATE SET
       source=excluded.source, instance_id=excluded.instance_id,
       instance_name=excluded.instance_name, arr_id=excluded.arr_id,
       monitored=excluded.monitored, status=excluded.status, quality=excluded.quality,
       quality_kind=excluded.quality_kind, root_folder=excluded.root_folder,
       arr_size_bytes=excluded.arr_size_bytes, tags=excluded.tags,
       folder_name=excluded.folder_name, title_slug=excluded.title_slug,
       last_synced=excluded.last_synced`
  );
  const del = preserveInstanceIds.length
    ? db.prepare(
        `DELETE FROM arr_items WHERE instance_id NOT IN (${preserveInstanceIds
          .map(() => '?')
          .join(',')})`
      )
    : db.prepare('DELETE FROM arr_items');
  const ts = now();
  db.transaction(() => {
    del.run(...preserveInstanceIds);
    for (const r of rows) {
      ins.run({
        rating_key: r.ratingKey,
        source: r.source,
        instance_id: r.instanceId,
        instance_name: r.instanceName,
        arr_id: r.arrId,
        monitored: r.monitored ? 1 : 0,
        status: r.status,
        quality: r.quality,
        quality_kind: r.qualityKind,
        root_folder: r.rootFolder,
        arr_size_bytes: r.arrSizeBytes,
        tags: JSON.stringify(r.tags ?? []),
        folder_name: r.folderName ?? null,
        title_slug: r.titleSlug ?? null,
        ts,
      });
    }
  })();
  return rows.length;
}

/** Clear the Sonarr/Radarr cache (rebuilt by the 'arr' job). */
export function clearArrItems(): number {
  return getDb().prepare('DELETE FROM arr_items').run().changes;
}

/** Rating keys of non-removed media items by external id (for arr matching). The
 *  stored guid may be a CSV ("376459,407505") when Plex lists several ids for one
 *  item — split it so a Sonarr/Radarr id matching ANY of them resolves. `tvdb` is
 *  scoped to shows, `tmdb` to movies; `imdb` spans both (ids are globally unique). */
export function ratingKeysByGuid(kind: 'tvdb' | 'tmdb' | 'imdb'): Map<string, string> {
  const col = kind === 'tvdb' ? 'guid_tvdb' : kind === 'tmdb' ? 'guid_tmdb' : 'guid_imdb';
  const kindFilter =
    kind === 'tvdb' ? 'show' : kind === 'tmdb' ? 'movie' : null; // imdb: any kind
  const where = kindFilter
    ? `removed = 0 AND library_kind = @kind AND ${col} IS NOT NULL`
    : `removed = 0 AND ${col} IS NOT NULL`;
  const rows = getDb()
    .prepare(`SELECT rating_key, ${col} AS guid FROM media_items WHERE ${where}`)
    .all(kindFilter ? { kind: kindFilter } : {}) as {
    rating_key: string;
    guid: string;
  }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    for (const id of String(r.guid).split(',')) {
      const t = id.trim();
      if (t && !map.has(t)) map.set(t, r.rating_key); // first item to claim an id wins
    }
  }
  return map;
}

/** Sonarr/Radarr "monitored" filter (reused by queryLibrary's arr filters). */
export type ArrMonitored = 'all' | 'monitored' | 'unmonitored';

/** Distinct filter values for the Browse arr filter dropdowns. */
export function arrFacets(): {
  instances: { id: string; name: string; source: string }[];
  tags: string[];
  qualities: string[];
  statuses: string[];
} {
  const db = getDb();
  const instances = db
    .prepare(
      `SELECT DISTINCT instance_id AS id, instance_name AS name, source
       FROM arr_items ORDER BY source, name`
    )
    .all() as { id: string; name: string; source: string }[];
  const tags = (
    db
      .prepare(
        `SELECT DISTINCT value AS tag FROM arr_items,
           json_each(COALESCE(arr_items.tags, '[]'))
         ORDER BY value COLLATE NOCASE`
      )
      .all() as { tag: string }[]
  ).map((r) => r.tag);
  const qualities = (
    db
      .prepare(
        `SELECT DISTINCT quality FROM arr_items
         WHERE quality IS NOT NULL AND quality <> '' ORDER BY quality`
      )
      .all() as { quality: string }[]
  ).map((r) => r.quality);
  const statuses = (
    db
      .prepare(
        `SELECT DISTINCT status FROM arr_items
         WHERE status IS NOT NULL AND status <> '' ORDER BY status`
      )
      .all() as { status: string }[]
  ).map((r) => r.status);
  return { instances, tags, qualities, statuses };
}

// --- Match health (Sonarr/Radarr titles with no Plex match) ---

export interface ArrUnmatchedInput {
  source: string;
  instanceId: string;
  instanceName: string;
  title: string;
  extKind: 'tvdb' | 'tmdb';
  extId: string;
  /** On-disk size in *arr (0 when not downloaded). */
  sizeBytes: number;
  /** sizeOnDisk > 0 in the *arr. Fileless (wanted-but-not-downloaded) titles
   *  are recorded too — they feed the identity-mismatch check — but the
   *  "downloaded, not in server" surfaces only count downloaded ones.
   *  Optional for back-compat (defaults to true). */
  downloaded?: boolean;
  /** Basename of the title's own *arr folder (disk-orphan known-name set).
   *  Optional for back-compat. */
  folderName?: string | null;
  /** FULL folder path as the *arr sees it (Problems page Location cell). */
  path?: string | null;
  /** FORK: series/movie id — what lets the Problems page act on the record
   *  (rescan it, or remove one whose folder isn't there). */
  arrId?: number | null;
  /** FORK: the *arr's own URL slug ("open it in Sonarr/Radarr"). */
  titleSlug?: string | null;
}
export interface ArrUnmatchedRow extends ArrUnmatchedInput {
  arrId: number | null;
  titleSlug: string | null;
  lastSynced: number;
  /** Disk reality check (arr + diskScan jobs): null = not verified yet,
   *  false = folder not found under any mapped root, true = found. */
  onDisk: boolean | null;
  /** Measured (walked) size when found — not the *arr's claim. */
  diskSizeBytes: number | null;
}

/** Replace the unmatched-arr list atomically (rebuilt by the 'arr' job).
 *  `preserveInstanceIds` keeps rows of instances that failed this run. */
export function replaceArrUnmatched(
  rows: ArrUnmatchedInput[],
  preserveInstanceIds: string[] = []
): number {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO arr_unmatched (source, instance_id, instance_name, title, ext_kind, ext_id, size_bytes, folder_name, path, downloaded, arr_id, title_slug, last_synced)
     VALUES (@source, @instanceId, @instanceName, @title, @extKind, @extId, @sizeBytes, @folderName, @path, @downloaded, @arrId, @titleSlug, @ts)`
  );
  const del = preserveInstanceIds.length
    ? db.prepare(
        `DELETE FROM arr_unmatched WHERE instance_id NOT IN (${preserveInstanceIds
          .map(() => '?')
          .join(',')})`
      )
    : db.prepare('DELETE FROM arr_unmatched');
  const ts = now();
  db.transaction(() => {
    del.run(...preserveInstanceIds);
    for (const r of rows)
      ins.run({
        ...r,
        folderName: r.folderName ?? null,
        path: r.path ?? null,
        downloaded: r.downloaded === false ? 0 : 1,
        arrId: r.arrId ?? null,
        titleSlug: r.titleSlug ?? null,
        ts,
      });
  })();
  return rows.length;
}

/** Persist the disk reality-check results for unmatched *arr titles (keyed by
 *  instance + external id; one transaction). Written by verifyArrUnmatchedOnDisk. */
export function updateArrUnmatchedDisk(
  rows: {
    instanceId: string;
    extKind: 'tvdb' | 'tmdb';
    extId: string;
    onDisk: boolean;
    diskSizeBytes: number | null;
  }[]
): void {
  const db = getDb();
  const upd = db.prepare(
    `UPDATE arr_unmatched SET on_disk = @onDisk, disk_size_bytes = @diskSizeBytes
     WHERE instance_id = @instanceId AND ext_kind = @extKind AND ext_id = @extId`
  );
  db.transaction(() => {
    for (const r of rows) {
      upd.run({ ...r, onDisk: r.onDisk ? 1 : 0, diskSizeBytes: r.diskSizeBytes });
    }
  })();
}

export function clearArrUnmatched(): number {
  return getDb().prepare('DELETE FROM arr_unmatched').run().changes;
}

/** FORK: drop ONE unmatched row (its *arr record was just removed). The next
 *  arr sync would rebuild the table anyway — this is so the Problems list stops
 *  showing a title that no longer exists in Sonarr/Radarr. */
export function deleteArrUnmatchedRow(
  instanceId: string,
  extKind: string,
  extId: string
): number {
  return getDb()
    .prepare(
      `DELETE FROM arr_unmatched
        WHERE instance_id = @instanceId AND ext_kind = @extKind AND ext_id = @extId`
    )
    .run({ instanceId, extKind, extId }).changes;
}

/** Unmatched titles, largest first (so the biggest orphaned downloads lead).
 *  Default = downloaded only (media on disk the server can't see — the Match
 *  health / "In *arr, not in server" semantics); pass false to include the
 *  fileless rows too. */
export function getArrUnmatched(downloadedOnly = true): ArrUnmatchedRow[] {
  const rows = getDb()
    .prepare(
      `SELECT source, instance_id, instance_name, title, ext_kind, ext_id, size_bytes, folder_name, path, downloaded, on_disk, disk_size_bytes, arr_id, title_slug, last_synced
       FROM arr_unmatched ${downloadedOnly ? 'WHERE downloaded = 1' : ''}
       ORDER BY size_bytes DESC, title COLLATE NOCASE`
    )
    .all() as {
    source: string;
    instance_id: string;
    instance_name: string;
    title: string;
    ext_kind: 'tvdb' | 'tmdb';
    ext_id: string;
    size_bytes: number;
    folder_name: string | null;
    path: string | null;
    downloaded: number;
    on_disk: number | null;
    disk_size_bytes: number | null;
    arr_id: number | null;
    title_slug: string | null;
    last_synced: number;
  }[];
  return rows.map((r) => ({
    source: r.source,
    instanceId: r.instance_id,
    instanceName: r.instance_name,
    title: r.title,
    extKind: r.ext_kind,
    extId: r.ext_id,
    sizeBytes: r.size_bytes,
    folderName: r.folder_name,
    path: r.path,
    downloaded: !!r.downloaded,
    onDisk: r.on_disk == null ? null : !!r.on_disk,
    diskSizeBytes: r.disk_size_bytes,
    arrId: r.arr_id,
    titleSlug: r.title_slug,
    lastSynced: r.last_synced,
  }));
}

/**
 * FORK: everything needed to act on a title in its *arr — which instance owns
 * it, its id there, and its slug for a link. Keyed by rating_key (the Problems
 * page's media-item rows); titles with no *arr match simply don't come back,
 * which is how the caller reports "3 of 5 could be rescanned".
 */
export interface ArrActionTarget {
  ratingKey: string;
  title: string;
  source: string;
  instanceId: string;
  instanceName: string;
  arrId: number | null;
  titleSlug: string | null;
}
export function arrActionTargets(ratingKeys: string[]): ArrActionTarget[] {
  if (ratingKeys.length === 0) return [];
  const marks = ratingKeys.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT a.rating_key, m.title, a.source, a.instance_id, a.instance_name,
              a.arr_id, a.title_slug
         FROM arr_items a
         JOIN media_items m ON m.rating_key = a.rating_key
        WHERE a.rating_key IN (${marks})`
    )
    .all(...ratingKeys) as {
    rating_key: string;
    title: string;
    source: string;
    instance_id: string;
    instance_name: string;
    arr_id: number | null;
    title_slug: string | null;
  }[];
  return rows.map((r) => ({
    ratingKey: r.rating_key,
    title: r.title,
    source: r.source,
    instanceId: r.instance_id,
    instanceName: r.instance_name,
    arrId: r.arr_id,
    titleSlug: r.title_slug,
  }));
}

// --- Cross-instance *arr conflicts (two instances claiming one item) ---

export interface ArrConflictInput {
  ratingKey: string;
  /** Losing record's title. */
  title: string;
  /** The winner — the instance whose record was kept in arr_items. */
  firstSource: string;
  firstInstanceId: string;
  firstInstanceName: string;
  /** The loser — the instance whose record was dropped (owns this row). */
  source: string;
  instanceId: string;
  instanceName: string;
  /** Loser's sizeOnDisk. */
  sizeOnDisk: number;
}

/** Replace the conflict list atomically (rebuilt by the 'arr' job).
 *  `preserveInstanceIds` keeps rows of instances that failed this run. */
export function replaceArrConflicts(
  rows: ArrConflictInput[],
  preserveInstanceIds: string[] = []
): number {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO arr_conflicts (rating_key, title, first_source, first_instance_id, first_instance_name,
                                source, instance_id, instance_name, size_on_disk, last_synced)
     VALUES (@ratingKey, @title, @firstSource, @firstInstanceId, @firstInstanceName,
             @source, @instanceId, @instanceName, @sizeOnDisk, @ts)`
  );
  const del = preserveInstanceIds.length
    ? db.prepare(
        `DELETE FROM arr_conflicts WHERE instance_id NOT IN (${preserveInstanceIds
          .map(() => '?')
          .join(',')})`
      )
    : db.prepare('DELETE FROM arr_conflicts');
  const ts = now();
  db.transaction(() => {
    del.run(...preserveInstanceIds);
    for (const r of rows) ins.run({ ...r, ts });
  })();
  return rows.length;
}

export interface ArrConflictRow {
  ratingKey: string;
  title: string;
  /** Poster path from media_items (the item IS in the media server). */
  thumb: string | null;
  winner: { source: string; instanceId: string; instanceName: string };
  loser: { source: string; instanceId: string; instanceName: string };
  /** Both claims from ONE instance = two *arr titles resolve to one media item
   *  (usually a merged multi-part entry on the server), not an instance overlap. */
  sameInstance: boolean;
  sizeOnDisk: number;
  lastSynced: number;
}

/** Conflicts, biggest loser-side download first (the route paginates). */
export function getArrConflicts(): ArrConflictRow[] {
  const rows = getDb()
    .prepare(
      `SELECT c.rating_key, c.title, m.thumb,
              c.first_source, c.first_instance_id, c.first_instance_name,
              c.source, c.instance_id, c.instance_name, c.size_on_disk, c.last_synced
       FROM arr_conflicts c
       LEFT JOIN media_items m ON m.rating_key = c.rating_key
       ORDER BY c.size_on_disk DESC, c.title COLLATE NOCASE`
    )
    .all() as {
    rating_key: string;
    title: string;
    thumb: string | null;
    first_source: string;
    first_instance_id: string;
    first_instance_name: string;
    source: string;
    instance_id: string;
    instance_name: string;
    size_on_disk: number;
    last_synced: number;
  }[];
  return rows.map((r) => ({
    ratingKey: r.rating_key,
    title: r.title,
    thumb: r.thumb,
    winner: {
      source: r.first_source,
      instanceId: r.first_instance_id,
      instanceName: r.first_instance_name,
    },
    loser: { source: r.source, instanceId: r.instance_id, instanceName: r.instance_name },
    sameInstance: r.first_instance_id === r.instance_id,
    sizeOnDisk: r.size_on_disk,
    lastSynced: r.last_synced,
  }));
}

export function arrConflictsSummary(): { titles: number; bytes: number } {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS titles, COALESCE(SUM(size_on_disk), 0) AS bytes FROM arr_conflicts`
    )
    .get() as { titles: number; bytes: number };
}

/** Managed, non-removed Plex items with no external id (so they can never match
 *  Sonarr/Radarr): counts per kind + a small sample of titles. */
export function mediaMissingExternalIds(): {
  shows: number;
  movies: number;
  sample: { title: string; kind: string }[];
} {
  const db = getDb();
  // An item can match if it has its kind's id OR an imdb id — so "no id" means
  // BOTH are null (truly unmatchable by Sonarr/Radarr).
  const count = (kind: 'show' | 'movie', col: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM media_items
           WHERE removed = 0 AND library_kind = @kind
             AND ${col} IS NULL AND guid_imdb IS NULL`
        )
        .get({ kind }) as { n: number }
    ).n;
  const sample = db
    .prepare(
      `SELECT title, library_kind AS kind FROM media_items
       WHERE removed = 0 AND guid_imdb IS NULL AND (
         (library_kind = 'show' AND guid_tvdb IS NULL) OR
         (library_kind = 'movie' AND guid_tmdb IS NULL))
       ORDER BY size_bytes DESC LIMIT 20`
    )
    .all() as { title: string; kind: string }[];
  return { shows: count('show', 'guid_tvdb'), movies: count('movie', 'guid_tmdb'), sample };
}

/** Count of arr-matched titles (rows in arr_items). */
export function arrMatchedCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM arr_items').get() as { n: number }).n;
}

// --- Reclaim-by-quality breakdown (Big Picture) ---

export interface QualitySummaryRow {
  quality: string;
  titles: number;
  bytes: number;
  reclaimableBytes: number; // not kept by anyone
  unwatchedBytes: number; // never watched by anyone
}

const notKeptExpr =
  'NOT EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key)';
const notWatchedAnyExpr =
  'NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.rating_key = m.rating_key)';

/** Per-quality aggregate over arr-matched, non-removed media. */
export function arrQualitySummary(): QualitySummaryRow[] {
  return getDb()
    .prepare(
      `SELECT COALESCE(a.quality, 'Unknown') AS quality,
              COUNT(*) AS titles,
              COALESCE(SUM(m.size_bytes), 0) AS bytes,
              COALESCE(SUM(CASE WHEN ${notKeptExpr} THEN m.size_bytes ELSE 0 END), 0) AS reclaimableBytes,
              COALESCE(SUM(CASE WHEN ${notWatchedAnyExpr} THEN m.size_bytes ELSE 0 END), 0) AS unwatchedBytes
       FROM arr_items a
       JOIN media_items m ON m.rating_key = a.rating_key AND m.removed = 0
       GROUP BY COALESCE(a.quality, 'Unknown')`
    )
    .all() as QualitySummaryRow[];
}

/** Single aggregate for non-removed media with NO arr match ("Not in *arr").
 *  `excludeMissingIds` mirrors notInArrItems' filter (the Problems pill counts
 *  the DEFAULT view); Big Picture calls without it (its table spans everything). */
export function unmatchedMediaSummary(
  excludeMissingIds = false
): Omit<QualitySummaryRow, 'quality'> {
  const missingIdFilter = excludeMissingIds ? ` AND NOT (${MISSING_ID_EXPR})` : '';
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS titles,
              COALESCE(SUM(m.size_bytes), 0) AS bytes,
              COALESCE(SUM(CASE WHEN ${notKeptExpr} THEN m.size_bytes ELSE 0 END), 0) AS reclaimableBytes,
              COALESCE(SUM(CASE WHEN ${notWatchedAnyExpr} THEN m.size_bytes ELSE 0 END), 0) AS unwatchedBytes
       FROM media_items m
       WHERE m.removed = 0
         AND NOT EXISTS (SELECT 1 FROM arr_items a WHERE a.rating_key = m.rating_key)${missingIdFilter}`
    )
    .get() as Omit<QualitySummaryRow, 'quality'>;
}

/** Map of existing (non-removed) show rating_key → current size_bytes. */
export function existingShowSizes(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT rating_key, size_bytes FROM media_items
       WHERE removed = 0 AND library_kind = 'show'`
    )
    .all() as { rating_key: string; size_bytes: number }[];
  return new Map(rows.map((r) => [r.rating_key, r.size_bytes]));
}

/** Rating keys of all non-removed shows (for the size-recompute job). */
export function showRatingKeys(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT rating_key FROM media_items WHERE removed = 0 AND library_kind = 'show'`
    )
    .all() as { rating_key: string }[];
  return rows.map((r) => r.rating_key);
}

/** Update a single item's size on disk (used by the size-recompute job).
 *  `dirPath`/`dirNames` (derived from episode paths) also refresh the on-disk
 *  folder fields when present — the backfill for servers that omit a show's
 *  Location from listings. `dirNames` covers multi-folder shows and is stored
 *  newline-joined. Null/empty leaves the stored values untouched. */
export function updateItemSize(
  ratingKey: string,
  sizeBytes: number,
  dirPath?: string | null,
  dirNames?: string[]
): void {
  getDb()
    .prepare(
      `UPDATE media_items SET
         size_bytes = @sizeBytes,
         dir_path   = COALESCE(@dirPath, dir_path),
         dir_name   = COALESCE(@dirName, dir_name)
       WHERE rating_key = @ratingKey`
    )
    .run({
      ratingKey,
      sizeBytes,
      dirPath: dirPath ?? null,
      dirName: dirNames?.length ? dirNames.join('\n') : lastSegment(dirPath ?? null),
    });
}

// ---------------------------------------------------------------------------
// Problems page (admin) — per-category detectors. Categories overlap
// deliberately (e.g. a zero-size item with >1 GB in *arr also passes the size
// mismatch check); never sum them into a grand total.
// ---------------------------------------------------------------------------

/** View options for the paged problem lists: sort key (per-category
 *  allow-list; unknown → default), direction, and library/kind filters. */
export interface ProblemListOpts {
  sort?: string;
  dir?: 'asc' | 'desc';
  sectionIds?: string[];
  kind?: LibraryKind;
}

/** ORDER BY from a per-category allow-list — user input NEVER lands in SQL
 *  directly. Untitled dir defaults: asc for name-ish keys, desc otherwise. */
function problemOrder(
  allow: Record<string, string>,
  def: string,
  opts: ProblemListOpts | undefined,
  tiebreak: string
): string {
  const key = opts?.sort && allow[opts.sort] ? opts.sort : def;
  const dir =
    opts?.dir ?? (key === 'title' || key === 'name' ? 'asc' : 'desc');
  return `${allow[key]} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, ${tiebreak}`;
}

/** Section/kind WHERE additions (named params added to `params`). `pre` is the
 *  media_items alias prefix ('m.' or ''). */
function problemFilterSql(
  opts: ProblemListOpts | undefined,
  params: Record<string, unknown>,
  pre = ''
): string {
  if (!opts) return '';
  let sql = '';
  if (opts.sectionIds?.length) {
    const named = opts.sectionIds.map((_, i) => `@fsec${i}`);
    opts.sectionIds.forEach((v, i) => (params[`fsec${i}`] = v));
    sql += ` AND ${pre}section_id IN (${named.join(', ')})`;
  }
  if (opts.kind) {
    params.fkind = opts.kind;
    sql += ` AND ${pre}library_kind = @fkind`;
  }
  return sql;
}

/** One arr-matched title whose Plex vs *arr sizes diverge (per SIZE_MISMATCH_EXPR). */
export interface SizeMismatchItem {
  ratingKey: string;
  title: string;
  year: number | null;
  libraryKind: LibraryKind;
  sectionId: string;
  thumb: string | null;
  dirPath: string | null;
  plexBytes: number;
  arrBytes: number;
  /** Signed: plex − arr (positive = Plex sees more than *arr). */
  deltaBytes: number;
  source: string;
  instanceName: string;
  /** The tiebreaker: MEASURED size on disk (diskScan walks the folder).
   *  Null until the Disk scan job has measured it. */
  diskSizeBytes: number | null;
  diskCheckedAt: number | null;
  /** Movie: distinct video files merged into the item (>1 = multi-part — the
   *  server sums them all, so exceeding the *arr's single file is expected).
   *  Null for shows / until a library scan captures it. */
  fileCount: number | null;
}

const SIZE_MISMATCH_SORT: Record<string, string> = {
  delta: 'ABS(m.size_bytes - a.arr_size_bytes)',
  title: 'm.title COLLATE NOCASE',
  size: 'm.size_bytes',
  arrSize: 'a.arr_size_bytes',
};

/** Size mismatches, biggest divergence first (sort/filter via opts). */
export function sizeMismatchItems(
  limit: number,
  offset: number,
  opts?: ProblemListOpts
): SizeMismatchItem[] {
  const params: Record<string, unknown> = { limit, offset };
  const rows = getDb()
    .prepare(
      `SELECT m.rating_key, m.title, m.year, m.library_kind, m.section_id, m.thumb,
              m.dir_path, m.size_bytes, m.disk_size_bytes, m.disk_checked_at,
              m.file_count, a.arr_size_bytes, a.source, a.instance_name
       FROM media_items m
       JOIN arr_items a ON a.rating_key = m.rating_key
       WHERE m.removed = 0 AND ${SIZE_MISMATCH_EXPR}${problemFilterSql(opts, params, 'm.')}
       ORDER BY ${problemOrder(SIZE_MISMATCH_SORT, 'delta', opts, 'm.title COLLATE NOCASE ASC')}
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as {
    rating_key: string;
    title: string;
    year: number | null;
    library_kind: LibraryKind;
    section_id: string;
    thumb: string | null;
    dir_path: string | null;
    size_bytes: number;
    disk_size_bytes: number | null;
    disk_checked_at: number | null;
    file_count: number | null;
    arr_size_bytes: number;
    source: string;
    instance_name: string;
  }[];
  return rows.map((r) => ({
    ratingKey: r.rating_key,
    title: r.title,
    year: r.year,
    libraryKind: r.library_kind,
    sectionId: r.section_id,
    thumb: r.thumb,
    dirPath: r.dir_path,
    plexBytes: r.size_bytes,
    arrBytes: r.arr_size_bytes,
    deltaBytes: r.size_bytes - r.arr_size_bytes,
    source: r.source,
    instanceName: r.instance_name,
    diskSizeBytes: r.disk_size_bytes,
    diskCheckedAt: r.disk_checked_at,
    fileCount: r.file_count,
  }));
}

/** The current size-mismatch rows' disk-lookup keys (for the diskScan measure
 *  pass): every folder name the title spans + the loose-file name, per section. */
export function sizeMismatchDiskTargets(): {
  ratingKey: string;
  sectionId: string;
  dirNames: string[];
  fileName: string | null;
}[] {
  const rows = getDb()
    .prepare(
      `SELECT m.rating_key, m.section_id, m.dir_name, m.file_name
       FROM media_items m
       JOIN arr_items a ON a.rating_key = m.rating_key
       WHERE m.removed = 0 AND ${SIZE_MISMATCH_EXPR}`
    )
    .all() as {
    rating_key: string;
    section_id: string;
    dir_name: string | null;
    file_name: string | null;
  }[];
  return rows.map((r) => ({
    ratingKey: r.rating_key,
    sectionId: r.section_id,
    dirNames: r.dir_name ? r.dir_name.split('\n').filter(Boolean) : [],
    fileName: r.file_name,
  }));
}

/** Persist a measured on-disk size for one item (null = couldn't locate it). */
export function updateItemDiskCheck(
  ratingKey: string,
  diskSizeBytes: number | null,
  checkedAt: number = now()
): void {
  getDb()
    .prepare(
      `UPDATE media_items SET disk_size_bytes = ?, disk_checked_at = ? WHERE rating_key = ?`
    )
    .run(diskSizeBytes, checkedAt, ratingKey);
}

/** Count + summed |Plex − arr| delta over all size mismatches. */
export function sizeMismatchSummary(): { titles: number; bytes: number } {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS titles,
              COALESCE(SUM(ABS(m.size_bytes - a.arr_size_bytes)), 0) AS bytes
       FROM media_items m
       JOIN arr_items a ON a.rating_key = m.rating_key
       WHERE m.removed = 0 AND ${SIZE_MISMATCH_EXPR}`
    )
    .get() as { titles: number; bytes: number };
}

/** One title in the media server that no Sonarr/Radarr instance matched. */
export interface NotInArrItem {
  ratingKey: string;
  title: string;
  year: number | null;
  libraryKind: LibraryKind;
  sectionId: string;
  thumb: string | null;
  dirPath: string | null;
  sizeBytes: number;
  addedAt: number | null;
}

/** Non-removed items with no arr match, largest first.
 *  `excludeMissingIds` drops items with no external id at all — they can NEVER
 *  match *arr, so they'd flood this view (they have their own Missing IDs
 *  category). (Aggregate counterpart: unmatchedMediaSummary().) */
const NOT_IN_ARR_SORT: Record<string, string> = {
  size: 'm.size_bytes',
  title: 'm.title COLLATE NOCASE',
  added: 'm.added_at',
};

export function notInArrItems(
  limit: number,
  offset: number,
  excludeMissingIds = false,
  opts?: ProblemListOpts
): NotInArrItem[] {
  const missingIdFilter = excludeMissingIds ? ` AND NOT (${MISSING_ID_EXPR})` : '';
  const params: Record<string, unknown> = { limit, offset };
  const rows = getDb()
    .prepare(
      `SELECT rating_key, title, year, library_kind, section_id, thumb, dir_path, size_bytes, added_at
       FROM media_items m
       WHERE m.removed = 0
         AND NOT EXISTS (SELECT 1 FROM arr_items a WHERE a.rating_key = m.rating_key)${missingIdFilter}${problemFilterSql(opts, params, 'm.')}
       ORDER BY ${problemOrder(NOT_IN_ARR_SORT, 'size', opts, 'm.title COLLATE NOCASE ASC')}
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as {
    rating_key: string;
    title: string;
    year: number | null;
    library_kind: LibraryKind;
    section_id: string;
    thumb: string | null;
    dir_path: string | null;
    size_bytes: number;
    added_at: number | null;
  }[];
  return rows.map((r) => ({
    ratingKey: r.rating_key,
    title: r.title,
    year: r.year,
    libraryKind: r.library_kind,
    sectionId: r.section_id,
    thumb: r.thumb,
    dirPath: r.dir_path,
    sizeBytes: r.size_bytes,
    addedAt: r.added_at,
  }));
}

/** Count + bytes of DOWNLOADED arr_unmatched rows without loading them
 *  (Problems summary — fileless rows aren't "media the server can't see"). */
export function arrUnmatchedSummary(): { titles: number; bytes: number } {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS titles, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM arr_unmatched WHERE downloaded = 1`
    )
    .get() as { titles: number; bytes: number };
}

export interface DuplicateMember {
  ratingKey: string;
  title: string;
  year: number | null;
  libraryKind: LibraryKind;
  sectionId: string;
  thumb: string | null;
  /** Where this copy lives — the whole point of the duplicates comparison. */
  dirPath: string | null;
  sizeBytes: number;
  addedAt: number | null;
}

/** Two+ non-removed items sharing one external id. */
export interface DuplicateGroup {
  idKind: 'tvdb' | 'tmdb' | 'imdb';
  idValue: string;
  totalBytes: number;
  /** Size DESC within the group. */
  items: DuplicateMember[];
}

interface DuplicateScanRow {
  rating_key: string;
  title: string;
  year: number | null;
  library_kind: LibraryKind;
  section_id: string;
  thumb: string | null;
  dir_path: string | null;
  size_bytes: number;
  added_at: number | null;
  guid_tvdb: string | null;
  guid_tmdb: string | null;
  guid_imdb: string | null;
}

/**
 * Groups of non-removed items sharing an external id — the same title imported
 * into two libraries, or one entry Plex should have merged. CSV guid values are
 * split like ratingKeysByGuid (an item can carry several ids of a kind); the
 * kind-scoped axes run first so a pair sharing tmdb AND imdb is reported once,
 * labeled by its primary id. An item whose ids pair it with two DIFFERENT
 * partners legitimately appears in two groups. Ordered by totalBytes DESC.
 */
export function duplicateGroups(): DuplicateGroup[] {
  const rows = getDb()
    .prepare(
      `SELECT rating_key, title, year, library_kind, section_id, thumb, dir_path,
              size_bytes, added_at, guid_tvdb, guid_tmdb, guid_imdb
       FROM media_items
       WHERE removed = 0
         AND (guid_tvdb IS NOT NULL OR guid_tmdb IS NOT NULL OR guid_imdb IS NOT NULL)`
    )
    .all() as DuplicateScanRow[];

  const toMember = (r: DuplicateScanRow): DuplicateMember => ({
    ratingKey: r.rating_key,
    title: r.title,
    year: r.year,
    libraryKind: r.library_kind,
    sectionId: r.section_id,
    thumb: r.thumb,
    dirPath: r.dir_path,
    sizeBytes: r.size_bytes,
    addedAt: r.added_at,
  });

  // Same scoping as arr matching: tvdb ids only mean anything on shows, tmdb on
  // movies; imdb spans both kinds.
  const axes: {
    kind: DuplicateGroup['idKind'];
    col: 'guid_tvdb' | 'guid_tmdb' | 'guid_imdb';
    scope?: LibraryKind;
  }[] = [
    { kind: 'tvdb', col: 'guid_tvdb', scope: 'show' },
    { kind: 'tmdb', col: 'guid_tmdb', scope: 'movie' },
    { kind: 'imdb', col: 'guid_imdb' },
  ];

  const groups: DuplicateGroup[] = [];
  const seenMemberSets = new Set<string>();
  for (const axis of axes) {
    const byId = new Map<string, DuplicateScanRow[]>();
    for (const r of rows) {
      if (axis.scope && r.library_kind !== axis.scope) continue;
      const guid = r[axis.col];
      if (!guid) continue;
      for (const raw of guid.split(',')) {
        const id = raw.trim();
        if (!id) continue;
        const list = byId.get(id);
        if (list) list.push(r);
        else byId.set(id, [r]);
      }
    }
    for (const [id, members] of byId) {
      const distinct = [...new Map(members.map((m) => [m.rating_key, m])).values()];
      if (distinct.length < 2) continue;
      // The same member set is often reachable via several ids/axes (a pair
      // sharing tmdb + imdb, or both halves of a CSV) — report it once.
      const setKey = distinct
        .map((m) => m.rating_key)
        .sort()
        .join('|');
      if (seenMemberSets.has(setKey)) continue;
      seenMemberSets.add(setKey);
      distinct.sort(
        (a, b) => b.size_bytes - a.size_bytes || a.title.localeCompare(b.title)
      );
      groups.push({
        idKind: axis.kind,
        idValue: id,
        totalBytes: distinct.reduce((s, m) => s + m.size_bytes, 0),
        items: distinct.map(toMember),
      });
    }
  }
  groups.sort((a, b) => b.totalBytes - a.totalBytes || a.idValue.localeCompare(b.idValue));
  return groups;
}

/** One media-server title with no file bytes (broken/missing files, or a dead
 *  metadata-only entry). */
export interface ZeroSizeItem {
  ratingKey: string;
  title: string;
  year: number | null;
  libraryKind: LibraryKind;
  sectionId: string;
  thumb: string | null;
  dirPath: string | null;
  addedAt: number | null;
  /** *arr context when matched: "the *arr has 19 GB for this — the server sees
   *  nothing" is a very different fix than a dead metadata-only entry. */
  arrBytes: number | null;
  instanceName: string | null;
}

const ZERO_SIZE_SORT: Record<string, string> = {
  added: 'm.added_at',
  title: 'm.title COLLATE NOCASE',
};

/** Zero-size items, newest first (a fresh one is likely a broken import). */
export function zeroSizeItems(
  limit: number,
  offset: number,
  opts?: ProblemListOpts
): ZeroSizeItem[] {
  const params: Record<string, unknown> = { limit, offset };
  const rows = getDb()
    .prepare(
      `SELECT m.rating_key, m.title, m.year, m.library_kind, m.section_id, m.thumb,
              m.dir_path, m.added_at, a.arr_size_bytes, a.instance_name
       FROM media_items m
       LEFT JOIN arr_items a ON a.rating_key = m.rating_key
       WHERE m.removed = 0 AND m.size_bytes = 0${problemFilterSql(opts, params, 'm.')}
       ORDER BY ${problemOrder(ZERO_SIZE_SORT, 'added', opts, 'm.title COLLATE NOCASE ASC')}
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as {
    rating_key: string;
    title: string;
    year: number | null;
    library_kind: LibraryKind;
    section_id: string;
    thumb: string | null;
    dir_path: string | null;
    added_at: number | null;
    arr_size_bytes: number | null;
    instance_name: string | null;
  }[];
  return rows.map((r) => ({
    ratingKey: r.rating_key,
    title: r.title,
    year: r.year,
    libraryKind: r.library_kind,
    sectionId: r.section_id,
    thumb: r.thumb,
    dirPath: r.dir_path,
    addedAt: r.added_at,
    arrBytes: r.arr_size_bytes,
    instanceName: r.instance_name,
  }));
}

export function zeroSizeCount(): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM media_items WHERE removed = 0 AND size_bytes = 0')
      .get() as { n: number }
  ).n;
}

/** A tombstoned item someone still keeps — something protected got deleted anyway. */
export interface RemovedButKeptItem {
  ratingKey: string;
  title: string;
  year: number | null;
  libraryKind: LibraryKind;
  sectionId: string;
  /** Last-known size — the item is gone from the media server, so this is stale. */
  sizeBytes: number;
  /** Last-known folder path (stale for the same reason — but it answers "did
   *  the files actually get deleted?"). */
  dirPath: string | null;
  keptBy: { plexUserId: string; username: string | null }[];
}

/** Removed items with surviving keeps, largest last-known size first
 *  (grouped like markedForDeleteItems; the route paginates). */
export function removedButKeptItems(): RemovedButKeptItem[] {
  const rows = getDb()
    .prepare(
      `SELECT m.rating_key, m.title, m.year, m.library_kind, m.section_id, m.size_bytes,
              m.dir_path, k.plex_user_id AS keeper_id, u.username AS keeper_name
       FROM keeps k
       JOIN media_items m ON m.rating_key = k.rating_key AND m.removed = 1
       LEFT JOIN users u ON u.plex_user_id = k.plex_user_id
       ORDER BY m.size_bytes DESC, m.title COLLATE NOCASE ASC, k.plex_user_id ASC`
    )
    .all() as {
    rating_key: string;
    title: string;
    year: number | null;
    library_kind: LibraryKind;
    section_id: string;
    size_bytes: number;
    dir_path: string | null;
    keeper_id: string;
    keeper_name: string | null;
  }[];
  // Group keepers per item; Map preserves the size-DESC insertion order.
  const byItem = new Map<string, RemovedButKeptItem>();
  for (const r of rows) {
    let item = byItem.get(r.rating_key);
    if (!item) {
      item = {
        ratingKey: r.rating_key,
        title: r.title,
        year: r.year,
        libraryKind: r.library_kind,
        sectionId: r.section_id,
        sizeBytes: r.size_bytes,
        dirPath: r.dir_path,
        keptBy: [],
      };
      byItem.set(r.rating_key, item);
    }
    item.keptBy.push({ plexUserId: r.keeper_id, username: r.keeper_name });
  }
  return [...byItem.values()];
}

/** Distinct removed-but-kept titles + their summed last-known bytes. */
export function removedButKeptSummary(): { titles: number; bytes: number } {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS titles, COALESCE(SUM(m.size_bytes), 0) AS bytes
       FROM media_items m
       WHERE m.removed = 1
         AND EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key)`
    )
    .get() as { titles: number; bytes: number };
}

/** One item with no external id at all (see mediaMissingExternalIds). */
export interface MissingIdItem {
  ratingKey: string;
  title: string;
  year: number | null;
  libraryKind: LibraryKind;
  sectionId: string;
  thumb: string | null;
  /** Often the diagnosis: a misnamed folder is why the match failed. */
  dirPath: string | null;
  sizeBytes: number;
}

// The "can never match *arr" predicate — no kind-primary id AND no imdb
// (mirrors mediaMissingExternalIds, whose count/sample shape still backs the
// arr-health endpoint; the Match health card shows the counts and links to the
// Problems page for the full list).
const MISSING_ID_EXPR = `guid_imdb IS NULL AND (
         (library_kind = 'show' AND guid_tvdb IS NULL) OR
         (library_kind = 'movie' AND guid_tmdb IS NULL))`;

const MISSING_ID_SORT: Record<string, string> = {
  size: 'size_bytes',
  title: 'title COLLATE NOCASE',
};

/** Items with no external id, largest first (full paged list). */
export function missingExternalIdItems(
  limit: number,
  offset: number,
  opts?: ProblemListOpts
): MissingIdItem[] {
  const params: Record<string, unknown> = { limit, offset };
  const rows = getDb()
    .prepare(
      `SELECT rating_key, title, year, library_kind, section_id, thumb, dir_path, size_bytes
       FROM media_items
       WHERE removed = 0 AND ${MISSING_ID_EXPR}${problemFilterSql(opts, params)}
       ORDER BY ${problemOrder(MISSING_ID_SORT, 'size', opts, 'title COLLATE NOCASE ASC')}
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as {
    rating_key: string;
    title: string;
    year: number | null;
    library_kind: LibraryKind;
    section_id: string;
    thumb: string | null;
    dir_path: string | null;
    size_bytes: number;
  }[];
  return rows.map((r) => ({
    ratingKey: r.rating_key,
    title: r.title,
    year: r.year,
    libraryKind: r.library_kind,
    sectionId: r.section_id,
    thumb: r.thumb,
    dirPath: r.dir_path,
    sizeBytes: r.size_bytes,
  }));
}

export function missingExternalIdsSummary(): { titles: number; bytes: number } {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS titles, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM media_items
       WHERE removed = 0 AND ${MISSING_ID_EXPR}`
    )
    .get() as { titles: number; bytes: number };
}

// --- Identity mismatch (same folder, two identities) ---

/** One folder claimed by BOTH a media-server item and an unmatched *arr title
 *  under different external ids — Plex/JF matched the folder to one thing,
 *  Sonarr/Radarr tracks another. One side's match is wrong (usually the
 *  server's). */
export interface IdentityMismatchItem {
  media: {
    ratingKey: string;
    title: string;
    year: number | null;
    libraryKind: LibraryKind;
    sectionId: string;
    thumb: string | null;
    dirPath: string | null;
    sizeBytes: number;
    /** The server's OWN external ids (CSV when it lists several; null = none of
     *  that kind) — shown beside the *arr's id so the disagreement is visible. */
    guidTmdb: string | null;
    guidTvdb: string | null;
    guidImdb: string | null;
  };
  arr: {
    title: string;
    source: string;
    /** FORK: which instance owns it — the Problems page acts on the record. */
    instanceId: string;
    instanceName: string;
    extKind: 'tvdb' | 'tmdb';
    extId: string;
    /** False = the *arr entry has no files ("added but never imported"). */
    downloaded: boolean;
    path: string | null;
  };
}

/**
 * Join unmatched *arr titles to media items by normalized FOLDER NAME (the
 * duplicateGroups pattern: load both sides, match in JS — names need unicode
 * NFC + case-fold comparison SQLite can't do). The ids disagree by
 * construction: a title whose id matched a media item wouldn't be in
 * arr_unmatched. Multi-folder shows store newline-joined dir_names — every
 * folder counts. Ordered by media size DESC.
 */
export function identityMismatchItems(): IdentityMismatchItem[] {
  const arrRows = getArrUnmatched(false).filter((u) => u.folderName);
  if (arrRows.length === 0) return [];
  const mediaRows = getDb()
    .prepare(
      `SELECT rating_key, title, year, library_kind, section_id, thumb, dir_path,
              dir_name, size_bytes, guid_tmdb, guid_tvdb, guid_imdb
       FROM media_items WHERE removed = 0 AND dir_name IS NOT NULL`
    )
    .all() as {
    rating_key: string;
    title: string;
    year: number | null;
    library_kind: LibraryKind;
    section_id: string;
    thumb: string | null;
    dir_path: string | null;
    dir_name: string;
    size_bytes: number;
    guid_tmdb: string | null;
    guid_tvdb: string | null;
    guid_imdb: string | null;
  }[];

  // folder name (normalized) → media items claiming it.
  const byFolder = new Map<string, typeof mediaRows>();
  for (const m of mediaRows) {
    for (const name of m.dir_name.split('\n')) {
      if (!name) continue;
      const key = normalizeName(name);
      const list = byFolder.get(key);
      if (list) list.push(m);
      else byFolder.set(key, [m]);
    }
  }

  const out: IdentityMismatchItem[] = [];
  for (const u of arrRows) {
    const claims = byFolder.get(normalizeName(u.folderName!)) ?? [];
    for (const m of claims) {
      out.push({
        media: {
          ratingKey: m.rating_key,
          title: m.title,
          year: m.year,
          libraryKind: m.library_kind,
          sectionId: m.section_id,
          thumb: m.thumb,
          dirPath: m.dir_path,
          sizeBytes: m.size_bytes,
          guidTmdb: m.guid_tmdb,
          guidTvdb: m.guid_tvdb,
          guidImdb: m.guid_imdb,
        },
        arr: {
          title: u.title,
          source: u.source,
          instanceId: u.instanceId,
          instanceName: u.instanceName,
          extKind: u.extKind,
          extId: u.extId,
          downloaded: u.downloaded ?? true,
          path: u.path ?? null,
        },
      });
    }
  }
  out.sort(
    (a, b) =>
      b.media.sizeBytes - a.media.sizeBytes ||
      a.media.title.localeCompare(b.media.title)
  );
  return out;
}

export function identityMismatchSummary(): { titles: number; bytes: number } {
  const items = identityMismatchItems();
  return {
    titles: items.length,
    bytes: items.reduce((s, i) => s + i.media.sizeBytes, 0),
  };
}

// --- Disk orphans (the diskScan job's results) ---

export interface DiskOrphanInput {
  name: string;
  /** Keeparr-container absolute path (mapping root + entry name). */
  path: string;
  isDir: boolean;
  sizeBytes: number;
  /** True when the circuit breaker recorded the name but skipped sizing. */
  sizeSkipped: boolean;
  /** Entry mtime (sec) at scan time — the size-cache key. */
  mtime: number | null;
}

export interface DiskOrphanRow extends DiskOrphanInput {
  sectionId: string;
  lastSynced: number;
}

/** Replace one section's orphan rows atomically. Sections the scan skips
 *  (safety guard, unreadable root) are simply not replaced — prior rows stay. */
export function replaceDiskOrphansForSection(
  sectionId: string,
  rows: DiskOrphanInput[]
): number {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO disk_orphans (section_id, name, path, is_dir, size_bytes, size_skipped, mtime, last_synced)
     VALUES (@sectionId, @name, @path, @isDir, @sizeBytes, @sizeSkipped, @mtime, @ts)`
  );
  const ts = now();
  db.transaction(() => {
    db.prepare('DELETE FROM disk_orphans WHERE section_id = ?').run(sectionId);
    for (const r of rows) {
      ins.run({
        ...r,
        sectionId,
        isDir: r.isDir ? 1 : 0,
        sizeSkipped: r.sizeSkipped ? 1 : 0,
        ts,
      });
    }
  })();
  return rows.length;
}

const mapOrphanRow = (r: {
  section_id: string;
  name: string;
  path: string;
  is_dir: number;
  size_bytes: number;
  size_skipped: number;
  mtime: number | null;
  last_synced: number;
}): DiskOrphanRow => ({
  sectionId: r.section_id,
  name: r.name,
  path: r.path,
  isDir: !!r.is_dir,
  sizeBytes: r.size_bytes,
  sizeSkipped: !!r.size_skipped,
  mtime: r.mtime,
  lastSynced: r.last_synced,
});

/** All orphans, largest first (the route paginates). */
export function getDiskOrphans(): DiskOrphanRow[] {
  const rows = getDb()
    .prepare(
      `SELECT section_id, name, path, is_dir, size_bytes, size_skipped, mtime, last_synced
       FROM disk_orphans ORDER BY size_bytes DESC, name COLLATE NOCASE ASC`
    )
    .all() as Parameters<typeof mapOrphanRow>[0][];
  return rows.map(mapOrphanRow);
}

/** An orphan annotated with the library title it LOOKS like (exact titleKey
 *  match) — usually a leftover old copy: the library already has the title in
 *  another folder, so the orphan is safe to verify-and-delete. */
export interface DiskOrphanAnnotated extends DiskOrphanRow {
  likely: {
    ratingKey: string;
    title: string;
    year: number | null;
    sizeBytes: number;
    libraryKind: LibraryKind;
  } | null;
}

/** getDiskOrphans + the "Looks like" diagnosis. When several items share a
 *  title key, the biggest one wins (that's the copy worth keeping). */
export function getDiskOrphansAnnotated(): DiskOrphanAnnotated[] {
  const orphans = getDiskOrphans();
  if (orphans.length === 0) return [];
  const items = getDb()
    .prepare(
      `SELECT rating_key, title, year, size_bytes, library_kind
       FROM media_items WHERE removed = 0`
    )
    .all() as {
    rating_key: string;
    title: string;
    year: number | null;
    size_bytes: number;
    library_kind: LibraryKind;
  }[];
  const byKey = new Map<string, (typeof items)[number]>();
  for (const it of items) {
    const key = titleKey(it.title);
    if (!key) continue;
    const cur = byKey.get(key);
    if (!cur || it.size_bytes > cur.size_bytes) byKey.set(key, it);
  }
  return orphans.map((o) => {
    const hit = byKey.get(titleKey(o.name));
    return {
      ...o,
      likely: hit
        ? {
            ratingKey: hit.rating_key,
            title: hit.title,
            year: hit.year,
            sizeBytes: hit.size_bytes,
            libraryKind: hit.library_kind,
          }
        : null,
    };
  });
}

/** One section's prior rows (feeds the scan's mtime size cache). */
export function diskOrphansForSection(sectionId: string): DiskOrphanRow[] {
  const rows = getDb()
    .prepare(
      `SELECT section_id, name, path, is_dir, size_bytes, size_skipped, mtime, last_synced
       FROM disk_orphans WHERE section_id = ?`
    )
    .all(sectionId) as Parameters<typeof mapOrphanRow>[0][];
  return rows.map(mapOrphanRow);
}

export function diskOrphansSummary(): { titles: number; bytes: number } {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS titles, COALESCE(SUM(size_bytes), 0) AS bytes FROM disk_orphans`
    )
    .get() as { titles: number; bytes: number };
}

/** One section's captured on-disk names (+ coverage counts for the safety
 *  guard: `named` = items with at least one name captured). */
export function sectionDiskNameStats(sectionId: string): {
  total: number;
  named: number;
  names: string[];
} {
  const rows = getDb()
    .prepare(
      `SELECT dir_name, file_name FROM media_items
       WHERE removed = 0 AND section_id = ?`
    )
    .all(sectionId) as { dir_name: string | null; file_name: string | null }[];
  const names: string[] = [];
  let named = 0;
  for (const r of rows) {
    if (r.dir_name || r.file_name) named++;
    // dir_name is newline-joined for multi-folder shows — every folder counts.
    if (r.dir_name) names.push(...r.dir_name.split('\n').filter(Boolean));
    if (r.file_name) names.push(r.file_name);
  }
  return { total: rows.length, named, names };
}

/** Every *arr folder basename we know of — matched (arr_items) AND unmatched
 *  (arr_unmatched: on disk per *arr but invisible to the media server). Global,
 *  not section-scoped: arr instances don't map to library sections. */
export function arrFolderNames(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT folder_name AS name FROM arr_items WHERE folder_name IS NOT NULL
       UNION
       SELECT folder_name AS name FROM arr_unmatched WHERE folder_name IS NOT NULL`
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// FORK: scheduled deletions (tag now, purge via Sonarr/Radarr after a grace
// period). Protective keeps always win — a kept item is never purge-eligible.
// ---------------------------------------------------------------------------

export type ScheduledDeletionStatus =
  | 'pending'
  | 'held'
  | 'deleted'
  | 'failed'
  | 'cancelled';

/** A scheduled_deletions row joined with its item + protection state. */
export interface ScheduledDeletionRow {
  rating_key: string;
  tagged_by: string;
  tagged_at: number;
  delete_after: number;
  status: ScheduledDeletionStatus;
  status_at: number | null;
  status_detail: string | null;
  notified_week: number;
  verified_at: number | null;
  /** Bytes still on disk after the delete. NULL = not verified. */
  residue_bytes: number | null;
  title: string;
  size_bytes: number;
  section_id: string;
  removed: number;
  /** Newline-joined when a show spans several root folders — split on '\n'. */
  dir_name: string | null;
  file_name: string | null;
  /** For post-delete Seerr cleanup (may be CSV when an item carries several). */
  guid_tmdb: string | null;
  guid_tvdb: string | null;
  kept: number; // anyone keeps it right now (protected)
  tagged_by_name: string | null;
}

/**
 * Tag an item for deletion (admin action). Re-tagging an existing row —
 * including a cancelled/failed one — restarts it as 'pending' with the new
 * dates ('held' immediately when someone currently keeps it). False when the
 * item doesn't exist or is tombstoned.
 */
export function tagForDeletion(
  ratingKey: string,
  taggedBy: string,
  deleteAfter: number
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const item = db
      .prepare('SELECT 1 FROM media_items WHERE rating_key = ? AND removed = 0')
      .get(ratingKey);
    if (!item) return false;
    const kept = db
      .prepare('SELECT 1 FROM keeps WHERE rating_key = ? LIMIT 1')
      .get(ratingKey);
    db.prepare(
      `INSERT INTO scheduled_deletions
         (rating_key, tagged_by, tagged_at, delete_after, status, status_at, status_detail)
       VALUES (@rk, @by, @at, @after, @status, @at, NULL)
       ON CONFLICT(rating_key) DO UPDATE SET
         tagged_by = excluded.tagged_by,
         tagged_at = excluded.tagged_at,
         delete_after = excluded.delete_after,
         status = excluded.status,
         status_at = excluded.status_at,
         status_detail = NULL`
    ).run({
      rk: ratingKey,
      by: taggedBy,
      at: now(),
      after: deleteAfter,
      status: kept ? 'held' : 'pending',
    });
    return true;
  })();
}

/** Cancel a tag (admin action). Keeps the row for audit. True if it was live. */
export function cancelDeletion(ratingKey: string, cancelledBy: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE scheduled_deletions
       SET status = 'cancelled', status_at = ?, status_detail = ?
       WHERE rating_key = ? AND status IN ('pending', 'held')`
    )
    .run(now(), `cancelled by ${cancelledBy}`, ratingKey);
  return info.changes > 0;
}

/** All scheduled-deletion rows with item info, live tags first, soonest first. */
export function listScheduledDeletions(): ScheduledDeletionRow[] {
  return getDb()
    .prepare(
      `SELECT sd.*, m.title, m.size_bytes, m.section_id, m.removed,
              m.dir_name, m.file_name,
              EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = sd.rating_key) AS kept,
              u.username AS tagged_by_name
       FROM scheduled_deletions sd
       JOIN media_items m ON m.rating_key = sd.rating_key
       LEFT JOIN users u ON u.plex_user_id = sd.tagged_by
       ORDER BY CASE WHEN sd.status IN ('pending', 'held') THEN 0 ELSE 1 END,
                sd.delete_after ASC, m.title COLLATE NOCASE ASC`
    )
    .all() as ScheduledDeletionRow[];
}

/**
 * Reconcile 'pending'/'held' with the CURRENT keep state: pending items someone
 * now keeps flip to held; held items nobody keeps anymore flip back to pending
 * (the countdown resumes — delete_after is untouched). Run at the start of each
 * purge pass. Returns {held, released} counts.
 */
export function refreshDeletionHolds(): { held: number; released: number } {
  const db = getDb();
  return db.transaction(() => {
    const t = now();
    const held = db
      .prepare(
        `UPDATE scheduled_deletions
         SET status = 'held', status_at = ?, status_detail = 'keep exists'
         WHERE status = 'pending'
           AND EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = scheduled_deletions.rating_key)`
      )
      .run(t).changes;
    const released = db
      .prepare(
        `UPDATE scheduled_deletions
         SET status = 'pending', status_at = ?, status_detail = 'keep removed'
         WHERE status = 'held'
           AND NOT EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = scheduled_deletions.rating_key)`
      )
      .run(t).changes;
    return { held, released };
  })();
}

/**
 * Items eligible for the purge right now: pending, past their delete_after,
 * item still present, and — belt and braces — not kept by anyone.
 */
export function dueDeletions(nowSec: number = now()): ScheduledDeletionRow[] {
  return getDb()
    .prepare(
      `SELECT sd.*, m.title, m.size_bytes, m.section_id, m.removed,
              m.dir_name, m.file_name, m.guid_tmdb, m.guid_tvdb,
              0 AS kept, NULL AS tagged_by_name
       FROM scheduled_deletions sd
       JOIN media_items m ON m.rating_key = sd.rating_key
       WHERE sd.status = 'pending' AND sd.delete_after <= ?
         AND m.removed = 0
         AND NOT EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = sd.rating_key)
       ORDER BY sd.delete_after ASC`
    )
    .all(nowSec) as ScheduledDeletionRow[];
}

/** Record the purge outcome for one item. */
export function setDeletionResult(
  ratingKey: string,
  status: 'deleted' | 'failed',
  detail: string
): void {
  getDb()
    .prepare(
      `UPDATE scheduled_deletions
       SET status = ?, status_at = ?, status_detail = ?
       WHERE rating_key = ?`
    )
    .run(status, now(), detail, ratingKey);
}

/**
 * Record the post-delete disk check. `residueBytes` null = could not verify
 * (section unmapped / root unreadable) — deliberately distinct from 0, which
 * means the folder really is gone.
 */
export function setDeletionVerification(
  ratingKey: string,
  residueBytes: number | null
): void {
  getDb()
    .prepare(
      `UPDATE scheduled_deletions
       SET verified_at = ?, residue_bytes = ?
       WHERE rating_key = ?`
    )
    .run(now(), residueBytes, ratingKey);
}

/** Deletions the purge reported as done but that left bytes behind — the
 *  "we said we reclaimed it, we didn't" report. Largest residue first. */
export function deletionResidueItems(): {
  ratingKey: string;
  title: string;
  claimedBytes: number;
  residueBytes: number;
  verifiedAt: number | null;
}[] {
  return getDb()
    .prepare(
      `SELECT sd.rating_key AS ratingKey, m.title AS title,
              m.size_bytes AS claimedBytes, sd.residue_bytes AS residueBytes,
              sd.verified_at AS verifiedAt
       FROM scheduled_deletions sd
       JOIN media_items m ON m.rating_key = sd.rating_key
       WHERE sd.status = 'deleted' AND sd.residue_bytes > 0
       ORDER BY sd.residue_bytes DESC`
    )
    .all() as {
    ratingKey: string;
    title: string;
    claimedBytes: number;
    residueBytes: number;
    verifiedAt: number | null;
  }[];
}

/** The arr match for one item (to target the DELETE at the right instance). */
export function arrMatchForItem(
  ratingKey: string
): { source: string; instance_id: string; instance_name: string; arr_id: number | null } | null {
  const row = getDb()
    .prepare(
      `SELECT source, instance_id, instance_name, arr_id
       FROM arr_items WHERE rating_key = ?`
    )
    .get(ratingKey) as
    | { source: string; instance_id: string; instance_name: string; arr_id: number | null }
    | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// FORK: deletion rules (rule-based auto-tagging feeding scheduled_deletions).
// ---------------------------------------------------------------------------

export interface DeletionRuleRow {
  id: number;
  name: string;
  enabled: number;
  conditions: string; // JSON RuleCondition[] (validated by lib/rules.ts)
  grace_days: number | null;
  created_at: number;
  updated_at: number;
}

export function listDeletionRules(): DeletionRuleRow[] {
  return getDb()
    .prepare('SELECT * FROM deletion_rules ORDER BY id ASC')
    .all() as DeletionRuleRow[];
}

export function createDeletionRule(input: {
  name: string;
  conditions: string;
  enabled: boolean;
  graceDays: number | null;
}): number {
  const t = now();
  const info = getDb()
    .prepare(
      `INSERT INTO deletion_rules (name, enabled, conditions, grace_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.name, input.enabled ? 1 : 0, input.conditions, input.graceDays, t, t);
  return Number(info.lastInsertRowid);
}

export function updateDeletionRule(
  id: number,
  input: { name: string; conditions: string; enabled: boolean; graceDays: number | null }
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE deletion_rules
       SET name = ?, enabled = ?, conditions = ?, grace_days = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(input.name, input.enabled ? 1 : 0, input.conditions, input.graceDays, now(), id);
  return info.changes > 0;
}

export function deleteDeletionRule(id: number): boolean {
  const info = getDb().prepare('DELETE FROM deletion_rules WHERE id = ?').run(id);
  return info.changes > 0;
}

/** The two halves of a rule's non-negotiable baseline, as expressions — named
 *  so the match query and the preview's "why fewer?" breakdown can't disagree
 *  about what "excluded" means. */
const RULE_KEPT_EXPR = 'EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key)';
/**
 * FORK: only a LIVE tag blocks a rule.
 *
 * This used to be any row at all, which made every finished outcome permanent:
 * cancel a tag once and no rule could ever consider that title again. A cancel
 * means "not this time", not "exempt forever" — the way to protect something
 * permanently is to keep it, which no rule can override. Terminal rows
 * (cancelled / failed / deleted) are therefore re-taggable; `insertRuleTags`
 * overwrites them and records what the previous outcome was.
 */
const RULE_LIVE_STATUSES = "('pending', 'held')";
const RULE_TAGGED_EXPR = `EXISTS (SELECT 1 FROM scheduled_deletions sd
     WHERE sd.rating_key = m.rating_key AND sd.status IN ${RULE_LIVE_STATUSES})`;

/**
 * The conditions half of a rule — everything the admin actually wrote, with
 * none of the baseline. Extracted so `ratingKeysMatchingRule` (which adds the
 * baseline) and `ruleExclusionCounts` (which counts what the baseline removed)
 * are built from one place. Not exported: conditions without the baseline must
 * never reach anything that tags.
 */
function ruleConditionSql(
  conditions: RuleCondition[],
  nowSec: number
): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = ['m.removed = 0'];
  const params: Record<string, unknown> = {};

  conditions.forEach((c, i) => {
    const p = `c${i}`;
    switch (c.field) {
      case 'last_watched_any':
        // No watch by ANYONE within the window (never-played matches too).
        params[p] = nowSec - c.value * 86400;
        where.push(
          `NOT EXISTS (SELECT 1 FROM watch_history w
             WHERE w.rating_key = m.rating_key AND w.last_watched >= @${p})`
        );
        break;
      case 'added_at':
        params[p] = nowSec - c.value * 86400;
        where.push(`m.added_at IS NOT NULL AND m.added_at <= @${p}`);
        break;
      case 'size':
        params[p] = c.value * 1024 ** 3;
        where.push(`m.size_bytes ${c.op === 'gtGB' ? '>' : '<'} @${p}`);
        break;
      case 'library': {
        const named = c.value.map((_, j) => `@${p}_${j}`);
        c.value.forEach((id, j) => (params[`${p}_${j}`] = id));
        where.push(
          named.length ? `m.section_id IN (${named.join(', ')})` : '1 = 0'
        );
        break;
      }
      case 'requested': {
        const exists =
          'EXISTS (SELECT 1 FROM seerr_requests r WHERE r.rating_key = m.rating_key)';
        where.push(c.value ? exists : `NOT ${exists}`);
        break;
      }
      // --- FORK (3.2): match on what the household said, not just on dates ---
      case 'verdict_score':
        // Un-voted titles count as 0, as they do in Browse's minScore — so
        // "score ≥ 1" means somebody actively wants it gone. The quorum below
        // is what stops that somebody being a lone voice.
        params[p] = c.value;
        where.push(`COALESCE(vs.score, 0) ${c.op === 'gte' ? '>=' : '<='} @${p}`);
        break;
      case 'verdict_count':
        params[p] = c.value;
        params[`${p}_v`] = c.verdict;
        where.push(
          `(SELECT COUNT(*) FROM votes v
              WHERE v.rating_key = m.rating_key AND v.verdict = @${p}_v)
           ${c.op === 'gte' ? '>=' : '<='} @${p}`
        );
        break;
      case 'verdict_by':
        // Counts an implied vote too: the requester who marked it "OK to
        // delete" in Browse said the same thing as one who swiped it away.
        params[p] = c.value;
        params[`${p}_v`] = c.verdict;
        where.push(
          `EXISTS (SELECT 1 FROM votes v
             WHERE v.rating_key = m.rating_key
               AND v.plex_user_id = @${p}
               AND v.verdict = @${p}_v)`
        );
        break;
      case 'min_voters':
      case 'nobody_kept':
        // Not per-item filters: the quorum is applied once by the caller (two
        // of them would fight), and "nobody keeps it" is already the baseline.
        break;
    }
  });

  return { where, params };
}

/**
 * Items a rule's conditions would tag RIGHT NOW: conditions AND'd on top of the
 * non-negotiable baseline — present, not kept by anyone, and not already
 * carrying a LIVE tag (pending/held: a countdown in progress, or a manual tag,
 * is never disturbed). A finished tag no longer blocks — see RULE_TAGGED_EXPR.
 * Mirrors the filter-builder style of queryLibrary. Conditions must be
 * pre-validated (lib/rules.ts).
 */
export function ratingKeysMatchingRule(
  conditions: RuleCondition[],
  nowSec: number = now(),
  /** FORK (3.2): force the voter quorum instead of deriving it from the
   *  conditions. */
  opts: { minVoters?: number } = {}
): { rating_key: string; title: string; size_bytes: number }[] {
  const { where, params } = ruleConditionSql(conditions, nowSec);
  where.push(`NOT ${RULE_KEPT_EXPR}`, `NOT ${RULE_TAGGED_EXPR}`);

  // FORK (3.2): the voter quorum — a rule that reads opinions doesn't fire
  // until enough different people have expressed one. Derived from the
  // conditions unless the caller forces it.
  const minVoters = opts.minVoters ?? effectiveMinVoters(conditions);
  if (minVoters != null && minVoters > 0) {
    params.minVoters = minVoters;
    where.push('COALESCE(vs.voters, 0) >= @minVoters');
  }

  return getDb()
    .prepare(
      // Same vote set as Browse and the consensus screen (explicit swipes plus
      // the keeps / "don't care" / "OK to delete" they stand in for).
      `WITH ${VOTES_CTE}, ${ITEM_SCORES_CTE}
       SELECT m.rating_key, m.title, m.size_bytes FROM media_items m
       LEFT JOIN item_scores vs ON vs.rating_key = m.rating_key
       WHERE ${where.join(' AND ')}
       ORDER BY m.size_bytes DESC`
    )
    .all(params) as { rating_key: string; title: string; size_bytes: number }[];
}

/** FORK (3.2): why a rule tags fewer titles than its conditions alone suggest.
 *  Counts only — this deliberately cannot hand rows to anything that tags. */
export interface RuleExclusionCounts {
  /** Titles the rule would actually tag (same set as ratingKeysMatchingRule). */
  matched: number;
  /** Matched the conditions, but somebody keeps it. */
  kept: number;
  /** Matched, but already carries a LIVE tag — it's counting down already
   *  (or paused by a keep), so there's nothing for a rule to add. */
  tagged: number;
  /** Matched and free, but too few people have voted on it. */
  quorum: number;
}

/**
 * FORK (3.2): the same conditions, counted by what the baseline removed.
 *
 * A rule preview that just says "4" next to a Browse filter showing 40 reads as
 * a broken rule. It usually isn't: Browse's score filter applies no baseline,
 * so it happily lists titles somebody keeps and titles already counting down.
 * Reasons are assigned in one pass with a fixed precedence — kept, then tagged,
 * then quorum — so the four numbers add up to the condition matches exactly,
 * with nothing double-counted.
 */
export function ruleExclusionCounts(
  conditions: RuleCondition[],
  nowSec: number = now()
): RuleExclusionCounts {
  const { where, params } = ruleConditionSql(conditions, nowSec);
  const minVoters = effectiveMinVoters(conditions);
  // No quorum in force → the quorum bucket can never fill, so compare against 0.
  params.minVoters = minVoters ?? 0;
  const row = getDb()
    .prepare(
      `WITH ${VOTES_CTE}, ${ITEM_SCORES_CTE}
       SELECT
         SUM(CASE WHEN ${RULE_KEPT_EXPR} THEN 1 ELSE 0 END) AS kept,
         SUM(CASE WHEN NOT ${RULE_KEPT_EXPR} AND ${RULE_TAGGED_EXPR} THEN 1 ELSE 0 END) AS tagged,
         SUM(CASE WHEN NOT ${RULE_KEPT_EXPR} AND NOT ${RULE_TAGGED_EXPR}
                   AND COALESCE(vs.voters, 0) < @minVoters THEN 1 ELSE 0 END) AS quorum,
         SUM(CASE WHEN NOT ${RULE_KEPT_EXPR} AND NOT ${RULE_TAGGED_EXPR}
                   AND COALESCE(vs.voters, 0) >= @minVoters THEN 1 ELSE 0 END) AS matched
       FROM media_items m
       LEFT JOIN item_scores vs ON vs.rating_key = m.rating_key
       WHERE ${where.join(' AND ')}`
    )
    .get(params) as { kept: number | null; tagged: number | null; quorum: number | null; matched: number | null };
  return {
    matched: row.matched ?? 0,
    kept: row.kept ?? 0,
    tagged: row.tagged ?? 0,
    quorum: row.quorum ?? 0,
  };
}

/**
 * Tag rule matches. A key that gained a LIVE tag in the meantime is left alone
 * (never overwrite a countdown, or a manual tag's chosen date); a key whose
 * previous tag finished — cancelled, failed, or deleted — is re-tagged fresh.
 * Returns how many rows were written.
 */
export function insertRuleTags(
  ratingKeys: string[],
  taggedBy: string,
  deleteAfter: number
): number {
  const db = getDb();
  // FORK: a finished row is replaced, a live one is left strictly alone — the
  // WHERE on the upsert is what keeps a rule from stamping over a manual tag's
  // date or restarting a countdown someone is already watching. The old row's
  // outcome is carried into status_detail so re-tagging a cancelled title still
  // shows, in the deletion history, that it had been cancelled before.
  const ins = db.prepare(
    `INSERT INTO scheduled_deletions
       (rating_key, tagged_by, tagged_at, delete_after, status, status_at)
     VALUES (@rk, @by, @at, @after, 'pending', @at)
     ON CONFLICT(rating_key) DO UPDATE SET
       tagged_by = excluded.tagged_by,
       tagged_at = excluded.tagged_at,
       delete_after = excluded.delete_after,
       status = 'pending',
       status_at = excluded.status_at,
       status_detail = 'Re-tagged; previous outcome: ' || scheduled_deletions.status,
       verified_at = NULL,
       residue_bytes = NULL,
       notified_week = 0
     WHERE scheduled_deletions.status NOT IN ${RULE_LIVE_STATUSES}`
  );
  const t = now();
  return db.transaction(() => {
    let n = 0;
    for (const rk of ratingKeys) {
      n += ins.run({ rk, by: taggedBy, at: t, after: deleteAfter }).changes;
    }
    return n;
  })();
}

/** Rating keys of all live 'pending' tags (drives the Leaving Soon collection).
 *  Joined to PRESENT items — a tombstoned item's id no longer exists on the
 *  media server, and one dead id can 400 a whole collection edit. */
export function pendingDeletionKeys(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT sd.rating_key FROM scheduled_deletions sd
       JOIN media_items m ON m.rating_key = sd.rating_key AND m.removed = 0
       WHERE sd.status = 'pending'`
    )
    .all() as { rating_key: string }[];
  return rows.map((r) => r.rating_key);
}

/**
 * Pending tags inside their final 7 days that haven't had the "entering final
 * week" notice yet (Discord). Caller marks them via markWeekNotified.
 */
export function enteringFinalWeek(nowSec: number = now()): ScheduledDeletionRow[] {
  return getDb()
    .prepare(
      `SELECT sd.*, m.title, m.size_bytes, m.section_id, m.removed,
              0 AS kept, NULL AS tagged_by_name
       FROM scheduled_deletions sd
       JOIN media_items m ON m.rating_key = sd.rating_key
       WHERE sd.status = 'pending' AND sd.notified_week = 0
         AND sd.delete_after <= ? + 7 * 86400
       ORDER BY sd.delete_after ASC`
    )
    .all(nowSec) as ScheduledDeletionRow[];
}

export function markWeekNotified(ratingKeys: string[]): void {
  const db = getDb();
  const upd = db.prepare(
    `UPDATE scheduled_deletions SET notified_week = 1 WHERE rating_key = ?`
  );
  db.transaction(() => {
    for (const rk of ratingKeys) upd.run(rk);
  })();
}

// ---------------------------------------------------------------------------
// FORK: swipe verdicts (2.1). Write-through so the rest of the app just works:
// want_to_watch/loved_it → keep; dont_care → skip; done_with_it/not_interested
// → clear this user's keep (they stand as delete votes via the verdicts table
// itself). All transitions atomic, mirroring the apply* mutation style.
// ---------------------------------------------------------------------------

/**
 * Record this user's verdict and write it through to keeps/skips. False when
 * the item is unknown/tombstoned. Replaces any previous verdict (re-swiping
 * an item transitions its write-through state too).
 */
export function applyVerdict(
  plexUserId: string,
  ratingKey: string,
  verdict: Verdict
): boolean {
  const db = getDb();
  return db.transaction(() => {
    const item = db
      .prepare('SELECT 1 FROM media_items WHERE rating_key = ? AND removed = 0')
      .get(ratingKey);
    if (!item) return false;
    const t = now();
    db.prepare(
      `INSERT INTO verdicts (plex_user_id, rating_key, verdict, decided_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(plex_user_id, rating_key) DO UPDATE SET
         verdict = excluded.verdict, decided_at = excluded.decided_at`
    ).run(plexUserId, ratingKey, verdict, t);

    const clearKeep = () =>
      db.prepare('DELETE FROM keeps WHERE plex_user_id = ? AND rating_key = ?').run(
        plexUserId,
        ratingKey
      );
    const clearSkip = () =>
      db.prepare('DELETE FROM user_skips WHERE plex_user_id = ? AND rating_key = ?').run(
        plexUserId,
        ratingKey
      );
    const clearDelete = () =>
      db.prepare('DELETE FROM user_deletes WHERE plex_user_id = ? AND rating_key = ?').run(
        plexUserId,
        ratingKey
      );

    if (verdict === 'want_to_watch' || verdict === 'loved_it') {
      // Same effect as applyKeep: keep + exclusivity + pause any pending tag.
      db.prepare(
        `INSERT INTO keeps (plex_user_id, rating_key, kept_at) VALUES (?, ?, ?)
         ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
      ).run(plexUserId, ratingKey, t);
      clearSkip();
      clearDelete();
      db.prepare(
        `UPDATE scheduled_deletions
         SET status = 'held', status_at = ?, status_detail = 'keep added'
         WHERE rating_key = ? AND status = 'pending'`
      ).run(t, ratingKey);
    } else if (verdict === 'dont_care') {
      db.prepare(
        `INSERT INTO user_skips (plex_user_id, rating_key, skipped_at) VALUES (?, ?, ?)
         ON CONFLICT(plex_user_id, rating_key) DO NOTHING`
      ).run(plexUserId, ratingKey, t);
      clearKeep();
      clearDelete();
    } else {
      // done_with_it / not_interested: a delete vote — withdraw this user's
      // keep/skip; the verdict row itself is the vote (fed to rules/consensus).
      clearKeep();
      clearSkip();
    }
    return true;
  })();
}

/**
 * Undo: remove the verdict AND its write-through side effects (keep/skip),
 * returning the removed verdict (null when there was none). The item rolls
 * back into the deck.
 */
export function removeVerdict(
  plexUserId: string,
  ratingKey: string
): Verdict | null {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare(
        'SELECT verdict FROM verdicts WHERE plex_user_id = ? AND rating_key = ?'
      )
      .get(plexUserId, ratingKey) as { verdict: Verdict } | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM verdicts WHERE plex_user_id = ? AND rating_key = ?').run(
      plexUserId,
      ratingKey
    );
    if (row.verdict === 'want_to_watch' || row.verdict === 'loved_it') {
      db.prepare('DELETE FROM keeps WHERE plex_user_id = ? AND rating_key = ?').run(
        plexUserId,
        ratingKey
      );
    } else if (row.verdict === 'dont_care') {
      db.prepare('DELETE FROM user_skips WHERE plex_user_id = ? AND rating_key = ?').run(
        plexUserId,
        ratingKey
      );
    }
    return row.verdict;
  })();
}

/** This user's verdict for one item (null = not swiped). */
export function getVerdict(plexUserId: string, ratingKey: string): Verdict | null {
  const row = getDb()
    .prepare('SELECT verdict FROM verdicts WHERE plex_user_id = ? AND rating_key = ?')
    .get(plexUserId, ratingKey) as { verdict: Verdict } | undefined;
  return row?.verdict ?? null;
}

/**
 * The swipe deck: movies AND whole series (rows are series-level — a verdict
 * covers the show, never a season) this user hasn't sworn a verdict on,
 * size-weighted like the feed, honoring the same section/watch-list filters.
 */
export function getSwipeDeck(
  plexUserId: string,
  limit: number,
  opts: { sectionId?: string; watchMode?: FeedWatchMode } = {}
): MediaItem[] {
  return weightedPull(
    plexUserId,
    {
      sectionId: opts.sectionId,
      watchMode: opts.watchMode,
      excludeMyVerdicts: true,
    },
    limit,
    []
  );
}

/** How many titles remain un-swiped for this user (per the same filters). */
export function countSwipeRemaining(
  plexUserId: string,
  opts: { sectionId?: string; watchMode?: FeedWatchMode } = {}
): number {
  const params: Record<string, unknown> = { uid: plexUserId };
  let extra = '';
  if (opts.sectionId) {
    extra += ' AND m.section_id = @sectionId';
    params.sectionId = opts.sectionId;
  }
  if (opts.watchMode) extra += ` AND ${feedWatchClause(opts.watchMode, params)}`;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM media_items m
       WHERE ${FEED_ELIGIBILITY}
         AND m.rating_key NOT IN (SELECT rating_key FROM verdicts WHERE plex_user_id = @uid)
         ${extra}`
    )
    .get(params) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// FORK: ratings enrichment (OMDb columns on media_items; 'ratings' job).
// ---------------------------------------------------------------------------

/**
 * Items due a ratings fetch: has an IMDb id, present, and never fetched or
 * stale (fetched before `staleBefore`). Never-fetched first (the backfill
 * cursor), then oldest — so a capped run naturally resumes where it left off.
 */
export function itemsNeedingRatings(
  limit: number,
  staleBefore: number
): { rating_key: string; guid_imdb: string }[] {
  return getDb()
    .prepare(
      `SELECT rating_key, guid_imdb FROM media_items
       WHERE removed = 0 AND guid_imdb IS NOT NULL AND guid_imdb != ''
         AND (ratings_fetched_at IS NULL OR ratings_fetched_at < ?)
       ORDER BY (ratings_fetched_at IS NULL) DESC, ratings_fetched_at ASC
       LIMIT ?`
    )
    .all(staleBefore, limit) as { rating_key: string; guid_imdb: string }[];
}

/**
 * Store a fetch result. Nulls are stored as-is (OMDb miss / N/A) — the
 * timestamp is stamped either way so a durable miss isn't refetched daily.
 */
export function updateItemRatings(
  ratingKey: string,
  r: { imdbRating: number | null; rtScore: number | null; metacritic: number | null }
): void {
  getDb()
    .prepare(
      `UPDATE media_items
       SET imdb_rating = ?, rt_score = ?, metacritic = ?, ratings_fetched_at = ?
       WHERE rating_key = ?`
    )
    .run(r.imdbRating, r.rtScore, r.metacritic, now(), ratingKey);
}

/**
 * Cancel every LIVE (pending/held) tag created by one tagger (e.g. 'rule:3'
 * when that rule is deleted — its tags shouldn't outlive it). Rows stay for
 * audit; completed/cancelled rows are untouched. Returns how many were live.
 */
export function cancelDeletionsByTagger(taggedBy: string, detail: string): number {
  return getDb()
    .prepare(
      `UPDATE scheduled_deletions
       SET status = 'cancelled', status_at = ?, status_detail = ?
       WHERE tagged_by = ? AND status IN ('pending', 'held')`
    )
    .run(now(), detail, taggedBy).changes;
}

// ---------------------------------------------------------------------------
// FORK: swipe matchmaking + consensus (2.4). Identity is deliberately visible
// here — "you and Sam both want to watch these" is the whole point.
// ---------------------------------------------------------------------------

/** Users who have sworn at least one verdict (the matchmaking participants). */
export function verdictParticipants(): { plex_user_id: string; username: string }[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT u.plex_user_id, COALESCE(u.username, u.plex_user_id) AS username
       FROM verdicts v JOIN users u ON u.plex_user_id = v.plex_user_id
       ORDER BY username COLLATE NOCASE`
    )
    .all() as { plex_user_id: string; username: string }[];
}

export interface MovieNightMatch extends MediaItem {
  want_count: number;
  wanter_ids: string; // CSV plex_user_ids
  wanter_names: string; // CSV usernames (same order)
}

/**
 * Movie night: present items where ≥2 of the chosen users (all participants
 * when omitted) said want_to_watch, most-wanted first. `unwatchedOnly` = nobody
 * on the server has watched it yet.
 */
export function movieNightMatches(
  opts: { userIds?: string[]; unwatchedOnly?: boolean } = {}
): MovieNightMatch[] {
  const params: Record<string, unknown> = {};
  let userSql = '';
  if (opts.userIds && opts.userIds.length > 0) {
    const named = opts.userIds.map((_, i) => `@u${i}`);
    opts.userIds.forEach((id, i) => (params[`u${i}`] = id));
    userSql = ` AND v.plex_user_id IN (${named.join(', ')})`;
  }
  const unwatchedSql = opts.unwatchedOnly
    ? ` AND NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.rating_key = m.rating_key)`
    : '';
  return getDb()
    .prepare(
      `SELECT m.*, COUNT(*) AS want_count,
              GROUP_CONCAT(v.plex_user_id) AS wanter_ids,
              GROUP_CONCAT(COALESCE(u.username, v.plex_user_id)) AS wanter_names
       FROM verdicts v
       JOIN media_items m ON m.rating_key = v.rating_key AND m.removed = 0
       LEFT JOIN users u ON u.plex_user_id = v.plex_user_id
       WHERE v.verdict = 'want_to_watch'${userSql}${unwatchedSql}
       GROUP BY v.rating_key
       HAVING COUNT(*) >= 2
       ORDER BY want_count DESC, m.size_bytes DESC, m.title COLLATE NOCASE`
    )
    .all(params) as MovieNightMatch[];
}

export interface ConsensusRow extends MediaItem {
  kept: number; // anyone keeps it (protected)
  want_names: string | null; // want_to_watch (save for later)
  keep_names: string | null; // loved_it (worth keeping)
  done_names: string | null; // done_with_it (can go — watched)
  never_names: string | null; // not_interested (let it go — unseen)
  skip_count: number; // dont_care abstentions
  delete_votes: number; // done_with_it + not_interested
  // --- FORK (3.3): the weighted projection ---
  /** Summed VERDICT_POINTS across every voter; positive = wanted gone. */
  score: number;
  /** Distinct people with an opinion (explicit or implied). */
  voters: number;
  /** Names whose "worth keeping" / "can go" / "skip" is IMPLIED by a keep,
   *  an "OK to delete" or a "don't care" rather than an actual swipe. */
  keep_implicit_names: string | null;
  done_implicit_names: string | null;
  skip_implicit_count: number;
  /** FORK (3.2 follow-up): the shruggers by name, so the per-item detail can
   *  show WHO abstained instead of just how many — a count is enough for a
   *  table cell, not for "who said what". */
  skip_names: string | null;
  skip_implicit_names: string | null;
  /** FORK (3.2 follow-up): the live deletion tag, if any — so a row can be
   *  tagged (or shown as already counting down) without a second lookup. */
  scheduled_delete_after: number | null;
  scheduled_delete_status: string | null;
}

/**
 * FORK (3.3): SQL CASE mapping a verdict column to its points, generated from
 * VERDICT_POINTS so the scale can't drift from the UI. Interpolation is safe —
 * both the labels and the numbers are our own compile-time constants.
 */
function verdictPointsSql(col: string): string {
  const whens = VERDICTS.map((v) => `WHEN '${v}' THEN ${VERDICT_POINTS[v]}`).join(' ');
  return `CASE ${col} ${whens} ELSE 0 END`;
}

/**
 * FORK (3.3): every opinion on every item — explicit swipe verdicts, plus the
 * verdict a keep / "don't care" / "OK to delete" stands in for when that person
 * never swiped the title. Without this a household member who triages in Browse
 * scores 0 while a swiper scores ±2, which would quietly bias the whole model.
 *
 * Implicit rows are excluded wherever a verdict exists for the same
 * (user, item), so an actual swipe always wins; the three source tables are
 * mutually exclusive per user, so nobody is double-counted either way.
 */
const VOTES_CTE = `votes AS (
      SELECT plex_user_id, rating_key, verdict, 0 AS implicit FROM verdicts
      UNION ALL
      SELECT k.plex_user_id, k.rating_key, '${IMPLIED_VERDICTS.keep}', 1
        FROM keeps k
       WHERE NOT EXISTS (SELECT 1 FROM verdicts v
                          WHERE v.plex_user_id = k.plex_user_id AND v.rating_key = k.rating_key)
      UNION ALL
      SELECT s.plex_user_id, s.rating_key, '${IMPLIED_VERDICTS.skip}', 1
        FROM user_skips s
       WHERE NOT EXISTS (SELECT 1 FROM verdicts v
                          WHERE v.plex_user_id = s.plex_user_id AND v.rating_key = s.rating_key)
      UNION ALL
      SELECT d.plex_user_id, d.rating_key, '${IMPLIED_VERDICTS.okToDelete}', 1
        FROM user_deletes d
       WHERE NOT EXISTS (SELECT 1 FROM verdicts v
                          WHERE v.plex_user_id = d.plex_user_id AND v.rating_key = d.rating_key)
    )`;

/**
 * FORK (3.2): the per-item rollup of `votes` — the score Browse sorts and
 * filters on, and the voter count that says how much weight to give it. Split
 * out of `verdictConsensus`'s big GROUP BY so both screens compute the number
 * the same way; requires VOTES_CTE to be in the same WITH clause.
 */
const ITEM_SCORES_CTE = `item_scores AS (
      SELECT rating_key,
             SUM(${verdictPointsSql('verdict')}) AS score,
             COUNT(*) AS voters
        FROM votes
       GROUP BY rating_key
    )`;

/**
 * Per-item verdict rollup over every item ANYONE has an opinion on — feeds the
 * human decision of what to tag for deletion. Sort: 'votes' = most delete votes
 * first (ties by size), 'size' = largest first, 'score' = most wanted gone
 * first (FORK 3.3).
 *
 * `voter`/`verdict` slice the list without changing any row's rollup: they ask
 * "show me the titles X marked Y", and each surviving row still reports what
 * everybody said about it.
 */
export function verdictConsensus(
  opts: {
    sort?: 'votes' | 'size' | 'score';
    voter?: string;
    verdict?: Verdict;
    limit: number;
    offset: number;
  }
): ConsensusRow[] {
  const name = `COALESCE(u.username, v.plex_user_id)`;
  const order =
    opts.sort === 'size'
      ? 'm.size_bytes DESC'
      : opts.sort === 'score'
        ? 'score DESC, m.size_bytes DESC'
        : 'delete_votes DESC, m.size_bytes DESC';
  const params: Record<string, unknown> = {
    limit: opts.limit,
    offset: opts.offset,
  };
  // Filter by who said what. Either half alone is meaningful: a voter with no
  // verdict = "everything X has an opinion on".
  const filters: string[] = [];
  if (opts.voter) {
    filters.push('f.plex_user_id = @voter');
    params.voter = opts.voter;
  }
  if (opts.verdict) {
    filters.push('f.verdict = @verdictFilter');
    params.verdictFilter = opts.verdict;
  }
  const filterSql = filters.length
    ? `WHERE EXISTS (SELECT 1 FROM votes f
                      WHERE f.rating_key = m.rating_key AND ${filters.join(' AND ')})`
    : '';
  return getDb()
    .prepare(
      `WITH ${VOTES_CTE}
       SELECT m.*,
              EXISTS (SELECT 1 FROM keeps k WHERE k.rating_key = m.rating_key) AS kept,
              GROUP_CONCAT(CASE WHEN v.verdict = 'want_to_watch' THEN ${name} END) AS want_names,
              GROUP_CONCAT(CASE WHEN v.verdict = 'loved_it' AND v.implicit = 0 THEN ${name} END) AS keep_names,
              GROUP_CONCAT(CASE WHEN v.verdict = 'loved_it' AND v.implicit = 1 THEN ${name} END) AS keep_implicit_names,
              GROUP_CONCAT(CASE WHEN v.verdict = 'done_with_it' AND v.implicit = 0 THEN ${name} END) AS done_names,
              GROUP_CONCAT(CASE WHEN v.verdict = 'done_with_it' AND v.implicit = 1 THEN ${name} END) AS done_implicit_names,
              GROUP_CONCAT(CASE WHEN v.verdict = 'not_interested' THEN ${name} END) AS never_names,
              SUM(v.verdict = 'dont_care' AND v.implicit = 0) AS skip_count,
              SUM(v.verdict = 'dont_care' AND v.implicit = 1) AS skip_implicit_count,
              GROUP_CONCAT(CASE WHEN v.verdict = 'dont_care' AND v.implicit = 0 THEN ${name} END) AS skip_names,
              GROUP_CONCAT(CASE WHEN v.verdict = 'dont_care' AND v.implicit = 1 THEN ${name} END) AS skip_implicit_names,
              MAX(sd.delete_after) AS scheduled_delete_after,
              MAX(sd.status) AS scheduled_delete_status,
              SUM(v.verdict IN ('done_with_it', 'not_interested')) AS delete_votes,
              SUM(${verdictPointsSql('v.verdict')}) AS score,
              COUNT(*) AS voters
       FROM votes v
       JOIN media_items m ON m.rating_key = v.rating_key AND m.removed = 0
       LEFT JOIN users u ON u.plex_user_id = v.plex_user_id
       -- At most one live tag per item (PK rating_key), so this can't multiply
       -- rows and skew the vote counts above.
       LEFT JOIN scheduled_deletions sd
         ON sd.rating_key = v.rating_key AND sd.status IN ('pending', 'held')
       ${filterSql}
       GROUP BY v.rating_key
       ORDER BY ${order}, m.title COLLATE NOCASE
       LIMIT @limit OFFSET @offset`
    )
    .all(params) as ConsensusRow[];
}

/**
 * FORK (3.3): everyone with an opinion the consensus list can be sliced by —
 * swipers and Browse-only triagers alike, so the voter filter never offers an
 * empty selection or hides someone who only ever kept things.
 */
export function consensusVoters(): { plex_user_id: string; username: string | null }[] {
  return getDb()
    .prepare(
      `WITH ${VOTES_CTE}
       SELECT v.plex_user_id, MAX(u.username) AS username
       FROM votes v
       JOIN media_items m ON m.rating_key = v.rating_key AND m.removed = 0
       LEFT JOIN users u ON u.plex_user_id = v.plex_user_id
       GROUP BY v.plex_user_id
       ORDER BY COALESCE(MAX(u.username), v.plex_user_id) COLLATE NOCASE`
    )
    .all() as { plex_user_id: string; username: string | null }[];
}

// ---------------------------------------------------------------------------
// FORK: live "movie night" swipe rooms (short-poll transport; everyone-agrees
// match). All SQL lives here; the routes compose RoomState + the matched card.
// ---------------------------------------------------------------------------

/** Server-wide watch modes valid for a shared room deck (my_unwatched is
 *  per-user, so it's meaningless for a group — dropped at creation). */
export const ROOM_WATCH_MODES: FeedWatchMode[] = [
  'never_played',
  'stale_90',
  'recent_30',
];

export interface RoomRow {
  code: string;
  created_by: string;
  created_at: number;
  section_id: string | null;
  watch_mode: FeedWatchMode | null;
  status: 'open' | 'matched' | 'closed';
  matched_rating_key: string | null;
  matched_at: number | null;
}

export interface RoomMemberRow {
  plex_user_id: string;
  username: string | null;
  active: number; // 0/1 from the presence comparison
  votes: number;
}

export function getRoomRow(code: string): RoomRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM swipe_rooms WHERE code = ?')
      .get(code) as RoomRow | undefined) ?? null
  );
}

/** Create a room and auto-join the host. Watch mode is coerced to a room-valid
 *  one (null otherwise). Caller supplies a collision-free code. */
export function createRoom(input: {
  code: string;
  hostId: string;
  hostName: string | null;
  sectionId: string | null;
  watchMode: FeedWatchMode | null;
}): void {
  const ts = now();
  const watch =
    input.watchMode && ROOM_WATCH_MODES.includes(input.watchMode)
      ? input.watchMode
      : null;
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO swipe_rooms (code, created_by, created_at, section_id, watch_mode, status)
       VALUES (@code, @hostId, @ts, @sectionId, @watchMode, 'open')`
    ).run({ ...input, watchMode: watch, ts });
    db.prepare(
      `INSERT INTO swipe_room_members (code, plex_user_id, username, joined_at, last_seen)
       VALUES (@code, @hostId, @hostName, @ts, @ts)`
    ).run({ code: input.code, hostId: input.hostId, hostName: input.hostName, ts });
  })();
}

/** Add (or refresh) a member and mark them present now. No-op if already in. */
export function joinRoom(code: string, userId: string, username: string | null): void {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO swipe_room_members (code, plex_user_id, username, joined_at, last_seen)
       VALUES (@code, @userId, @username, @ts, @ts)
       ON CONFLICT(code, plex_user_id) DO UPDATE SET
         username = excluded.username,
         last_seen = excluded.last_seen`
    )
    .run({ code, userId, username, ts });
}

/** Bump a member's presence timestamp (called by the poll). */
export function touchRoomMember(code: string, userId: string): void {
  getDb()
    .prepare(
      'UPDATE swipe_room_members SET last_seen = ? WHERE code = ? AND plex_user_id = ?'
    )
    .run(now(), code, userId);
}

export function leaveRoom(code: string, userId: string): void {
  getDb()
    .prepare('DELETE FROM swipe_room_members WHERE code = ? AND plex_user_id = ?')
    .run(code, userId);
}

export function isRoomMember(code: string, userId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM swipe_room_members WHERE code = ? AND plex_user_id = ?')
    .get(code, userId);
}

/** All members with a live presence flag + how many titles each has swiped. */
export function roomMembers(code: string, activeSince: number): RoomMemberRow[] {
  return getDb()
    .prepare(
      `SELECT mem.plex_user_id, mem.username,
              (mem.last_seen >= @activeSince) AS active,
              (SELECT COUNT(*) FROM swipe_room_votes v
                 WHERE v.code = mem.code AND v.plex_user_id = mem.plex_user_id) AS votes
       FROM swipe_room_members mem
       WHERE mem.code = @code
       ORDER BY mem.joined_at ASC`
    )
    .all({ code, activeSince }) as RoomMemberRow[];
}

export function roomActiveCount(code: string, activeSince: number): number {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS n FROM swipe_room_members WHERE code = ? AND last_seen >= ?'
    )
    .get(code, activeSince) as { n: number };
  return row.n;
}

/** Record a want/pass vote (idempotent per item). */
export function recordRoomVote(
  code: string,
  userId: string,
  ratingKey: string,
  want: boolean
): void {
  getDb()
    .prepare(
      `INSERT INTO swipe_room_votes (code, plex_user_id, rating_key, want, voted_at)
       VALUES (@code, @userId, @ratingKey, @want, @ts)
       ON CONFLICT(code, plex_user_id, rating_key) DO UPDATE SET
         want = excluded.want, voted_at = excluded.voted_at`
    )
    .run({ code, userId, ratingKey, want: want ? 1 : 0, ts: now() });
}

/**
 * The first title EVERYONE currently present wants (>=2 present), or null.
 * "Completed first" = the earliest moment its final needed want-vote arrived.
 * Pure read — the caller commits the result with setRoomMatched.
 */
export function computeRoomMatch(code: string, activeSince: number): string | null {
  const active = roomActiveCount(code, activeSince);
  if (active < 2) return null;
  const row = getDb()
    .prepare(
      `SELECT v.rating_key AS rk
       FROM swipe_room_votes v
       JOIN swipe_room_members mem
         ON mem.code = v.code AND mem.plex_user_id = v.plex_user_id
       JOIN media_items m ON m.rating_key = v.rating_key AND m.removed = 0
       WHERE v.code = @code AND v.want = 1 AND mem.last_seen >= @activeSince
       GROUP BY v.rating_key
       HAVING COUNT(*) >= @active
       ORDER BY MAX(v.voted_at) ASC
       LIMIT 1`
    )
    .get({ code, activeSince, active }) as { rk: string } | undefined;
  return row?.rk ?? null;
}

/** Atomically land the room on a title; true only for the call that wins the
 *  still-open room (so concurrent pollers don't double-fire). */
export function setRoomMatched(code: string, ratingKey: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE swipe_rooms SET status = 'matched', matched_rating_key = ?, matched_at = ?
       WHERE code = ? AND status = 'open'`
    )
    .run(ratingKey, now(), code);
  return info.changes > 0;
}

export function closeRoom(code: string): void {
  getDb()
    .prepare("UPDATE swipe_rooms SET status = 'closed' WHERE code = ?")
    .run(code);
}

/** Close open rooms older than `olderThan` (epoch). Housekeeping; called on
 *  create so stale rows don't accumulate. Returns rooms closed. */
export function pruneStaleRooms(olderThan: number): number {
  return getDb()
    .prepare(
      "UPDATE swipe_rooms SET status = 'closed' WHERE status = 'open' AND created_at < ?"
    )
    .run(olderThan).changes;
}

/**
 * The shared, deterministic deck for a room: non-removed items in the room's
 * section/watch filter, newest first, minus what THIS viewer already swiped in
 * the room. Everyone sees the same order, so votes converge on the same titles.
 */
export function getRoomDeck(
  room: RoomRow,
  userId: string,
  limit: number
): MediaItem[] {
  const params: Record<string, unknown> = { code: room.code, uid: userId, limit };
  const clauses: string[] = ['m.removed = 0'];
  if (room.section_id) {
    clauses.push('m.section_id = @sectionId');
    params.sectionId = room.section_id;
  }
  if (room.watch_mode && ROOM_WATCH_MODES.includes(room.watch_mode)) {
    clauses.push(feedWatchClause(room.watch_mode, params));
  }
  clauses.push(
    `m.rating_key NOT IN (
       SELECT rating_key FROM swipe_room_votes WHERE code = @code AND plex_user_id = @uid
     )`
  );
  return getDb()
    .prepare(
      `SELECT m.* FROM media_items m
       WHERE ${clauses.join(' AND ')}
       ORDER BY m.added_at DESC, m.rating_key ASC
       LIMIT @limit`
    )
    .all(params) as MediaItem[];
}

/** Remaining un-swiped titles for this viewer in the room (for the deck count). */
export function countRoomDeckRemaining(room: RoomRow, userId: string): number {
  const params: Record<string, unknown> = { code: room.code, uid: userId };
  const clauses: string[] = ['m.removed = 0'];
  if (room.section_id) {
    clauses.push('m.section_id = @sectionId');
    params.sectionId = room.section_id;
  }
  if (room.watch_mode && ROOM_WATCH_MODES.includes(room.watch_mode)) {
    clauses.push(feedWatchClause(room.watch_mode, params));
  }
  clauses.push(
    `m.rating_key NOT IN (
       SELECT rating_key FROM swipe_room_votes WHERE code = @code AND plex_user_id = @uid
     )`
  );
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM media_items m WHERE ${clauses.join(' AND ')}`)
    .get(params) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// FORK: re-link per-user state across a REPLACED item id (4K upgrades, library
// rebuilds). Upstream keys every per-user table on the mutable rating_key; the
// fork acts on that state (rules/purge), so an orphaned keep is a safety bug.
// ---------------------------------------------------------------------------

/** What `relinkReplacedItems` moved, for the job summary. */
export interface RelinkResult {
  items: number;
  keeps: number;
  skips: number;
  deletes: number;
  verdicts: number;
  watch: number;
}

/**
 * Carry per-user state across a REPLACED item.
 *
 * `rating_key` is the media server's item id, and it is not stable: re-adding a
 * title (the classic case is upgrading a movie to 4K, but any remove+re-add or
 * library rebuild does it) mints a NEW id. Every per-user table is keyed on
 * rating_key, so without this the old row is orphaned onto the tombstone and
 * the live copy comes back **unkept and never-watched** — i.e. unprotected, and
 * matching "big and nobody's watched it" rules on its very first evaluation.
 *
 * Matches a tombstoned item to a live one by shared external id (tvdb for
 * shows / tmdb for movies, falling back to imdb across both — same precedence
 * as the *arr matcher), then moves keeps, skips, "OK to delete", verdicts and
 * watch history onto the new id. Idempotent: once moved, the old rows are gone,
 * so a second run finds nothing.
 *
 * Mutual exclusivity is preserved — a migrated skip/"OK to delete" is dropped
 * if that user already keeps the live item. Watch rows MERGE (plays sum, latest
 * timestamp wins) because the server itself loses UserData on a re-add, making
 * our cached copy the only surviving record.
 *
 * Deliberately does NOT touch `scheduled_deletions`: a pending tag on the dead
 * id is already inert (`dueDeletions` requires `removed = 0`), and carrying one
 * forward would auto-tag a freshly re-added copy.
 */
export function relinkReplacedItems(): RelinkResult {
  const db = getDb();
  const result: RelinkResult = {
    items: 0,
    keeps: 0,
    skips: 0,
    deletes: 0,
    verdicts: 0,
    watch: 0,
  };

  // Live targets, by external id. Kind-scoped for tvdb/tmdb; imdb spans both.
  const byTvdb = ratingKeysByGuid('tvdb');
  const byTmdb = ratingKeysByGuid('tmdb');
  const byImdb = ratingKeysByGuid('imdb');

  // Only tombstones that still carry per-user state are worth examining.
  const stale = db
    .prepare(
      `SELECT rating_key, library_kind, guid_tvdb, guid_tmdb, guid_imdb
         FROM media_items
        WHERE removed = 1
          AND (guid_tvdb IS NOT NULL OR guid_tmdb IS NOT NULL OR guid_imdb IS NOT NULL)
          AND (EXISTS (SELECT 1 FROM keeps        t WHERE t.rating_key = media_items.rating_key)
            OR EXISTS (SELECT 1 FROM user_skips   t WHERE t.rating_key = media_items.rating_key)
            OR EXISTS (SELECT 1 FROM user_deletes t WHERE t.rating_key = media_items.rating_key)
            OR EXISTS (SELECT 1 FROM verdicts     t WHERE t.rating_key = media_items.rating_key)
            OR EXISTS (SELECT 1 FROM watch_history t WHERE t.rating_key = media_items.rating_key))`
    )
    .all() as {
    rating_key: string;
    library_kind: LibraryKind;
    guid_tvdb: string | null;
    guid_tmdb: string | null;
    guid_imdb: string | null;
  }[];
  if (stale.length === 0) return result;

  /** First live id claimed by any of a CSV guid's tokens. */
  const lookup = (csv: string | null, map: Map<string, string>): string | null => {
    if (!csv) return null;
    for (const raw of String(csv).split(',')) {
      const hit = map.get(raw.trim());
      if (hit) return hit;
    }
    return null;
  };

  const move = db.transaction((oldKey: string, newKey: string) => {
    // Keeps first — the exclusivity guards below depend on the final keep set.
    let info = db
      .prepare(
        `INSERT OR IGNORE INTO keeps (plex_user_id, rating_key, kept_at)
         SELECT plex_user_id, ?, kept_at FROM keeps WHERE rating_key = ?`
      )
      .run(newKey, oldKey);
    result.keeps += info.changes;
    db.prepare('DELETE FROM keeps WHERE rating_key = ?').run(oldKey);

    info = db
      .prepare(
        `INSERT OR IGNORE INTO user_skips (plex_user_id, rating_key, skipped_at)
         SELECT s.plex_user_id, ?, s.skipped_at FROM user_skips s
          WHERE s.rating_key = ?
            AND NOT EXISTS (SELECT 1 FROM keeps k
                             WHERE k.rating_key = ? AND k.plex_user_id = s.plex_user_id)
            AND NOT EXISTS (SELECT 1 FROM user_deletes d
                             WHERE d.rating_key = ? AND d.plex_user_id = s.plex_user_id)`
      )
      .run(newKey, oldKey, newKey, newKey);
    result.skips += info.changes;
    db.prepare('DELETE FROM user_skips WHERE rating_key = ?').run(oldKey);

    info = db
      .prepare(
        `INSERT OR IGNORE INTO user_deletes (plex_user_id, rating_key, marked_at)
         SELECT d.plex_user_id, ?, d.marked_at FROM user_deletes d
          WHERE d.rating_key = ?
            AND NOT EXISTS (SELECT 1 FROM keeps k
                             WHERE k.rating_key = ? AND k.plex_user_id = d.plex_user_id)
            AND NOT EXISTS (SELECT 1 FROM user_skips s
                             WHERE s.rating_key = ? AND s.plex_user_id = d.plex_user_id)`
      )
      .run(newKey, oldKey, newKey, newKey);
    result.deletes += info.changes;
    db.prepare('DELETE FROM user_deletes WHERE rating_key = ?').run(oldKey);

    info = db
      .prepare(
        `INSERT OR IGNORE INTO verdicts (plex_user_id, rating_key, verdict, decided_at)
         SELECT plex_user_id, ?, verdict, decided_at FROM verdicts WHERE rating_key = ?`
      )
      .run(newKey, oldKey);
    result.verdicts += info.changes;
    db.prepare('DELETE FROM verdicts WHERE rating_key = ?').run(oldKey);

    // Merge rather than ignore: the re-added item starts with no server-side
    // watch data, so both sides can hold real plays.
    info = db
      .prepare(
        `INSERT INTO watch_history (plex_user_id, rating_key, plays, last_watched)
         SELECT plex_user_id, ?, plays, last_watched FROM watch_history WHERE rating_key = ?
         ON CONFLICT(plex_user_id, rating_key) DO UPDATE SET
           plays = plays + excluded.plays,
           last_watched = MAX(COALESCE(last_watched, 0), COALESCE(excluded.last_watched, 0))`
      )
      .run(newKey, oldKey);
    result.watch += info.changes;
    db.prepare('DELETE FROM watch_history WHERE rating_key = ?').run(oldKey);
  });

  for (const row of stale) {
    const primary =
      row.library_kind === 'show'
        ? lookup(row.guid_tvdb, byTvdb)
        : lookup(row.guid_tmdb, byTmdb);
    const target = primary ?? lookup(row.guid_imdb, byImdb);
    if (!target || target === row.rating_key) continue;
    move(row.rating_key, target);
    result.items++;
  }
  return result;
}

