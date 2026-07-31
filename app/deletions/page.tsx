import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import AppShell from '@/components/AppShell';
import DeletionHistoryView from '@/components/DeletionHistoryView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** FORK (3.1): the deletion audit trail. Admin-only — it's the record of
 *  destructive automation, and the cancel action on it is an admin power. */
export default async function DeletionsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if (!user.isAdmin) redirect('/');

  return (
    <AppShell>
      <div className="px-6 py-6">
        <DeletionHistoryView />
      </div>
    </AppShell>
  );
}
