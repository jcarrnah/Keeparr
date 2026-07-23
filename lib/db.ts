import Database from 'better-sqlite3';
import fs from 'node:fs';
import { DB_PATH, DATA_DIR } from './config';

let db: Database.Database | null = null;

/** Create the schema on a freshly opened database. Exported for tests only —
 *  the app always goes through getDb(). */
export function applySchema(database: Database.Database): void {
  database.pragma('foreign_keys = ON');
  database.exec(`
    -- One row per series (show) or movie. Episodes are NOT stored individually;
    -- a series' size_bytes is the summed total across all episodes/parts/versions.
    CREATE TABLE IF NOT EXISTS media_items (
      rating_key    TEXT PRIMARY KEY,          -- Plex ratingKey (shared id across systems)
      section_id    TEXT NOT NULL,             -- Plex library section id
      library_kind  TEXT NOT NULL,             -- 'movie' | 'show'
      title         TEXT NOT NULL,
      year          INTEGER,
      thumb         TEXT,                       -- relative Plex thumb path
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      added_at      INTEGER,
      guid_tmdb     TEXT,                       -- external ids (CSV when Plex lists several)
      guid_tvdb     TEXT,
      guid_imdb     TEXT,                       -- imdb id(s) ("tt…"); extra arr-match axis
      last_synced   INTEGER NOT NULL,
      removed       INTEGER NOT NULL DEFAULT 0, -- tombstone if gone from Plex
      -- FORK: OMDb ratings (refreshed by the 'ratings' job). Also present here,
      -- not just as migrate() ALTERs: a FRESH db must never take the ALTER path
      -- (parallel next-build prerender workers race through migrate()).
      imdb_rating   REAL,
      rt_score      INTEGER,
      metacritic    INTEGER,
      ratings_fetched_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_media_section ON media_items(section_id);
    CREATE INDEX IF NOT EXISTS idx_media_size ON media_items(size_bytes DESC);
    CREATE INDEX IF NOT EXISTS idx_media_removed ON media_items(removed);
    -- External-id lookups for matching Sonarr (tvdb) / Radarr (tmdb) titles.
    CREATE INDEX IF NOT EXISTS idx_media_guid_tvdb ON media_items(guid_tvdb);
    CREATE INDEX IF NOT EXISTS idx_media_guid_tmdb ON media_items(guid_tmdb);

    -- Per-user keeps. An item is "kept" (protected) if ANYONE keeps it; each user
    -- manages their own keep and can't remove another user's.
    CREATE TABLE IF NOT EXISTS keeps (
      plex_user_id TEXT NOT NULL,
      rating_key   TEXT NOT NULL REFERENCES media_items(rating_key) ON DELETE CASCADE,
      kept_at      INTEGER NOT NULL,
      PRIMARY KEY (plex_user_id, rating_key)
    );
    CREATE INDEX IF NOT EXISTS idx_keeps_item ON keeps(rating_key);

    -- Per-user "don't care" — hides an item from THAT user's random rolls only.
    CREATE TABLE IF NOT EXISTS user_skips (
      plex_user_id TEXT NOT NULL,
      rating_key   TEXT NOT NULL REFERENCES media_items(rating_key) ON DELETE CASCADE,
      skipped_at   INTEGER NOT NULL,
      PRIMARY KEY (plex_user_id, rating_key)
    );
    CREATE INDEX IF NOT EXISTS idx_skips_user ON user_skips(plex_user_id);

    -- Per-user "OK to delete" — the original Seerr requester signing off ("I'm
    -- done with it"). Only allowed on items that user requested. Mutually
    -- exclusive with that user's keep / "don't care". Does NOT override anyone
    -- else's keep: a marked item stays protected while someone keeps it.
    CREATE TABLE IF NOT EXISTS user_deletes (
      plex_user_id TEXT NOT NULL,
      rating_key   TEXT NOT NULL REFERENCES media_items(rating_key) ON DELETE CASCADE,
      marked_at    INTEGER NOT NULL,
      PRIMARY KEY (plex_user_id, rating_key)
    );
    CREATE INDEX IF NOT EXISTS idx_deletes_user ON user_deletes(plex_user_id);
    -- By-item lookup for the "OK to delete by anyone" view + attribution join.
    CREATE INDEX IF NOT EXISTS idx_deletes_item ON user_deletes(rating_key);

    CREATE TABLE IF NOT EXISTS users (
      plex_user_id TEXT PRIMARY KEY,           -- numeric Plex account id
      username     TEXT,
      email        TEXT,
      thumb        TEXT,
      is_admin     INTEGER NOT NULL DEFAULT 0,
      enabled      INTEGER NOT NULL DEFAULT 1,  -- can this account sign in?
      session_epoch INTEGER NOT NULL DEFAULT 0, -- bump to invalidate this user's tokens
      created_at   INTEGER NOT NULL,
      last_login   INTEGER
    );

    -- Per-user watch data cached from Tautulli (for "your top watched").
    CREATE TABLE IF NOT EXISTS watch_history (
      plex_user_id TEXT NOT NULL,
      rating_key   TEXT NOT NULL,              -- grandparent (series) or movie rating_key
      plays        INTEGER NOT NULL DEFAULT 0,
      last_watched INTEGER,
      PRIMARY KEY (plex_user_id, rating_key)
    );
    CREATE INDEX IF NOT EXISTS idx_watch_user ON watch_history(plex_user_id);
    -- By-item lookup for "watched by anyone" (the PK is user-first, so a
    -- rating_key-only probe needs its own index).
    CREATE INDEX IF NOT EXISTS idx_watch_item ON watch_history(rating_key);

    -- Admin-configured connections + app settings. Token values are encrypted
    -- at rest (see lib/crypto.ts) before being stored here.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Single-row sync status (id is pinned to 1). Legacy; superseded by job_state.
    CREATE TABLE IF NOT EXISTS sync_state (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      last_run      INTEGER,
      last_status   TEXT,                       -- 'ok' | 'error' | 'running'
      last_message  TEXT,
      items_synced  INTEGER
    );
    INSERT OR IGNORE INTO sync_state (id, last_status) VALUES (1, 'never');

    -- Per-job status for the scheduled refresh jobs (one row per job id).
    CREATE TABLE IF NOT EXISTS job_state (
      job_id           TEXT PRIMARY KEY,
      last_run         INTEGER,
      last_status      TEXT,                    -- 'never' | 'running' | 'ok' | 'error'
      last_message     TEXT,
      last_duration_ms INTEGER,
      last_result      INTEGER
    );

    -- Seerr requests cached per user (refreshed by the 'requests' job).
    CREATE TABLE IF NOT EXISTS seerr_requests (
      plex_user_id TEXT NOT NULL,
      rating_key   TEXT NOT NULL,
      PRIMARY KEY (plex_user_id, rating_key)
    );
    CREATE INDEX IF NOT EXISTS idx_seerr_user ON seerr_requests(plex_user_id);

    -- Sonarr/Radarr metadata per matched media item (refreshed by the 'arr' job).
    -- One row per matched Plex item (rating_key); quality/tags/status cross-data
    -- for the Quality view. Report-only today; arr_id + instance let a future
    -- action (unmonitor/delete) target the right instance.
    CREATE TABLE IF NOT EXISTS arr_items (
      rating_key     TEXT PRIMARY KEY REFERENCES media_items(rating_key) ON DELETE CASCADE,
      source         TEXT NOT NULL,             -- 'sonarr' | 'radarr'
      instance_id    TEXT NOT NULL,
      instance_name  TEXT NOT NULL,
      arr_id         INTEGER,                   -- Sonarr series id / Radarr movie id
      monitored      INTEGER NOT NULL DEFAULT 0,
      status         TEXT,                      -- raw arr status (continuing/ended/released…)
      quality        TEXT,                      -- movie: file quality; series: profile name
      quality_kind   TEXT,                      -- 'file' | 'profile'
      root_folder    TEXT,
      arr_size_bytes INTEGER,                   -- arr-reported sizeOnDisk (cross-check)
      tags           TEXT,                      -- JSON array of resolved tag labels
      last_synced    INTEGER NOT NULL
    );

    -- Sonarr/Radarr titles that couldn't be matched to a Plex item (no Plex item
    -- carries their tvdb/tmdb id). Surfaced in Settings → Match health. Replaced
    -- wholesale by the 'arr' job.
    CREATE TABLE IF NOT EXISTS arr_unmatched (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL,              -- 'sonarr' | 'radarr'
      instance_id   TEXT NOT NULL DEFAULT '',   -- scopes the per-instance replace
      instance_name TEXT NOT NULL,
      title         TEXT NOT NULL,
      ext_kind      TEXT NOT NULL,              -- 'tvdb' | 'tmdb'
      ext_id        TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL DEFAULT 0, -- on-disk size in *arr (only "downloaded" rows are stored)
      last_synced   INTEGER NOT NULL
    );

    -- Append-only history of scheduled-job runs (for the admin activity log).
    CREATE TABLE IF NOT EXISTS job_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      status      TEXT,                          -- 'ok' | 'error'
      message     TEXT,
      duration_ms INTEGER,
      result      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_job_runs_time ON job_runs(started_at DESC);

    -- FORK: scheduled deletions — admin tags an item "delete after date"; the
    -- nightly 'purge' job deletes eligible items via Sonarr/Radarr. Fork-only
    -- (crosses upstream's "never deletes" line), default OFF and dry-run ON.
    -- Protective keeps always win: an item with ANY active keep is never purged
    -- (status flips to 'held' until the keep goes away).
    CREATE TABLE IF NOT EXISTS scheduled_deletions (
      rating_key    TEXT PRIMARY KEY REFERENCES media_items(rating_key) ON DELETE CASCADE,
      tagged_by     TEXT NOT NULL,          -- plex_user_id of the tagging admin
      tagged_at     INTEGER NOT NULL,
      delete_after  INTEGER NOT NULL,       -- epoch seconds; tagged_at + grace
      status        TEXT NOT NULL DEFAULT 'pending',
                    -- pending | held (keep exists) | deleted | failed | cancelled
      status_at     INTEGER,
      status_detail TEXT,                   -- arr response / error / who cancelled
      notified_week INTEGER NOT NULL DEFAULT 0 -- final-7-days Discord notice sent
    );
    CREATE INDEX IF NOT EXISTS idx_scheddel_due ON scheduled_deletions(status, delete_after);

    -- FORK: rule-based auto-tagging (Maintainerr-style). Conditions are a JSON
    -- array of {field, op, value} AND'd together; the nightly 'rules' job
    -- evaluates enabled rules and INSERTs into scheduled_deletions (INSERT OR
    -- IGNORE — it never overwrites an existing tag of any status, and the
    -- match query itself excludes kept items).
    CREATE TABLE IF NOT EXISTS deletion_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 0,
      conditions  TEXT NOT NULL,              -- JSON RuleCondition[]
      grace_days  INTEGER,                    -- NULL = use the global default
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- FORK: per-user swipe verdicts (movies-first). Two dimensions, not
    -- flattened: want-to-watch vs worth-keeping. Write-through keeps the rest
    -- of the app working: want_to_watch/loved_it upsert into keeps, dont_care
    -- into user_skips, done_with_it/not_interested clear this user's keep and
    -- stand as delete votes (read by deletion rules / consensus views).
    CREATE TABLE IF NOT EXISTS verdicts (
      plex_user_id TEXT NOT NULL,
      rating_key   TEXT NOT NULL REFERENCES media_items(rating_key) ON DELETE CASCADE,
      verdict      TEXT NOT NULL,
        -- want_to_watch : never seen, interested        → implies keep
        -- loved_it      : seen, would rewatch           → implies keep
        -- done_with_it  : seen, finished with it        → soft delete vote
        -- not_interested: never seen, never will        → delete vote
        -- dont_care     : abstain                       → maps to user_skips
      decided_at   INTEGER NOT NULL,
      PRIMARY KEY (plex_user_id, rating_key)
    );
    CREATE INDEX IF NOT EXISTS idx_verdicts_item ON verdicts(rating_key);

    -- App event log (shown on the Settings → Logs page).
    CREATE TABLE IF NOT EXISTS logs (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      level   TEXT NOT NULL,                     -- 'info' | 'warn' | 'error'
      source  TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
  `);

  migrate(database);
}

