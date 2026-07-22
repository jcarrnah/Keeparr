import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import {
  cancelDeletion,
  getMediaItem,
  listScheduledDeletions,
  tagForDeletion,
} from '@/lib/queries';
import { getDeletionEnabled, getDeletionGraceDays } from '@/lib/settings';
import { sendDiscordMessage } from '@/lib/discord';

export const runtime = 'nodejs';

/** FORK: list all scheduled-deletion tags (live first, soonest first). */
export async function GET() {
  try {
    await requireAdmin();
    const items = listScheduledDeletions().map((r) => ({
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
    }));
    return NextResponse.json({ items, enabled: getDeletionEnabled() });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * FORK: tag an item "delete after date" (admin only). Body: {ratingKey,
 * graceDays?} — graceDays overrides the configured default for this tag.
 * A currently-kept item is tagged as 'held' (keeps always win).
 */
export async function POST(req: Request) {
  try {
    const user = await requireAdmin();
    const body = (await req.json()) as { ratingKey?: string; graceDays?: number };
    if (!body.ratingKey || typeof body.ratingKey !== 'string') {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const graceDays =
      typeof body.graceDays === 'number' && body.graceDays >= 0
        ? Math.floor(body.graceDays)
        : getDeletionGraceDays();
    const deleteAfter = Math.floor(Date.now() / 1000) + graceDays * 86400;
    const ok = tagForDeletion(body.ratingKey, user.plexUserId, deleteAfter);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    // Discord: fire-and-forget — a slow/failing webhook must not stall the tag.
    const title = getMediaItem(body.ratingKey)?.title ?? body.ratingKey;
    void sendDiscordMessage(
      `🏷️ **${title}** was tagged for deletion after ${new Date(deleteAfter * 1000).toLocaleDateString()}. Keep it in Keeparr to rescue it.`
    );
    return NextResponse.json({ ok: true, deleteAfter });
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
