# Keeparr Fork Plan (jcarrnah fork)

Fork of https://github.com/drohack/Keeparr (Next.js 15 App Router, React 19,
better-sqlite3, Tailwind, Vitest). Upstream ships v0.2.x–v0.3.x via ghcr on
every push. Keep upstream mergeable: prefer **additive** changes (new tables,
new routes, new query params, new pages) over rewriting existing files.

```
git clone git@github.com:<me>/Keeparr.git
git remote add upstream https://github.com/drohack/Keeparr.git
# periodically: git fetch upstream && git merge upstream/main
npm install && npm run verify   # vitest + next build must stay green
```

Target environment: Jellyfin on Unraid (jcarrnah.com), Sonarr/Radarr present,
Discord available (JC Access bot exists and can be reused for notifications).

---

## Phase 0 — Verify the Jellyfin backend (do this first)

Upstream README: Jellyfin/Emby support is written to documented APIs but
**never tested against a live server** — treat as beta. Before building
anything:

1. Stand the app up against the real Jellyfin instance (username/password
   login, first login becomes Owner).
2. Exercise: library sync, poster images, per-user watch history ingestion
   (native Jellyfin — no Tautulli needed), sizes on disk, the keep loop,
   Browse filters (especially the Watched filter buckets).
3. Fix whatever breaks in `lib/jellyfin.ts` / `lib/mediaserver/*`. Add or
   extend tests in `lib/jellyfin.test.ts` for each fix.
4. Consider upstreaming Phase 0 fixes as PRs — they benefit everyone and
   keep the fork's diff small.

---

## Phase 1 — Core fork features

### 1.1 Watch-history voting lists in the keep loop

Goal: instead of one big weighted feed, selectable lists — **Never played
(by anyone)**, **Not watched in 90+ days**, **Recently watched (30d)**,
**My unwatched** — so votes can be gathered on coherent slices.

Most of the machinery exists. `lib/queries.ts` already implements watch
predicates for the Browse page (`watched`, `unwatched`, `unwatchedAny`,
recency windows via `watch_history.last_watched`); they are just not wired
into the feed.

Changes:
- `app/api/feed/random/route.ts`: accept `watch=<mode>` query param
  (`never_played | stale_90 | recent_30 | my_unwatched`). Pass through to
  queries.
- `lib/queries.ts`: thread a `watchMode` option into `getFeed()` /
  `getFeedAll()` / `countFeedRemaining()`, reusing the existing WHERE
  fragments (never_played = the `unwatchedAny` NOT EXISTS subquery;
  stale/recent use `wh.last_watched` vs cutoff).
- `app/page.tsx`: add list tabs alongside the existing library/Largest
  switcher; persist selection like the current section choice.
- Show per-list remaining count (already returned by
  `countFeedRemaining`).
- Tests: extend `lib/queries.test.ts` feed cases for each mode.

Small, contained diff. Ship this first.

### 1.2 Scheduled deletion tagging + purge job

Goal: tag items "delete after date"; a nightly job deletes eligible items
via Radarr/Sonarr. This deliberately crosses upstream's "never deletes"
line — fork-only feature, keep it clearly separated and default-OFF.

Design principles:
- **Protective keeps still win.** An item with ANY active keep is never
  purged, regardless of tag. A new keep cancels/pauses the countdown.
- **Delete via the arrs, never the filesystem.** Use existing `lib/arr.ts`
  matching (`arr_items` table). Radarr: `DELETE /api/v3/movie/{id}?deleteFiles=true&addImportExclusion=false`.
  Sonarr: `DELETE /api/v3/series/{id}?deleteFiles=true`. Items with no arr
  match are reported, not deleted.
- **Audit everything** through the existing `job_runs` + logs tables.

New table (add to `lib/db.ts`, additive):

```sql
CREATE TABLE IF NOT EXISTS scheduled_deletions (
  rating_key    TEXT PRIMARY KEY REFERENCES media_items(rating_key) ON DELETE CASCADE,
  tagged_by     TEXT NOT NULL,          -- plex_user_id (admin)
  tagged_at     INTEGER NOT NULL,
  delete_after  INTEGER NOT NULL,       -- epoch seconds; tagged_at + grace
  status        TEXT NOT NULL DEFAULT 'pending',
                -- pending | held (keep exists) | deleted | failed | cancelled
  status_at     INTEGER,
  status_detail TEXT                    -- arr response / error / who cancelled
);
CREATE INDEX IF NOT EXISTS idx_scheddel_due ON scheduled_deletions(status, delete_after);
```

Changes:
- Settings (Settings → new "Deletion" card): master enable toggle
  (default OFF), grace period days (default 30), dry-run mode (default ON —
  logs what WOULD be deleted).
- API: `POST/DELETE /api/admin/scheduled-deletions` (tag/untag, admin
  only), `GET` list with status.
- Job: new `purge` job in `lib/jobs.ts` + `lib/scheduler.ts` (nightly).
  Eligibility: `status='pending' AND delete_after <= now AND NOT EXISTS
  keep`. Held items (keep appeared) flip to `held` and back if the keep is
  removed.
- Browse page: add "Scheduled for deletion" status bucket to the existing
  Status filter dropdown; badge with the date on cards.
- Rescue path: any user keeping an item cancels/holds its deletion —
  surface this ("Keeping this cancels its scheduled deletion").
