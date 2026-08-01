import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import {
  cancelDeletion,
  deletionResidueItems,
  getMediaItem,
  listScheduledDeletions,
  tagForDeletion,
} from '@/lib/queries';
import { getDeletionEnabled, getDeletionGraceDays } from '@/lib/settings';
import { sendDiscordMessage } from '@/lib/discord';

export const runtime = 'nodejs';

/**
 * FORK: list all scheduled-deletion tags (live first, soonest first) — the
 * permanent record behind the deletion-history screen. Nothing prunes
 * `scheduled_deletions`, which matters: `logs` keeps 1000 rows and `job_runs`
 * 100 runs, so a purge from last week is gone from both. Absence from the log
 * proves nothing; this endpoint is the audit trail.
 */
export async function GET() {
  try {
    await requireAdmin();
    const rows = listScheduledDeletions();
    const items = rows.map((r) => ({
      ratingKey: r.rating_key,
      title: r.title,
      sizeBytes: r.size_bytes,
      sectionId: r.section_id,
      taggedBy: r.tagged_by,
      taggedByName: r.tagged_by_name,
      taggedAt: r.tagged_at,
      deleteAfter: r.delete_after,
      status: r.status,
      statusAt: r.status_at,
      statusDetail: r.status_detail,
      kept: r.kept === 1,
      removed: r.removed === 1,
      // The post-delete reality check. residueBytes null = we couldn't verify
      // (section unmapped / root unreadable) — never read that as "gone".
      verifiedAt: r.verified_at,
      residueBytes: r.residue_bytes,
    }));
    // Per-status rollup, plus what the disk says actually left for the deleted
    // ones — the media server's `size_bytes` is a claim, not a measurement.
    const summary = items.reduce<
      Record<string, { count: number; bytes: number }>
    >((acc, i) => {
      const b = (acc[i.status] ??= { count: 0, bytes: 0 });
      b.count += 1;
      b.bytes += i.sizeBytes;
      return acc;
    }, {});
    const deleted = items.filter((i) => i.status === 'deleted');
    const verified = deleted.filter((i) => i.residueBytes != null);
    return NextResponse.json({
      items,
      summary,
      reclaim: {
        claimedBytes: deleted.reduce((n, i) => n + i.sizeBytes, 0),
        // Measured across the VERIFIED deletions only; the unverified ones are
        // counted separately rather than assumed successful.
        verifiedClaimedBytes: verified.reduce((n, i) => n + i.sizeBytes, 0),
        residueBytes: verified.reduce((n, i) => n + (i.residueBytes ?? 0), 0),
        verifiedCount: verified.length,
        unverifiedCount: deleted.length - verified.length,
      },
      residueItems: deletionResidueItems(),
      enabled: getDeletionEnabled(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Cap on one batch — a mis-click on a big Problems page shouldn't be able to
 *  schedule a library. Well above any single page of results. */
const MAX_BATCH = 200;

/**
 * FORK: tag an item "delete after date" (admin only). Body: {ratingKey,
 * graceDays?} — graceDays overrides the configured default for this tag.
 * A currently-kept item is tagged as 'held' (keeps always win).
 *
 * Also accepts {ratingKeys: string[]} to tag a batch in one call — the
 * Problems page triages a list at a time. The batch reports ONE Discord
 * summary rather than N pings, the way the rules job does; a hundred separate
 * "tagged X" messages is how a household learns to mute the channel.
 */
export async function POST(req: Request) {
  try {
    const user = await requireAdmin();
    const body = (await req.json()) as {
      ratingKey?: string;
      ratingKeys?: unknown;
      graceDays?: number;
    };
    const batch = Array.isArray(body.ratingKeys) ? body.ratingKeys : null;
    if (batch && batch.some((k) => typeof k !== 'string')) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const keys: string[] = batch
      ? (batch as string[])
      : typeof body.ratingKey === 'string' && body.ratingKey
        ? [body.ratingKey]
        : [];
    if (keys.length === 0) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    if (keys.length > MAX_BATCH) {
      return NextResponse.json({ error: 'too_many_items' }, { status: 400 });
    }
    const graceDays =
      typeof body.graceDays === 'number' && body.graceDays >= 0
        ? Math.floor(body.graceDays)
        : getDeletionGraceDays();
    const deleteAfter = Math.floor(Date.now() / 1000) + graceDays * 86400;

    const tagged: string[] = [];
    for (const key of keys) {
      if (tagForDeletion(key, user.plexUserId, deleteAfter)) tagged.push(key);
    }
    // Single-key callers keep the old contract exactly: 404 when the item is
    // unknown or tombstoned. A batch reports the shortfall instead — one dead
    // id shouldn't discard the other 19 tags.
    if (!batch && tagged.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // Discord: fire-and-forget — a slow/failing webhook must not stall the tag.
    const when = new Date(deleteAfter * 1000).toLocaleDateString();
    if (tagged.length === 1) {
      const title = getMediaItem(tagged[0])?.title ?? tagged[0];
      void sendDiscordMessage(
        `🏷️ **${title}** was tagged for deletion after ${when}. Keep it in Keeparr to rescue it.`
      );
    } else if (tagged.length > 1) {
      const titles = tagged.slice(0, 8).map((k) => getMediaItem(k)?.title ?? k);
      void sendDiscordMessage(
        `🏷️ ${tagged.length} titles were tagged for deletion after ${when} — e.g. ${titles.join(', ')}${
          tagged.length > 8 ? ', …' : ''
        }. Keep anything you want to rescue.`
      );
    }
    return NextResponse.json({
      ok: true,
      deleteAfter,
      tagged: tagged.length,
      skipped: keys.length - tagged.length,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** FORK: cancel a live tag (admin only). Body: {ratingKey}. */
export async function DELETE(req: Request) {
  try {
    const user = await requireAdmin();
    const body = (await req.json()) as { ratingKey?: string };
    if (!body.ratingKey || typeof body.ratingKey !== 'string') {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const ok = cancelDeletion(body.ratingKey, user.plexUserId);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
