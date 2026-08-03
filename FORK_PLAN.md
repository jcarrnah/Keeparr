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

---

# Phase 3

Written up 2026-07-30 after the first live purge exposed gaps. Phases 1–2 are
shipped. **3.1, 3.3 and 3.6 are built (2026-07-30)**; 3.2, 3.4 and 3.7 are still
designed-but-unimplemented, and 3.5 is a standing decision. Read
[FORK_SYNC.md](FORK_SYNC.md) before touching upstream-owned files.

## 3.1 Deletion history UI — BUILT 2026-07-30

**Why.** The fork runs destructive automation whose only audit trail today is a
raw JSON endpoint. There is no screen anywhere that lists what was tagged,
what got deleted, and what failed — `components/MediaCard.tsx` is the sole
surface, and it only shows a per-card badge.

This bit us: after a live purge the question "did it actually delete?" was
genuinely hard to answer, because

- `logs` keeps only the newest **1000** rows and `job_runs` only the newest
  **100** runs (`lib/queries.ts`), and *every* job run logs a line. With
  `recentlyAdded` on a 5-minute interval (288 runs/day) that's roughly **3 days**
  of app log and **~8 hours** of job history. A purge from last week is gone
  from both — pruned, not absent.
- Browse's tag join is restricted to live tags
  (`AND sd.status IN ('pending','held')`), so a *successful* purge makes its
  tags vanish from the "Scheduled for deletion" filter. An empty view reads as
  "nothing ever happened" when it actually means "it completed".

Meanwhile `scheduled_deletions` rows are permanent — nothing in the codebase
deletes them and no hard-delete of `media_items` can cascade them away. The
data is all there; it just isn't visible.

**As built.** A dedicated admin page rather than a settings card — the content
is a full table plus rollups, and it's an operational screen, not a preference.

- `app/deletions/page.tsx` → `components/DeletionHistoryView.tsx`, with a rail
  entry (admin-only, beside Problems). Both fork-owned; `AppShell` takes two
  lines.
- Status pills with counts (`pending`/`held`/`deleted`/`failed`/`cancelled`),
  each carrying a plain-language explanation on hover — a count of zero is a
  real answer, so the pills show even when empty.
- Three reclaim tiles: **actually reclaimed** (measured), **left behind**, and
  **unverified**. The measured figure spans VERIFIED deletions only; the ones
  whose disk couldn't be checked are counted separately rather than assumed
  successful. `residue_bytes` null ≠ 0 anywhere in this UI.
- The table shows `statusDetail` (which *arr instance did it, or why it
  failed), who tagged it — rule tags read "a rule", since `tagged_by` is
  `rule:<id>` and joins no user — and a Cancel action on live tags.
- `deletionResidueItems()` gets its own "said reclaimed, didn't" list under the
  table; it was previously reachable only from tests.
- `GET /api/admin/scheduled-deletions` grew `verifiedAt`/`residueBytes`,
  `summary`, `reclaim` and `residueItems`. Retention was left alone — the
  `scheduled_deletions` row already IS the durable store, so raising
  `job_runs` would only duplicate it.

## 3.2 Verdict-aware deletion rules — BUILT 2026-07-31

**Why.** Rules currently match on objective facts only — `last_watched_any`,
`added_at`, `size`, `library`, `requested` (`ratingKeysMatchingRule`,
`lib/queries.ts`). The household is generating opinions through Swipe and those
opinions are never consulted, so a title everyone voted to dump still has to
age out on a date rule.

**Build.** New `RuleCondition` fields in `lib/types.ts`, validated in
`parseRuleConditions`, evaluated in `ratingKeysMatchingRule`:

- `verdict_score` (`gte`/`lte` N) — the weighted total from 3.3. "Tag anything
  scoring ≥ 3" is the headline rule.
- `verdict_count` (verdict, op, N) — e.g. at least 2 `not_interested` votes.
- `verdict_by` (user, verdict) — e.g. the original requester marked it
  `done_with_it`.
