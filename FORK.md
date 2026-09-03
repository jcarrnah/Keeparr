# Keeparr — jcarrnah fork

This is a fork of [drohack/Keeparr](https://github.com/drohack/Keeparr) that
**crosses upstream's "never deletes" line** — deliberately, carefully, and
default-OFF. Upstream Keeparr tags and reports; this fork can also *act*:
schedule deletions, auto-tag by rule, and add a swipe UI for gathering
household verdicts.

Image: `ghcr.io/jcarrnah/keeparr:latest` (built from this repo's `main` by the
same release workflow as upstream). Everything upstream does still works the
same; the database changes are all additive, so switching between upstream's
image and this one on the same `/data` is safe in both directions (fork
tables are simply ignored by upstream).

## What this fork adds

### Watch-history voting lists (keep loop)
The home feed can be sliced into coherent lists so votes mean something:
**Never played (by anyone)** · **Not watched in 90d+** · **Watched recently
(30d)** · **My unwatched**. Tabs appear under the library switcher (when watch
data is available) with a per-list remaining count. API: `watch=` on
`/api/feed/random`.

### Scheduled deletions (default OFF, dry-run ON)
Tag an item "delete after date"; a nightly **purge** job (02:30) deletes
eligible items **via Sonarr/Radarr only** — never the filesystem.

Safety rails, in order:
1. **Master toggle** (Settings → General → Deletion) — default **OFF**;
   nothing anywhere deletes while it's off.
2. **Dry run** — default **ON**; the purge only logs what it *would* delete.
3. **Keeps always win** — an item with ANY active keep is never purged. A new
   keep instantly pauses a pending countdown (`held`); removing the last keep
   resumes it.
4. Items with **no Sonarr/Radarr match are reported, never deleted**.
5. Everything is audited (status per tag, app log, job history).

Browse gains a **Scheduled for deletion** status bucket and a
"⌛ Leaving \<date\>" / "⏸ Deletion paused" badge on cards.
Admin API: `GET/POST/DELETE /api/admin/scheduled-deletions`.

### Rule-based auto-tagging (Maintainerr-style)
Settings → General → **Deletion rules**: condition rows AND'd together —
*not watched by anyone in N days · added more than N days ago · size ≷ N GB ·
library is one of · requested via Seerr* — with a per-rule grace override and
a live **preview** of exactly what tonight's run would tag. The nightly
**rules** job (02:00) only *tags* (into the same scheduled-deletions pipeline);
it never touches kept items and never overwrites an existing tag.
**Deleting a rule cancels its still-live tags** (they don't keep counting
down); merely *disabling* a rule stops new tagging but leaves existing tags
in place.

Rules can also match on **what the household said**, not just on dates and
sizes:

- **Household score** at least / at most N — the weighted total described under
  [Vote scoring](#vote-scoring). "Tag anything scoring +3 or more" is the
  headline rule.
- **N people said** *let it go* (or any other verdict).
- **A specific person said** *wouldn't be mad* — e.g. the person who originally
  requested it is done with it.
- **Nobody keeps it** — always enforced anyway; add it if you want the rule to
  say so out loud.

**The quorum.** A rule that reads opinions won't tag anything until **2
different people** have weighed in on that title, so one person's swiping spree
can't schedule the library for deletion. It's a default, not a law: add a
**Minimum voters** condition to change it — set it to 1 if, in your house, one
clear "no" is enough. The builder tells you the number in force while you're
editing, and the preview says what it held back ("*3 more matched but were held
back: fewer than 2 people have voted on them*") so a small count never looks
like a broken rule. Rules that only use dates, sizes or libraries are unaffected
— they never wait for votes they don't read.

A keep still beats everything: no score, however lopsided, tags a title someone
is keeping.

**Why the rule matches fewer than Browse.** Filtering Browse by "Score ≥ +3"
will almost always list more titles than a rule with the same threshold, and
that's not a bug — Browse is a browsing screen and applies none of the rule
baseline. The preview now spells out the difference:

- **already tagged and counting down** — nothing for a rule to add.
- **somebody keeps it.**
- **held back by the quorum** — fewer than N people have voted on it.

Those three plus the match count are exactly the titles the conditions hit, so
the preview always adds up to what Browse shows you.

**Cancelling is "not this time", not "never again."** A tag you cancel — or one
that failed, or one a past purge already handled — stops blocking rules: the
next nightly run may tag that title again if it still matches. The permanent
protection is **keeping** it, which no rule and no score can override. When a
rule re-tags something, the deletion history records what happened last time
("*Re-tagged; previous outcome: cancelled*"), so the trail isn't lost. A tag
that's still **counting down** is never disturbed — neither its date nor a
manual tag you set by hand.

### "Leaving Soon" collection + Discord notifications
- On Jellyfin/Emby, pending tags are mirrored into a **Leaving Soon**
  collection on the server itself, so the household sees doomed titles where
  they watch — and can rescue them by keeping in Keeparr.
- A **Discord webhook** (Settings → General → Deletion) notifies on: items
  tagged (manual or per-rule), items entering their **final 7 days**, and
  purge results (items + GB reclaimed, plus failures).

### Swipe mode ("Tinder for the library")
**/swipe** is the front door: pick the library and list you want to swipe (with
the count of what's waiting), start or join a **movie night room**, and see the
titles the household is converging on — what everyone wants to watch, and what
they most want gone. Tick *go straight to swiping* and `/swipe` takes you
straight to the deck from then on; **Swipe home** on the deck gets you back.

**/swipe/deck** (also a PWA shortcut): a card stack over **movies and whole TV
series** (a verdict always covers the entire show — never a season).
Right = **Save for later** (unseen, keep to watch) · up = **Worth keeping**
(seen, keep) · left = **Let it go / delete this shit** (never watching —
releases your claim) · down = **Wouldn't be mad / OK to delete** (watched, done
with it) · **Skip** = abstain. Buttons +
arrow keys on desktop, U to undo (last 5). Cards show the synopsis, genres,
and runtime (pulled from your media server during the normal library sync).
Verdicts are persistent and
per-user, and write through to the normal keep/skip machinery (*Save for
later*/*Worth keeping* = a keep — which also pauses any pending deletion;
*Let it go*/*Can go* stand as delete votes for rules and future consensus
views). Decks support the same watch-history lists as the feed.

### Ratings on swipe cards (OMDb)
Add a free [OMDb API key](https://www.omdbapi.com/apikey.aspx) (Settings →
General → Ratings) and the daily **ratings** job backfills IMDb / Rotten
Tomatoes / Metacritic scores (under the ~1000/day free cap, resuming
automatically) for display on swipe cards.

### Deletion integrity
Three fixes that came out of running a real purge and reading the results on
upstream's Problems page:

- **Keeps survive a re-add.** `rating_key` is the media server's item id and it
  is *not* stable — re-adding a title (upgrading a movie to 4K, a library
  rebuild) mints a new one. Every per-user table keys on it, so a keep was left
  stranded on the old id while the live copy came back **unkept and
  never-watched** — unprotected, and matching "big and nobody's watched it"
  rules on its first evaluation. The library sweep now re-links keeps, skips,
  "OK to delete", verdicts and watch history onto the replacement (matched by
  tvdb/tmdb, falling back to imdb). A scheduled deletion is deliberately never
  carried forward onto a fresh copy.
- **"Reclaimed" is now measured, not assumed.** The purge used to report the
  size the media server last knew about. Deletes can leave real bytes behind —
  artwork, subtitles, `Extras/`, a second copy — which later resurface as disk
  orphans long after the space was claimed back. Each delete is now re-measured
  on disk and the run reports what actually left, flagging leftovers.
- **Deletion finishes in all three systems.** Deleting via Sonarr/Radarr left
  Jellyfin/Emby serving empty entries until it rescanned, and left the Seerr
  request in place — so a title could be re-requested and re-downloaded. The
  purge now clears the request and triggers one library refresh per run.

### Fix problems at the source
Most rows on the Problems page can't be fixed *in Keeparr* — the disagreement
lives in Sonarr/Radarr or on the media server, and walking over to that app to
find the title is where triage tends to stop. **Fix at the source…** opens a
picker of the rows you're looking at and acts on them where they live:

- **Rescan files in Sonarr/Radarr** — the *arr looks at the folder again and
  re-reports its size. The fix when the \*arr is the stale side of a size
  disagreement, or still thinks it has files it doesn't.
- **Refresh metadata in Sonarr/Radarr** — re-pulls the title's metadata there.
- **Rescan items on the server** — Jellyfin/Emby re-reads *just these items*
  instead of the whole library.
- **Re-identify on the server** — a full metadata refresh that replaces what the
  server stored, so an item with missing or wrong tmdb/tvdb ids can finally get
  the right ones. Those ids are what Sonarr/Radarr matching runs on, so this is
  the actual cure for "not in \*arr" and "no external ids" rows rather than a
  note about them. Artwork is never replaced, and the new ids show up in Keeparr
  after the next library sync.
- **Remove the stale \*arr record** — for a title your \*arr tracks whose folder
  the disk scan couldn't find. It deletes **no files** (there are none) and adds
  no import exclusion, so the title can come back if it's ever downloaded again.
  Offered only on rows the disk scan actually confirmed are missing — "not
  checked yet" is not the same as "not there", and Keeparr re-checks that on the
  server before removing anything.

Each row also carries links straight to the title in Sonarr/Radarr and on your
media server, for the fixes that are a human decision rather than an API call.
Scans are queued in the other app, so numbers here update after it finishes and
Keeparr's next sync runs.

### Schedule deletions from Problems
The Problems page finds the junk; now you can act on it there. On **Not in
Sonarr/Radarr**, **No external ids**, **Zero size** and **Duplicates**,
*Schedule deletion…* opens a picker of that category's titles with sizes and a
running total — tick what should go, tag it in one click. Duplicates are
flattened to individual copies with their folder shown, since the decision is
*which copy* goes. Zero-size rows are sized by what **\*arr** reports, because
the *arr is what actually deletes.

Everything a tag normally means still applies: the configured grace period,
anyone keeping an item pauses its countdown, and it's cancellable from
**Deletions**. Batches send **one** Discord summary rather than a ping per title.

Not offered where deletion isn't the fix — size mismatches and identity
mismatches want a rescan or a corrected match — nor on rows that aren't media
items at all (\*arr-only titles, disk orphans), which have no id to tag.

### Fix-it actions on the Problems page
Upstream's Problems page diagnoses; the fork adds buttons for the problems it
can repair: **re-link keeps to the new copies** (on "Removed but kept"),
**rescan the library** (on zero-size / missing-from-server rows), and
**measure on disk now** (on size mismatches, where the measured size is the
tiebreaker — and on disk orphans, to refresh the list). The Disk scan job only
runs weekly, so that last one is the difference between settling a mismatch now
and waiting until Sunday. All non-destructive — no media is deleted and the
filesystem is never touched.

## New jobs
| Job | Default schedule | Notes |
|---|---|---|
| `rules` | daily 02:00 | tags only; inert unless Deletion is enabled |
| `purge` | daily 02:30 | the only job that deletes; dry-run by default |
| `ratings` | daily 09:00 | inert without an OMDb key |

## Auditing a purge
Job logs are **pruned aggressively** — `logs` keeps the newest 1000 rows and
`job_runs` the newest 100 runs, and every job run writes a line. With
`recentlyAdded` running every 5 minutes that's roughly **3 days** of app log and
**~8 hours** of job history, so a purge from last week is gone from both. Absence
from the log is not evidence it never ran.

The durable record is the `scheduled_deletions` row, which is never pruned:

```
GET /api/admin/scheduled-deletions
```

returns every tag with its `status` (`pending`/`held`/`deleted`/`failed`/
`cancelled`) and `statusDetail` (including which *arr instance did the delete).

Note that Browse's "Scheduled for deletion" filter only matches **live** tags
(`pending`/`held`), so a *successful* purge makes its tags disappear from that
view — an empty list there means it completed, not that nothing happened. A
proper history screen is [planned](FORK_PLAN.md#31-deletion-history-ui).

## Staying current with upstream
See **[FORK_SYNC.md](FORK_SYNC.md)** for the full procedure — the conflict
classes, the verification gate (including the fresh-`DATA_DIR` build that
`npm run verify` cannot catch), and the rule that keeps syncs cheap: fork logic
lives in fork-owned modules.

```
git fetch upstream && git fetch origin   # origin too: CI moves main behind you
git log --oneline main..upstream/main    # scope it first
git checkout -b sync/upstream-X.Y.Z
git merge upstream/main
```

### Matches & consensus (`/swipe/matches`)
- **Movie night**: titles two or more chosen people saved for later — "You
  and Sam want to watch this" — with a participant picker and a
  "nobody's watched it yet" filter.
- **Consensus**: a per-item rollup of who wants each title, who's keeping it,
  and who released it, sortable by delete votes, size or **score** — the human
  input for deciding what to tag for deletion. Filter it by **who voted what**
  ("everything Sam let go"). **Click any row** to see who said what,
  person by person, with inferred opinions labelled ("*Sam — Worth keeping —
  kept it*") so they never read as swipes. Admins with deletion enabled get
  **Schedule deletion** right there: the screen you use to decide is the screen
  you decide on.

### Vote scoring
Each verdict carries a weight, and a title's **score** is the sum across
everyone. Positive means the household wants it gone, so sorting by score puts
the safest reclaims on top:

| Verdict | Points |
|---|---|
| Let it go / delete this shit | **+2** |
| Wouldn't be mad / OK to delete | **+1** |
| Skip | **0** |
| Save for later | **−1** |
| Worth keeping | **−2** |

Two "let it go" votes (+4) therefore outrank one "worth keeping" (−2). Keeping
something in **Browse, Search or the Keep page counts too** — a keep reads as
"worth keeping", a "don't care" as a skip, an "OK to delete" as "wouldn't be
mad" — so people who never open Swipe still have a say. Those inferred opinions
are marked (*"Sam (kept)"*) so they're never mistaken for an actual swipe, and
an actual swipe always overrides them.

### Browse by score
The score isn't confined to the consensus screen. **Browse** can sort by
**Household score** (grid dropdown, or the Score column in List view) and filter
to **Score ≥ +N**, which turns "what does everyone want gone?" into an ordinary
grid of posters and sizes with the verdict control on every card. Each card and
row shows the score with the number of people behind it, so a +4 from four
people never reads the same as a +4 from one.

Two details worth knowing:

- A title **nobody has voted on** shows no score and sorts to the end in *both*
  directions — silence isn't a keep signal.
- The threshold treats an un-voted title as 0, so "Score ≥ +1" means *somebody
  actively wants this gone*.

### One vocabulary on every card
Browse (grid and list) and Search cards no longer toggle a plain keep. The
control **cycles through all five verdicts** in score order, so triage anywhere
produces the same votes swiping does:

```
no vote → Worth keeping → Save for later → Skip → Wouldn't be mad → Let it go → …
```

Click to advance, **shift-click or right-click to step back** (six positions
means overshooting is easy), and only the state you land on is saved. Keeps and
"don't care" are still written underneath exactly as before — this changes the
vocabulary, not the machinery. The Keep page keeps its own fast keep/skip loop.

### Movie night — live rooms (`/swipe/rooms`)
Start a room from **/swipe** or **/swipe/matches** ("Start a room"), share the short code, and
everyone swipes the **same** deck together in real time (right = want, left =
pass). The room lands on the first title **everyone currently in it** wants to
watch, then celebrates the match. Live updates use lightweight polling (no
setup, works behind any reverse proxy); rooms need at least two people to match,
and someone going idle stops holding up the group. Nothing here deletes or keeps
anything — it's just for picking what to watch tonight.

### Deletion history (`/deletions`, admin)
Every tag ever made and what became of it — counting down, paused by a keep,
deleted, failed, cancelled. Three things it answers that nothing else could:

- **What actually got reclaimed**, measured on disk rather than assumed. *arr
  reporting a successful delete doesn't mean the folder is empty, so the purge
  re-measures; "left behind" is the shortfall, and titles that couldn't be
  checked at all are counted separately instead of being called gone.
- **Whether a purge ran.** The app log keeps 1000 lines and job history 100
  runs, and every job writes a line — with the 5-minute sync that's roughly
  three days of log. A purge from last week is *pruned*, not absent. These rows
  are permanent.
- **Where a tag went.** Browse's "Scheduled for deletion" filter only shows
  live tags, so a successful purge makes them vanish from it — which reads as
  "nothing ever happened".

Live tags can be cancelled from here; the row stays as a record.

### Manual tagging in Browse
Admins (with Deletion enabled) get a **Schedule deletion / Cancel deletion**
button on Browse cards, using the configured grace period.

### Excluded libraries (name patterns)
Settings → Connections → **Excluded libraries** hides libraries by title, using
`*` (any run of characters) and `?` (one), case-insensitively. A pattern with no
`*` has to match the whole title, so `Movies` never swallows `4K Movies`.

This exists because a Jellyfin/Emby **recommendation plugin creates a library per
user**, and each one reports a `movies`/`tvshows` CollectionType — so they arrive
looking exactly like real libraries, and Keeparr adopts them all (an empty
`managed_section_ids` means "all"). Unticking them in the picker doesn't hold:
the plugin makes another one the next time a user is added, and it's managed
again on the following scan. `*Recommend*` holds forever.

Notes on the design:

- The filter runs **at the read**, inside `getPlexSections()`, so every consumer
  (feed, Browse, Big Picture, storage, the sync engine) inherits it — including
  ones added later — rather than each remembering to apply it.
- Discovery still records **every** library, so clearing a pattern un-hides its
  libraries immediately with no re-scan. `getAllDiscoveredSections()` is that raw
  list, and only the Settings picker reads it.
- Excluded libraries are hidden from the picker and the storage mapper entirely;
  the Excluded libraries card names them, so an over-broad pattern is visible
  rather than silently eating a library.
- Items an excluded library already contributed **tombstone** on the next full
  Library sweep — the same path an unticked library's rows take.
- `syncLibrary` **aborts** if a pattern hides every library, rather than
  tombstoning the entire database. `*` is a footgun and is treated as one.
- The matcher is a pure module (`lib/section-filter.ts`) and upstream's
  `ConnectionsPanel.tsx` carries two added lines — an import and one render —
  per the FORK_SYNC.md rule.

### Why a Problems fix used to look like it did nothing

Two separate causes, both fixed:

**The feedback loop didn't exist.** Every "fix at the source" action is
asynchronous *in the other app* — Sonarr queues a rescan, Jellyfin queues a
refresh — while the Problems page reads Keeparr's own cache. So a title you
genuinely fixed keeps showing as a problem until Keeparr re-reads the media
server **and** re-matches Sonarr/Radarr. Those are two different nightly jobs
(`library` 03:00, then `arr` 07:00), so the honest wait was "tomorrow morning",
and reloading the page in the meantime showed identical rows.

The **Re-check now** button runs both, in order. The order is the whole point:
`arr` matches on the external ids `library` just refreshed, so running them the
other way round re-matches against the stale guids and reports no change.

**Zero-size shows were re-affirmed, not re-measured.** `syncLibrary` skips the
expensive per-series size call when it already has a cached size — but it
treated a cached **0** as a known size. A show stuck at 0 therefore had the 0
written straight back on every sweep, and could only be rescued by the separate
`sizes` job at 06:00. Running a Library scan to check whether a Problems fix had
worked actively re-confirmed the problem. A cached 0 now means "never
successfully measured" and is re-measured, which is what `syncRecentlyAdded`
had been doing all along.

**What still can't be fixed by a button, honestly:** `server-reidentify` asks
the media server to re-query its metadata providers. If the server re-derives
the *same* wrong id (usually an ambiguous folder name), the identity mismatch
comes back. The fix there is Jellyfin's own **Identify** dialog with the correct
id, or renaming the folder — Re-check now will tell you which case you're in
within a minute instead of a day.
