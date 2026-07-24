import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { isServerConfigured } from '@/lib/settings';
import AppShell from '@/components/AppShell';
import RoomView from '@/components/RoomView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** FORK: a live "movie night" swipe room. */
export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const { code } = await params;

  return (
    <AppShell>
      {!isServerConfigured() ? (
        <p className="text-slate-400 p-6">Not set up yet.</p>
      ) : (
        <RoomView code={code.toUpperCase()} />
      )}
    </AppShell>
  );
}
