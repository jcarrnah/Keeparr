# Syncing this fork with upstream

How to pull [drohack/Keeparr](https://github.com/drohack/Keeparr) into this fork
without breaking the fork-only features. See [FORK.md](FORK.md) for what the
fork adds and [CLAUDE.md](CLAUDE.md) for the architecture.

## The rule that makes syncs cheap

**Keep fork logic in fork-only modules.** In the v0.3.13 sync, 14 files
conflicted and **none of them were fork-only files** — every conflict was in a
*shared* file where fork code sits inline. Fork features that live in their own
module (`lib/purge.ts`, `lib/rules.ts`, `lib/rooms.ts`, `lib/ratings.ts`,
`lib/omdb.ts`, `lib/discord.ts`, `lib/leaving-soon.ts`, `components/SwipeView.tsx`,
`components/RoomView.tsx`, `app/swipe/**`, `app/api/swipe/**`) merged untouched.

So, when adding fork code:

- New behavior → a **new file**, not a block inside a shared one.
- Unavoidable edits to shared files → keep them **small**, mark them `FORK:`, and
  put them at the **end** of a list/type/registry. Upstream appends at the end
  too, which is exactly why `lib/queries.test.ts` collided — but an end-of-file
  collision is trivial to resolve, and a tangled mid-file one is not.
- Additive schema only, so a `/data` volume stays compatible in both directions.

**Worked example — the Problems page.** `components/ProblemsView.tsx` is ~1,300
lines of upstream code that renders every category through its own hand-written
`<thead>`/`<tbody>`, with ~23 inline action-badge sites, and upstream actively
develops it. The fork wanted per-row buttons there. A trailing action cell would
have meant ~10 insertions into the most-merged part of the file — so instead ALL
fork UI lives in `components/ForkProblemActions.tsx`, an action bar above the
table, and upstream's file carries exactly **one** changed line:

```tsx
<ForkProblemActions type={active} items={items} onDone={() => load(active, true)} />
```

That constraint shaped the feature (a batch tag picker rather than per-row
buttons) and the feature is better for it — you triage a list of problems, not
one. It also means the fork bar reads `deletion.enabled` from
`/api/admin/settings` itself rather than threading a prop through upstream's
component. When a fork feature wants to live inside a hot upstream file, look
for the shape of it that needs one seam instead of twenty.

## The loop

```bash
git fetch upstream
git log --oneline main..upstream/main          # scope it before you start
git checkout -b sync/upstream-X.Y.Z
git merge upstream/main
```

## Conflict classes, in the order you'll hit them

1. **Version strings** — `package.json`, `package-lock.json` (×2: root + the
   `packages[""]` entry), `openapi.json`. Always keep the **fork's** version; it
   runs ahead of upstream because every push to `main` ships a release.
2. **"Keep both" field lists** — `UpsertMediaInput`, `BackendItem`, the
   `lib/dev-seed.ts` item factory, test fixtures. Take the **union**, never one
   side. Upstream adds columns and so does the fork; dropping either half
   compiles fine and then fails at runtime.
3. **Append-at-EOF blocks** — new `describe(...)` blocks in tests, new bullets in
   docs. Both sides appended, so git also swallows the **shared closing braces**
   into the conflict. Keep both blocks *and* restore the trailing `});`.
4. **`CLAUDE.md` prose** — merge both descriptions rather than picking one. Keep
   the `FORK-ONLY` bullets grouped together (they read better contiguous, and it
   makes the next sync's diff smaller).

## Verification gate

All four, before committing:

```bash
npx tsc --noEmit
npx vitest run
DATA_DIR=$(mktemp -d) npx next build   # NOT `npm run verify` — see below
git grep -nE '^(<<<<<<< |>>>>>>> |=======$)'   # no leftover markers
```

The **fresh `DATA_DIR`** build is the non-obvious one and the reason v0.3.9's
image build failed. `next build`'s prerender workers open a *fresh* database in
parallel and race each other's `ALTER`s ("duplicate column name"). A plain
`npm run verify` can't catch it, because your dev `./data` already has the
columns. Any sync that brings new columns needs this. (Corollary, from
CLAUDE.md: new columns go in **both** the `CREATE TABLE` block and the guarded
`migrate()` `ALTER`.)

Then confirm upstream didn't touch the fork's hook points — the shared functions
fork features depend on:

```bash
git diff -U0 $(git merge-base main upstream/main) upstream/main -- lib/queries.ts \
  | grep -E 'applyKeep|FEED_ELIGIBILITY|getSwipeDeck|applyVerdict|refreshDeletionHolds|dueDeletions'
```

No output = upstream's changes were additive and the fork's write-through logic
(keeps pausing pending deletions, verdict → keep/skip, deck eligibility) is
intact. Output = read those hunks carefully before trusting a green test run.

Finally, run the fork suites on their own so a pass isn't buried in the full run:

```bash
npx vitest run lib/rooms.test.ts lib/purge.test.ts lib/rules.test.ts \
               lib/ratings.test.ts lib/leaving-soon.test.ts
```

## Landing it

- Commit the merge on the `sync/*` branch, then merge to `main`.
- **Pushing to `main` ships a release** (image + GitHub release, see CLAUDE.md
  "Releases + images"). Land syncs deliberately, not as a drive-by.
- Check new upstream **jobs** against the fork's schedule
  (`DEFAULT_JOB_SCHEDULES` in `lib/config.ts`). The scheduler fires every due job
  **concurrently** (`void runJob(id)` in `lib/scheduler.ts`, no `await`), so
  overlapping times run at once. v0.3.13 put upstream's `diskScan` at Sunday
  09:00 alongside the fork's daily `ratings` 09:00 — harmless (diskScan is
  `node:fs/promises`, so it never blocks the event loop), but worth a glance.
- Keep `CLAUDE.md`, `README.md`, `FORK.md`, and `openapi.json` in sync with any
  behavior/route/schema/settings change the merge introduces.
