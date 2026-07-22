import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { isServerConfigured, isWatchAvailable } from '@/lib/settings';
import AppShell from '@/components/AppShell';
import SwipeView from '@/components/SwipeView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** FORK: swipe mode — card-stack verdicts over the movie library. */
export default async function SwipePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  return (
    <AppShell>
      {!isServerConfigured() ? (
        <p className="text-slate-400 p-6">Not set up yet.</p>
      ) : (
        <SwipeView watchAvailable={isWatchAvailable()} />
      )}
    </AppShell>
  );
}
