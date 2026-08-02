import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { getManagedSections, isServerConfigured, isWatchAvailable } from '@/lib/settings';
import AppShell from '@/components/AppShell';
import SwipeView from '@/components/SwipeView';
import { FEED_WATCH_MODES, type FeedWatchMode } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * FORK: swipe mode — card-stack verdicts over the library. Moved here from
 * /swipe in 3.8, which is now the landing page; the list/library choice arrives
 * as query params (an unknown section id is ignored rather than emptying the
 * deck — a stale bookmark should still give you something to swipe).
 */
export default async function SwipeDeckPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; watch?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const { section, watch } = await searchParams;

  const known = getManagedSections().find((s) => s.id === section);
  const watchMode = FEED_WATCH_MODES.includes(watch as FeedWatchMode)
    ? (watch as FeedWatchMode)
    : undefined;

  return (
    <AppShell>
      {!isServerConfigured() ? (
        <p className="text-slate-400 p-6">Not set up yet.</p>
      ) : (
        <SwipeView
          watchAvailable={isWatchAvailable()}
          sectionId={known?.id}
          sectionTitle={known?.title}
          initialWatch={watchMode}
        />
      )}
    </AppShell>
  );
}
