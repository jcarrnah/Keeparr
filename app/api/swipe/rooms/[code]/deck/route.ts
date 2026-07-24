import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import {
  countRoomDeckRemaining,
  getRoomDeck,
  getRoomRow,
  isRoomMember,
  seerrRequestKeys,
  watchedRatingKeys,
} from '@/lib/queries';
import { toCard } from '@/lib/cards';

export const runtime = 'nodejs';

/**
 * FORK: the shared, ordered deck for a room (this viewer's un-swiped slice).
 * Same order for everyone, so votes converge on the same titles.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const user = await requireUser();
    const { code: raw } = await params;
    const code = raw.toUpperCase();
    const room = getRoomRow(code);
    if (!room) return NextResponse.json({ error: 'room_not_found' }, { status: 404 });
    if (!isRoomMember(code, user.plexUserId)) {
      return NextResponse.json({ error: 'not_in_room' }, { status: 403 });
    }
    const limit = Math.min(
      60,
      Math.max(1, Number(new URL(req.url).searchParams.get('limit')) || 30)
    );
    const watched = watchedRatingKeys(user.plexUserId);
    const requested = new Set(seerrRequestKeys(user.plexUserId));
    const rows = getRoomDeck(room, user.plexUserId, limit);
    const items = rows.map((m) => ({
      ...toCard(m, false, undefined, undefined, watched.has(m.rating_key)),
      requestedByMe: requested.has(m.rating_key),
      imdbRating: m.imdb_rating ?? undefined,
      rtScore: m.rt_score ?? undefined,
      metacritic: m.metacritic ?? undefined,
    }));
    return NextResponse.json({
      items,
      remaining: countRoomDeckRemaining(room, user.plexUserId),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
