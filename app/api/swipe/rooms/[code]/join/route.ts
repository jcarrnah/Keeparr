import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { getRoomRow, joinRoom } from '@/lib/queries';
import { buildRoomState } from '@/lib/rooms';

export const runtime = 'nodejs';

/** FORK: join a live room by code. Returns the current RoomState. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const user = await requireUser();
    const { code: raw } = await params;
    const code = raw.toUpperCase();
    const room = getRoomRow(code);
    if (!room) return NextResponse.json({ error: 'room_not_found' }, { status: 404 });
    if (room.status === 'closed') {
      return NextResponse.json({ error: 'room_closed' }, { status: 409 });
    }
    joinRoom(code, user.plexUserId, user.username);
    return NextResponse.json({ state: buildRoomState(getRoomRow(code)!, user) });
  } catch (e) {
    return errorResponse(e);
  }
}
