import { NextResponse } from 'next/server';
import { clearSessionCookie, requireUser } from '@/lib/auth';
import { bumpSessionEpoch, logEvent } from '@/lib/queries';
import { errorResponse } from '@/lib/route-helpers';

export const runtime = 'nodejs';

/**
 * Sign out EVERYWHERE: bump this user's session epoch so every token they hold
 * (this device and any others) is invalidated on its next request, then clear
 * this device's cookie. Use after a suspected token theft.
 */
export async function POST() {
  try {
    const user = await requireUser();
    bumpSessionEpoch(user.plexUserId);
    await clearSessionCookie();
    logEvent('info', 'auth', `${user.username ?? user.plexUserId} signed out of all devices.`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e, 'auth/logout-all');
  }
}
