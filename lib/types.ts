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

/**
 * FORK: one condition row of a deletion rule (rows are AND'd together). Fixed
 * vocabulary — the rule engine turns each into a SQL fragment; kept items and
 * already-tagged items are always excluded on top of these.
 */
export type RuleCondition =
  /** No one on the server has watched it within N days (includes never-played). */
  | { field: 'last_watched_any'; op: 'olderThanDays'; value: number }
  /** Added to the library more than N days ago. */
  | { field: 'added_at'; op: 'olderThanDays'; value: number }
  /** Size on disk above/below N GB. */
  | { field: 'size'; op: 'gtGB' | 'ltGB'; value: number }
  /** In one of these libraries (section ids). */
  | { field: 'library'; op: 'in'; value: string[] }
  /** Whether ANY user requested it via Seerr. */
  | { field: 'requested'; op: 'eq'; value: boolean }
  // --- FORK (3.2): match on what the household actually said ---
  /** The weighted score (VERDICT_POINTS summed over voters); positive = gone. */
  | { field: 'verdict_score'; op: 'gte' | 'lte'; value: number }
  /** How many people gave it a particular verdict. */
  | { field: 'verdict_count'; op: 'gte' | 'lte'; value: number; verdict: Verdict }
  /** One named person said a particular thing (e.g. the requester is done). */
  | { field: 'verdict_by'; op: 'eq'; value: string; verdict: Verdict }
  /** Override the quorum a vote-matching rule needs (see DEFAULT_MIN_VOTERS). */
  | { field: 'min_voters'; op: 'gte'; value: number }
  /** Spell out the baseline guarantee that no one keeps it. Always true — the
   *  match query enforces it regardless; this only makes it visible in the rule. */
  | { field: 'nobody_kept'; op: 'eq'; value: true };

export const RULE_FIELDS = [
  'last_watched_any',
  'added_at',
  'size',
  'library',
  'requested',
  'verdict_score',
  'verdict_count',
  'verdict_by',
  'min_voters',
  'nobody_kept',
] as const;

/**
 * FORK (3.2): the conditions that match on opinions rather than facts. A rule
 * using any of them gets the voter quorum below.
 */
export const VOTE_RULE_FIELDS = ['verdict_score', 'verdict_count', 'verdict_by'] as const;

/**
 * FORK (3.2): how many DISTINCT people must have weighed in before a
 * vote-matching rule may tag anything.
 *
 * Two, by default, so one person's swiping spree can't schedule the library for
 * deletion on its own. It is a default and not a floor: in a two-person house a
 * quorum that never arrives just means the rule never fires, so a rule can set
 * its own `min_voters` (1 = "one clear no is enough"). Rules are admin-only to
 * write, so the override is already behind the right gate.
 */
export const DEFAULT_MIN_VOTERS = 2;

/**
 * FORK (3.2): the quorum a set of conditions actually runs with — an explicit
 * `min_voters`, else the default for vote-matching rules, else `null` for a
 * rule that never consults an opinion (a date/size rule is not held up waiting
 * for votes it doesn't use). The rule builder shows this, the preview reports
 * what it held back, and the match query applies it — one source, so the number
 * on screen is the number that runs.
 */
export function effectiveMinVoters(conditions: RuleCondition[]): number | null {
  const explicit = conditions.find((c) => c.field === 'min_voters');
  if (explicit) return explicit.value as number;
  const votes = VOTE_RULE_FIELDS as readonly string[];
  return conditions.some((c) => votes.includes(c.field)) ? DEFAULT_MIN_VOTERS : null;
}

/**
 * FORK: a swipe verdict. Gestures: right = want_to_watch, up = loved_it,
 * left = not_interested, down = done_with_it, skip = dont_care.
 */
export type Verdict =
  | 'want_to_watch'
  | 'loved_it'
  | 'done_with_it'
  | 'not_interested'
  | 'dont_care';

export const VERDICTS: Verdict[] = [
  'want_to_watch',
  'loved_it',
  'done_with_it',
  'not_interested',
  'dont_care',
];

/**
 * FORK (3.3): the signed weight of each verdict. Positive = the household wants
 * it gone, so an item's score is the sum across voters and the largest scores
 * are the safest to reclaim. Two "let it go" votes (+4) outrank one "worth
 * keeping" (−2) by design. Stored verdict values never change — this is purely
 * a projection. SQL builds its CASE from this map (`verdictPointsSql`) so the
 * scale can't drift between the query and the UI.
 */
export const VERDICT_POINTS: Record<Verdict, number> = {
  not_interested: 2, // "Let it go / delete this shit"
  done_with_it: 1, // "Wouldn't be mad / OK to delete"
  dont_care: 0, // "Skip" — an abstention, deliberately weightless
  want_to_watch: -1, // "Save for later"
  loved_it: -2, // "Worth keeping"
};

/**
 * FORK (3.3): the verdict a keep / "don't care" / "OK to delete" made OUTSIDE
 * Swipe stands in for, so someone who triages in Browse still counts. Only used
 * where that user has no explicit verdict for the item — an actual swipe always
 * wins. Kept as data (not inlined in SQL) so the two vocabularies map in exactly
 * one place.
 */
