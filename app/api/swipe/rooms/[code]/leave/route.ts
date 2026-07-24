import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { closeRoom, getRoomRow, leaveRoom } from '@/lib/queries';

export const runtime = 'nodejs';

/**
 * FORK: leave a room. If the host leaves an open room, close it (the session is
 * over). Idempotent — leaving a room you're not in still returns ok.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const user = await requireUser();
    const { code: raw } = await params;
    const code = raw.toUpperCase();
    const room = getRoomRow(code);
    if (room) {
      leaveRoom(code, user.plexUserId);
      if (room.created_by === user.plexUserId && room.status === 'open') {
        closeRoom(code);
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
