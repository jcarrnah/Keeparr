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

### "Leaving Soon" collection + Discord notifications
- On Jellyfin/Emby, pending tags are mirrored into a **Leaving Soon**
  collection on the server itself, so the household sees doomed titles where
  they watch — and can rescue them by keeping in Keeparr.
- A **Discord webhook** (Settings → General → Deletion) notifies on: items
  tagged (manual or per-rule), items entering their **final 7 days**, and
  purge results (items + GB reclaimed, plus failures).

### Swipe mode ("Tinder for the library")
**/swipe** (also a PWA shortcut): a card stack over **movies and whole TV
series** (a verdict always covers the entire show — never a season).
Right = *want to watch* · up = *worth keeping* · left = *not interested* ·
down = *done with it* · Skip = *don't care*. Buttons + arrow keys on desktop,
U to undo (last 5). Verdicts are persistent and per-user, and write through to
the normal keep/skip machinery (*want to watch*/*worth keeping* = a keep —
which also pauses any pending deletion; *done with it*/*not interested* stand
as delete votes for rules and future consensus views). Decks support the same
watch-history lists as the feed.

### Ratings on swipe cards (OMDb)
Add a free [OMDb API key](https://www.omdbapi.com/apikey.aspx) (Settings →
General → Ratings) and the daily **ratings** job backfills IMDb / Rotten
Tomatoes / Metacritic scores (under the ~1000/day free cap, resuming
automatically) for display on swipe cards.

## New jobs
| Job | Default schedule | Notes |
|---|---|---|
| `rules` | daily 02:00 | tags only; inert unless Deletion is enabled |
| `purge` | daily 02:30 | the only job that deletes; dry-run by default |
| `ratings` | daily 09:00 | inert without an OMDb key |

## Staying current with upstream
```
git fetch upstream
git merge upstream/main   # fork changes are additive; conflicts should be rare
npm run verify            # tests + build must stay green
git push origin main      # ships a new fork image
```

## Not yet built
- Movie-night matchmaking + per-item verdict consensus (`/swipe/matches`).
- Overview/genres/runtime on swipe cards (needs new fields through the
  media-server sync seam).
- A manual "tag for deletion" button in Browse (today: tag via rules or the
  admin API / `/api-docs`).
