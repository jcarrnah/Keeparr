/**
 * FORK: fix-it actions for the admin Problems page.
 *
 * Deliberately a SEPARATE route from upstream's `app/api/admin/problems/*` so
 * the fork's actions never collide with upstream's read endpoints (see
 * FORK_SYNC.md).
 *
 * Two families. The Keeparr-side fixes (`relink`, `rescan`, `diskscan`,
 * `recheck`) act on
 * our own bookkeeping or kick off one of our jobs. The **source** actions
 * (`arr-rescan`, `arr-refresh`, `server-rescan`, `server-reidentify`,
 * `arr-remove-stale`) reach into Sonarr/Radarr or the media server, because
 * that's where most of these problems can actually be fixed — see
 * `lib/source-actions.ts`. Only `arr-remove-stale` removes anything, and only a
 * *arr RECORD whose folder the disk scan couldn't find; no action here deletes
 * media or touches the filesystem.
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { logEvent, relinkReplacedItems } from '@/lib/queries';
import { triggerServerRefresh } from '@/lib/post-delete-cleanup';
import { runJob } from '@/lib/jobs';
import {
  arrScanMediaItems,
  arrScanUnmatched,
  refreshServerItems,
  removeStaleArrRecords,
  sourceLinksFor,
} from '@/lib/source-actions';

export const runtime = 'nodejs';

/** How many rows one source action may touch — each is an upstream HTTP call,
 *  and a request that fans out to hundreds would outlive its own timeout. */
const MAX_TARGETS = 100;

/** Where the selected rows can be opened in the app that owns them.
 *  Query: ratingKeys / unmatchedKeys (comma lists). Admin-only — these are
 *  internal service URLs. */
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const p = new URL(req.url).searchParams;
    const split = (v: string | null) => (v ?? '').split(',').filter(Boolean).slice(0, MAX_TARGETS);
    return NextResponse.json({
      links: sourceLinksFor({
        ratingKeys: split(p.get('ratingKeys')),
        unmatchedKeys: split(p.get('unmatchedKeys')),
      }),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Run a fix. Body: { action, ratingKeys?, unmatchedKeys? }. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as {
      action?: string;
      ratingKeys?: unknown;
      unmatchedKeys?: unknown;
    };
    const { action } = body;
    const keyList = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
    const ratingKeys = keyList(body.ratingKeys);
    const unmatchedKeys = keyList(body.unmatchedKeys);

    // --- Source actions: act in Sonarr/Radarr or on the media server --------
    const SOURCE_ACTIONS = new Set([
      'arr-rescan',
      'arr-refresh',
      'server-rescan',
      'server-reidentify',
      'arr-remove-stale',
    ]);
    if (action && SOURCE_ACTIONS.has(action)) {
      if (ratingKeys.length === 0 && unmatchedKeys.length === 0) {
        return NextResponse.json({ error: 'no_targets' }, { status: 400 });
      }
      if (ratingKeys.length > MAX_TARGETS || unmatchedKeys.length > MAX_TARGETS) {
        return NextResponse.json({ error: 'too_many_items' }, { status: 400 });
      }

      if (action === 'arr-remove-stale') {
        // The only removal in the fork's Problems surface; the "folder isn't on
        // disk" gate is re-checked against the database inside.
        const r = await removeStaleArrRecords(unmatchedKeys);
        return NextResponse.json(r);
      }
      if (action === 'server-rescan' || action === 'server-reidentify') {
        const r = await refreshServerItems(ratingKeys, {
          reidentify: action === 'server-reidentify',
        });
        return NextResponse.json(r);
      }
      const mode = action === 'arr-refresh' ? 'refresh' : 'rescan';
      const r = unmatchedKeys.length
        ? await arrScanUnmatched(unmatchedKeys, mode)
        : await arrScanMediaItems(ratingKeys, mode);
      return NextResponse.json(r);
    }

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

    if (action === 'recheck') {
      // Close the loop after a source fix.
      //
      // Every source action is asynchronous in the OTHER app, and this page
      // reads Keeparr's cache — so a fixed title keeps showing as a problem
      // until Keeparr re-reads the server AND re-matches against Sonarr/Radarr.
      // Those are two separate nightly jobs (library 03:00, arr 07:00), which
      // is why "I ran the fix and nothing changed" is the normal experience.
      //
      // Order is the whole point: `arr` matches on the ids `library` just
      // refreshed, so running them the other way round re-matches against the
      // stale guids and reports no change. Hence the sequential chain rather
      // than two parallel triggers. Fire-and-forget for the same reason as
      // diskscan (a full sweep far outlives a request), and single-flight in
      // runWithState means a double-click can't stack sweeps.
      void runJob('library')
        .then(() => runJob('arr'))
        .catch(() => {});
      logEvent(
        'info',
        'problems',
        'Re-check triggered from the Problems page (library sync, then arr re-match).'
      );
      return NextResponse.json({
        ok: true,
        message:
          'Re-checking — reading the server, then re-matching Sonarr/Radarr. ' +
          'Rows that are genuinely fixed drop off once it finishes ' +
          '(Settings → Jobs for progress).',
        // The sweep is still running; refetching now would show identical rows.
        changed: 0,
      });
    }

    if (action === 'diskscan') {
      // The measured on-disk size is the tiebreaker between what the server
      // claims and what *arr claims — and the table already tells you to "Run
      // Disk scan". The job is weekly, so without this you wait up to six days
      // to settle a mismatch you're looking at right now. Fire-and-forget:
      // walking library roots takes minutes, far longer than a request should.
      // Same fire-and-forget shape as /api/admin/jobs; single-flight in
      // runWithState is what stops an impatient double-click stacking scans.
      void runJob('diskScan').catch(() => {});
      logEvent('info', 'problems', 'Disk scan triggered from the Problems page.');
      return NextResponse.json({
        ok: true,
        message:
          'Disk scan started — sizes and orphans update as it walks your library paths (Settings → Jobs for progress).',
        // Never refetch on the back of this: the job is still working, so the
        // rows would come back unchanged and read as "the button did nothing".
        changed: 0,
      });
    }

    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