- `nobody_kept` — no keep from anyone (the existing baseline already excludes
  kept items, so this is mainly for explicit rules).

Keep the existing safety baseline untouched: `m.removed = 0`, no keep exists,
no existing `scheduled_deletions` row.

**The minimum-voters guard — decided 2026-07-30: keep it, but make it
overridable.** The original design made it a mandatory hidden floor, so a rule
matching on votes wouldn't fire until N distinct people had weighed in. That's
the right default — one person's swiping spree shouldn't be able to tag the
library — but it's wrong as an absolute: in a two-person household, waiting for
a quorum that will never arrive just means the rule never fires.

So:

- Vote-matching rules carry a **default minimum of 2 distinct voters**, applied
  automatically so a rule written carelessly is still safe.
- Each rule can **override it** — `min_voters` as an explicit condition,
  including `1` for "one clear no is enough". Rules are admin-only to create
  and edit, so the override is already admin-gated; no separate permission is
  needed.
- Show the effective value in the rule builder rather than leaving it implicit,
  and reflect it in the preview count — "would tag 12 items (3 held back:
  only one voter)" is far more useful than a silently smaller number.

The remaining safety net is unchanged either way: keeps always win, the grace
period still runs, and Discord announces every tag.

**As built (2026-07-31).** All five conditions landed as described, validated in
`parseRuleConditions` and evaluated in `ratingKeysMatchingRule` over the same
`VOTES_CTE`/`ITEM_SCORES_CTE` as Browse and consensus — so an "OK to delete"
made in Browse satisfies a `verdict_by … done_with_it` rule, exactly as a swipe
would. Notes on the edges:

- `effectiveMinVoters()` (`lib/types.ts`) is the single decider of the quorum;
  the SQL, the preview route and the rule builder all call it, so the number on
  screen can't drift from the number that runs. No vote condition → no quorum.
- `min_voters` and `nobody_kept` emit no per-item SQL: the quorum is applied
  once (two competing thresholds would be ambiguous — the parser refuses a
  second `min_voters`), and the keep exclusion is already in the baseline.
  `nobody_kept` accepts only `true`; `false` would be a rule that can never
  match, which is a typo rather than an intention.
- `verdict_score` thresholds are signed and un-voted titles count as 0, matching
  Browse's `minScore`, so "≥ 1" means somebody actively wants it gone.
- The preview reports `minVoters` + a full exclusion breakdown
  (`heldByQuorum`/`excludedKept`/`excludedTagged`, from `ruleExclusionCounts()`
  in one pass with precedence kept→tagged→quorum). Added 2026-07-31 after the
  user hit the obvious confusion: **Browse's score filter lists far more than a
  rule with the same threshold**, because Browse applies none of the rule
  baseline — no keep exclusion, and no exclusion of titles already counting
  down. The four numbers partition the condition matches exactly, so the
  preview reconciles with Browse instead of looking broken.
