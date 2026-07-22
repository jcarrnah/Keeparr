import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import {
  countFeedRemaining,
  getFeed,
  largestItems,
  seerrRequestKeys,
  watchedRatingKeys,
} from '@/lib/queries';
import { FEED_WATCH_MODES, type FeedWatchMode } from '@/lib/types';
import { toCard } from '@/lib/cards';
import { FEED_BATCH_SIZE } from '@/lib/config';

export const runtime = 'nodejs';

/**
 * A fresh feed batch. Query: limit, largest (1 = biggest titles overall,
 * regardless of library/keep-eligibility), section (a single Plex library id;
 * omit for a mix across all libraries), watch (a watch-history slice:
 * never_played | stale_90 | recent_30 | my_unwatched; omit = no watch filter,
 * ignored with largest=1). Categories are real Plex libraries — nothing is
 * hardcoded.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const p = new URL(req.url).searchParams;
    const limit = Math.min(
      120,
      Math.max(1, Number(p.get('limit')) || FEED_BATCH_SIZE)
    );

    const watched = watchedRatingKeys(user.plexUserId);
    // So requested titles can show the "OK to delete" control in the feed.
    const requested = new Set(seerrRequestKeys(user.plexUserId));

    if (p.get('largest') === '1') {
      const rows = largestItems(limit, 0, user.plexUserId);
      const items = rows.map((r) => ({
        ...toCard(r, r.kept === 1, r.kept_by_me === 1, undefined, watched.has(r.rating_key)),
        requestedByMe: requested.has(r.rating_key),
      }));
      return NextResponse.json({ items, remaining: null });
    }

    const sectionId = p.get('section') || undefined;
    const watchParam = p.get('watch');
    const watchMode = FEED_WATCH_MODES.includes(watchParam as FeedWatchMode)
      ? (watchParam as FeedWatchMode)
      : undefined;
    const rows = getFeed(user.plexUserId, limit, { sectionId, watchMode });
    const items = rows.map((m) => ({
      ...toCard(m, false, undefined, undefined, watched.has(m.rating_key)),
      requestedByMe: requested.has(m.rating_key),
    }));
    const remaining = countFeedRemaining(user.plexUserId, { sectionId, watchMode });
    return NextResponse.json({ items, remaining });
  } catch (e) {
    return errorResponse(e);
  }
}
