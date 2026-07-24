import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import {
  getActiveMediaItem,
  getRoomRow,
  isRoomMember,
  recordRoomVote,
  touchRoomMember,
} from '@/lib/queries';
import { buildRoomState, evaluateMatch } from '@/lib/rooms';

export const runtime = 'nodejs';

/**
 * FORK: cast a want/pass vote in a room. Body { ratingKey, want }. Records the
 * vote, refreshes presence, re-checks consensus, and returns the RoomState
 * (which carries the matched card once the room agrees).
 */
export async function POST(
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

    const body = await req.json();
    const ratingKey = String(body?.ratingKey ?? '');
    const want = body?.want === true;
    if (!ratingKey) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    if (!getActiveMediaItem(ratingKey)) {
      return NextResponse.json({ error: 'unknown_item' }, { status: 404 });
    }

    touchRoomMember(code, user.plexUserId);
    // A vote in a closed/matched room is a harmless no-op on consensus, but we
    // still record it so the voter's deck advances if they keep going.
    if (room.status === 'open') recordRoomVote(code, user.plexUserId, ratingKey, want);
    if (want && room.status === 'open') evaluateMatch(code);

    return NextResponse.json({ state: buildRoomState(getRoomRow(code)!, user) });
  } catch (e) {
    return errorResponse(e);
  }
}
