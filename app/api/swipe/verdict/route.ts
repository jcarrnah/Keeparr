import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { applyVerdict, removeVerdict } from '@/lib/queries';
import { VERDICTS, type Verdict } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * FORK: record a swipe verdict. Body: {ratingKey, verdict}. Write-through:
 * want_to_watch/loved_it → keep (pauses a pending scheduled deletion),
 * dont_care → skip, done_with_it/not_interested → clears this user's keep and
 * stands as a delete vote. Re-posting replaces the previous verdict.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json()) as { ratingKey?: string; verdict?: string };
    if (
      !body.ratingKey ||
      typeof body.ratingKey !== 'string' ||
      !VERDICTS.includes(body.verdict as Verdict)
    ) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const ok = applyVerdict(user.plexUserId, body.ratingKey, body.verdict as Verdict);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** FORK: undo — removes the verdict AND its keep/skip side effects. Body: {ratingKey}. */
export async function DELETE(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json()) as { ratingKey?: string };
    if (!body.ratingKey || typeof body.ratingKey !== 'string') {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const removed = removeVerdict(user.plexUserId, body.ratingKey);
    if (!removed) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    return errorResponse(e);
  }
}
