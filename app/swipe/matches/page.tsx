import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { isServerConfigured } from '@/lib/settings';
import AppShell from '@/components/AppShell';
import MatchesView from '@/components/MatchesView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** FORK: movie-night matches + per-item verdict consensus. */
export default async function MatchesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  return (
    <AppShell>
      {!isServerConfigured() ? (
        <p className="text-slate-400 p-6">Not set up yet.</p>
      ) : (
        <MatchesView />
      )}
    </AppShell>
  );
}
