import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { applyKeep, getActiveMediaItem, removeKeep } from '@/lib/queries';

export const runtime = 'nodejs';

/** Add the current user's keep. Clears their "don't care" (mutually exclusive). Body: { ratingKey }. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const { ratingKey } = (await req.json()) as { ratingKey?: string };
    if (!ratingKey || !getActiveMediaItem(ratingKey)) {
      return NextResponse.json({ error: 'unknown_item' }, { status: 404 });
    }
    // Keep is exclusive with "don't care" and "OK to delete" (cleared atomically).
    const newlyKept = applyKeep(user.plexUserId, ratingKey);
    return NextResponse.json({ kept: true, newlyKept });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Remove only the current user's keep (never another user's). Body: { ratingKey }. */
export async function DELETE(req: Request) {
  try {
    const user = await requireUser();
    const { ratingKey } = (await req.json()) as { ratingKey?: string };
    if (!ratingKey) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const removed = removeKeep(user.plexUserId, ratingKey);
    return NextResponse.json({ kept: false, removed });
  } catch (e) {
    return errorResponse(e);
  }
}
