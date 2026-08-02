import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { isServerConfigured, isWatchAvailable } from '@/lib/settings';
import AppShell from '@/components/AppShell';
import SwipeHome from '@/components/SwipeHome';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * FORK (3.8): the Swipe front door — pick a list, start a movie night, see what
 * the household is landing on. The card stack itself lives at /swipe/deck.
 * `?home=1` overrides the "go straight to swiping" preference.
 */
export default async function SwipePage({
  searchParams,
}: {
  searchParams: Promise<{ home?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const { home } = await searchParams;

  return (
    <AppShell>
      {!isServerConfigured() ? (
        <p className="text-slate-400 p-6">Not set up yet.</p>
      ) : (
        <SwipeHome watchAvailable={isWatchAvailable()} skipLandingAllowed={home !== '1'} />
      )}
    </AppShell>
  );
}