- **Policy change, 2026-07-31 (user's call): a finished tag no longer blocks a
  rule.** Previously ANY `scheduled_deletions` row did, so cancelling a tag
  once made that title permanently invisible to every future rule — "something
  getting cancelled shouldn't make it immutable from further changes". Now only
  `pending`/`held` block. `cancelled`/`failed`/`deleted` are re-taggable and
  `insertRuleTags` upserts over them, carrying the old outcome into
  `status_detail`. The user was offered a cooling-off window (30d/7d) and chose
  the simple version — a cancelled title a rule still matches gets re-tagged on
  the next nightly run, and **keeping** is the way to protect it for good.
  Consequence to watch: with an enabled rule, "cancel" alone is a temporary
  reprieve. If that turns out to nag, the cooling-off design is the fallback.

**Also asked for at the same time** (2026-07-30) — score needs to be usable
*outside* the rules engine, so tagging decisions can be reviewed by hand:

- **Browse by score — BUILT 2026-07-31.** `sort=score` and `minScore=<n>` on
  `/api/library`; rows carry `verdictScore`/`verdictVoters`. `queryLibrary`
  joins `ITEM_SCORES_CTE` over the SAME `VOTES_CTE` the consensus screen uses,
  so a title can't score differently on the two screens — implied votes
  included. Two deliberate asymmetries: an un-voted title has a NULL score and
  sorts last in **both** directions (silence is not a keep signal), while
  `minScore` reads it as 0 (so a threshold of ≤ 0 filters nothing). UI: a
  "Household score" grid sort, a sortable Score column in List view, a
  "Score ≥ +N" dropdown, and `components/ScoreBadge.tsx` on cards and rows —
  the score is visible wherever you can sort by it, with its voter count beside
  it so a +4 from one person doesn't read like a +4 from four. Search is
  deliberately left out: `SearchRow.score` is already relevance, and a second
  meaning for that word there would be a trap.
  **This is the sanity check for the rest of 3.2** — a `verdict_score >= 3` rule
  should now be previewable as a Browse query first.
- **Better consensus review — BUILT 2026-07-31.** Click a row to expand a
  who-said-what panel (`voteDetail()` in `MatchesView`), ordered worst-first so
  it reads the same direction as the score, with implied opinions labelled by
  their source ("kept it" / "marked OK to delete" / "said don't care"). Needed
  two new query columns: `skip_names`/`skip_implicit_names` (the shruggers had
  only ever been counted, which is fine for a cell and useless for "what did
  Sam say"), and a LIVE-tag-only join for `scheduled_delete_after`/`_status`.
  Admins with deletion enabled get Schedule/Cancel in the panel — the decision
  now happens where the evidence is instead of requiring a trip to Browse to
  find the title again. A kept item still tags as `held`, and the button says
  so before you press it.

## 3.3 Weighted vote scoring ("points") — BUILT 2026-07-30

**Why.** `verdictConsensus` currently reports `delete_votes` as a flat count of
`done_with_it + not_interested` (`lib/queries.ts`), which flattens a shrug and
a hard no into the same number, and ignores keep-side votes entirely. A signed
score orders the library by how much the household actually wants something
gone.

**The scale** (agreed 2026-07-30). Positive = wants it gone:

| Verdict | Swipe label | Points |
|---|---|---|
| `not_interested` | "Let it go / delete this shit" | **+2** |
| `done_with_it` | "Wouldn't be mad / OK to delete" | **+1** |
| `dont_care` | "Skip" | **0** |
| `want_to_watch` | "Save for later" | **−1** |
| `loved_it` | "Worth keeping" | **−2** |

An item's score is the sum across all voters, so two "let it go" votes (+4)
outrank one "worth keeping" (−2). Stored verdict values do not change — this is
purely a projection over `verdicts`.

**As built.**
- `VERDICT_POINTS` in `lib/types.ts`, beside `VERDICTS`. SQL generates its CASE
  from it (`verdictPointsSql`), so the scale exists once.
- `verdictConsensus` returns a summed `score` + `voters` and accepts
  `sort: 'score'` plus `voter`/`verdict` filters — the filter is an EXISTS over
  the same vote set, so slicing the list never narrows a surviving row's
  rollup. `consensusVoters()` backs the picker.
- `/swipe/matches` Consensus tab: Score column (sortable, signed, greyed while
  someone keeps it), voter + verdict dropdowns, Clear.
- **Implicit votes** (the 3.4 decision, settled 2026-07-30 — see below): a keep
  / "don't care" / "OK to delete" with no verdict behind it counts as
  `loved_it` / `dont_care` / `done_with_it` via `IMPLIED_VERDICTS` and the
  `VOTES_CTE` UNION. An explicit verdict always wins for that (user, item), and
  because the three source tables are mutually exclusive per user nobody is
  counted twice — including the keep `applyVerdict` itself writes.
- Implied names come back in `*_implicit_*` columns and render as "Sam (kept)",
  so an inference never reads as a swipe.
- Browse sorts and filters by the same score as of 2026-07-31 (see 3.2).
- Still to do: feed `score` to 3.2's `verdict_score` condition.

## 3.4 Are Keep / Browse / Swipe actually in sync?

**The question** (raised 2026-07-30): "Is the keep section linked to the browse
/ swipe section, and is swipe linked to browse? They don't feel in sync."

**What's true today.** They share state through the same tables, and mostly
agree:

| Surface | Excludes |
|---|---|
| Keep feed (`FEED_ELIGIBILITY`) | any keep (anyone's), **my** skip, **my** OK-to-delete |
| Swipe deck (`getSwipeDeck`) | the same, **plus my existing verdicts** |
| Browse (default `state=undecided`) | kept, **my** skip, **my** OK-to-delete |

So Swipe is strictly narrower than Keep — anything you've already swiped is
gone from it but still visible elsewhere. That alone explains a lot of the
"out of sync" feeling, and it's working as designed.

**The real gap — the write-through is one-way.** `applyVerdict` writes through
to `keeps`/`user_skips`, so swiping updates the keep state. But keeping an item
in **Browse or Keep does not record a verdict**. Consequences:

- Someone who does all their triage in Browse never appears in
  `verdictConsensus` or Movie night — they have opinions, but no votes.
- **This directly undercuts 3.3's scoring**: a household member who keeps
  things in Browse contributes 0 points, while a swiper contributes ±2.

**Decided 2026-07-30, and both halves are now built:**
1. **Scoring infers the missing votes** rather than staying swipe-only. A keep
   counts as `loved_it` (−2), a "don't care" as `dont_care` (0), an "OK to
   delete" as `done_with_it` (+1) — only where that person has no verdict for
   the item. See 3.3.
2. **The card control speaks verdicts**, so the gap stops widening: Browse
   (grid + list) and Search cycle all five states instead of toggling a keep.
   See 3.6.

Together these mean the two vocabularies now converge from both ends —
inference covers the history, the cycle control covers new triage. The Keep
page deliberately keeps its own keep/skip batch loop; its keeps are inferred
like any other.

**Also worth knowing** (this is what made Murderbot look broken): an item can
appear in Keep but not Browse with no decision recorded at all, because Browse
carries **sticky filters** the Keep feed doesn't — the library selection in the
rail, plus any quality/status/watched/arr filters. Search (`/api/search`)
applies none of them, so it's the quickest way to prove an item exists before
hunting for the filter hiding it.

**Still to do.** Verify the deck/feed/Browse exclusion table end-to-end with a
live account — it's read from the SQL, not observed.

## 3.5 Decision to revisit: keep syncing, or hard-fork?

**The question** (raised 2026-07-30): "Maybe we should just fork it, because
we're adding too much stuff?" — i.e. stop tracking `drohack/Keeparr` and own
the codebase outright.

**Not yet — but here's the evidence, so it's a decision and not a vibe.**

What the v0.3.13 sync actually cost (the only real data point so far): 14
conflicted files, and **zero of them were fork-owned**. Every conflict was
mechanical — version strings, two field lists that needed unioning, two
append-at-EOF blocks, and doc prose. One session, no logic merged by hand. The
"keep fork logic in fork-owned modules" discipline is doing its job; that's
also why Phases 1–3's new code sits in `lib/purge.ts`, `lib/rules.ts`,
`lib/rooms.ts`, `lib/purge-verify.ts`, `lib/post-delete-cleanup.ts` and
`components/ForkProblemActions.tsx` rather than inline.

What syncing buys, concretely: that same merge delivered the entire **Problems
page + disk-orphan scan** — the feature this whole round of work was built on
top of, for free. Plus upstream's security hardening, dependency bumps, the
Jellyfin/Emby backend seam, and the CI/release pipeline. A hard fork inherits
all of that as *your* maintenance: Next.js upgrades, `better-sqlite3` rebuilds,
media-server API drift, CVE response.

What genuinely pushes toward divergence: Phase 3.2/3.3 reach into shared
code (`ratingKeysMatchingRule`, `verdictConsensus`) more deeply than anything so
far, and upstream will never take the deletion features — they cross its stated
"never deletes" line.

**Trigger conditions — revisit the moment any of these happen:**
1. A sync produces conflicts **inside fork-owned modules**, or requires
   hand-merging fork logic (so far: never).
2. Upstream refactors something the fork hooks structurally — the `lib/queries.ts`
   SQL layout, the `lib/mediaserver/*` seam, or `FEED_ELIGIBILITY`.
3. A sync costs more than roughly a day, twice running.
4. The fork needs to change upstream *behavior* rather than add to it. Additive
   is cheap; changing existing semantics is what makes merges painful.

**Cheaper middle paths, in order of preference:**
- **Contribute the generic fixes upstream.** The keep re-link (3.1's sibling —
  `relinkReplacedItems`) is a real upstream bug: their keeps are orphaned by any
  4K re-add too. Upstreaming it deletes fork surface permanently.
- Keep pushing shared-file edits toward end-of-file fork sections (already the
  convention — see FORK_SYNC.md).
- Pin to upstream tags and sync deliberately per release rather than tracking
  `main`, so syncs are scheduled work rather than surprises.

Related, still unresolved: the repo is a **public** GitHub fork. GitHub can't
make a fork private — going private means detaching (which is the hard-fork
decision) or a fresh repo. Raised previously; no action requested.

## 3.6 Click-to-cycle verdict control on cards — BUILT 2026-07-30

**The idea** (raised 2026-07-30): "Clicking on it should cycle all states, since
we have 5 now."

Today a card's keep control is effectively binary (keep / not), while the five
verdicts are only reachable by swiping. Turning the card control into a
**cycling verdict button** would make every surface speak the same vocabulary —
and it's the cleanest fix for the asymmetry in [3.4](#34-are-keep--browse--swipe-actually-in-sync)
and the scoring gap in [3.3](#33-weighted-vote-scoring-points): people who
triage in Browse would finally produce votes instead of silent keeps.

**Cycle order** — follow the points scale so the control has a direction rather
than being an arbitrary carousel:

```
none → Worth keeping (−2) → Save for later (−1) → Skip (0)
     → Wouldn't be mad (+1) → Let it go (+2) → none
```

Six positions counting the empty state.

**As built.** It **replaces** the keep interaction (the user's call, over
sitting beside it or hiding behind a preference): one vocabulary everywhere was
the point, and two controls driving overlapping state is exactly the confusion
3.4 describes.

- `components/useVerdictCycle.ts` owns the state; `components/VerdictCycle.tsx`
  is the button. `MediaCard` and `MediaRow` each take a `verdictControl` prop
  and, when it's on, read this user's keep/skip from the cycle rather than
  `useKeepState` — `applyVerdict` writes both through, so the badges, the card
  border and the row accent stay honest. Delete-side verdicts get the same rose
  framing an explicit "OK to delete" gets.
- Order is `VERDICT_CYCLE` in `lib/types.ts` (score order, `null` first);
  **shift-click or right-click steps back**, on the button and on the card body.
  No long-press picker yet.
- Reuses `POST/DELETE /api/swipe/verdict` — no new endpoint.
- **Debounced to the state you land on** (450 ms), not one request per click.
  The hook tracks desired-vs-confirmed in refs, so a click landing mid-request
  isn't lost and a failure reverts to what the server actually acked, not to a
  guess.
- Labels, colours and glyphs moved to `components/verdict-meta.ts`, shared with
  SwipeView so the two screens can't name the same stored value differently.
  This also pulled `sky-300/400/500` into the themed ladder — the swipe screen
  had been using unthemed sky shades all along.
- Applied to Browse (grid **and** list) and Search. The Keep page keeps its own
  keep/skip batch loop — it's a different interaction, and 3.3's inference means
  those keeps still count.

## 3.7 Paper cut: the Swipe watch tabs are unreachable on desktop — FIXED 2026-07-31

**Symptom** (2026-07-30): on the `/swipe` page the watch-mode tab strip is cut
off mid-word — "Everything · Never played · Not watched in 90d+ · Watched
recently · M…" — so **My unwatched** can't be clicked. On a phone you can swipe
the strip sideways, so it only bites on desktop.

**Cause** — `components/SwipeView.tsx:247`:

```
flex items-center gap-1 overflow-x-auto … [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
```

inside a `w-full max-w-md` column (`:232`). Five tabs don't fit in `max-w-md`
(448px), so the strip overflows and `overflow-x-auto` makes it scrollable — but
the scrollbar is **deliberately hidden** in both Firefox and WebKit. Touch users
can still drag; on desktop there's no scrollbar, no affordance, and a mouse
wheel won't scroll horizontally without Shift. The hidden scrollbar was a mobile
polish tweak that silently broke the desktop case.

**Fix options**, cheapest first:
- Let the strip wrap on wider screens (`md:flex-wrap`) — the desktop layout has
  vertical room, though the page is intentionally no-scroll so check it still
  fits `100dvh`.
- Or let the tab strip exceed the card column on `md:`+ (it's only capped
  because it shares the card's `max-w-md`).
- Or re-enable the scrollbar on non-touch (`@media (hover: hover)`), or add
  edge-fade/arrow affordances.

Low severity — every tab is still reachable on mobile, and Everything is the
default. Worth doing next time the swipe layout is touched.

**Fixed 2026-07-31** with the first option, but gated on **pointer type rather
than width**: the container is `max-w-md` at every breakpoint, so the overflow
exists at all sizes and a `md:` rule would have missed a narrow desktop window
while needlessly re-laying-out a large phone. `[@media(hover:hover)]:flex-wrap`
+ `:overflow-visible` wraps the strip wherever there's a real pointer and leaves
touch scrolling exactly as it was — which is the actual distinction, since the
bug is "a mouse can't drag a scrollbar that isn't drawn". The card stack is
`flex-1 min-h-0`, so a second tab row just makes it shorter; no-scroll holds.

> **Withdrawn:** an earlier version of this section reported "swipe doesn't
> work on iOS". It was a false alarm — wrong location, not a bug. Swipe works
> on iOS. Don't go chasing `setPointerCapture`; nothing is known to be broken
> there.

## 3.8 A landing page for Swipe — BUILT 2026-08-02

**The idea** (raised 2026-07-30): "we should make a landing page for swipe
maybe, since that's the biggest feature I feel like people use."

Right now `/swipe` drops you straight into the card stack, with the watch-mode
tab strip above it. That's the correct destination for someone mid-triage, but
it's a poor front door for the feature the household actually uses most — and
everything *around* swiping is a click away somewhere else: rooms are started
from `/swipe/matches`, and so are Movie night and Consensus.

**Worth putting on it** (pick, don't build all of it):
- **Start swiping** — with the list/library choice made here rather than as a
  strip above the deck, plus the remaining count so the size of the job is
  visible before you commit to it.
- **Movie night, front and centre** — start a room, or join by code. This is
  the thing people want on a Friday evening and it's currently two navigations
  deep.
- **Where you left off** — how many you've swiped, what's left, maybe the last
  few verdicts with an undo.
- **What the household is landing on** — a peek at the top Movie night matches
  and the highest-scoring "everyone wants this gone" titles, each linking into
  the existing screens.

**Open questions.**
- Does it get in the way of the returning user who just wants to swipe? Likely
  answer: remember the choice and let `/swipe` go straight to the deck once
  someone has started, with the landing page as `/swipe` only when there's no
  session in progress — or a "skip this" that sticks in `localStorage`, like
  the watch-mode preference already does.
- Does it replace `/swipe/matches` or sit beside it? Matches has grown two
  substantial tabs plus the room entry; a landing page might be the natural
  home for the room entry, leaving Matches as the results screen.
- Mobile first — this is a phone feature. The full-height no-scroll layout and
  the safe-area padding rules apply.

**What was built** (three of the four sections — the user picked; "where you
left off" was deliberately left out):

- `/swipe` is now `components/SwipeHome.tsx`; the card stack moved to
  `/swipe/deck`. **Start swiping** carries the library select + the watch-list
  chips and the remaining count for that exact combination (`/api/swipe/deck?
  limit=1` — the count is the payload, the one card is the cost of not adding an
  endpoint), then hands the choice to the deck as `?section=&watch=`.
  **Movie night** lifts the start/join room controls out of Matches (they stay
  there too — it's still the results screen, per the open question above).
  **What the household is landing on** peeks at the top 4 matches and the top 5
  positive-scoring titles, each linking into `/swipe/matches`; both fail
  silently, since the real screens are one click away.
- The returning swiper is answered with `keeparr.swipeSkipLanding` (a checkbox,
  same shape as the watch-mode preference) → `/swipe` replaces to `/swipe/deck`.
  `?home=1` overrides it, which is what the deck's "Swipe home" link and the
  Movie-night PWA shortcut use — otherwise the preference would make the front
  door unreachable.
- `components/swipe-prefs.ts` holds the labels + the three localStorage keys,
  since both screens now offer the same choice. The deck gained a `section`
  filter it never had (the API always accepted one); an unknown section id is
  ignored rather than emptying the deck, so a stale bookmark still swipes.
- PWA shortcuts: "Swipe" → `/swipe/deck` (the shortcut means *swipe now*),
  new "Movie night" → `/swipe?home=1`.
- Verified: tsc, 607 tests, `next build`. No API or schema change.

## 3.9 Pin "Leaving Soon" to the front of Jellyfin's collections

**The idea** (raised 2026-07-31, deliberately deferred): the Leaving Soon
collection should be the **first** item in Collections on the media server, not
buried alphabetically among the household's other collections. It's the rescue
window — a countdown nobody sees is a countdown nobody acts on, and the whole
point of mirroring pending tags onto the server is that people meet them where
they watch.

**Where it lives.** `lib/leaving-soon.ts` creates the collection once via
`createCollection()` (`lib/jellyfin.ts:461` — `POST /Collections?Name=…`) and
caches the id in `leaving_soon_collection_id`. Nothing sets a sort name today,
so the server files it under "L".

**Likely approach** (unverified — check against a live Jellyfin before
building): Jellyfin orders by `SortName`, and a `ForcedSortName` set on the
collection item overrides the title for sorting. That would mean a follow-up
write after creation — `POST /Items/{id}` with the item's metadata carrying
`ForcedSortName: '!Leaving Soon'` (or `'0000 …'`) — since the create endpoint
takes only a name. Points to confirm first:

- Whether the update endpoint needs the FULL item body (Jellyfin's item update
  is a replace, not a patch — reading the item first and echoing it back is the
  usual dance) and whether Emby behaves the same way.
- Whether it should be applied once at creation or re-asserted each sync (a
  user renaming or editing the collection could clear it — re-asserting is
  cheap but writes on every purge run).
- Whether a leading `!`/`0` is the right sigil, or whether it just looks like
  junk in the UI. The sort name is invisible in most Jellyfin views, but not
  all.
- Non-goal: reordering anyone else's collections. Only this one.

Low risk and self-contained — but it writes to the media server, and it's the
one part of the fork that does, so it wants a look at a real server rather than
a confident guess.

## 3.10 Problems that act on the source — BUILT 2026-08-02

**The ask** (2026-08-02): "I kind of wanted more actionable items in the
problems page. Things that call to Sonarr, Radarr, or Jellyfin and deal with
the file or mismatches from the source rather than just using options in
Keeparr."

Fair: the fix-its up to now (`relink`, `rescan`, `diskscan`) either edited
Keeparr's own bookkeeping or kicked off a Keeparr job. Nearly every row's real
fix lives in another app, and the page stopped one step short of it.

**Blast radius — the user's call.** Offered three levels (non-destructive only /
also remove stale *arr records / also delete files from Problems), they chose
the middle one. So: no file ever gets deleted from this surface, but a *arr
RECORD pointing at a folder that isn't on disk can be removed. Deleting media
stays on the scheduled-deletion path, where it has a grace window, keep
protection and the Deletions audit trail.

**Built** (`lib/source-actions.ts`, one new fork module; UI in the existing
fork-owned action bar):

- `arr-rescan` / `arr-refresh` — Sonarr `RescanSeries`/`RefreshSeries`, Radarr
  `RescanMovie`/`RefreshMovie`. **One command per title, deliberately.** The two
  apps disagree on the field (`RefreshMovieCommand` takes only `MovieIds`;
  `RefreshSeriesCommand` has `SeriesId` *and* `SeriesIds`, and older Sonarr had
  only the singular), so a batch command is the thing most likely to silently
  act on just the first title. Verified against the current command classes,
  not assumed.
- `server-rescan` / `server-reidentify` — Jellyfin/Emby
  `POST /Items/{id}/Refresh`. Re-identify is `FullRefresh` +
  `replaceAllMetadata`, which is the ONLY real cure for the identity
  categories: an item with no (or wrong) tmdb/tvdb ids can never match *arr, and
  no amount of Keeparr-side bookkeeping changes that. Images are never replaced
  — re-identifying shouldn't discard curated artwork. Plex has no equivalent
  single call, the same limit `triggerServerRefresh` already carries, so the
  buttons hide there rather than failing.
- `arr-remove-stale` — `DELETE /series|movie/{id}?deleteFiles=false`, gated on
  `arr_unmatched.on_disk = 0`. **The gate is re-read from the database inside
  the action**, never taken from the request: this is the one removal on the
  page and "the folder is really gone" is its entire justification. An
  unverified row (`on_disk IS NULL`) is refused too — unknown is not absent.
- Deep links per row, resolved **server-side** (`sourceLinksFor`) because every
  URL involved is an admin-only setting. `title_slug` is new on both `arr_items`
  and `arr_unmatched`; a row synced before the column existed gets no link
  rather than a guessed one.
- `arr_unmatched` also gained `arr_id`. Without it those rows were a report you
  could read and not act on.

**Failure handling:** every target is one upstream call, each caught, counted
and named in the summary — a briefly-down *arr costs you that title, not the
other nine. Queued work answers `changed: 0` so the UI doesn't refetch and show
identical rows, which reads as "the button did nothing".

**Where the UI went, and why it looks like that.** All of it is in
`ForkProblemActions.tsx`, as a second picker beside the tag picker. Same reason
as 3.x before it: upstream's `ProblemsView` renders bespoke tbodys per category,
so per-row buttons would mean ~10 insertions into the hottest part of an
upstream file. A candidate can carry both a `ratingKey` and an `unmatchedKey`,
which is what makes `identityMismatch` work — one row, two ends, two different
fixes.

**Not offered:** `arrConflicts` (the fix is choosing which of two instances
keeps the title — a human decision, and doing it wrong deletes files),
`diskOrphans` (not media items; the filesystem stays off-limits),
`removedButKept` (already tombstoned).

Verified: tsc, 621 tests (14 new in `lib/source-actions.test.ts`), `next build`,
and a fresh-`DATA_DIR` build for the two schema additions.