export const IMPLIED_VERDICTS = {
  keep: 'loved_it',
  skip: 'dont_care',
  okToDelete: 'done_with_it',
} as const satisfies Record<string, Verdict>;

/**
 * FORK (3.6): the order the card control steps through, lowest score (most
 * protective) first, so clicking has a direction rather than being an arbitrary
 * carousel. `null` is the un-voted position that starts and ends the cycle.
 */
export const VERDICT_CYCLE: (Verdict | null)[] = [
  null,
  'loved_it',
  'want_to_watch',
  'dont_care',
  'done_with_it',
  'not_interested',
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
  /** On-disk names/path captured from the media server (NULL until a library
   *  scan records them). Optional: older row casts predate the columns. */
  dir_name?: string | null;
  file_name?: string | null;
  dir_path?: string | null;
  /** Movie: distinct video files merged into the item (>1 = multi-part). */
  file_count?: number | null;
  last_synced: number;
  removed: number;
  // --- FORK: OMDb ratings (guarded-ALTER columns; absent pre-migration) ---
  imdb_rating?: number | null;
  rt_score?: number | null;
  metacritic?: number | null;
  ratings_fetched_at?: number | null;
  // --- FORK: card enrichment from the sync seam (absent pre-migration) ---
  overview?: string | null;
  /** JSON array of genre labels as stored; parse with the card mapper. */
  genres?: string | null;
  runtime_minutes?: number | null;
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
  // --- FORK: OMDb ratings (swipe cards; undefined until the ratings job ran) ---
  imdbRating?: number;
  rtScore?: number;
  metacritic?: number;
  // --- FORK: card enrichment from the backend (undefined when not synced yet) ---
  /** Plot synopsis. */
  overview?: string;
  /** Genre labels. */
  genres?: string[];
  /** Runtime in whole minutes. */
  runtimeMinutes?: number;
  /** FORK: this user's swipe verdict, if any — drives the card's cycle control. */
  myVerdict?: Verdict;
  /** FORK (3.2): the household's weighted score (positive = they want it gone)
   *  and how many people fed it. Undefined when nobody has an opinion — which
   *  is not the same as a score of 0, so the two travel together. */
  verdictScore?: number;
  verdictVoters?: number;
  // --- FORK: scheduled deletion (live tag only) ---
  /** Epoch seconds after which the purge may delete it (undefined = untagged). */
  scheduledDeleteAfter?: number;
  /** True when a keep is currently pausing the countdown. */
  scheduledDeleteHeld?: boolean;
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

/** FORK: one participant in a live swipe room, as the poll surfaces them. */
export interface RoomMember {
  plexUserId: string;
  username: string | null;
  /** True when last_seen is within the presence window (actively polling). */
  active: boolean;
  /** How many titles this member has swiped in the room. */
  votes: number;
  /** True for the current viewer (so the UI can label "you"). */
  isMe?: boolean;
}

/** FORK: full state of a live swipe room, returned by create/join/poll. */
export interface RoomState {
  code: string;
  status: 'open' | 'matched' | 'closed';
  /** True when the current viewer created the room. */
  isHost: boolean;
  sectionId: string | null;
  watchMode: FeedWatchMode | null;
  members: RoomMember[];
  /** Count of members currently within the presence window. */
  activeCount: number;
  /** The agreed title once status === 'matched' (else null). */
  matched: MediaCardData | null;
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

// --- Problems page (admin) ---

/** The problem categories the admin Problems page can show. */
export type ProblemType =
  | 'sizeMismatch' // Plex vs *arr size diverges >10% AND >1 GB
  | 'notInArr' // in the media server, matched by no Sonarr/Radarr instance
  | 'missingFromPlex' // downloaded in *arr but not in the media server (arr_unmatched)
  | 'identityMismatch' // same folder claimed under two different external ids (server vs *arr)
  | 'duplicates' // two+ media items sharing an external id
  | 'arrConflicts' // two *arr instances claiming the same media item
  | 'zeroSize' // media server reports the title but no file bytes
  | 'removedButKept' // gone from the media server while someone still keeps it
  | 'missingIds' // no tvdb/tmdb/imdb id — can never match *arr
  | 'diskOrphans'; // reserved stub (disk-scan job not built yet) — never queryable

/** One pill on the Problems page.
 *  `bytes` semantics vary per category: sizeMismatch = summed |Plex−arr| delta;
 *  missingFromPlex/arrConflicts = summed *arr size on disk; duplicates = summed
 *  member bytes (and `titles` = GROUP count, not item count); zeroSize = always 0;
 *  removedButKept = summed last-known sizes; notInArr/missingIds = summed Plex sizes. */
export interface ProblemCategorySummary {
  type: ProblemType;
  /** False = category can't run (arr not configured / storage unmapped / never scanned). */
  available: boolean;
  /** Reserved for future not-yet-built categories — the UI shows a dimmed
   *  "Planned" pill. (No category sets it today; kept for API stability.) */
  planned?: boolean;
  /** Why an otherwise-buildable category is unavailable — the UI shows a dimmed
   *  pill with a fix-it tooltip instead of hiding it. */
  reason?: 'storage_not_configured' | 'not_scanned';
  titles: number;
  bytes: number;
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