/** Idempotent column migrations for databases created before a column existed. */
function migrate(database: Database.Database): void {
  const cols = database
    .prepare(`PRAGMA table_info(users)`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === 'enabled')) {
    database.exec(
      `ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`
    );
  }
  if (!cols.some((c) => c.name === 'session_epoch')) {
    database.exec(
      `ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0`
    );
  }

  // arr_unmatched gained size_bytes (to show downloaded-but-not-in-Plex sizes).
  // It's a cache table the 'arr' job rebuilds wholesale, so a default 0 is fine.
  const arrUnCols = database
    .prepare(`PRAGMA table_info(arr_unmatched)`)
    .all() as { name: string }[];
  if (arrUnCols.length > 0 && !arrUnCols.some((c) => c.name === 'size_bytes')) {
    database.exec(
      `ALTER TABLE arr_unmatched ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0`
    );
  }
  // arr_unmatched gained instance_id (scopes the per-instance replace so one
  // failed instance doesn't lose its cached rows). A '' row is never in a
  // preserve list, so it's swept up by the next successful arr run.
  if (arrUnCols.length > 0 && !arrUnCols.some((c) => c.name === 'instance_id')) {
    database.exec(
      `ALTER TABLE arr_unmatched ADD COLUMN instance_id TEXT NOT NULL DEFAULT ''`
    );
  }

  // FORK: scheduled_deletions gained notified_week (final-7-days Discord notice
  // sent) after the table first shipped — guarded ALTER for those fork DBs.
  const sdCols = database
    .prepare(`PRAGMA table_info(scheduled_deletions)`)
    .all() as { name: string }[];
  if (sdCols.length > 0 && !sdCols.some((c) => c.name === 'notified_week')) {
    try {
      database.exec(
        `ALTER TABLE scheduled_deletions ADD COLUMN notified_week INTEGER NOT NULL DEFAULT 0`
      );
    } catch (e) {
      if (!String(e).includes('duplicate column name')) throw e;
    }
  }

  // media_items gained guid_imdb (an extra arr-match axis). Backfilled to NULL;
  // the next library scan populates it. Additive, no data touched.
  const mediaCols = database
    .prepare(`PRAGMA table_info(media_items)`)
    .all() as { name: string }[];
  if (mediaCols.length > 0 && !mediaCols.some((c) => c.name === 'guid_imdb')) {
    database.exec(`ALTER TABLE media_items ADD COLUMN guid_imdb TEXT`);
  }

  // FORK: external ratings from OMDb — ALTERs for databases created before the
  // columns were in the CREATE block above. try/catch because two processes
  // opening the same fresh file (next-build prerender workers) can both pass
  // the PRAGMA guard and race the ALTER; "duplicate column" just means the
  // other process won.
  for (const [col, type] of [
    ['imdb_rating', 'REAL'], // 0–10
    ['rt_score', 'INTEGER'], // Rotten Tomatoes %
    ['metacritic', 'INTEGER'], // 0–100
    ['ratings_fetched_at', 'INTEGER'], // epoch; set even on a miss (no refetch loop)
  ] as const) {
    if (mediaCols.length > 0 && !mediaCols.some((c) => c.name === col)) {
      try {
        database.exec(`ALTER TABLE media_items ADD COLUMN ${col} ${type}`);
      } catch (e) {
        if (!String(e).includes('duplicate column name')) throw e;
      }
    }
  }

  // Migrate the legacy global keeps table (rating_key PK, kept_by) to per-user
  // (plex_user_id, rating_key). The new applySchema CREATE only runs on a fresh
  // DB; existing DBs still have the old shape until rebuilt here.
  const keepCols = database
    .prepare(`PRAGMA table_info(keeps)`)
    .all() as { name: string }[];
  if (keepCols.length > 0 && !keepCols.some((c) => c.name === 'plex_user_id')) {
    // A leftover keeps_new can only be an orphaned partial copy from a crash
    // mid-rebuild (this branch only runs while keeps is still legacy-shape) —
    // drop it and redo, else CREATE TABLE below would fail and block boot.
    database.exec('DROP TABLE IF EXISTS keeps_new');
    // One transaction so a crash rolls back to the intact legacy table —
    // autocommit-per-statement left windows that boot-looped or silently
    // emptied keeps.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE keeps_new (
          plex_user_id TEXT NOT NULL,
          rating_key   TEXT NOT NULL REFERENCES media_items(rating_key) ON DELETE CASCADE,
          kept_at      INTEGER NOT NULL,
          PRIMARY KEY (plex_user_id, rating_key)
        );
        INSERT OR IGNORE INTO keeps_new (plex_user_id, rating_key, kept_at)
          SELECT kept_by, rating_key, kept_at FROM keeps;
        DROP TABLE keeps;
        ALTER TABLE keeps_new RENAME TO keeps;
        CREATE INDEX IF NOT EXISTS idx_keeps_item ON keeps(rating_key);
      `);
    })();
  }
}

function init(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const database = new Database(DB_PATH);
  database.pragma('journal_mode = WAL');
  applySchema(database);
  return database;
}

export function getDb(): Database.Database {
  if (!db) {
    db = init();
  }
  return db;
}

/**
 * Close the singleton so the database file can be swapped (backup restore).
 * The next getDb() reopens it — and runs applySchema()/migrate(), so restoring
 * an older backup upgrades it automatically. Safe because better-sqlite3 is
 * synchronous: no statement is ever held across an await, so nothing can be
 * mid-query when this runs. All statements are prepared per-call via getDb()
 * (see lib/queries.ts), so nothing references the closed handle afterwards.
 */
export function closeDbForSwap(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Test helper: replace the singleton with a fresh in-memory database so tests
 * run against a real SQLite instance (no mocks) in full isolation. Call in
 * beforeEach. Never used by the app at runtime.
 */
export function __setTestDbToMemory(): Database.Database {
  if (db) db.close();
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  applySchema(db);
  return db;
}

/** Test helper: close and clear the singleton. Call in afterAll. */
export function __closeDb(): void {
  closeDbForSwap();
}
