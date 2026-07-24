import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { getRoomRow, isRoomMember, touchRoomMember } from '@/lib/queries';
import { buildRoomState, evaluateMatch } from '@/lib/rooms';

export const runtime = 'nodejs';

/**
 * FORK: poll a room (the ~2s heartbeat). Bumps the caller's presence, re-checks
 * consensus (a match can also complete when a member goes idle), and returns the
 * current RoomState. Members only — join first via POST /join.
 */
export async function GET(
  _req: Request,
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
    touchRoomMember(code, user.plexUserId);
    evaluateMatch(code); // presence-driven completion
    const fresh = getRoomRow(code)!;
    return NextResponse.json({ state: buildRoomState(fresh, user) });
  } catch (e) {
    return errorResponse(e);
  }
}
