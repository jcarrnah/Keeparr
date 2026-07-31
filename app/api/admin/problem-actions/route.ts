/**
 * FORK: fix-it actions for the admin Problems page.
 *
 * Deliberately a SEPARATE route from upstream's `app/api/admin/problems/*` so
 * the fork's actions never collide with upstream's read endpoints (see
 * FORK_SYNC.md). Every action here is non-destructive: nothing deletes media,
 * and nothing touches the filesystem.
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { logEvent, relinkReplacedItems } from '@/lib/queries';
import { triggerServerRefresh } from '@/lib/post-delete-cleanup';

export const runtime = 'nodejs';

/** Run a fix. Body: { action: 'relink' | 'rescan' }. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const { action } = (await req.json()) as { action?: string };

    if (action === 'relink') {
      // Carry keeps/watch onto items that came back under a new id (4K
      // upgrades). Normally runs with the nightly library sweep; this is the
      // "don't wait until 03:00" button.
      const r = relinkReplacedItems();
      const message = r.items
        ? `Re-linked ${r.items} replaced item(s): ${r.keeps} keep(s), ${r.skips} skip(s), ` +
          `${r.verdicts} verdict(s), ${r.watch} watch row(s).`
        : 'Nothing to re-link — no tombstoned item has a live replacement.';
      logEvent('info', 'problems', message);
      return NextResponse.json({ ok: true, message, changed: r.items });
    }

    if (action === 'rescan') {
      // Make the server notice files that are already gone, so its empty
      // entries disappear instead of lingering as zero-size problems.
      const refreshed = await triggerServerRefresh('problems');
      return NextResponse.json({
        ok: true,
        message: refreshed
          ? 'Library rescan started — empty entries clear once the server finishes.'
          : 'No rescan available for this media server (Jellyfin/Emby only).',
        changed: refreshed ? 1 : 0,
      });
    }

    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
