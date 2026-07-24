import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { createUniqueRoom, roomStateByCode } from '@/lib/rooms';
import { ROOM_WATCH_MODES } from '@/lib/queries';
import type { FeedWatchMode } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * FORK: create a live swipe room. Body: { section?: string, watch?: room watch
 * mode }. The caller becomes host + first member. Returns { code, state }.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    let body: { section?: string; watch?: string } = {};
    try {
      body = await req.json();
    } catch {
      /* empty body is fine — defaults to all libraries / everything */
    }
    const sectionId = body.section ? String(body.section) : null;
    const watchMode = ROOM_WATCH_MODES.includes(body.watch as FeedWatchMode)
      ? (body.watch as FeedWatchMode)
      : null;
    const code = createUniqueRoom({
      hostId: user.plexUserId,
      hostName: user.username,
      sectionId,
      watchMode,
    });
    return NextResponse.json({ code, state: roomStateByCode(code, user) });
  } catch (e) {
    return errorResponse(e);
  }
}
