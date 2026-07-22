import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import {
  countSwipeRemaining,
  getSwipeDeck,
  seerrRequestKeys,
  watchedRatingKeys,
} from '@/lib/queries';
import { toCard } from '@/lib/cards';
import { FEED_WATCH_MODES, type FeedWatchMode } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * FORK: a swipe deck — movies this user hasn't sworn a verdict on. Query:
 * limit, section (one library id), watch (the same feed list modes: never_played
 * | stale_90 | recent_30 | my_unwatched). Series stay in the classic keep loop.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const p = new URL(req.url).searchParams;
    const limit = Math.min(60, Math.max(1, Number(p.get('limit')) || 30));
    const sectionId = p.get('section') || undefined;
    const watchParam = p.get('watch');
    const watchMode = FEED_WATCH_MODES.includes(watchParam as FeedWatchMode)
      ? (watchParam as FeedWatchMode)
      : undefined;

    const watched = watchedRatingKeys(user.plexUserId);
    const requested = new Set(seerrRequestKeys(user.plexUserId));
    const rows = getSwipeDeck(user.plexUserId, limit, { sectionId, watchMode });
    const items = rows.map((m) => ({
      ...toCard(m, false, undefined, undefined, watched.has(m.rating_key)),
      requestedByMe: requested.has(m.rating_key),
    }));
    const remaining = countSwipeRemaining(user.plexUserId, { sectionId, watchMode });
    return NextResponse.json({ items, remaining });
  } catch (e) {
    return errorResponse(e);
  }
}