- Tests: eligibility query, keep-cancels-purge, dry-run behavior.

### 1.3 Rule-based auto-tagging (Maintainerr-style)

Goal: rules like *"not watched by anyone in 180d AND added > 365d ago AND
size > 20 GB → auto-tag with 30d grace."*

- New table `deletion_rules` (JSON conditions, enabled flag, grace
  override). Rule engine generates SQL against `media_items` +
  `watch_history` + `keeps` — mirror the filter-builder style already in
  `libraryItems()` in `lib/queries.ts`.
- Nightly `rules` job evaluates rules and inserts into
  `scheduled_deletions` (never overwrites a manual tag; never tags kept
  items).
- Admin UI: simple rule builder (condition rows: field / op / value).
- Start with a fixed condition vocabulary: last_watched_any, added_at,
  size, library, kept_by_anyone, requested (seerr_requests).

### 1.4 "Leaving Soon" Jellyfin collection + Discord notifications

- Job step after tagging: sync a **"Leaving Soon"** collection in Jellyfin
  (create collection via API, add/remove items to mirror
  `scheduled_deletions` where status=pending). Household members see doomed
  titles in Jellyfin itself and can rescue via Keeparr.
- Notifications (upstream parked these in Tier 3 — build fork-side):
  Discord webhook agent, events: item tagged, item entering final 7 days,
  purge summary (what was deleted + GB reclaimed), purge failures. Config
  in Settings. Optionally route through the existing JC Access bot instead
  of a bare webhook.

---

## Phase 2 — Swipe mode ("Tinder for the library")

Goal: a card-stack swipe UI over the movie library — poster, title, year,
overview, genres, runtime, IMDb rating, RT score — producing per-user
verdicts that feed BOTH movie-night matchmaking and keep/delete decisions.

Prior art: KinoSwipe (Bergasha/kino-swipe) does session-based match
swiping for Plex/Jellyfin. This differs: verdicts are **persistent,
per-user, library-wide**, and integrate with keeps/deletions.

Build INSIDE the fork (auth, sync, users, watch history, poster proxy, PWA
manifest all already exist). Movies-first; series stay in the classic keep
loop for now (per-series keep semantics are a separate design problem).

### 2.1 Verdicts schema

Two dimensions matter: *want to watch* vs *worth keeping*. Don't flatten
them.

```sql
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
```

Mapping into existing tables (write-through so the rest of the app just
works): `want_to_watch`/`loved_it` upsert into `keeps`; `dont_care` into
`user_skips`; `done_with_it`/`not_interested` clear that user's keep and
count as delete votes (feed 1.3 rules: e.g. "N delete votes AND no keeps →
auto-tag").

Gestures: right = want_to_watch, up = loved_it, left = not_interested,
down = done_with_it, tap-skip = dont_care. (Buttons on desktop.)

### 2.2 Ratings enrichment (IMDb / RT)

- Jellyfin already provides overview, genres, runtime, year,
  CommunityRating, and ProviderIds (IMDb id) — persist the IMDb id during
  sync if not already stored.
- OMDb API (free key, ~1000 req/day) returns IMDb rating + RT + Metacritic
  by IMDb id. Add columns to `media_items` (additive migration):
  `imdb_id`, `imdb_rating`, `rt_score`, `metacritic`, `ratings_fetched_at`.
- New `ratings` job: backfill respecting the daily cap (resume cursor in
  `job_state`), then refresh stale (>90d) entries. OMDb key in Settings
  (encrypted like other secrets via `lib/crypto.ts`).

### 2.3 Swipe UI

- New page `app/swipe/page.tsx` + `GET /api/swipe/deck` (reuses feed
  query machinery; excludes items the user already has a verdict on;
  supports the same `watch=` list modes from 1.1 — e.g. swipe only "never
  played").
- Card stack: framer-motion is the easy path, but upstream is
  dependency-light — a small pointer-events implementation keeps the
  bundle lean. Either is acceptable; prefer no new deps if reasonable.
- `POST /api/swipe/verdict` with undo (5-swipe buffer client-side).
- PWA: add a "Swipe" shortcut to `app/manifest.ts`.

### 2.4 Results & matchmaking

- **Movie night**: items where ≥2 chosen users have `want_to_watch` and
  (optionally) nobody has watched — "You and Sam both want to watch these
  7 movies." Page: `app/swipe/matches`.
- **Consensus report**: per-item verdict rollup (who wants it, who's done
  with it) on the item hover/detail and as a sortable list — feeds the
  human decision of what to tag for deletion.
- Optional later: live session mode with a room code (KinoSwipe-style)
  once the async version works.

---

## Sequencing

1. Phase 0 (Jellyfin verification) — everything depends on it.
2. 1.1 feed lists (small win, immediately useful for gathering votes).
3. 2.1–2.3 swipe mode (gets the household actually generating data).
4. 1.2 scheduled deletions (dry-run ON for the first weeks).
5. 1.3 rules + 1.4 Leaving Soon/Discord.
6. 2.4 matchmaking polish.

Rules of the road for every phase: `npm run verify` green before merge;
additive schema only (upstream uses CREATE TABLE IF NOT EXISTS boot-time
migration style — follow it); new features behind settings toggles,
default OFF where destructive; update `openapi.json` for new endpoints.
